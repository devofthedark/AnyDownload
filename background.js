if (typeof importScripts === "function") {
    try {
        importScripts("rpc.js");
    } catch (e) {
        console.warn("importScripts failed, continuing without rpc.js", e);
    }
} else {
    console.warn("importScripts not available in this context");
}
const sw = createNode('sw');

// From https://github.com/kairi003/Get-cookies.txt-LOCALLY/blob/master/src/modules/cookie_format.mjs
function jsonToNetscapeMapper(cookies) {
    return cookies.map(
        ({ domain, expirationDate, path, secure, name, value }) => {
            const includeSubDomain = !!domain?.startsWith('.');
            const expiry = expirationDate?.toFixed() ?? '0';
            const arr = [domain, includeSubDomain, path, secure, expiry, name, value];
            return arr.map((v) =>
                typeof v === 'boolean' ? v.toString().toUpperCase() : v,
            );
        },
    );
}

function netscapeSerializer(cookies) {
    const netscapeTable = jsonToNetscapeMapper(cookies);
    const text = [
        '# Netscape HTTP Cookie File',
        '# http://curl.haxx.se/rfc/cookie_spec.html',
        '# This is a generated file!  Do not edit.',
        '',
        ...netscapeTable.map((row) => row.join('\t')),
        '', // Add a new line at the end
    ].join('\n');
    return text;
}

// when the extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
    // nothing gets downloaded until the terms have been accepted
    const { agree } = await chrome.storage.local.get({ agree: false });
    if (!agree) {
        chrome.tabs.create({ url: chrome.runtime.getURL("/pages/agreement/index.html") });
        return;
    }
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["/rpc.js", "/core/content/content.js"],
        injectImmediately: true,
        world: "ISOLATED"
    });
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["/rpc.js", "/core/content/potoken.js"],
        injectImmediately: true,
        world: "MAIN"
    });
});


async function cookies(url) {
    const cookies = await chrome.cookies.getAll({ url: url });
    return netscapeSerializer(cookies);
}

sw.handle("cookies", async (params, { signal }) => {
    const res = await cookies(params.url);
    console.log(res);
    return res;
});


sw.route("iframe", "content");
sw.route("worker", "content");

chrome.runtime.onConnect.addListener((port) => {
    sw.connect("content", portLink(port));
})



chrome.runtime.onInstalled.addListener(function (details) {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        chrome.tabs.create({ url: chrome.runtime.getURL("/pages/welcome/index.html") });
        chrome.storage.local.get({ "agree": false }).then(({ agree }) => {
            if (!agree) {
                chrome.tabs.create({ url: chrome.runtime.getURL("/pages/agreement/index.html") });
            }
        });
    }
});

sw.handle("dl", async (params) => {
    const {name, file} = params;
    const url = URL.createObjectURL(file);
    let e = await chrome.downloads.download({url: url, filename: name});
    console.debug(e);
    URL.revokeObjectURL(url);
    return 0;
})