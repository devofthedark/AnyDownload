const check = document.getElementById('check');
const accept = document.getElementById('accept');
const decline = document.getElementById('decline');
const accepted = document.getElementById('accepted');

function showAccepted() {
    check.checked = true;
    check.disabled = true;
    accept.disabled = true;
    accept.textContent = 'Agreed';
    decline.hidden = true;
    accepted.hidden = false;
}

chrome.storage.local.get({ agree: false }).then(({ agree }) => {
    if (agree) showAccepted();
});

check.addEventListener('change', () => {
    accept.disabled = !check.checked;
});

accept.addEventListener('click', async () => {
    await chrome.storage.local.set({ agree: true });
    showAccepted();
});

decline.addEventListener('click', () => {
    // the browser asks the user to confirm before removing the extension
    chrome.management.uninstallSelf({ showConfirmDialog: true }).catch(() => {});
});
