// The update checks the chrome build makes on its own (see check.js). Its listeners are added as soon as
// it runs, as a service worker's have to be, and it's wrapped to keep its names out of background.js's.
(function () {
    'use strict';

    const { KEYS } = Updater;

    async function autoCheck(options) {
        const { [KEYS.auto]: auto } = await chrome.storage.local.get({ [KEYS.auto]: true });
        if (auto && await Updater.enabled()) await Updater.check(options);
    }

    // The update page's Reload records the version it should bring. Reloading an unpacked extension
    // counts as an update whether or not its files were replaced, so the version is what tells.
    async function confirmUpdate() {
        const { [KEYS.pending]: pending } = await chrome.storage.local.get(KEYS.pending);
        if (!pending) return;
        await chrome.storage.local.remove(KEYS.pending);
        const updated = Updater.compareVersions(Updater.current(), pending.to) >= 0;
        await chrome.tabs.create({ url: chrome.runtime.getURL(`/updater/update.html#${updated ? 'updated' : 'unchanged'}`) });
    }

    chrome.runtime.onInstalled.addListener(async ({ reason }) => {
        if (reason === chrome.runtime.OnInstalledReason.UPDATE) await confirmUpdate();
        // what an older version found might not be in the shape this one expects
        await chrome.storage.local.remove(KEYS.check);
        await autoCheck({ force: true });
    });
    chrome.runtime.onStartup.addListener(() => autoCheck());
    // opening the panel is when news of an update is wanted, and the click has woken this worker anyway
    chrome.action.onClicked.addListener(() => autoCheck());
})();
