// The Chromium store builds' background (see scripts/package.mjs): the shared one, then the note of
// updates. Absolute paths, as importScripts resolves them against this file.
importScripts('/background.js', '/whatsnew/background.js');
