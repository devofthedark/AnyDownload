// The chrome build's update notice in the panel (see check.js). scripts/package.mjs adds this to
// iframe.html after iframe.js; it's wrapped to keep its names out of iframe.js's.
(function () {
    'use strict';

    const { KEYS } = Updater;
    const PAGE = '/updater/update.html';

    const style = document.createElement('style');
    style.textContent = `
        #update-notice {
            display: none;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px 10px;
            background: #26272b;
            border: 1px solid #333;
            border-radius: 6px;
            padding: 8px 10px;
            font-size: 12px;
        }
        #update-notice.active { display: flex; }
        #update-notice span { flex: 1 1 100%; }
        #update-notice a {
            background: #3b82f6;
            color: #fff;
            border-radius: 6px;
            padding: 4px 10px;
            text-decoration: none;
        }
        #update-notice button {
            background: none;
            border: none;
            color: #aaa;
            padding: 0;
            font-size: 12px;
            cursor: pointer;
        }
        #update-notice button:hover { color: #fff; }
    `;
    document.head.appendChild(style);

    // opens in a tab of its own, as the footer's links do
    function pageLink(href, text) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = text;
        return a;
    }

    const notice = document.createElement('div');
    notice.id = 'update-notice';
    const text = document.createElement('span');
    // the update page starts downloading straight away
    const update = pageLink(`${PAGE}#download`, 'Update');
    const later = document.createElement('button');
    later.textContent = 'Not now';
    notice.append(text, update, later);
    document.querySelector('main').prepend(notice);

    // the version in the footer leads to the update page too, to check by hand or turn the checks off
    const version = document.getElementById('version');
    const versionLink = pageLink(PAGE, version.textContent);
    versionLink.title = 'Check for updates';
    version.replaceChildren(versionLink);

    let shown = null; // the version the notice is about
    async function refresh() {
        const { [KEYS.check]: state, [KEYS.dismissed]: dismissed } = await chrome.storage.local.get([KEYS.check, KEYS.dismissed]);
        const release = Updater.available(state);
        shown = release && release.version !== dismissed ? release.version : null;
        if (shown) text.textContent = `AnyDownload ${shown} is available.`;
        notice.classList.toggle('active', !!shown);
    }
    later.addEventListener('click', () => chrome.storage.local.set({ [KEYS.dismissed]: shown }));
    // a check that ends after the panel opened, or "Not now" in another panel
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (KEYS.check in changes || KEYS.dismissed in changes)) refresh();
    });
    refresh();
})();
