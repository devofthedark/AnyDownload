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
// (MIT License, see THIRD_PARTY_LICENSES.txt)
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

// Some pages can't be scripted at all: the browser's own pages, its extension store, file:// URLs
// without file access, and so on. Rather than doing nothing, the button flags it for a while, with
// the reason in its tooltip.
const CANT_RUN_FOR = 8_000;
async function showCantRun(tabId, error) {
    const why = String(error?.message ?? error ?? '').replace(/\.$/, '');
    await Promise.all([
        chrome.action.setBadgeText({ tabId, text: '!' }),
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' }),
        chrome.action.setTitle({ tabId, title: `AnyDownload can't run on this page${why ? ` (${why})` : ''}` }),
    ]);
    setTimeout(() => clearCantRun(tabId), CANT_RUN_FOR);
}
function clearCantRun(tabId) {
    // the tab may be gone by now
    return Promise.all([
        chrome.action.setBadgeText({ tabId, text: '' }),
        chrome.action.setTitle({ tabId, title: chrome.runtime.getManifest().action.default_title }),
    ]).catch(() => {});
}

// when the extension icon is clicked
async function openPanel(tab) {
    // nothing gets downloaded until the terms have been accepted
    const { agree } = await chrome.storage.local.get({ agree: false });
    if (!agree) {
        chrome.tabs.create({ url: chrome.runtime.getURL("/pages/agreement/index.html") });
        return;
    }
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["/rpc.js", "/core/content/content.js"],
            injectImmediately: true,
            world: "ISOLATED"
        });
        await clearCantRun(tab.id);
    } catch (e) {
        console.warn(`can't open the panel in tab ${tab.id}`, e);
        await showCantRun(tab.id, e);
    }
}
chrome.action.onClicked.addListener(openPanel);

// Runs in the page's MAIN world, where YouTube's player keeps its PO token minter. Injected once per
// token rather than leaving an RPC node there: anything in the MAIN world is reachable by the page.
async function mintPotokenInPage({ content_binding, mint_cold_start_token, mint_error_token }) {
    try {
        // The youtube token minter location.
        const token = await window["havuokmhhs-0"]?.bevasrs?.wpc().then((client) => client.mws({
            c: content_binding,
            mc: mint_cold_start_token,
            me: mint_error_token
        }));
        return { token };
    } catch (e) {
        return { error: String(e?.message ?? e) };
    }
}

async function potoken(params, sender) {
    const [injection] = await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
        world: "MAIN",
        func: mintPotokenInPage,
        args: [params]
    });
    const { token, error } = injection?.result ?? {};
    if (error) throw new Error(`minting a PO token failed: ${error}`);
    return token;
}


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
        .handle("potoken", async (params, { signal }) => {
            return await potoken(params, port.sender);
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
