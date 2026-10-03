(function () {
if (window.__webvideoDlActive) {
    // Panel is already open in this page — nothing to do.
    return;
}
window.__webvideoDlActive = true;

const ORIGIN = chrome.runtime.getURL("").slice(0, -1)
const content = createNode("content");

// The background gets stopped when idle, which disconnects its port, so connect on demand
let swPort = null;
function callSw(method, params) {
    if (!swPort) {
        const port = chrome.runtime.connect();
        // the "sw" link takes itself down too, failing any call still waiting on it (see rpc.js)
        port.onDisconnect.addListener(() => {
            if (swPort === port) swPort = null;
        });
        swPort = port;
        content.connect("sw", portLink(port));
    }
    return content.call("sw", method, params);
}
// Every link below is a MessagePort or runtime port. Nothing listens on the page's window: the
// page can read and forge anything posted there.
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
    return { stream, status: response.status, url: response.url, headers: entries }
});
content.handle("cur_url", async (params, {signal}) => {
    return location.href
})
// read fresh for every download, so signing in after opening the panel still counts
content.handle("cookies", async (params, { signal }) => {
    return await callSw("cookies", { url: location.href });
});
// minted by the background in the page's MAIN world, see background.js
content.handle("potoken", async (params) => {
    return await callSw("potoken", params);
});
// the iframe hands over a direct channel to the worker, so fetch streams skip a hop
content.handle("bridge", async ({ port }) => {
    content.connect('worker', messagePortLink(port));
    content.route("worker", "worker")
});

async function main() {
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
    // The iframe gets its end of this channel in a message addressed to the extension's origin,
    // which the page can't see. The page can post to the iframe too, so the port comes with a
    // one-time token the iframe checks against extension storage, which the page can't touch.
    const channel = new MessageChannel();
    const token = crypto.getRandomValues(new Uint32Array(4)).join("-");
    const tokenKey = `bridge:${token}`;
    iframe.addEventListener("load", async () => {
        await chrome.storage.local.set({ [tokenKey]: true });
        iframe.contentWindow.postMessage({ ytx: "bridge", token }, ORIGIN, [channel.port2]);
    }, { once: true });
    shadow.appendChild(iframe);
    content.connect("iframe", messagePortLink(channel.port1));
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
        content.disconnect("sw");
        // in case the iframe never picked it up
        chrome.storage.local.remove(tokenKey);
        window.__webvideoDlActive = false;
    });
}
main();
})();
