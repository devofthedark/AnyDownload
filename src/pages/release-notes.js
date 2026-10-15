// Release notes as GitHub renders their Markdown: the body_html it sends for the
// application/vnd.github.html+json media type. Shown by the chrome build's update page (updater/) and the
// store builds' What's New page (whatsnew/), styled by .notes in pages.css.
(function (global) {
    'use strict';

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

    // Puts the notes `html` into `el` in place of what it had, hiding it if they say nothing.
    // `base` is the release's page on GitHub.
    function show(el, html, base) {
        const notes = document.createDocumentFragment();
        rebuild(new DOMParser().parseFromString(html ?? '', 'text/html').body, notes, base);
        el.replaceChildren(notes);
        el.hidden = !el.textContent.trim();
    }

    global.ReleaseNotes = { show };
})(globalThis);
