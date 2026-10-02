import contextlib, errno, functools, io, os, re, sys
from types import NoneType
import yt_dlp, js
from pyodide.ffi import to_js, run_sync, JsException
from collections.abc import Iterable

def _opts(**kw):
    return to_js(kw, dict_converter=js.Object.fromEntries)

def _may_have(fmt, key) -> bool:
    """Whether a format may carry the track its `key` ("vcodec"/"acodec") describes. Only "none" rules
    one out: like yt-dlp's own merger, an unknown codec still counts, as plenty of formats don't report
    one (e.g. HLS audio renditions never get an acodec)"""
    return fmt.get(key) != 'none'

class FetchStream:
    """File-like over a fetch `ReadableStream`. Only .read/.close are needed."""
    def __init__(self, js_reader):
        self._reader = js_reader
        self._buf = bytearray()
        self._eof = False
        self.closed = False

    def _pump(self):
        chunk = run_sync(self._reader.read())
        if chunk.done:
            self._eof = True
        else:
            self._buf += bytes(chunk.value.to_py())

    def read(self, amt=None) -> bytes:
        if amt is None or amt < 0:
            while not self._eof:
                self._pump()
            out, self._buf = bytes(self._buf), bytearray()
            return out
        while len(self._buf) < amt and not self._eof:
            self._pump()
        out = bytes(self._buf[:amt])
        del self._buf[:amt]
        return out

    def close(self):
        # Don't wait for the cancel: yt-dlp's Response closes this from IOBase.__del__, so it runs whenever
        # Python happens to garbage collect, e.g. while JS has called into Python synchronously. run_sync
        # can't suspend there, and the SuspendError it can throw isn't a Python exception, so it escaped
        # the except below and left the download hanging.
        # The catch keeps a stream that already errored from being reported as an unhandled rejection.
        if not self.closed:
            self.closed = True
            try:
                self._reader.cancel().catch(lambda _: None)
            except Exception:
                pass


from yt_dlp.networking.common import RequestHandler, Response, Request, register_rh
from yt_dlp.networking.exceptions import HTTPError, TransportError

@register_rh
class FetchRH(RequestHandler):
    """Use the `fetch` api instad of some library"""
    RN_NAME = "nativeFetch"
    _SUPPORTED_URL_SCHEMES = ('http', 'https')
    _SUPPORTED_PROXY_SCHEMES = None
    _SUPPORTED_ENCODINGS = ('gzip', 'br')

    def _send(self, request: Request):
        """The browser sends the cookies, not yt-dlp: fetch can't set a Cookie header. It does so only
        for requests to the page's origin, see python_fetch in worker.js. yt-dlp's cookie jar holds
        the same cookies (the cookiefile option) so extractors can see them, but it isn't sent."""
        new_headers = {}
        proxy = False
        # see the visionos notes below
        anonymous = request.headers.get("X-YouTube-Client-Name") == VISIONOS_CLIENT_NAME
        NO_SET_HEADERS = ["accept-encoding", "cookie", "cookie2", "origin", "referer", "sec-fetch-mode", "user-agent"]
        # fetch can't set Origin or Referer, so requests that need them are sent from the page instead,
        # which gives them the page's. Some CDNs (e.g. bilibili's) refuse requests without a Referer.
        PROXY_INDICATOR_HEADERS = ["origin", "referer"]
        referrer = None
        for k, v in request.headers.items():
            if k.lower() not in NO_SET_HEADERS and not (anonymous and k.lower() in YT_ACCOUNT_HEADERS):
                new_headers[k] = v
            if k.lower() in PROXY_INDICATOR_HEADERS:
                proxy = True
            if k.lower() == "referer":
                referrer = v
        # normalize request.data to just bytes or None (js will deal with none just fine)
        js_compat_body = request.data
        if isinstance(js_compat_body, bytearray | memoryview):
            js_compat_body = bytes(js_compat_body)
        elif hasattr(js_compat_body, "read"):
            content = js_compat_body.read()
            js_compat_body = content if isinstance(content, bytes) else bytes(content)
        js_compat_request = {
            "method": request.method,
            "url": request.url,
            "headers": new_headers,
            "body": js_compat_body,
            # never send the browser's cookies, even to the page's origin
            "anonymous": anonymous,
        }
        if referrer:
            # only honoured when it's on the page's origin, otherwise the page's URL is used
            js_compat_request["referrer"] = referrer
        # js.console.debug("Sending HTTP request:", js_compat_request, "proxy", proxy)


        try:
            response = run_sync(js.python_fetch(to_js(js_compat_request, dict_converter=js.Object.fromEntries), proxy))
        except Exception as e:
            # network failure, CORS rejection, etc. yt-dlp retries on TransportError
            raise TransportError(cause=e) from e
        r_headers = {}
        for k, v in response.headers:
            r_headers[k] = v
        res = Response(
            # no body for e.g. HEAD requests
            fp = FetchStream(response.stream.getReader()) if response.stream else io.BytesIO(),
            # where any redirects ended up, like yt-dlp's own handlers report
            url = response.url or request.url,
            headers = r_headers,
            status = response.status
        )
        # like yt-dlp's own handlers: without this an error page gets saved as the video
        if not 200 <= res.status < 300:
            raise HTTPError(res)
        return res

