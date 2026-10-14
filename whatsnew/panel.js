// The store builds' notice in the panel that AnyDownload was updated (see background.js), which links to
// the release notes (see whatsnew.html). scripts/package.mjs adds this to iframe.html after iframe.js;
// it's wrapped to keep its names out of iframe.js's.
(function () {
    'use strict';

    const KEY = 'whatsNew'; // see background.js
    const PAGE = '/whatsnew/whatsnew.html';

    const style = document.createElement('style');
    style.textContent = `
        #whats-new-notice {
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
        #whats-new-notice.active { display: flex; }
        #whats-new-notice span { flex: 1 1 100%; }
        #whats-new-notice a {
            background: #3b82f6;
            color: #fff;
            border-radius: 6px;
            padding: 4px 10px;
            text-decoration: none;
        }
        #whats-new-notice button {
            background: none;
            border: none;
            color: #aaa;
            padding: 0;
            font-size: 12px;
            cursor: pointer;
        }
        #whats-new-notice button:hover { color: #fff; }
    `;
    document.head.appendChild(style);

    const notice = document.createElement('div');
    notice.id = 'whats-new-notice';
    const text = document.createElement('span');
    // opens in a tab of its own, as the footer's links do
    const whatsNew = document.createElement('a');
    whatsNew.target = '_blank';
    whatsNew.rel = 'noopener';
    whatsNew.textContent = "What's New";
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    notice.append(text, whatsNew, dismiss);
    document.querySelector('main').prepend(notice);

    async function refresh() {
        const { [KEY]: update } = await chrome.storage.local.get(KEY);
        if (update) {
            text.textContent = `AnyDownload has been updated to ${update.to}.`;
            // the page lists every release since `from`
            whatsNew.href = `${PAGE}?from=${encodeURIComponent(update.from)}`;
        }
        notice.classList.toggle('active', !!update);
    }
    // the release notes are what the notice is for, so reading them dismisses it too
    const forget = () => chrome.storage.local.remove(KEY);
    whatsNew.addEventListener('click', forget);
    dismiss.addEventListener('click', forget);
    // an update while the panel is open, or the notice dismissed in another panel
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && KEY in changes) refresh();
    });
    refresh();
})();
