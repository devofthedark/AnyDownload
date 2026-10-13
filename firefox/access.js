// The page the panel's notice opens (see panel.js). Unlike the panel, a tab of the extension's own can ask
// Firefox for access to websites, as long as it's from a click.
const ORIGINS = chrome.runtime.getManifest().host_permissions;
const allow = document.getElementById('allow');
const granted = document.getElementById('granted');
const denied = document.getElementById('denied');

async function refresh() {
    const ok = await chrome.permissions.contains({ origins: ORIGINS });
    allow.disabled = ok;
    allow.textContent = ok ? 'Allowed' : 'Allow access';
    granted.hidden = !ok;
    return ok;
}

allow.addEventListener('click', async () => {
    try {
        await chrome.permissions.request({ origins: ORIGINS });
    } catch (e) {
        console.warn("couldn't ask for access to websites", e);
    }
    denied.hidden = await refresh();
});

// e.g. turned on in about:addons instead
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);
refresh();