# YouTube: always use the visionos client. Signed in, yt-dlp would otherwise pick clients that
# only get 360p here, and it skips visionos since that client doesn't support cookies. So visionos
# is kept, and FetchRH sends its requests signed out instead: no cookies and no account headers,
# just as yt-dlp does when it has no cookies.

from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS

VISIONOS_CLIENT_NAME = str(INNERTUBE_CLIENTS['visionos']['INNERTUBE_CONTEXT_CLIENT_NAME'])
INNERTUBE_CLIENTS['visionos']['SUPPORTS_COOKIES'] = True
# what YoutubeBaseInfoExtractor._generate_cookie_auth_headers adds when signed in
YT_ACCOUNT_HEADERS = ["authorization", "x-origin", "x-goog-authuser", "x-goog-pageid", "x-youtube-bootstrap-logged-in"]

# JS Challenge

from yt_dlp.extractor.youtube.jsc.provider import register_provider, register_preference
from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP

@register_provider
class NativeJSEngineJCP(EJSBaseJCP):
    JS_RUNTIME_NAME = "yt-dlp-web-sandbox-runner"
    PROVIDER_VERSION = "0.0.1"
    BUG_REPORT_LOCATION = "https://github.com/devofthedark/AnyDownload/issues?q="
    def _run_js_runtime(self, stdin):
        resp = run_sync(js.jsc(stdin))
        return resp
    @functools.cache
    def is_available(self):
        return True

@register_preference(NativeJSEngineJCP)
def preference(*_) -> int:
    return 999_999_999

# PO token provider, basically just yoink from the browser

from yt_dlp.extractor.youtube.pot.provider import (
    PoTokenRequest,
    PoTokenContext,
    PoTokenProvider,
    PoTokenResponse,
    register_provider,
    register_preference
)
from yt_dlp.extractor.youtube.pot.utils import get_webpo_content_binding, WEBPO_CLIENTS


@register_provider
class NativeExtractorPTP(PoTokenProvider):
    PROVIDER_VERSION = "0.0.1"
    PROVIDER_NAME = "NativeBrowserExtractor"
    BUG_REPORT_LOCATION = "https://github.com/devofthedark/AnyDownload/"

    _SUPPORTED_CLIENTS = WEBPO_CLIENTS

    _SUPPORTED_CONTEXTS = (
        PoTokenContext.GVS,
        PoTokenContext.PLAYER,
        PoTokenContext.SUBS
    )

    @functools.cache
    def is_available(self):
        return True
    def _real_request_pot(self, request: PoTokenRequest):
        bind = get_webpo_content_binding(request)
        tok = run_sync(js.mint_potoken([bind[0], None if bind[1] is None else str(bind[1])], False, False)) # jank
        return PoTokenResponse(po_token=tok)

# Patch file writes over OPFS to avoid wasm 4GB memory limit. Firefox's private windows have no OPFS,
# so there the worker hands us an in-memory stand-in with the same API instead (see memory-fs.js).

# yt-dlp handles file errors with `except OSError` (and retries some errnos), but OPFS failures
# arrive as JsException, which would skip all of that. Name of the DOMException -> OSError to raise.
_OPFS_ERRORS = {
    "NotFoundError": (FileNotFoundError, errno.ENOENT),
    "TypeMismatchError": (IsADirectoryError, errno.EISDIR),
    # the file is locked, e.g. still open through another sync access handle
    "NoModificationAllowedError": (PermissionError, errno.EACCES),
    "InvalidModificationError": (PermissionError, errno.EACCES),
    "QuotaExceededError": (OSError, errno.ENOSPC),
}

