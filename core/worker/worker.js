importScripts("/rpc.js")
importScripts(
    "/libs/vendor.js",
    "/libs/mediabunny/mediabunny.js",
    "/libs/mediabunny/mediabunny-aac-encoder.js",
    "/libs/mediabunny/mediabunny-flac-encoder.js",
    "/libs/mediabunny/mediabunny-mp3-encoder.js",
    "/core/worker/memory-fs.js",
    "/core/worker/mediabunny-merge.js"
)
const worker = createNode("worker");
worker.connect("iframe", workerLink(self));
worker.route("sw", "iframe");
worker.route("sandbox", "iframe");
ORIGIN = self.origin
const NS = 'ytx';
self.addEventListener('message', function bridgeHandshake(e) {
  if (e.data?.[NS] !== 'bridge') return;
  const port = e.ports[0];
  worker.connect('content', messagePortLink(port));
});
// shows `text` in the panel's status line; python calls this too
function set_status(text) {
    worker.notify("iframe", "status", { text });
}

// thin wrappers around RPC calls to give to python
async function jsc(code) {
    set_status("Solving YouTube's JavaScript challenge in the sandbox…");
    return await worker.call("sandbox", "jsc", { code: code });
}
async function mint_potoken(content_binding, mint_cold_start_token, mint_error_token) {
    set_status("Getting a PO token from the page's YouTube player…");
    const c_bind = [];
    c_bind.push(content_binding[0] === undefined ? null : content_binding[0])
    c_bind.push(content_binding[1] === undefined ? null : content_binding[1])
    return await worker.call("content", "potoken", {content_binding: c_bind, mint_cold_start_token, mint_error_token})
}
// Only requests to the page's own origin can carry the site's cookies: sent from the content
// script they're first-party. This worker sits inside the extension's frame, so the browser never
// sends it any, and the page's cross-site requests are third-party, which get blocked.
// `proxy` asks for the page's Origin/Referer, which also means sending it from the content script.
// `request.anonymous` requests never get cookies.
async function python_fetch(request, proxy) {
    const sameOrigin = new URL(request.url).origin === pageOrigin;
    if (sameOrigin || proxy) {
        await worker.waitForLink("content");
        const credentials = sameOrigin && !request.anonymous ? "include" : "omit";
        try {
            return await worker.call("content", "proxyfetch", { ...request, credentials });
        } catch (e) {
            // fetch's network/CORS failure, e.g. a redirect to another origin; send it from here instead
            if (e.name !== "TypeError") throw e;
            console.debug(`page fetch of ${request.url} failed (${e.message}), retrying from the worker`);
        }
    }
    const { method, url, body, headers } = request;
    const response = await fetch(url, {
        method: method,
        headers: headers,
        body: body === null ? undefined : body,
        credentials: "omit"
    });
    return { stream: response.body, status: response.status, url: response.url, headers: [...response.headers.entries()] };
}

// The page the panel is open on and its cookies, re-read before every operation: the page can
// navigate without a reload (e.g. YouTube), and the user can sign in after opening the panel.
let pageUrl, pageOrigin;
async function readPage() {
    pageUrl = await worker.call("content", "cur_url", {});
    pageOrigin = new URL(pageUrl).origin;
    set_status("Reading this site's cookies…");
    // yt-dlp loads this (the cookiefile option) to see what the browser sends, e.g. that you're signed in
    pyodide.FS.writeFile("/cookies.txt", await worker.call("content", "cookies", {}));
}
async function cur_url() {
    return pageUrl;
}
async function progress_hook(d) {
    // `d` is a PyProxy (PyDict) borrowed for the duration of this call — pull out
    // plain values now (auto-converted at the get() boundary) rather than trying
    // to structured-clone the proxy itself, which postMessage can't carry.
    worker.notify("iframe", "dl_progress", {
        status: d.get("status"),
        filename: d.get("filename"),
        stream: d.get("stream"),
        downloaded_bytes: d.get("downloaded_bytes"),
        total_bytes: d.get("total_bytes"),
        total_bytes_estimate: d.get("total_bytes_estimate"),
        speed: d.get("speed"),
        eta: d.get("eta"),
        elapsed: d.get("elapsed"),
        fragment_index: d.get("fragment_index"),
        fragment_count: d.get("fragment_count"),
    });
}



let pyodide;

// Downloads are stored in the Origin Private File System, except where the browser has none: Firefox's
// private windows throw a SecurityError there, so those keep them in memory instead (see memory-fs.js).
const storage = (async () => {
    try {
        const root = await navigator.storage.getDirectory();
        // dl.py writes through these
        if (!('createSyncAccessHandle' in FileSystemFileHandle.prototype)) throw new Error('no sync access handles');
        return { root, inMemory: false };
    } catch (e) {
        console.warn('OPFS is unavailable, keeping downloads in memory instead', e);
        return { root: createMemoryRoot(), inMemory: true };
    }
})();

// the directory downloads are stored under; python calls this too
async function storage_root() {
    return (await storage).root;
}

// Each panel downloads into its own OPFS directory, so panels open in different tabs can't delete
// or save each other's files. A panel holds a Web Lock named after its directory for as long as it's
// open (the lock goes when the worker does), which tells a closed panel's leftovers from a live one's.
const STORE_PREFIX = '_yt_dlp_OPFS_store';
const STORE_DIR = `${STORE_PREFIX}_${crypto.randomUUID()}`;

// Taken before anything creates the directory, so no other panel's cleanup can see it unlocked
const storeLocked = new Promise((granted) => {
    navigator.locks.request(STORE_DIR, () => {
        granted();
        return new Promise(() => {}); // never settles: hold the lock until this worker ends
    });
});

