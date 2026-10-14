// The store builds' note that the browser has updated AnyDownload, for the panel's notice (see panel.js).
// Its listener is added as soon as it runs, as a service worker's have to be, and it's wrapped to keep
// its names out of background.js's.
(function () {
    'use strict';

    // storage.local: { from, to }, the versions before and after the update, until the notice is dismissed
    const KEY = 'whatsNew';

    chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
        if (reason !== chrome.runtime.OnInstalledReason.UPDATE) return;
        const version = chrome.runtime.getManifest().version;
        // reloading a copy loaded unpacked or as a temporary add-on counts as an update too
        if (!previousVersion || previousVersion === version) return;
        // updated again before the notice was dismissed: What's New covers both updates
        const { [KEY]: last } = await chrome.storage.local.get(KEY);
        await chrome.storage.local.set({ [KEY]: { from: last?.from ?? previousVersion, to: version } });
    });
})();
