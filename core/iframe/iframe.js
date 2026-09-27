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

iframeNode.handle("muxProgress", async (params, {signal}) => {
    progressWrap.classList.add('active');
    progressEl.value = params.progress;
    statusEl.textContent = `Merging… ${Math.round(params.progress * 100)}%`;
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
    const { status, filename, downloaded_bytes, total_bytes, total_bytes_estimate, speed, eta } = params;
    const total = total_bytes ?? total_bytes_estimate;
    const name = filename ? filename.split('/').pop() : '';

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

iframeNode.handle("ready", async () => {
    startBtn.disabled = false;
    videoSel.disabled = false;
    audioSel.disabled = false;
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
    if (v === 'none') return a === 'default' ? 'ba' : a;
    if (a === 'none') return v === 'default' ? 'bv' : v;
    if (v === 'default') return `bv+${a}`;
    // a format that already carries audio doesn't need a second track merged in
    if (a === 'default') return hasCodec(formatsById.get(v)?.acodec) ? v : `${v}+ba`;
    return `${v}+${a}`;
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

iframeNode.connect('content', windowLink(window.parent, '*', { accept: '*' }));
iframeNode.route("sw", "content");
iframeNode.route("potoken", "content")

const sandbox_iframe = document.createElement("iframe");
sandbox_iframe.src = chrome.runtime.getURL("/core/sandbox/sandbox.html");
sandbox_iframe.sandbox = "allow-scripts";
sandbox_iframe.style.display = "none";
document.body.appendChild(sandbox_iframe);


iframeNode.connect("sandbox", windowLink(sandbox_iframe.contentWindow, '*', { accept: '*' }));


const { port1, port2 } = new MessageChannel();
worker.postMessage({ [NS]: 'bridge', to: 'content' }, [port1]);
window.parent.postMessage({ [NS]: 'bridge', to: 'worker' }, '*', [port2]);

closeBtn.addEventListener('click', () => {
    iframeNode.notify('content', 'close', {});
});

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    videoSel.disabled = true;
    audioSel.disabled = true;
    loadFormatsBtn.disabled = true;
    statusEl.textContent = 'Downloading…';
    try {
        await iframeNode.call('worker', 'start', { format: formatSelector() }, { timeout: 0 });
        statusEl.textContent = 'Finished';
    } catch (e) {
        statusEl.textContent = `Error: ${e.message}`;
        startBtn.disabled = false;
        videoSel.disabled = false;
        audioSel.disabled = false;
        loadFormatsBtn.disabled = formatsById.size > 0;
    }
});
