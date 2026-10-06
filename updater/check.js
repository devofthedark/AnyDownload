// The chrome build's update check (see scripts/package.mjs). Chrome users load the release zip
// unpacked, which Chrome never updates, so the extension asks GitHub for new releases itself, and the
// user swaps the files in (see update.html). Loaded by the background, the panel and the update page.
(function (global) {
    'use strict';

    const REPO = 'devofthedark/AnyDownload';
    const API = 'https://api.github.com';
    const SITE = 'https://github.com';
    // GitHub's latest release is the newest one that isn't a draft or marked as a pre-release, so betas
    // and release candidates are never offered
    const LATEST_URL = `${API}/repos/${REPO}/releases/latest`;
    const RELEASES_PAGE = `${SITE}/${REPO}/releases`;
    // where release zips are downloaded from, whatever else the API says
    const ASSET_PREFIX = `${RELEASES_PAGE}/download/`;

    // how often to check on its own, and how long to wait after a failed check GitHub gave no time for
    const CHECK_EVERY = 12 * 60 * 60_000;
    const RETRY_AFTER = 60 * 60_000;
    const TIMEOUT = 15_000;

    // storage.local keys, kept apart so the background and the pages can't overwrite each other's
    const KEYS = {
        check: 'updateCheck',         // what the last check found, see check()
        dismissed: 'updateDismissed', // the version the panel's "Not now" was clicked for
        auto: 'updateAuto',           // whether to check on its own, see the update page
        pending: 'updatePending',     // set by the update page's Reload, see background.js
    };

    // "1.2.0" -> [1, 2, 0], or null if it isn't a version: Chrome's are 1 to 4 dot-separated integers
    function parseVersion(text) {
        return /^\d+(\.\d+){0,3}$/.test(text) ? text.split('.').map(Number) : null;
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

    const current = () => chrome.runtime.getManifest().version;

    // Only an extension loaded unpacked gets updated by hand: the browser updates any other install itself
    async function enabled() {
        return (await chrome.management.getSelf()).installType === 'development';
    }

    // what this needs of a GitHub release, or null if its tag isn't a version
    function readRelease(release) {
        const version = release.tag_name;
        if (!parseVersion(version)) return null;
        // the name scripts/package.mjs gives the chrome build's zip
        const name = `anydownload-${version}-chrome.zip`;
        const asset = release.assets?.find((a) => a.name === name && a.browser_download_url?.startsWith(ASSET_PREFIX));
        return {
            version,
            page: release.html_url?.startsWith(`${RELEASES_PAGE}/`) ? release.html_url : RELEASES_PAGE,
            notes: release.body ?? '',
            published: release.published_at,
            // without one the update page links to the release instead
            asset: asset ? {
                name,
                url: asset.browser_download_url,
                size: asset.size,
                // GitHub only records this for assets uploaded since mid-2025
                sha256: /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1] ?? null,
            } : null,
        };
    }

    // when to ask again after GitHub refused, e.g. for going over its rate limit
    function retryTime(res, now) {
        const after = Number(res.headers.get('retry-after'));
        if (after > 0) return now + after * 1000;
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        return reset > now ? reset : now + RETRY_AFTER;
    }

    // Asks GitHub for the latest release, unless the last check was too recent and this isn't `force`d,
    // and keeps the answer under KEYS.check: { checkedAt, nextCheck, etag, latest, error }. `latest` is
    // readRelease()'s, null if there's no release to update to, or undefined if no check got an answer.
    async function check({ force = false } = {}) {
        const { [KEYS.check]: last = {} } = await chrome.storage.local.get(KEYS.check);
        const now = Date.now();
        if (!force && now < (last.nextCheck ?? 0)) return last;

        const state = { ...last, checkedAt: now, nextCheck: now + CHECK_EVERY, error: null };
        try {
            const headers = { Accept: 'application/vnd.github+json' };
            // GitHub doesn't count an "unchanged" answer against its rate limit
            if (last.etag) headers['If-None-Match'] = last.etag;
            const res = await fetch(LATEST_URL, {
                headers,
                credentials: 'omit',
                cache: 'no-store',
                signal: AbortSignal.timeout(TIMEOUT),
            });
            if (res.ok) {
                state.latest = readRelease(await res.json());
                state.etag = res.headers.get('etag');
            } else if (res.status === 404) {
                // no releases yet
                state.latest = null;
                state.etag = null;
            } else if (res.status !== 304) {
                state.error = `GitHub answered with HTTP ${res.status}`;
                state.nextCheck = retryTime(res, now);
            }
        } catch (e) {
            state.error = e.name === 'TimeoutError' ? "GitHub didn't answer in time" : "couldn't reach GitHub";
            state.nextCheck = now + RETRY_AFTER;
        }
        if (state.error) console.warn(`couldn't check for updates: ${state.error}`);
        await chrome.storage.local.set({ [KEYS.check]: state });
        return state;
    }

    // the release a check found, if it's newer than this version
    function available(state) {
        const latest = state?.latest;
        return latest && compareVersions(latest.version, current()) > 0 ? latest : null;
    }

    global.Updater = { KEYS, ASSET_PREFIX, check, available, enabled, current, compareVersions };
})(globalThis);
