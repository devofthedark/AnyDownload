// The firefox build's answer to whether AnyDownload can access websites, which the panel asks (see
// panel.js): in Firefox, an extension frame inside a web page has no permissions API of its own.
(function () {
    'use strict';

    const ORIGINS = chrome.runtime.getManifest().host_permissions;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.ytx !== 'siteAccess') return;
        chrome.permissions.contains({ origins: ORIGINS }).then(sendResponse);
        return true;
    });
})();
