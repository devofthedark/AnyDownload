(function () {
if (window.__webvideoDlPotokenActive) {
    // Already wired up in this page's MAIN world — the existing node's
    // window-postMessage link keeps working across content.js re-injections.
    return;
}
window.__webvideoDlPotokenActive = true;

console.log("potoken here")
const potoken = createNode("potoken")
potoken.connect("content", windowLink(window, location.origin))
potoken.route("worker", "content")
potoken.handle("potoken", async(params, { signal })=> {
    console.log("potoken extractor called")
    return await window.top["havuokmhhs-0"]?.bevasrs?.wpc().then((client) => client.mws({
        c: params.content_binding,
        mc: params.mint_cold_start_token,
        me: params.mint_error_token
    }))
})
})();