importScripts("/rpc.js")
importScripts(
    "/libs/vendor.js",
    "/libs/mediabunny/mediabunny.js",
    "/libs/mediabunny/mediabunny-aac-encoder.js",
    "/libs/mediabunny/mediabunny-flac-encoder.js",
    "/libs/mediabunny/mediabunny-mp3-encoder.js",
    "/core/worker/mediabunny-merge.js"
)
const worker = createNode("worker");
worker.connect("iframe", workerLink(self));
worker.route("sw", "iframe");
worker.route("sandbox", "iframe");
worker.route("potoken", "iframe")
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
    return await worker.call("potoken", "potoken", {content_binding: c_bind, mint_cold_start_token, mint_error_token})
}
async function python_fetch(request, proxy) {
    if (proxy) {
        await worker.waitForLink("content");
        return await worker.call("content", "proxyfetch", request);
    } else {
        let { method, url, body, headers, credentials } = request;
        const response = await fetch(url, {
        method: method,
        headers: headers,
        body: body === null ? undefined : body,
        credentials: credentials
        })
        return {stream: response.body, status: response.status, headers: [...response.headers.entries()]}
    }
}
async function cur_url() {
    return await worker.call("content", "cur_url", {});
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

// e.g. "Merging video and audio into .mp4, re-encoding audio from opus to aac"
function muxLabel(label, reencoding) {
    if (!reencoding.length) return label;
    const tracks = reencoding.map(({ type, from, to }) => to ? `${type} from ${from} to ${to}` : `${type} from ${from}`);
    return `${label}, re-encoding ${tracks.join(' and ')}`;
}

const merger = createMerger('_yt_dlp_OPFS_store', {
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
    await worker.waitForLink("content");
    set_status("Reading this site's cookies…");
    const cookies = await worker.call("content", "cookies", {});
    set_status("Starting Python (Pyodide) and loading yt-dlp…");
    importScripts(
        "/libs/pyodide/pyodide.js"
    )
    pyodide = await loadPyodide({
        indexURL: "/libs/pyodide",
        stdLibURL: "/libs/pyodide/python_stdlib.zip",
        packages: VENDOR.wheels // from requirements.txt, see scripts/vendor.mjs
    })

    await pyodide.FS.writeFile("/cookies.txt", cookies);
    pyodide.registerJsModule('mb_bridge', merger);
}

// dl.py registers handlers with yt-dlp, which can only happen once, so only run it once
let setupPromise;
function setupPython() {
    if (!setupPromise) {
        setupPromise = (async () => {
            set_status("Initializing yt-dlp…");
            await pyodide.runPythonAsync(await (await fetch("/core/worker/dl.py")).text())
        })();
        setupPromise.catch(() => { setupPromise = undefined; });
    }
    return setupPromise;
}

async function listFormats() {
    await setupPython();
    set_status("Extracting video info from this page…");
    return JSON.parse(await pyodide.runPythonAsync("list_formats()"));
}

async function runDownload(format, output) {
    await setupPython();
    const root = await navigator.storage.getDirectory();
    // Clear out the previous download's files here rather than right after handing them
    // off: the browser reads the blob lazily, so deleting the OPFS file too early can
    // cut the saved file short. dl.py's download() recreates the directory.
    await root.removeEntry('_yt_dlp_OPFS_store', { recursive: true }).catch(() => {});
    pyodide.globals.set("_web_format", format || "");
    pyodide.globals.set("_web_output", output || "");
    set_status("Extracting video info from this page…");
    await pyodide.runPythonAsync("download(_web_format, _web_output)");
    const store = await root.getDirectoryHandle("_yt_dlp_OPFS_store");
    const saved = [];
    for await (const [name, handle] of store.entries()) {
        if (handle.kind !== 'file') continue;
        set_status(`Saving ${name}…`);
        const file = await handle.getFile();
        await worker.call('iframe', 'dl', {file: file, name:name});
        saved.push(name);
    }
    return saved;
}

worker.handle("formats", async () => {
    return await listFormats();
});

worker.handle("start", async ({ format, output } = {}) => {
    return await runDownload(format, output);
});

async function main() {
    await prepare();
    set_status("Checking which output formats this browser can encode…");
    worker.notify('iframe', 'ready', { outputs: await outputFormats() });
}
main();
