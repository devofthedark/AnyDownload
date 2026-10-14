// The release notes of the versions an update brought, from GitHub. Opened from the panel's notice (see
// panel.js) with ?from=<the version before the update>; without it, it shows this version's.
const REPO = 'devofthedark/AnyDownload';
// the newest first; an update that skipped more releases than this is rare, and they're all on GitHub
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const TIMEOUT = 15_000;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const current = chrome.runtime.getManifest().version;

// "1.2.0" -> [1, 2, 0], or null if it isn't a version: Chrome's are 1 to 4 dot-separated integers
function parseVersion(text) {
    return /^\d+(\.\d+){0,3}$/.test(text ?? '') ? text.split('.').map(Number) : null;
}

// > 0 if version `a` is newer than `b`, < 0 if it's older, 0 if they're the same
function compareVersions(a, b) {
    const x = parseVersion(a), y = parseVersion(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const diff = (x[i] ?? 0) - (y[i] ?? 0);
        if (diff) return Math.sign(diff);
    }
    return 0;
}

const fromParam = new URLSearchParams(location.search).get('from');
const from = parseVersion(fromParam) ? fromParam : null;

// whether the update brought this release: newer than `from`, and no newer than this version
function brought(release) {
    const version = release.tag_name;
    if (!parseVersion(version)) return false;
    if (!from) return compareVersions(version, current) === 0;
    return compareVersions(version, from) > 0 && compareVersions(version, current) <= 0;
}

async function fetchReleases() {
    const res = await fetch(RELEASES_URL, {
        // with each release's Markdown rendered by GitHub, as body_html
        headers: { Accept: 'application/vnd.github.html+json' },
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`GitHub answered with HTTP ${res.status}`);
    return res.json();
}

// What GitHub made of the notes is rebuilt from their text, the tags below and links to web pages,
// rather than trusting its HTML: anything else is dropped, keeping what's inside it. Nothing in it is
// loaded or run, as DOMParser's documents never do.
const KEEP = new Set(['p', 'div', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'b',
    'em', 'i', 'del', 's', 'code', 'pre', 'kbd', 'sup', 'sub', 'blockquote', 'details', 'summary', 'table', 'thead',
    'tbody', 'tr', 'th', 'td', 'a']);
// dropped along with what's inside them
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'svg']);

// `base`: the release's page, which the notes' own relative links (e.g. to a heading) are relative to
function rebuild(source, into, base) {
    for (const node of source.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            into.append(node.data);
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE || SKIP.has(node.localName)) continue;
        const name = node.localName;
        // GitHub links an image to itself, so the link is left, saying what the image was
        if (name === 'img') {
            into.append(node.getAttribute('alt') ?? '');
            continue;
        }
        const url = name === 'a' && URL.parse(node.getAttribute('href') ?? '', base);
        if (!KEEP.has(name) || (name === 'a' && !/^https?:$/.test(url?.protocol))) {
            rebuild(node, into, base);
            continue;
        }
        const el = document.createElement(name);
        if (name === 'a') {
            el.href = url.href;
            el.target = '_blank';
            el.rel = 'noopener';
        }
        const start = node.getAttribute('start');
        if (name === 'ol' && /^\d+$/.test(start ?? '')) el.start = Number(start);
        rebuild(node, el, base);
        // e.g. a heading's anchor, which is only an icon
        if (name === 'a' && !el.textContent.trim()) continue;
        into.append(el);
    }
}

function showRelease(release) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.textContent = `Version ${release.tag_name}`;

    const info = document.createElement('p');
    info.className = 'muted';
    const date = release.published_at && new Date(release.published_at).toLocaleDateString(undefined, { dateStyle: 'long' });
    const page = document.createElement('a');
    page.href = release.html_url?.startsWith(`${RELEASES_PAGE}/`) ? release.html_url : RELEASES_PAGE;
    page.target = '_blank';
    page.rel = 'noopener';
    page.textContent = 'Release page';
    info.append(date ? `Released ${date} · ` : '', page);
    section.append(title, info);

    const notes = document.createElement('div');
    notes.className = 'notes';
    rebuild(new DOMParser().parseFromString(release.body_html ?? '', 'text/html').body, notes, page.href);
    if (notes.textContent.trim()) section.append(notes);
    $('releases').append(section);
}

async function main() {
    $('summary').textContent = from && from !== current
        ? `AnyDownload was updated from ${from} to ${current}.`
        : `You have AnyDownload ${current}.`;
    let releases;
    try {
        releases = (await fetchReleases()).filter(brought);
    } catch (e) {
        const why = e.name === 'TimeoutError' ? "GitHub didn't answer in time"
            : e.name === 'TypeError' ? "couldn't reach GitHub" : e.message;
        statusEl.textContent = `Couldn't get the release notes from GitHub: ${why}.`;
        statusEl.className = 'error';
        return;
    }
    if (!releases.length) {
        statusEl.textContent = `GitHub doesn't have the release notes for version ${current} yet.`;
        return;
    }
    statusEl.hidden = true;
    releases.sort((a, b) => compareVersions(b.tag_name, a.tag_name)).forEach(showRelease);
}
main();