@contextlib.contextmanager
def _os_errors(path):
    try:
        yield
    except JsException as e:
        name = getattr(e, "name", None) or str(e).split(":", 1)[0]
        cls, code = _OPFS_ERRORS.get(name, (OSError, errno.EIO))
        raise cls(code, f"{name}: {getattr(e, 'message', None) or e}", path) from e

class OPFSFile(io.RawIOBase):
    """
    File-like access for OPFS files

    @param store: The owner of this file. Essentially just a representation the parent directory
    @param name: file name
    @param mode: open mode
    """
    def __init__(self, store: OPFSStore, name, mode):
        self._store = store
        if "x" in mode and store.exists(name):
            raise FileExistsError(errno.EEXIST, "File exists", name)
        # like open(): reading ("r", "r+") needs the file to be there already
        self._handle = store._sync_handle(name, create=any(c in mode for c in "wax"))
        self.name = name
        self.mode = mode
        self._scratch = js.Uint8Array.new(1 << 20) # 1MB buffer before read/write to disk, can change with requested view size
        if "w" in mode:
            self._handle.truncate(0)
            self._pos = 0
        elif "a" in mode:
            self._pos = self._handle.getSize()
        else:
            self._pos = 0
        self._strmode = "b" not in mode
        js.console.debug(f'[OPFS translation layer] OPFSFile.__init__(name="{name}", mode="{mode}")')

    

    def _view(self, n: int) -> js.Uint8Array:
        if n > self._scratch.length:
            self._scratch = js.Uint8Array.new(max(n, self._scratch.length * 2))
        return self._scratch.subarray(0, n)

    def writable(self) -> bool:
        js.console.debug(f'[OPFS translation layer] OPFSFile(name="{self.name}").writable()')
        return any(c in self.mode for c in "wax+")
    def readable(self) -> bool:
        js.console.debug(f'[OPFS translation layer] OPFSFile(name="{self.name}").readable()')
        return "r" in self.mode or "+" in self.mode
    def seekable(self) -> bool:
        return True

    def write(self, b: bytearray | str) -> int:
        js.console.debug(f'[OPFS translation layer] OPFSFile(name="{self.name}").write([len {len(b)}])')
        if self._strmode:
            b = bytearray(b, "utf-8")
        n = len(b)
        if not n:
            return 0
        view = self._view(n)
        view.assign(b)
        with _os_errors(self.name):
            written = self._handle.write(view, _opts(at=self._pos))
        if written != n:
            raise OSError(f"Small write to {self.name}: {written}/{n}")
        self._pos += written
        return written

    def readinto(self, buf: bytearray) -> int:
        n = len(buf)
        view = self._view(n)
        with _os_errors(self.name):
            got = self._handle.read(view, _opts(at=self._pos))
        if got:
            view.subarray(0, got).assign_to(memoryview(buf)[:got])
            self._pos += got
        return got

    def read(self, size: int =-1) -> bytes | str:
        if size is None or size < 0:
            size = max(0, self._handle.getSize() - self._pos)
        buf = bytearray(size)
        got = self.readinto(buf)
        if not self._strmode:
            return bytes(buf[:got])
        return bytes(buf[:got]).decode("utf-8")

    def seek(self, offset, whence=os.SEEK_SET):
        if whence == os.SEEK_SET:
            self._pos = offset
        elif whence == os.SEEK_CUR:
            self._pos += offset
        else:
            self._pos = self._handle.getSize() + offset
        return self._pos

    def tell(self):
        return self._pos

    def flush(self):
        if not self.closed:
            self._handle.flush()

    def close(self):
        if self.closed:
            return
        try:
            super().close()
        finally:
            self._handle.close()
            self._store._forget(self)

