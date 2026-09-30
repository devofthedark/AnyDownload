(function () {
if (window.__webvideoDlActive) {
    // Panel is already open in this page — nothing to do.
    return;
}
window.__webvideoDlActive = true;

const ORIGIN = chrome.runtime.getURL("").slice(0, -1)
const content = createNode("content");
const port = chrome.runtime.connect();
content.connect("sw", portLink(port));
content.connect("potoken", windowLink(window, location.origin))
content.handle("proxyfetch", async (request, { transfer }) => {
    let { method, url, body, headers, credentials, referrer } = request;
    const response = await fetch(url, {
        method: method,
        headers: headers,
        body: body === null ? undefined : body,
        credentials: credentials,
        referrer: referrer
    })
    await content.waitForLink("worker");
    await content.waitForDirect("worker");
    const stream = response.body;
    transfer.push(stream)
    const entries = []
    response.headers.forEach((value, key) => entries.push([key, value]));
    return { stream, status: response.status, headers: entries }
});
content.handle("cur_url", async (params, {signal}) => {
    return location.href
})
window.addEventListener('message', function bridgeHandshake(e) {
    if (e.origin !== ORIGIN) return;
    if (e.data?.ytx !== 'bridge') return;
    // One-time handshake per session — remove immediately so a leftover
    // listener from a previous open/close cycle can't also grab the next
    // session's port and create a second "content" node on the same link.
    window.removeEventListener('message', bridgeHandshake);
    const port = e.ports[0];
    content.connect('worker', messagePortLink(port));
    content.route("worker", "worker")
});

async function main() {
    const cookies = await content.call("sw", "cookies", { url: location.href });

    // cached cookies, we dont want to wait for SW to start up
    content.handle("cookies", async (params, { signal }) => {
        return cookies;
    });

    const host = document.createElement("div");
    host.style.cssText = `
        all: initial !important;
        position: fixed !important;
        top: 16px !important;
        right: 16px !important;
        width: 340px !important;
        height: 420px !important;
        z-index: 2147483647 !important;
    `;
    document.documentElement.appendChild(host);

    let shadow = host.attachShadow({ mode: "open" });

    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("/core/iframe/iframe.html");
    iframe.style.cssText = `
        all: initial !important;
        display: block !important;
        width: 100% !important;
        height: 100% !important;
        border: none !important;
        border-radius: 12px !important;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35) !important;
    `;
    shadow.appendChild(iframe);
    content.connect(
        "iframe",
        windowLink(iframe.contentWindow, ORIGIN),
    );
    content.route("worker", "iframe")

    // the iframe reports how far its header has been dragged since dragStart
    let dragOrigin = null;
    content.handle("dragStart", async () => {
        const rect = host.getBoundingClientRect();
        dragOrigin = { left: rect.left, top: rect.top };
    });
    content.handle("drag", async ({ dx, dy }) => {
        if (!dragOrigin) return;
        const maxLeft = Math.max(0, window.innerWidth - host.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - host.offsetHeight);
        const left = Math.min(Math.max(0, dragOrigin.left + dx), maxLeft);
        const top = Math.min(Math.max(0, dragOrigin.top + dy), maxTop);
        host.style.setProperty("right", "auto", "important");
        host.style.setProperty("left", `${left}px`, "important");
        host.style.setProperty("top", `${top}px`, "important");
    });

    content.handle("close", async () => {
        host.remove();
        // Tear down this session's links so their window/port listeners can't
        // linger and intercept the next session's identically-named "content"
        // node — that's what caused the cross-session RPC loops.
        content.disconnect("iframe");
        content.disconnect("worker");
        content.disconnect("potoken");
        content.disconnect("sw");
        window.__webvideoDlActive = false;
    });
}
main();
})();
