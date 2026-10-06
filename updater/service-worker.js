// The chrome build's background (see scripts/package.mjs): the shared one, then the update checks.
// Absolute paths, as importScripts resolves them against this file.
importScripts('/background.js', '/updater/check.js', '/updater/background.js');
