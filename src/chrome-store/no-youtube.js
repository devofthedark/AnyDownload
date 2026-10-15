// The chrome-store build's stand-in for the panel on YouTube, which the Chrome Web Store doesn't allow
// downloading from (see doc/no-youtube-chrome.md). scripts/package.mjs has the background inject this just
// before content.js, which then doesn't open the panel: it takes this notice for one already open.
(function () {
    'use strict';

    // youtube.com, youtu.be, youtube-nocookie.com and youtubekids.com, with any subdomain (www., m., music., ...)
    const YOUTUBE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|youtubekids\.com)$/i;
    const DOC = 'https://github.com/devofthedark/AnyDownload/blob/main/doc/no-youtube-chrome.md';

    // not YouTube, or this notice is open already
    if (!YOUTUBE.test(location.hostname) || window.__webvideoDlActive) return;
    window.__webvideoDlActive = true;

    // placed and styled like the panel (see content.js and iframe.html)
    const host = document.createElement('div');
    host.style.cssText = `
        all: initial !important;
        position: fixed !important;
        top: 16px !important;
        right: 16px !important;
        width: 340px !important;
        z-index: 2147483647 !important;
    `;
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
        .notice {
            font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #1e1f22;
            color: #e8e8ea;
            border-radius: 12px;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
            overflow: hidden;
        }
        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 12px;
            background: #26272b;
            border-bottom: 1px solid #333;
        }
        .title {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        img {
            width: 18px;
            height: 18px;
            display: block;
        }
        h1 {
            font-size: 13px;
            margin: 0;
            font-weight: 600;
        }
        button {
            background: none;
            border: none;
            color: #aaa;
            font: inherit;
            font-size: 15px;
            line-height: 1;
            cursor: pointer;
            padding: 3px 7px;
            border-radius: 4px;
        }
        button:hover { background: #3a3b3f; color: #fff; }
        p { margin: 0; padding: 14px 12px; }
        a { color: #6ea1f8; text-decoration: none; }
        a:hover { text-decoration: underline; }
    `;

    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.setAttribute('role', 'dialog');
    notice.setAttribute('aria-label', 'AnyDownload');

    const header = document.createElement('header');
    const title = document.createElement('div');
    title.className = 'title';
    const logo = document.createElement('img');
    logo.src = chrome.runtime.getURL('/logo/icon.svg');
    logo.alt = '';
    const name = document.createElement('h1');
    name.textContent = 'AnyDownload';
    title.append(logo, name);
    const close = document.createElement('button');
    close.title = 'Close';
    close.textContent = '✕';
    header.append(title, close);

    const text = document.createElement('p');
    const more = document.createElement('a');
    more.href = DOC;
    more.target = '_blank';
    more.rel = 'noopener';
    more.textContent = 'Learn more';
    text.append('Downloading from YouTube is not supported in this version of AnyDownload. ', more);

    notice.append(header, text);
    shadow.append(style, notice);
    document.documentElement.appendChild(host);

    close.addEventListener('click', () => {
        host.remove();
        window.__webvideoDlActive = false;
    });
})();