class OPFSStore:
    """Owner of an OPFS dir"""

    def __init__(self, dir_handle):
        self._dir = dir_handle
        self._live: dict[str, io.BufferedRandom | io.BufferedReader | io.BufferedWriter | io.TextIOWrapper] = {}
        self._live_raw = {}

    @classmethod
    def open(cls, subdir=None):
        js.console.debug(f'[OPFS translation layer] OPFSStore.open({subdir})')
        root = run_sync(js.storage_root())
        if subdir:
            root = run_sync(root.getDirectoryHandle(subdir, _opts(create=True)))
        return cls(root)

    @staticmethod
    def _key(path):
        return os.path.basename(path)

    def _file_handle(self, name, create=True):
        with _os_errors(name):
            return run_sync(self._dir.getFileHandle(name, _opts(create=create)))

    def _sync_handle(self, name, create=True):
        handle = self._file_handle(name, create=create)
        with _os_errors(name):
            return run_sync(handle.createSyncAccessHandle())

    def _forget(self, raw: OPFSFile):
        # only if it's still the registered one, not an older handle closed late
        if self._live_raw.get(raw.name) is raw:
            del self._live_raw[raw.name]
            del self._live[raw.name]

    def close_all(self):
        """Close every file still open, e.g. after a download failed halfway"""
        for f in list(self._live.values()):
            try:
                f.close()
            except Exception as e:
                js.console.warn(f'[OPFS translation layer] could not close {f}: {e}')

    def _wrap(self, raw: OPFSFile, mode):
        if raw.readable() and raw.writable():
            buf = io.BufferedRandom(raw, 1 << 20)
        elif raw.readable():
            buf = io.BufferedReader(raw, 1 << 20)
        else:
            buf = io.BufferedWriter(raw, 1 << 20)

        if "b" in mode:
            return buf
        return io.TextIOWrapper(buf, encoding="utf-8", newline="")

    def open_file(self, path, mode="rb"):
        js.console.debug(f'[OPFS translation layer] OPFSStore.open_file("{path}", mode="{mode}")')
        name = self._key(path)
        # A file can only have one sync access handle at a time, so a second open() of the same
        # file closes the first instead of failing. Callers get a handle in the mode they asked for.
        existing = self._live.get(name)
        if existing is not None and not existing.closed:
            js.console.debug(f'[OPFS translation layer] "{name}" is already open, closing it first')
            existing.close()
        f = OPFSFile(self, name, mode)
        self._live_raw[name] = f
        self._live[name] = self._wrap(f, mode)
        return self._live[name]

    def size(self, path):
        js.console.debug(f'[OPFS translation layer] OPFSStore.size("{path}")')
        name = self._key(path)
        live = self._live_raw.get(name)
        if live and not live.closed:
            return live._handle.getSize()
        handle = self._file_handle(name, create=False)
        with _os_errors(path):
            return run_sync(handle.getFile()).size

    def exists(self, path):
        name = self._key(path)
        if name in self._live:
            return True
        try:
            self._file_handle(name, create=False)
            return True
        except OSError:
            return False

    def rename(self, src, dst):
        # Chrome and Firefox both support this, at least for moving single files
        # not sure why theres nothing on MDN documenting any of this
        # https://caniuse.com/mdn-api_filesystemhandle_move
        # keep a lookout for any changes

        src_name, dst_name = self._key(src), self._key(dst)
        if src_name == dst_name:
            return
        handle = self._file_handle(src_name, create=False)
        # os.replace() overwrites the destination; move() isn't guaranteed to
        if self.exists(dst_name):
            self.remove(dst_name)
        with _os_errors(src):
            run_sync(handle.move(dst_name))

    def remove(self, path):
        with _os_errors(path):
            run_sync(self._dir.removeEntry(self._key(path)))


OPFS_PREFIX = "/OPFS"
import yt_dlp.utils as ytu
orig = ytu.sanitize_open
# STORE_DIR is this panel's own OPFS directory, set by worker.js before it runs this file
dir_store = OPFSStore.open(STORE_DIR)

def sanitize_open(filename, open_mode):
    js.console.debug(f'[OPFS translation layer] sanitize_open("{filename}", "{open_mode}")')
    if filename == "-":
        return sys.stdout.buffer, filename
    return dir_store.open_file(filename, open_mode), filename

for mod in list(sys.modules.values()):
    if getattr(mod, "__name__", "").startswith("yt_dlp"):
        try:
            if getattr(mod, "sanitize_open", None) is orig:
                mod.sanitize_open = sanitize_open
        except Exception:
            pass
ytu.sanitize_open = sanitize_open

def _in_opfs(p):
    return os.fspath(p).startswith(OPFS_PREFIX + "/")

_getsize = os.path.getsize
def size(p):
    return dir_store.size(os.fspath(p)) if _in_opfs(p) else _getsize(p)
os.path.getsize = size

_exists = os.path.exists
def exists(p):
    return dir_store.exists(os.fspath(p)) if _in_opfs(p) else _exists(p)
os.path.exists = exists

# the store only holds files, so anything in it that exists is a file
_isfile = os.path.isfile
def isfile(p):
    return dir_store.exists(os.fspath(p)) if _in_opfs(p) else _isfile(p)
os.path.isfile = isfile

_replace = os.replace
def replace(src, dist, *args, **kwargs):
    return dir_store.rename(os.fspath(src), os.fspath(dist)) if _in_opfs(src) else _replace(src, dist, *args, **kwargs)
