// The update page: downloads the new release's zip and walks through putting it in place, which only
// the user can do for an extension loaded unpacked (see check.js). Opened from the panel with
// #download, and by the background with #updated or #unchanged after Reload (see background.js).
const { KEYS } = Updater;
const $ = (id) => document.getElementById(id);
const resultEl = $('result');
const statusEl = $('status');
const downloadBtn = $('download');
const downloadStatus = $('download-status');
const progressEl = $('progress');
const checkBtn = $('check');
const autoBox = $('auto');

// a download that's gone this long without receiving anything is given up on
const STALL = 30_000;

// the newer release on offer, if any (see Updater.available)
let release = null;

function say(el, text, kind = '') {
    el.textContent = text;
    el.className = kind;
    el.hidden = false;
}

function showRelease() {
    $('release').hidden = !release;
    if (!release) {
        $('steps').hidden = true;
        return;
    }
    $('release-title').textContent = `Version ${release.version}`;
    const date = release.published && new Date(release.published).toLocaleDateString(undefined, { dateStyle: 'long' });
    $('release-date').textContent = date ? `Released ${date} ·` : '';
    $('release-page').href = release.page;
    const notes = release.notes.trim();
    $('notes').textContent = notes;
    $('notes').hidden = !notes;
    $('zip-name').textContent = release.asset?.name ?? '';
    downloadBtn.hidden = !release.asset;
    if (!release.asset) downloadStatus.textContent = 'This release has no Chrome zip to download here. Get it from its release page.';
}

async function checkNow() {
    checkBtn.disabled = true;
    say(statusEl, 'Checking for updates…');
    const state = await Updater.check({ force: true });
    checkBtn.disabled = false;
    release = Updater.available(state);
    showRelease();
    const cur = Updater.current();
    if (release) {
        // the last check's answer, if this one failed
        const stale = state.error ? ` (Couldn't check again just now: ${state.error}.)` : '';
        say(statusEl, `AnyDownload ${release.version} is available. You have ${cur}.${stale}`);
    } else if (state.error) {
        say(statusEl, `Couldn't check for updates: ${state.error}.`, 'error');
    } else {
        say(statusEl, `You have the latest version, ${cur}.`);
    }
}

async function sha256(blob) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// like the panel's downloads (see iframe.js)
function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // revoking straight after click() can cancel the download before it starts reading
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function download() {
    const asset = release?.asset;
    // only ever from GitHub's release downloads, whatever was stored (see check.js)
    if (!asset?.url.startsWith(Updater.ASSET_PREFIX)) return;
    downloadBtn.disabled = true;
    progressEl.hidden = false;
    progressEl.value = 0;
    downloadStatus.textContent = 'Downloading…';
    const abort = new AbortController();
    let stalled;
    const waitForData = () => {
        clearTimeout(stalled);
        stalled = setTimeout(() => abort.abort(new DOMException('GitHub stopped sending it', 'TimeoutError')), STALL);
    };
    try {
        waitForData();
        const res = await fetch(asset.url, { credentials: 'omit', cache: 'no-store', signal: abort.signal });
        if (!res.ok) throw new Error(`GitHub answered with HTTP ${res.status}`);
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            waitForData();
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            progressEl.value = received / asset.size;
            downloadStatus.textContent = `Downloading… ${mb(received)} of ${mb(asset.size)}`;
        }
        const zip = new Blob(chunks, { type: 'application/zip' });
        // a download cut short or corrupted on the way fails these, rather than leaving a zip that won't open
        if (zip.size !== asset.size) throw new Error(`got ${zip.size} bytes instead of ${asset.size}`);
        if (asset.sha256 && await sha256(zip) !== asset.sha256) throw new Error("it doesn't match the release's checksum");
        save(zip, asset.name);
        downloadStatus.textContent = `Saved ${asset.name}.`;
        downloadBtn.textContent = 'Download again';
        $('steps').hidden = false;
    } catch (e) {
        const why = e.name === 'TypeError' ? "couldn't reach GitHub" : e.message;
        downloadStatus.textContent = `Couldn't download the update: ${why}.`;
        downloadBtn.textContent = 'Try again';
        progressEl.hidden = true;
    } finally {
        clearTimeout(stalled);
        downloadBtn.disabled = false;
    }
}

downloadBtn.addEventListener('click', download);
checkBtn.addEventListener('click', checkNow);

$('open-extensions').addEventListener('click', () => {
    // AnyDownload's details there say which folder it's loaded from
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

$('reload').addEventListener('click', async () => {
    await chrome.storage.local.set({ [KEYS.pending]: { to: release.version } });
    // this page closes with it; the background opens it again to say how it went
    chrome.runtime.reload();
});

chrome.storage.local.get({ [KEYS.auto]: true }).then(({ [KEYS.auto]: auto }) => {
    autoBox.checked = auto;
});
autoBox.addEventListener('change', () => chrome.storage.local.set({ [KEYS.auto]: autoBox.checked }));

async function main() {
    const cur = Updater.current();
    $('current').textContent = cur;
    if (!(await Updater.enabled())) {
        say(statusEl, "This copy of AnyDownload isn't loaded unpacked, so your browser keeps it up to date itself.");
        $('settings').hidden = true;
        return;
    }
    const arrived = location.hash.slice(1);
    // so refreshing the page doesn't download again
    history.replaceState(null, '', location.pathname);
    if (arrived === 'updated') {
        say(resultEl, `AnyDownload was updated to ${cur}. You can delete the downloaded zip.`, 'ok');
    } else if (arrived === 'unchanged') {
        say(resultEl, `AnyDownload is still version ${cur}: the files in its folder weren't replaced. Check that `
            + "manifest.json from the update ended up directly in the folder AnyDownload is loaded from, then "
            + 'reload it again.', 'error');
    }
    await checkNow();
    if (arrived === 'unchanged' && release) $('steps').hidden = false;
    if (arrived === 'download' && release) download();
}
main();
