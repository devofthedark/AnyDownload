const ORIGIN = chrome.runtime.getURL('').slice(0, -1);
const iframeNode = createNode('iframe');

const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start');
const progressWrap = document.getElementById('progress-wrap');
const progressEl = document.getElementById('progress');
const filesEl = document.getElementById('files');
const closeBtn = document.getElementById('close');
const videoSel = document.getElementById('video-format');
const audioSel = document.getElementById('audio-format');
const loadFormatsBtn = document.getElementById('load-formats');
const outputSel = document.getElementById('output-format');
const outputWarning = document.getElementById('output-warning');
const memoryNote = document.getElementById('memory-note');
document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
const NS = 'ytx';
iframeNode.handle("dl", async (params, {signal}) => {
    console.debug("dl file");
    const {name, file} = params;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    
    const li = document.createElement('li');
    li.textContent = `Saved: ${name}`;
    filesEl.appendChild(li);
    // revoking straight after click() can cancel the download before it starts reading
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

iframeNode.handle("status", async ({ text }) => {
    statusEl.textContent = text;
});

iframeNode.handle("muxProgress", async (params, {signal}) => {
    progressWrap.classList.add('active');
    progressEl.value = params.progress;
    statusEl.textContent = `${params.label ?? 'Merging'}… ${Math.round(params.progress * 100)}%`;
});

function formatBytes(n) {
    if (n == null || !isFinite(n)) return null;
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatEta(s) {
    if (s == null || !isFinite(s)) return null;
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

iframeNode.handle("dl_progress", async (params, {signal}) => {
    const { status, filename, stream, downloaded_bytes, total_bytes, total_bytes_estimate, speed, eta,
        fragment_index, fragment_count } = params;
    const total = total_bytes ?? total_bytes_estimate;
    // "video stream (1080p)" / "audio stream" when they're fetched separately, else the file name
    const name = stream ?? (filename ? filename.split('/').pop() : '');

    if (status === 'downloading') {
        progressWrap.classList.add('active');
        if (total) {
            progressEl.value = downloaded_bytes / total;
        } else {
            progressEl.removeAttribute('value');
        }

        const parts = [];
        if (total) parts.push(`${Math.round((downloaded_bytes / total) * 100)}%`);
        else if (downloaded_bytes != null) parts.push(formatBytes(downloaded_bytes));
        if (fragment_count) parts.push(`fragment ${fragment_index ?? 0}/${fragment_count}`);
        const speedStr = formatBytes(speed);
        if (speedStr) parts.push(`${speedStr}/s`);
        const etaStr = formatEta(eta);
        if (etaStr) parts.push(`ETA ${etaStr}`);

        statusEl.textContent = `Downloading ${name} — ${parts.join(' • ')}`;
    } else if (status === 'finished') {
        progressEl.value = 1;
        statusEl.textContent = `Downloaded ${name}`;
    } else if (status === 'error') {
        statusEl.textContent = `Error downloading ${name}`;
    }
});

// containers the worker can write, split by whether the download has a video track
let outputFormats = { video: [], audio: [] };

function fillOutputs() {
    const prev = outputSel.value;
    const exts = videoSel.value === 'none' ? outputFormats.audio : outputFormats.video;
    while (outputSel.options.length > 1) outputSel.remove(1);
    for (const ext of exts) outputSel.add(new Option(`.${ext}`, ext));
    // falls back to "default" if the previous choice isn't offered for this mode
    outputSel.value = exts.includes(prev) ? prev : 'default';
    outputWarning.classList.toggle('active', outputSel.value !== 'default');
}
outputSel.addEventListener('change', () => {
    outputWarning.classList.toggle('active', outputSel.value !== 'default');
});
videoSel.addEventListener('change', fillOutputs);

iframeNode.handle("ready", async ({ outputs, inMemory } = {}) => {
    if (outputs) outputFormats = outputs;
    fillOutputs();
    // the worker has no OPFS here (e.g. a Firefox private window), see memory-fs.js
    memoryNote.classList.toggle('active', !!inMemory);
    startBtn.disabled = false;
    videoSel.disabled = false;
    audioSel.disabled = false;
    outputSel.disabled = false;
    loadFormatsBtn.disabled = false;
    statusEl.textContent = 'Ready to download';
});

const hasCodec = (c) => c != null && c !== 'none';
let formatsById = new Map();

function videoLabel(f) {
    const parts = [f.height ? `${f.height}p` : (f.note || f.id)];
    if (f.fps) parts.push(`${Math.round(f.fps)}fps`);
    parts.push(f.ext);
    if (hasCodec(f.vcodec)) parts.push(f.vcodec.split('.')[0]);
    if (hasCodec(f.acodec)) parts.push('+ audio');
    const size = formatBytes(f.filesize);
    if (size) parts.push(`~${size}`);
    return `${parts.join(' ')} [${f.id}]`;
}

function audioLabel(f) {
    const parts = [];
    const br = f.abr ?? f.tbr;
    if (br) parts.push(`${Math.round(br)}k`);
    parts.push(f.ext);
    if (hasCodec(f.acodec)) parts.push(f.acodec.split('.')[0]);
    if (f.note) parts.push(f.note);
    const size = formatBytes(f.filesize);
    if (size) parts.push(`~${size}`);
    return `${parts.join(' ')} [${f.id}]`;
}

function fillSelect(sel, formats, label) {
    // keep the "default" and "none" options, drop any previously loaded formats
    while (sel.options.length > 2) sel.remove(2);
    // yt-dlp sorts worst -> best
    for (const f of [...formats].reverse()) {
        sel.add(new Option(label(f), f.id));
    }
}

// Build a yt-dlp format selector from the dropdowns.
// undefined means "let yt-dlp decide", i.e. the original behaviour.
function formatSelector() {
    const v = videoSel.value, a = audioSel.value;
    if (v === 'default' && a === 'default') return undefined;
    // Sites that don't serve audio and video separately only have formats with both, so fall back
    // to those; the worker then drops the unwanted track (see onlyTrack)
    if (v === 'none') return a === 'default' ? 'ba/b' : a;
    if (a === 'none') return v === 'default' ? 'bv/b' : v;
    if (v === 'default') return `bv+${a}`;
    // a format that already carries audio doesn't need a second track merged in
    if (a === 'default') return hasCodec(formatsById.get(v)?.acodec) ? v : `${v}+ba`;
    return `${v}+${a}`;
}

// which track to keep when the other one was set to "None", or undefined for both
function onlyTrack() {
    if (videoSel.value === 'none') return 'audio';
    if (audioSel.value === 'none') return 'video';
    return undefined;
}

function updateStartEnabled() {
    startBtn.disabled = videoSel.value === 'none' && audioSel.value === 'none';
}
videoSel.addEventListener('change', updateStartEnabled);
audioSel.addEventListener('change', updateStartEnabled);

loadFormatsBtn.addEventListener('click', async () => {
    loadFormatsBtn.disabled = true;
    startBtn.disabled = true;
    statusEl.textContent = 'Loading formats…';
    try {
        const formats = await iframeNode.call('worker', 'formats', {}, { timeout: 0 });
        formatsById = new Map(formats.map((f) => [f.id, f]));
        fillSelect(videoSel, formats.filter((f) => f.vcodec !== 'none'), videoLabel);
        fillSelect(audioSel, formats.filter((f) => f.vcodec === 'none' && hasCodec(f.acodec)), audioLabel);
        loadFormatsBtn.textContent = `${formats.length} formats loaded`;
        statusEl.textContent = 'Ready to download';
    } catch (e) {
        statusEl.textContent = `Error loading formats: ${e.message}`;
        loadFormatsBtn.disabled = false;
    }
    updateStartEnabled();
});

let worker = new Worker("/core/worker/worker.js");
iframeNode.connect("worker", workerLink(worker));

// The content script sends us its end of a private channel (see content.js). The page is our parent
// window too and can post here as well, so only take a port whose token content stored for us.
window.addEventListener('message', async function bridgeHandshake(e) {
    if (e.source !== window.parent || e.data?.[NS] !== 'bridge' || !e.ports[0]) return;
    const key = `bridge:${e.data.token}`;
    const { [key]: valid } = await chrome.storage.local.get(key);
    if (!valid) return;
    window.removeEventListener('message', bridgeHandshake);
    await chrome.storage.local.remove(key);
    iframeNode.connect('content', messagePortLink(e.ports[0]));
    // give the worker and the content script a direct channel of their own
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ [NS]: 'bridge', to: 'content' }, [port1]);
    iframeNode.notify('content', 'bridge', { port: port2 }, { transfer: [port2] });
});
iframeNode.route("sw", "content");

// The page can reach the sandbox frame through window.frames and navigate it to a page of its own,
// so whatever loads there has to prove it's the sandbox: it answers with the secret from its URL,
// which no other document can read.
const sandboxSecret = crypto.getRandomValues(new Uint32Array(4)).join('-');
const sandbox_iframe = document.createElement("iframe");
sandbox_iframe.src = chrome.runtime.getURL(`/core/sandbox/sandbox.html#${sandboxSecret}`);
sandbox_iframe.sandbox = "allow-scripts";
sandbox_iframe.style.display = "none";
sandbox_iframe.addEventListener('load', () => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (e) => {
        port1.onmessage = null;
        if (e.data?.[NS] !== 'sandbox' || e.data.secret !== sandboxSecret) {
            port1.close();
            return;
        }
        iframeNode.connect("sandbox", messagePortLink(port1));
    };
    // the sandbox has an opaque origin, so it can't be addressed by one
    sandbox_iframe.contentWindow.postMessage({ [NS]: 'sandbox' }, '*', [port2]);
}, { once: true });
document.body.appendChild(sandbox_iframe);

closeBtn.addEventListener('click', () => {
    iframeNode.notify('content', 'close', {});
});

// Drag the panel by its header. The iframe can't move itself, so send the offset since
// the drag started to the content script. Screen coordinates stay put while the iframe
// moves under the cursor, unlike client coordinates.
const header = document.querySelector('header');
let dragStart = null;
header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#close')) return;
    dragStart = { x: e.screenX, y: e.screenY };
    header.setPointerCapture(e.pointerId);
    header.classList.add('dragging');
    iframeNode.notify('content', 'dragStart', {});
});
header.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    iframeNode.notify('content', 'drag', { dx: e.screenX - dragStart.x, dy: e.screenY - dragStart.y });
});
const endDrag = () => {
    dragStart = null;
    header.classList.remove('dragging');
};
header.addEventListener('pointerup', endDrag);
header.addEventListener('pointercancel', endDrag);

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    videoSel.disabled = true;
    audioSel.disabled = true;
    outputSel.disabled = true;
    loadFormatsBtn.disabled = true;
    statusEl.textContent = 'Starting download…';
    const output = outputSel.value === 'default' ? undefined : outputSel.value;
    try {
        const saved = await iframeNode.call('worker', 'start', { format: formatSelector(), output, only: onlyTrack() }, { timeout: 0 });
        statusEl.textContent = `Finished, saved ${saved.length} file${saved.length === 1 ? '' : 's'}`;
    } catch (e) {
        statusEl.textContent = `Error: ${e.message}`;
        startBtn.disabled = false;
        videoSel.disabled = false;
        audioSel.disabled = false;
        outputSel.disabled = false;
        loadFormatsBtn.disabled = formatsById.size > 0;
    }
});
