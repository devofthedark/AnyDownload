import functools, io, os, sys
from types import NoneType
import yt_dlp, js
from pyodide.ffi import to_js, run_sync
from collections.abc import Iterable

def _opts(**kw):
    return to_js(kw, dict_converter=js.Object.fromEntries)

def _has(fmt, key) -> bool:
    codec = fmt.get(key)
    return codec is not None and codec != 'none'

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
        try:
            run_sync(self._reader.cancel())
        except Exception:
            pass
        self.closed = True


from yt_dlp.networking.common import RequestHandler, Response, Request, register_rh

@register_rh
class FetchRH(RequestHandler):
    """Use the `fetch` api instad of some library"""
    RN_NAME = "nativeFetch"
    _SUPPORTED_URL_SCHEMES = ('http', 'https')
    _SUPPORTED_PROXY_SCHEMES = None
    _SUPPORTED_ENCODINGS = ('gzip', 'br')

    def _send(self, request: Request):
        """We use the browser's cookie jar instead of yt-dlp's. I might regret this"""
        new_headers = {}
        proxy = False
        w_credentials = False
        NO_SET_HEADERS = ["accept-encoding", "cookie", "cookie2", "origin", "referer", "sec-fetch-mode", "user-agent"]
        COOKIE_INDICATOR_HEADERS = ["cookie", "cookie2"]
        PROXY_INDICATOR_HEADERS = ["origin"]
        for k, v in request.headers.items():
            if k.lower() not in NO_SET_HEADERS:
                new_headers[k] = v
            if k.lower() in COOKIE_INDICATOR_HEADERS:
                w_credentials = True
            if k.lower() in PROXY_INDICATOR_HEADERS:
                proxy = True
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
            "credentials": "include" if w_credentials else "omit"
        }
        js.console.debug("Sending HTTP request:", js_compat_request, "proxy", proxy)


        response = run_sync(js.python_fetch(to_js(js_compat_request, dict_converter=js.Object.fromEntries), proxy))
        r_headers = {}
        for k, v in response.headers:
            r_headers[k] = v
        return Response(
            fp = FetchStream(response.stream.getReader()),
            url = request.url,
            headers = r_headers,
            status = response.status
        )

# JS Challenge

from yt_dlp.extractor.youtube.jsc.provider import register_provider, register_preference
from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP

@register_provider
class NativeJSEngineJCP(EJSBaseJCP):
    JS_RUNTIME_NAME = "yt-dlp-web-sandbox-runner"
    PROVIDER_VERSION = "0.0.1"
    BUG_REPORT_LOCATION = "https://github.com/devofthedark/yt-dlp-web/issues?q="
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
    BUG_REPORT_LOCATION = "https://github.com/devofthedark/yt-dlp-web/"

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

# Patch file writes over OPFS to avoid wasm 4GB memory limit

class OPFSFile(io.RawIOBase):
    """
    File-like access for OPFS files

    @param store: The owner of this file. Essentially just a representation the parent directory
    @param name: file name
    @param mode: open mode
    """
    def __init__(self, store: OPFSStore, name, mode):
        self._store = store
        self._handle = store._sync_handle(name)
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
        return "w" in self.mode or "a" in self.mode or "+" in self.mode
    def readable(self) -> bool:
        js.console.debug(f'[OPFS translation layer] OPFSFile(name="{self.name}").readable()')
        return "r" in self.mode or "+" in self.mode
    def seekable(self) -> bool:
        True

    def write(self, b: bytearray | str) -> int:
        js.console.debug(f'[OPFS translation layer] OPFSFile(name="{self.name}").write([len {len(b)}])')
        if self._strmode:
            b = bytearray(b, "utf-8")
        n = len(b)
        if not n:
            return 0
        view = self._view(n)
        view.assign(b)
        written = self._handle.write(view, _opts(at=self._pos))
        if written != n:
            raise OSError(f"Small write to {self.name}: {written}/{n}")
        self._pos += written
        return written

    def readinto(self, buf: bytearray) -> int:
        n = len(buf)
        view = self._view(n)
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
            self._store._forget(self.name)

class OPFSStore:
    """Owner of an OPFS dir"""

    def __init__(self, dir_handle):
        self._dir = dir_handle
        self._live: dict[str, io.BufferedRandom | io.BufferedReader | io.BufferedWriter | io.TextIOWrapper] = {}
        self._live_raw = {}

    @classmethod
    def open(cls, subdir=None):
        js.console.debug(f'[OPFS translation layer] OPFSStore.open({subdir})')
        root = run_sync(js.navigator.storage.getDirectory())
        if subdir:
            root = run_sync(root.getDirectoryHandle(subdir, _opts(create=True)))
        return cls(root)

    @staticmethod
    def _key(path):
        return os.path.basename(path)

    def _file_handle(self, name, create=True):
        return run_sync(self._dir.getFileHandle(name, _opts(create=create)))

    def _sync_handle(self, name):
        return run_sync(self._file_handle(name).createSyncAccessHandle())

    def _forget(self, name):
        self._live.pop(name)
        self._live_raw.pop(name)

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
        existing = self._live.get(name)
        if existing and not existing.closed:
            return existing
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
        return run_sync(self._file_handle(name, create=False).getFile()).size

    def exists(self, path):
        name = self._key(path)
        if name in self._live:
            return True
        try:
            self._file_handle(name, create=False)
            return True
        except Exception:
            return False

    def rename(self, src, dst):
        # Chrome and Firefox both support this, at least for moving single files
        # not sure why theres nothing on MDN documenting any of this
        # https://caniuse.com/mdn-api_filesystemhandle_move
        # keep a lookout for any changes

        self._file_handle(self._key(src), create=False).move(self._key(dst))

    def remove(self, path):
        run_sync(self._dir.removeEntry(self._key(path)))