os.replace = replace

_rename = os.rename
def rename(src, dist, *args, **kwargs):
    return dir_store.rename(os.fspath(src), os.fspath(dist)) if _in_opfs(src) else _rename(src, dist, *args, **kwargs)
os.rename = rename

_remove = os.remove
def remove(p, *args, **kwargs):
    return dir_store.remove(os.fspath(p)) if _in_opfs(p) else _remove(p, *args, **kwargs)
os.remove = remove

_unlink = os.unlink
def unlink(p, *args, **kwargs):
    return dir_store.remove(os.fspath(p)) if _in_opfs(p) else _unlink(p, *args, **kwargs)
os.unlink = unlink

os.utime = lambda *a, **k: None


#Patch FFmpeg post-processors to use MediaBunny instead

from yt_dlp.postprocessor import PostProcessor
from yt_dlp.utils import PostProcessingError
import mb_bridge

AUDIO_TARGETS = {
    'mp3': ('mp3', 'mp3'),
    'aac': ('aac', 'aac'),
    'm4a': ('m4a', 'aac'),
    'opus': ('opus', 'opus'),
    'vorbis': ('ogg', 'vorbis'),
    'flac': ('flac', 'flac'),
    'wav': ('wav', 'pcm-s16')
}

COPY_TARGETS = {
    'aac': 'm4a',
    'mp3': 'mp3',
    'opus': 'opus',
    'vorbis': 'ogg',
    'flac': 'flac',
    'ac3': 'mka',
    'eac3': 'mka'
}

_VBR_BITRATES = [256, 224, 192, 160, 128, 112, 96, 80, 64, 56, 48]

def _bitrate(quality):
    if quality is None:
        return None
    text = str(quality).strip()
    if text[-1:] in ('k', 'K'):
        try:
            return int(float(text[:-1]) * 1000)
        except ValueError:
            return None
    try:
        value = float(text)
    except ValueError:
        return None
    if 0 <= value <= 10 and value == int(value):
        return _VBR_BITRATES[int(value)] * 1000
    return int(value)

def _tags_for(info):
    """Map info_dict onto Mediabunny's MetadataTags shape."""
    tags = {}
 
    def first(target, *keys):
        for key in keys:
            value = info.get(key)
            if value:
                tags[target] = value
                return
 
    first('title', 'track', 'title')
    first('artist', 'artist', 'creator', 'uploader')
    first('album', 'album')
    first('albumArtist', 'album_artist')
    first('genre', 'genre')
    first('comment', 'description')
    first('description', 'description')
 
    if info.get('track_number'):
        tags['trackNumber'] = info['track_number']
 
    date = info.get('upload_date') or info.get('release_date')
    if date and len(str(date)) == 8:
        date = str(date)
        tags['date'] = f'{date[0:4]}-{date[4:6]}-{date[6:8]}'
 
    for thumb in reversed(info.get('thumbnails') or []):
        if thumb.get('filepath'):
            tags['coverFrom'] = thumb['filepath']
            break
 
    return tags

class _MediabunnyPP(PostProcessor):
    store = dir_store
    bridge = mb_bridge
    write_tags = True

    @property
    def available(self):
        return True

    def _mux(self, info, sources, out_path, container, tags=None, label=None):
        store, bridge = self.store, self.bridge

        if not bridge.supports(container):
            raise PostProcessingError(f'Mediabunny cannot write .{container}')

        names = [s['name'] for s in sources]
        if tags and tags.get('coverFrom'):
            tags = dict(tags, coverFrom=store._key(tags['coverFrom']))
            names.append(tags['coverFrom'])
        for name in names:
            live = store._live.get(name)
            if live is not None and not live.closed:
                live.close()

        payload = {
            'sources': [_opts(**s) for s in sources],
            'outputName': store._key(out_path),
            'container': container,
            'jobId': store._key(out_path),
            'label': label
        }
        if tags:
            payload['tags'] = _opts(**tags)
        if label:
            js.set_status(f'{label}…')

        try:
            run_sync(bridge.mux(_opts(**payload)))
        except Exception as err:
            raise PostProcessingError(str(err)) from err

        info['__mb_muxed'] = True
        return out_path

    def _maybe_tags(self, info):
        return _tags_for(info) if self.write_tags else None

