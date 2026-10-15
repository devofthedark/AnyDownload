// The firefox build's notice in the panel for when AnyDownload can't access websites. scripts/package.mjs
// adds this to iframe.html after iframe.js; it's wrapped to keep its names out of iframe.js's.
// Firefox lets the user turn host_permissions off (or never grants them), unlike Chrome. Without them,
// the worker's requests to other sites get CORS checked as the extension's origin, which hardly any site
// allows, e.g. YouTube's videos without "Use Cookies", and the site's cookies can't be read either.
// This frame has no permissions API in Firefox, so the background says whether they're granted (see
// background.js) and a tab of the extension's own asks for them (see access.html).
(function () {
    'use strict';

    const PAGE = '/firefox/access.html';
    const statusEl = document.getElementById('status');
    const BLOCKED = 'Allow AnyDownload to access websites first';

    const style = document.createElement('style');
    style.textContent = `
        #access-notice {
            display: none;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px 10px;
            background: #26272b;
            border: 1px solid #f0b43c;
            border-radius: 6px;
            padding: 8px 10px;
            font-size: 12px;
        }
        #access-notice.active { display: flex; }
        #access-notice span { flex: 1 1 100%; }
        #access-notice a {
            background: #3b82f6;
            color: #fff;
            border-radius: 6px;
            padding: 4px 10px;
            text-decoration: none;
        }
    `;
    document.head.appendChild(style);

    const notice = document.createElement('div');
    notice.id = 'access-notice';
    const text = document.createElement('span');
    text.textContent = "AnyDownload needs access to websites to download from them, which Firefox hasn't given it.";
    // opens in a tab of its own, as the footer's links do
    const allow = document.createElement('a');
    allow.href = PAGE;
    allow.target = '_blank';
    allow.rel = 'noopener';
    allow.textContent = 'Allow access';
    notice.append(text, allow);
    document.querySelector('main').prepend(notice);

    // null until the background answers, which is long before anyone can click
    let granted = null;
    async function refresh() {
        try {
            granted = await chrome.runtime.sendMessage({ ytx: 'siteAccess' });
        } catch (e) {
            console.warn("couldn't ask the background about access to websites", e);
        }
        notice.classList.toggle('active', granted === false);
        // a Download refused before doesn't apply any more
        if (granted && statusEl.textContent === BLOCKED) statusEl.textContent = 'Ready to download';
        return granted;
    }

    // Ahead of iframe.js's own listeners. Without access, a download can only fail, after 10 retries at
    // that, so this checks again in case it's been allowed since, and carries on only if it has.
    for (const button of [document.getElementById('start'), document.getElementById('load-formats')]) {
        button.addEventListener('click', async (e) => {
            if (granted !== false) return;
            e.stopImmediatePropagation();
            if (await refresh()) {
                button.click();
            } else {
                statusEl.textContent = BLOCKED;
            }
        }, { capture: true });
    }

    // e.g. back from access.html, or from turning it on in about:addons
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh();
    });
    refresh();
})();