OPFS_PREFIX = "/OPFS"
import yt_dlp.utils as ytu
orig = ytu.sanitize_open
dir_store = OPFSStore.open("_yt_dlp_OPFS_store")

def sanitize_open(filename, open_mode):
    print(f"[OPFS translation layer] sanitize_open(\"{filename}\", \"{open_mode}\")")
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

_getsize = os.path.getsize
def size(p):
    p = str(p)
    return dir_store.size(p) if p.startswith(OPFS_PREFIX) else _getsize(p)
os.path.getsize = size

_exists = os.path.exists
def exists(p):
    p = str(p)
    return dir_store.exists(p) if p.startswith(OPFS_PREFIX) else _exists(p)
os.path.exists = exists

_replace = os.replace
def replace(src, dist, *args, **kwargs):
    src, dist = str(src), str(dist)
    return dir_store.rename(src, dist) if src.startswith(OPFS_PREFIX) else _replace(src, dist, *args, **kwargs)
os.replace = replace

_rename = os.rename
def rename(src, dist, *args, **kwargs):
    src, dist = str(src), str(dist)
    return dir_store.rename(src, dist) if src.startswith(OPFS_PREFIX) else _rename(src, dist, *args, **kwargs)
os.rename = rename

_remove = os.remove
def remove(p, *args, **kwargs):
    p = str(p)
    return dir_store.remove(p) if p.startswith(OPFS_PREFIX) else _remove(p, *args, **kwargs)
os.remove = remove

_unlink = os.unlink
def unlink(p, *args, **kwargs):
    p = str(p)
    return dir_store.remove(p) if p.startswith(OPFS_PREFIX) else _unlink(p, *args, **kwargs)
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

    def _mux(self, info, sources, out_path, container, tags=None):
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
            'jobId': store._key(out_path)
        }
        if tags:
            payload['tags'] = _opts(**tags)

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
                'video': _has(fmt, "vcodec"),
                'audio': _has(fmt, "acodec")
            })
        target = info['filepath']
        self.to_screen(f'merging formats into "{target}"')
        self._mux(info, sources, target, info['ext'], self._maybe_tags(info))
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
        self._mux(info, [source], target, ext, self._maybe_tags(info))

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
            if self.bridge.supports(candidate):
                wanted = candidate
                break
        if wanted is None:
            raise PostProcessingError(f"Mediabunny cannot write any of: {"/".join(self._formats)}")

        target = f'{path.rsplit(".", 1)[0]}.{wanted}'
        source = {'name': self.store._key(path), 'video': True, 'audio': True}

        self.to_screen(f'Remuxing video into {wanted}')
        self._mux(info, [source], target, wanted, self._maybe_tags(info))

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
        self._mux(info, [source], temp, info['ext'], _tags_for(info))
 
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
        self._mux(info, [source], temp, info['ext'], self._maybe_tags(info))
 
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

class BrowserYDL(yt_dlp.YoutubeDL):
    @functools.cached_property
    def _request_director(self):
        return self.build_request_director([FetchRH])

def progress_hook(d):
    run_sync(js.progress_hook(d))



ydl_opts = {
    "verbose": True,
    "paths": {"home": OPFS_PREFIX},
    "progress_with_newline": True,
    "hls_prefer_native": True,
    "external_downloader": {'dash': 'native', 'm3u8': 'native'},
    "postprocessors": [],
    "_no_ytdl_file": True,
    "progress_hooks": [progress_hook]
}

# This file is only run once per session; the functions below are called by the worker

def list_formats():
    """Extract the current page and return its formats as JSON for the UI"""
    import json
    with BrowserYDL(ydl_opts) as ydl:
        info = ydl.extract_info(run_sync(js.cur_url()), download=False, process=True)
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
    return json.dumps(formats)

def download(fmt=None):
    """Download the current page. `fmt` is a yt-dlp format selector; empty means yt-dlp's default"""
    # the worker deletes the store dir after each download, so get a fresh handle
    dir_store._dir = OPFSStore.open("_yt_dlp_OPFS_store")._dir
    opts = dict(ydl_opts)
    if fmt:
        opts["format"] = fmt
    ydl = BrowserYDL(opts)
    info = ydl.download([run_sync(js.cur_url())])
    print(info)