class MediabunnyMergerPP(_MediabunnyPP):

    def can_merge(self) -> bool:
        return True

    def run(self, info):
        to_merge = info['__files_to_merge']
        formats = info.get("requested_formats") or []

        sources = []
        for fmt, fallback in zip(formats, to_merge):
            path = fmt.get("filepath") or fallback
            sources.append({
                'name': self.store._key(path),
                'video': _may_have(fmt, "vcodec"),
                'audio': _may_have(fmt, "acodec")
            })
        target = info['filepath']
        self.to_screen(f'merging formats into "{target}"')
        self._mux(info, sources, target, info['ext'], self._maybe_tags(info),
                  label=f'Merging video and audio into .{info["ext"]}')
        return to_merge, info

class MediabunnyExtractAudioPP(_MediabunnyPP):
    def __init__(self, downloader=None, preferredcodec=None, preferredquality=None, nopostoverwrites=False):
        super().__init__(downloader)
        self._codec = preferredcodec or 'best'
        self._quality = preferredquality
        self._nopostoverwrites = nopostoverwrites

    def _target(self, name):
        if self._codec != 'best':
            target = AUDIO_TARGETS.get(self._codec)
            if target is None:
                raise PostProcessingError(
                    f'Mediabunny cannot encode audio as "{self._codec}". '
                    f'Available: {", ".join(sorted(AUDIO_TARGETS))}'
                )
            return target

        probe = run_sync(self.bridge.probeAudio(name))
        if probe is None:
            raise PostProcessingError('no audio track to extract')
        codec = probe.codec
        return COPY_TARGETS.get(codec, 'mka'), None

    def run(self, info):
        path = info['filepath']
        name = self.store._key(path)

        live = self.store._live.get(name)
        if live is not None and not live.closed:
            live.close()

        ext, codec = self._target(name)
        target = f'{path.rsplit(".", 1)[0]}.{ext}'

        if target == path:
            self.to_screen(f'Not extracting audio, already in target format {ext}')
            return [], info

        source = {'name': name, 'video': False, 'audio': True}
        if codec:
            source['audioCodec'] = codec
            bitrate = _bitrate(self._quality)
            if bitrate:
                source['audioBitrate'] = bitrate

        self.to_screen(f'Extracting audio to "{target}"')
        verb = 'Converting' if codec else 'Extracting'
        self._mux(info, [source], target, ext, self._maybe_tags(info), label=f'{verb} audio to .{ext}')

        info['filepath'] = target
        info['ext'] = ext
        return [path], info
        
def _has_track(pp, info, kind):
    """Whether the downloaded file has a `kind` ("video"/"audio") track. Asks the file itself:
    plenty of sites don't report codecs, so the info dict can't be trusted for this"""
    name = pp.store._key(info['filepath'])
    live = pp.store._live.get(name)
    if live is not None and not live.closed:
        live.close()
    try:
        return bool(getattr(run_sync(pp.bridge.probeTracks(name)), kind))
    except Exception as err:
        raise PostProcessingError(f'could not read the tracks of "{name}": {err}') from err

# "Audio only" / "video only" fall back to formats with both tracks on sites that don't serve them
# separately (see formatSelector in iframe.js), so these drop the track that wasn't asked for.

class MediabunnyAudioOnlyPP(MediabunnyExtractAudioPP):
    def run(self, info):
        if not _has_track(self, info, 'video'):
            return [], info
        return super().run(info)

class MediabunnyVideoOnlyPP(_MediabunnyPP):

    def __init__(self, downloader=None, preferedformat=None):
        super().__init__(downloader)
        self._format = preferedformat

    def run(self, info):
        if not _has_track(self, info, 'audio'):
            return [], info
        path = info['filepath']
        name = self.store._key(path)
        ext = self._format or info['ext']
        if not self.bridge.supports(ext):
            ext = 'mkv'  # takes any codec
        target = f'{path.rsplit(".", 1)[0]}.{ext}'
        source = {'name': name, 'video': True, 'audio': False}

        self.to_screen(f'Removing the audio track from "{path}"')
        label = 'Removing the audio track'
        if target == path:
            temp = f'{name}.video'
            self._mux(info, [source], temp, ext, self._maybe_tags(info), label=label)
            self.store.remove(name)
            self.store.rename(temp, name)
            return [], info
        self._mux(info, [source], target, ext, self._maybe_tags(info), label=label)
        info['filepath'] = target
        info['ext'] = ext
        return [path], info

