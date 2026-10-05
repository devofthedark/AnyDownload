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

// The formats/start call being run, if any, as an AbortController. The panel's Cancel aborts it:
// whatever Python is waiting on gives up at once, and dl.py stops with DownloadCancelled as soon as it
// next asks cancelled().
let job = null;

// python calls these two
function cancelled() {
    return !!job?.signal.aborted;
}
// The next chunk from `reader`, unless the job is cancelled first: a response that has stalled would
// otherwise keep a cancel waiting forever. Python passes the reader rather than the promise from its
// read(), as passing a promise in and awaiting the one this returns crashes Pyodide.
function read_chunk(reader) {
    return until_cancelled(reader.read());
}

// `promise`, unless the job is cancelled first
function until_cancelled(promise) {
    const signal = job?.signal;
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
    });
}

// Runs `fn` as the job. However it ends, if Cancel was clicked meanwhile it throws an AbortError,
// which tells the panel it was cancelled rather than failed.
async function runJob(fn) {
    const controller = job = new AbortController();
    try {
        return await fn();
    } catch (e) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw e;
    } finally {
        job = null;
        // a failed download can leave requests hanging too
        abortPageFetches();
    }
}

// Ends the requests the content script sent for the job, which cancelling their bodies here doesn't:
// left open, one would keep its connection busy, and the browser would hold back the next request
// for the same URL until it timed out (see openFetches in content.js).
function abortPageFetches() {
    try {
        worker.notify("content", "abortFetches", {});
    } catch (e) {
        console.warn("couldn't end the page's requests", e);
    }
}

// thin wrappers around RPC calls to give to python
async function jsc(code) {
    set_status("Solving YouTube's JavaScript challenge in the sandbox…");
    return await worker.call("sandbox", "jsc", { code: code }, { signal: job?.signal });
}
async function mint_potoken(content_binding, mint_cold_start_token, mint_error_token) {
    set_status("Getting a PO token from the page's YouTube player…");
    const c_bind = [];
    c_bind.push(content_binding[0] === undefined ? null : content_binding[0])
    c_bind.push(content_binding[1] === undefined ? null : content_binding[1])
    return await worker.call("content", "potoken", {content_binding: c_bind, mint_cold_start_token, mint_error_token}, { signal: job?.signal })
}
// Only requests to the page's own origin can carry the site's cookies: sent from the content
// script they're first-party. This worker sits inside the extension's frame, so the browser never
// sends it any, and the page's cross-site requests are third-party, which get blocked.
// `proxy` asks for the page's Origin/Referer, which also means sending it from the content script.
// `request.anonymous` requests never get cookies.
async function send(request, proxy, signal) {
    const sameOrigin = new URL(request.url).origin === pageOrigin;
    if (sameOrigin || proxy) {
        await worker.waitForLink("content");
        const credentials = sameOrigin && !request.anonymous ? "include" : "omit";
        try {
            return await worker.call("content", "proxyfetch", { ...request, credentials }, { signal });
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
        credentials: "omit",
        signal
    });
    return { stream: response.body, status: response.status, url: response.url, headers: [...response.headers.entries()] };
}

// Sends `request` (see send() above) and hands Python a reader for the body. Cancelling aborts the
// request, and the response too once there is one: left open, it would keep its connection busy, and
// the browser would hold back the next request for the same URL until it timed out.
async function python_fetch(request, proxy) {
    const signal = job?.signal;
    const { stream, ...response } = await send(request, proxy, signal);
    const reader = stream?.getReader();
    if (reader && signal) {
        const release = () => reader.cancel(signal.reason).catch(() => {});
        if (signal.aborted) release();
        else signal.addEventListener('abort', release, { once: true });
    }
    return { reader, ...response };
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
    // a mux that's under way stops when Cancel is clicked
    getSignal: () => job?.signal,
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

// Pyodide doesn't need the page, so it loads alongside the handshake with it rather than after
async function loadPython() {
    importScripts(
        "/libs/pyodide/pyodide.js"
    )
    pyodide = await loadPyodide({
        indexURL: "/libs/pyodide",
        stdLibURL: VENDOR.stdlib, // see scripts/vendor.mjs
        packages: VENDOR.wheels // from requirements.txt, see scripts/vendor.mjs
    })

    pyodide.registerJsModule('mb_bridge', merger);
}

async function connectToPage() {
    // the panel hands the channel over as soon as it loads (see iframe.js), so this only times out if
    // that handshake failed
    await worker.waitForLink("content", { timeout: 30_000 }).catch(() => {
        throw new Error("couldn't connect to the page");
    });
}

// dl.py registers handlers with yt-dlp, which can only happen once, so it runs once, on startup
async function setupPython() {
    set_status("Initializing yt-dlp…");
    await storeLocked; // dl.py creates the directory
    pyodide.globals.set("STORE_DIR", STORE_DIR);
    await pyodide.runPythonAsync(await (await fetch("/core/worker/dl.py")).text())
}

// Runs one of dl.py's entry points, which say how it went in JSON (see run_for_worker there)
async function runPython(code) {
    const { value, error } = JSON.parse(await pyodide.runPythonAsync(code));
    // cancelled, or finished just as Cancel was clicked: either way it doesn't count
    job?.signal.throwIfAborted();
    if (error) throw new Error(error);
    return value;
}

async function listFormats() {
    await readPage();
    set_status("Extracting video info from this page…");
    return await runPython("run_for_worker('list_formats')");
}

async function runDownload(format, output, only) {
    await readPage();
    const { root, inMemory } = await storage;
    // Clear out the previous download's files here rather than right after handing them
    // off: the browser reads the blob lazily, so deleting the OPFS file too early can
    // cut the saved file short. dl.py's download() recreates the directory.
    await root.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
    let handedOff = false;
    try {
        pyodide.globals.set("_web_format", format || "");
        pyodide.globals.set("_web_output", output || "");
        pyodide.globals.set("_web_only", only || "");
        set_status("Extracting video info from this page…");
        await runPython("run_for_worker('download', _web_format, _web_output, _web_only)");
        handedOff = true;
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
        // Only files handed to the panel have to stay, as OPFS ones are read lazily (see above). In
        // memory the panel's files hold their own data, and a failed or cancelled download leaves
        // nothing anyone will read, so free those now rather than at the next download.
        if (inMemory || !handedOff) await root.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
    }
}

worker.handle("formats", async () => {
    return await runJob(listFormats);
});

worker.handle("start", async ({ format, output, only } = {}) => {
    return await runJob(() => runDownload(format, output, only));
});

// the panel's Cancel button
worker.handle("cancel", async () => {
    if (!job) return;
    job.abort(new DOMException("Cancelled", "AbortError"));
    abortPageFetches();
});

async function main() {
    // probing what Mediabunny can encode needs neither Python nor the page
    const outputs = outputFormats();
    set_status("Starting Python (Pyodide) and loading yt-dlp…");
    await Promise.all([loadPython(), connectToPage()]);
    // the panel only says it's ready once a download can start straight away
    await setupPython();
    worker.notify('iframe', 'ready', { outputs: await outputs, inMemory: (await storage).inMemory });
}
// without this the panel would wait for "ready" forever
main().catch((e) => {
    console.error('the worker failed to start', e);
    worker.notify('iframe', 'failed', { message: String(e?.message ?? e) });
});
