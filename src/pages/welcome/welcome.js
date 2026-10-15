// point people at the terms if they closed that tab without accepting
chrome.storage.local.get({ agree: false }).then(({ agree }) => {
    document.getElementById('agree-note').hidden = agree;
});

document.getElementById('version').textContent = `Version ${chrome.runtime.getManifest().version}`;
