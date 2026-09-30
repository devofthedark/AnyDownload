if (typeof importScripts === "function") {
    try {
        importScripts("rpc.js");
    } catch (e) {
        console.warn("importScripts failed, continuing without rpc.js", e);
    }
} else {
    console.warn("importScripts not available in this context");
}

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


// Incognito tabs and Firefox containers have their own cookie stores, and without a storeId
// getAll() reads the default one, i.e. the wrong account's cookies.
async function cookieStoreId(tab) {
    if (tab.cookieStoreId) return tab.cookieStoreId; // Firefox
    const stores = await chrome.cookies.getAllCookieStores();
    return stores.find((store) => store.tabIds.includes(tab.id))?.id;
}

async function cookies(url, tab) {
    const query = { url: url };
    const storeId = tab && await cookieStoreId(tab);
    if (storeId) query.storeId = storeId;
    return netscapeSerializer(await chrome.cookies.getAll(query));
}

// Every tab's content script is a node called "content", so a single shared node would send each
// reply down whichever tab connected last. Instead each connection gets its own node, which also
// knows the tab it serves.
chrome.runtime.onConnect.addListener((port) => {
    const tab = port.sender?.tab;
    createNode("sw")
        .handle("cookies", async (params, { signal }) => {
            return await cookies(params.url, tab);
        })
        .connect("content", portLink(port));
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