class MediabunnyVideoRemuxerPP(_MediabunnyPP):

    def __init__(self, downloader=None, preferedformat=None):
        super().__init__(downloader)
        self._formats = [f for f in (preferedformat or '').split('/') if f]

    def run(self, info):
        path = info['filepath']
        current = info['ext']

        wanted = None
        for candidate in self._formats:
            if candidate == current:
                self.to_screen(f'Not remuxing, already {current}')
                return [], info
            if self.bridge.supports(candidate):
                wanted = candidate
                break
        if wanted is None:
            raise PostProcessingError(f"Mediabunny cannot write any of: {"/".join(self._formats)}")

        target = f'{path.rsplit(".", 1)[0]}.{wanted}'
        source = {'name': self.store._key(path), 'video': True, 'audio': True}

        self.to_screen(f'Remuxing video into {wanted}')
        self._mux(info, [source], target, wanted, self._maybe_tags(info), label=f'Converting .{current} to .{wanted}')

        info['filepath'] = target
        info['ext'] = wanted
        return [path], info

class MediabunnyMetadataPP(_MediabunnyPP):
 
    def __init__(self, downloader=None, add_metadata=True,
                 add_chapters=True, add_infojson='if_exists'):
        super().__init__(downloader)
        self._add_metadata = add_metadata
        self._add_chapters = add_chapters
 
    def run(self, info):
        if not self._add_metadata:
            return [], info
 
        if info.get('__mb_muxed'):
            self.to_screen('Metadata already written during muxing')
            return [], info
 
        if self._add_chapters and info.get('chapters'):
            self.report_warning('Chapters are not supported by Mediabunny')
 
        path = info['filepath']
        name = self.store._key(path)
        temp = f'{name}.meta'
 
        self.to_screen(f'Adding metadata to "{path}"')
        source = {'name': name, 'video': True, 'audio': True}
        self._mux(info, [source], temp, info['ext'], _tags_for(info), label='Writing metadata')
 
        self.store.remove(name)
        self.store.rename(temp, name)
        return [], info

class MediabunnyRemuxFixupPP(_MediabunnyPP):

    def run(self, info):
        path = info['filepath']
        name = self.store._key(path)
        temp = f'{name}.remux'
 
        self.to_screen(f'Fixing container of "{path}"')
        source = {'name': name, 'video': True, 'audio': True}
        self._mux(info, [source], temp, info['ext'], self._maybe_tags(info), label=f'Fixing up the .{info["ext"]} container')
 
        self.store.remove(name)
        self.store.rename(temp, name)
        return [], info


class _NoopPP(PostProcessor):

    @property
    def available(self):
        return True

    def run(self, info):
        return [], info

def _rebind(name, replacement):
    count = 0
    for module in list(sys.modules.values()):
        if not getattr(module, "__name__", '').startswith('yt_dlp'):
            continue
        # check the module's own namespace: getattr() would trigger the lazy __getattr__
        # of yt_dlp.compat passthrough modules, which try to import `name` as a submodule
        if isinstance(vars(module).get(name), type):
            setattr(module, name, replacement)
            count += 1
    return count

replacements = {
    'FFmpegMergerPP': MediabunnyMergerPP,
    'FFmpegExtractAudioPP': MediabunnyExtractAudioPP,
    'FFmpegVideoRemuxerPP': MediabunnyVideoRemuxerPP,
    'FFmpegMetadataPP': MediabunnyMetadataPP,
    # Stretched/Timestamp/Duration rewrite metadata Mediabunny already
    # writes correctly from the source tracks.
    'FFmpegFixupStretchedPP': _NoopPP,
    'FFmpegFixupTimestampPP': _NoopPP,
    'FFmpegFixupDurationPP': _NoopPP,
    'FFmpegFixupM3u8PP': MediabunnyRemuxFixupPP,
    'FFmpegFixupM4aPP': MediabunnyRemuxFixupPP,
}

for name, cls in replacements.items():
    _rebind(name, cls)

_SCREEN_LINE = re.compile(r'\[(?P<tag>[^\]]+)\] (?P<msg>.+)', re.DOTALL)

def _describe(message):
    """Tidy a yt-dlp console line (e.g. "[youtube] dQw4w9WgXcQ: Downloading webpage") for the status line"""
    message = message.strip()
    m = _SCREEN_LINE.fullmatch(message)
    if not m:
        return message
    # our post-processors print as e.g. "[MediabunnyMerger]"; show them like yt-dlp's own
    tag, msg = m['tag'].removeprefix('Mediabunny'), m['msg']
    if tag == 'download' and msg.startswith('Destination: '):
        return f'Starting download of {os.path.basename(msg.removeprefix("Destination: "))}'
    # extractor lines are prefixed with the video id, which isn't useful to show
    msg = re.sub(r'^[^\s:]+: ', '', msg)
    return f'{tag}: {msg}'