// Delete the directories of panels that have since closed (and the one all panels used to share)
async function removeStaleStores() {
    const held = new Set((await navigator.locks.query()).held.map((lock) => lock.name));
    const root = await storage_root();
    const stale = [];
    for await (const [name, handle] of root.entries()) {
        if (handle.kind === 'directory' && name.startsWith(STORE_PREFIX) && !held.has(name)) stale.push(name);
    }
    for (const name of stale) {
        await root.removeEntry(name, { recursive: true }).catch((e) => console.warn(`could not remove ${name}`, e));
    }
}
storeLocked.then(removeStaleStores).catch((e) => console.warn('could not clean up old downloads', e));

// e.g. "Merging video and audio into .mp4, re-encoding audio from opus to aac"
function muxLabel(label, reencoding) {
    if (!reencoding.length) return label;
    const tracks = reencoding.map(({ type, from, to }) => to ? `${type} from ${from} to ${to}` : `${type} from ${from}`);
    return `${label}, re-encoding ${tracks.join(' and ')}`;
}

const merger = createMerger(STORE_DIR, {
    getRoot: storage_root,
    onProgress: ({ jobId, label, reencoding, progress }) =>
        worker.notify('iframe', 'muxProgress', { jobId, label: muxLabel(label || 'Merging', reencoding), progress }),
});

// Containers the UI can offer. Audio ones need their codec to be encodable, since dl.py
// converts into it (mirrors AUDIO_TARGETS there: extension -> Mediabunny codec).
const VIDEO_OUTPUTS = ['mp4', 'mkv', 'webm', 'mov'];
const AUDIO_OUTPUTS = { m4a: 'aac', mp3: 'mp3', opus: 'opus', ogg: 'vorbis', flac: 'flac', wav: 'pcm-s16', aac: 'aac' };

async function outputFormats() {
    try {
        const { containers, audioCodecs } = await merger.capabilities();
        return {
            video: VIDEO_OUTPUTS.filter((ext) => containers.includes(ext)),
            audio: Object.keys(AUDIO_OUTPUTS).filter(
                (ext) => containers.includes(ext) && audioCodecs.includes(AUDIO_OUTPUTS[ext])
            ),
        };
    } catch (e) {
        console.warn('could not probe output formats', e);
        return { video: [], audio: [] };
    }
}

async function prepare() {
    set_status("Connecting to the page…");
    // the panel hands the channel over as soon as it loads (see iframe.js), so this only times out if
    // that handshake failed
    await worker.waitForLink("content", { timeout: 30_000 }).catch(() => {
        throw new Error("couldn't connect to the page");
    });
    set_status("Starting Python (Pyodide) and loading yt-dlp…");
    importScripts(
        "/libs/pyodide/pyodide.js"
    )
    pyodide = await loadPyodide({
        indexURL: "/libs/pyodide",
        stdLibURL: "/libs/pyodide/python_stdlib.zip",
        packages: VENDOR.wheels // from requirements.txt, see scripts/vendor.mjs
    })

    pyodide.registerJsModule('mb_bridge', merger);
}

// dl.py registers handlers with yt-dlp, which can only happen once, so only run it once
let setupPromise;
function setupPython() {
    if (!setupPromise) {
        setupPromise = (async () => {
            set_status("Initializing yt-dlp…");
            await storeLocked; // dl.py creates the directory
            pyodide.globals.set("STORE_DIR", STORE_DIR);
            await pyodide.runPythonAsync(await (await fetch("/core/worker/dl.py")).text())
        })();
        setupPromise.catch(() => { setupPromise = undefined; });
    }
    return setupPromise;
}

async function listFormats() {
    await setupPython();
    await readPage();
    set_status("Extracting video info from this page…");
    return JSON.parse(await pyodide.runPythonAsync("list_formats()"));
}

async function runDownload(format, output, only) {
    await setupPython();
    await readPage();
    const { root, inMemory } = await storage;
    // Clear out the previous download's files here rather than right after handing them
    // off: the browser reads the blob lazily, so deleting the OPFS file too early can
    // cut the saved file short. dl.py's download() recreates the directory.
    await root.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
    try {
        pyodide.globals.set("_web_format", format || "");
        pyodide.globals.set("_web_output", output || "");
        pyodide.globals.set("_web_only", only || "");
        set_status("Extracting video info from this page…");
        await pyodide.runPythonAsync("download(_web_format, _web_output, _web_only)");
        const store = await root.getDirectoryHandle(STORE_DIR);
        const saved = [];
        for await (const [name, handle] of store.entries()) {
            if (handle.kind !== 'file') continue;
            set_status(`Saving ${name}…`);
            const file = await handle.getFile();
            await worker.call('iframe', 'dl', {file: file, name:name});
            saved.push(name);
        }
        return saved;
    } finally {
        // In memory nothing is read lazily: the files the panel was handed hold their own data. So
        // free it now rather than keeping the last download in memory until the next one.
        if (inMemory) await root.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
    }
}

worker.handle("formats", async () => {
    return await listFormats();
});

worker.handle("start", async ({ format, output, only } = {}) => {
    return await runDownload(format, output, only);
});

async function main() {
    await prepare();
    set_status("Checking which output formats this browser can encode…");
    worker.notify('iframe', 'ready', { outputs: await outputFormats(), inMemory: (await storage).inMemory });
}
// without this the panel would wait for "ready" forever
main().catch((e) => {
    console.error('the worker failed to start', e);
    worker.notify('iframe', 'failed', { message: String(e?.message ?? e) });
});