class BrowserYDL(yt_dlp.YoutubeDL):
    @functools.cached_property
    def _request_director(self):
        return self.build_request_director([FetchRH])

    def to_screen(self, message, *args, **kwargs):
        super().to_screen(message, *args, **kwargs)
        js.set_status(_describe(message))

def _stream_label(info):
    """Which part of the download this is, when yt-dlp is fetching video and audio separately"""
    video, audio = _may_have(info, 'vcodec'), _may_have(info, 'acodec')
    if video and not audio:
        return f'video stream ({info["height"]}p)' if info.get('height') else 'video stream'
    if audio and not video:
        return 'audio stream'
    return None

def progress_hook(d):
    run_sync(js.progress_hook(d | {'stream': _stream_label(d.get('info_dict') or {})}))



ydl_opts = {
    "paths": {"home": OPFS_PREFIX},
    "progress_with_newline": True,
    "hls_prefer_native": True,
    "external_downloader": {'dash': 'native', 'm3u8': 'native'},
    "postprocessors": [],
    "_no_ytdl_file": True,
    # a video opened from a playlist (e.g. YouTube's watch?v=...&list=...) is the video, not the playlist
    "noplaylist": True,
    "cookiefile": "/cookies.txt", # the page's cookies, written by the worker before each call below
    "extractor_args": {"youtube": {"player_client": ["visionos"]}}, # see the visionos notes above
    "progress_hooks": [progress_hook]
}

# This file is only run once per session; the functions below are called by the worker

def list_formats():
    """Extract the current page and return its formats as JSON for the UI. A playlist page has no
    formats of its own, so its entries are only listed, not extracted, and just their count is returned"""
    import json
    with BrowserYDL(ydl_opts | {"extract_flat": "in_playlist"}) as ydl:
        info = ydl.extract_info(run_sync(js.cur_url()), download=False, process=True)
    if info.get("_type") == "playlist":
        count = info.get("playlist_count") or len(info.get("entries") or [])
        return json.dumps({"formats": [], "playlist": {"title": info.get("title"), "count": count}})
    formats = []
    for fmt in info.get("formats") or []:
        formats.append({
            "id": fmt.get("format_id"),
            "ext": fmt.get("ext"),
            "vcodec": fmt.get("vcodec"),
            "acodec": fmt.get("acodec"),
            "height": fmt.get("height"),
            "fps": fmt.get("fps"),
            "abr": fmt.get("abr"),
            "tbr": fmt.get("tbr"),
            "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
            "note": fmt.get("format_note"),
        })
    return json.dumps({"formats": formats, "playlist": None})

def download(fmt=None, output=None, only=None):
    """Download the current page. `fmt` is a yt-dlp format selector; empty means yt-dlp's default.
    `output` is the container extension to end up with; empty keeps whatever yt-dlp picks.
    `only` is "audio" or "video" to drop the other track if the downloaded format has both"""
    # the worker deletes the store dir after each download, so get a fresh handle
    dir_store._dir = OPFSStore.open(STORE_DIR)._dir
    opts = dict(ydl_opts)
    if fmt:
        opts["format"] = fmt
    audio_codec = next((k for k, (ext, _) in AUDIO_TARGETS.items() if ext == output), None)
    if output and not audio_codec:
        opts["merge_output_format"] = output
    ydl = BrowserYDL(opts)
    # added directly: yt-dlp's postprocessor registry still maps the FFmpeg keys to the FFmpeg classes
    if only == "audio" and not audio_codec:  # converting to an audio format drops the video anyway
        ydl.add_post_processor(MediabunnyAudioOnlyPP(ydl), when="post_process")
    elif only == "video":
        # straight into `output`, so the remuxer below finds nothing left to do
        ydl.add_post_processor(MediabunnyVideoOnlyPP(ydl, preferedformat=output), when="post_process")
    if audio_codec:
        ydl.add_post_processor(MediabunnyExtractAudioPP(ydl, preferredcodec=audio_codec), when="post_process")
    elif output:
        # merges already land in `output`; this covers single-file downloads
        ydl.add_post_processor(MediabunnyVideoRemuxerPP(ydl, preferedformat=output), when="post_process")
    try:
        ydl.download([run_sync(js.cur_url())])
    finally:
        # a file left open (say the download failed halfway) keeps its lock, and the worker then
        # can't clear the directory before the next download, so its leftovers would get saved too
        dir_store.close_all()
