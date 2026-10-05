// Rebuilds libs/ from the pinned dependencies:
//   package.json      -> Mediabunny (+ encoders) and Pyodide, copied out of node_modules/
//   requirements.txt  -> Python wheels, downloaded from PyPI and checked against its sha256
// and writes libs/vendor.js, which tells the worker where Python's stdlib and the wheels are.
//
// Usage: npm run vendor   (also runs after every `npm install`)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unblobEncoderWorkers } from './unblob-encoder-workers.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const LIBS = path.join(ROOT, 'libs');

const MEDIABUNNY_PKGS = ['mediabunny', '@mediabunny/mp3-encoder', '@mediabunny/aac-encoder', '@mediabunny/flac-encoder'];
// only what loadPyodide() fetches at runtime
const PYODIDE_FILES = ['pyodide.js', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
// Wheels whose version comes from another wheel's exact pin instead of requirements.txt.
// yt-dlp only works with one specific yt-dlp-ejs; a mismatch breaks the JS challenge solver.
const PINNED_BY = { 'yt-dlp-ejs': 'yt-dlp' };

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const pkgDir = (name) => path.join(ROOT, 'node_modules', name);

function copy(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

// installed version of each npm dependency, failing if node_modules doesn't match package.json
function npmVersions() {
    const wanted = readJson(path.join(ROOT, 'package.json')).dependencies;
    const versions = {};
    for (const [name, version] of Object.entries(wanted)) {
        const pkgJson = path.join(pkgDir(name), 'package.json');
        const installed = fs.existsSync(pkgJson) && readJson(pkgJson).version;
        if (installed !== version) {
            throw new Error(`${name}: package.json wants ${version} but ${installed || 'nothing'} is installed. Run \`npm install\`.`);
        }
        versions[name] = version;
    }
    const mb = new Set(MEDIABUNNY_PKGS.map((name) => versions[name]));
    if (mb.size !== 1) throw new Error(`Mediabunny packages must share one version, got ${[...mb].join(', ')}`);
    return versions;
}

function vendorMediabunny() {
    const dir = path.join(LIBS, 'mediabunny');
    // the .cjs bundle is a plain script that defines the `Mediabunny` global, as importScripts needs
    copy(path.join(pkgDir('mediabunny'), 'dist/bundles/mediabunny.cjs'), path.join(dir, 'mediabunny.js'));
    for (const codec of ['mp3', 'aac', 'flac']) {
        const file = `mediabunny-${codec}-encoder.js`;
        copy(path.join(pkgDir(`@mediabunny/${codec}-encoder`), 'dist/bundles', file), path.join(dir, file));
    }
    unblobEncoderWorkers(dir, '/libs/mediabunny');
}

function vendorPyodide() {
    for (const file of PYODIDE_FILES) {
        copy(path.join(pkgDir('pyodide'), file), path.join(LIBS, 'pyodide', file));
    }
}

// name==version lines from requirements.txt
function requirements() {
    const reqs = {};
    for (const raw of fs.readFileSync(path.join(ROOT, 'requirements.txt'), 'utf8').split('\n')) {
        const line = raw.replace(/#.*/, '').trim();
        if (!line) continue;
        const m = /^([A-Za-z0-9._-]+)\s*==\s*([^\s;]+)$/.exec(line);
        if (!m) throw new Error(`requirements.txt: only exact \`name==version\` pins are supported, got "${line}"`);
        reqs[m[1]] = m[2];
    }
    return reqs;
}

async function pypi(name, version) {
    const res = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
    if (!res.ok) throw new Error(`PyPI: ${name} ${version}: HTTP ${res.status}`);
    return res.json();
}

// the exact version `parent` pins `name` to, from its requires_dist
function pinnedVersion(parentInfo, name) {
    const esc = name.replace(/[-_.]+/g, '[-_.]+');
    for (const req of parentInfo.info.requires_dist || []) {
        const m = new RegExp(`^${esc}\\s*==\\s*([^\\s;,]+)`, 'i').exec(req);
        if (m) return m[1];
    }
    throw new Error(`${parentInfo.info.name} ${parentInfo.info.version} doesn't pin ${name} to an exact version`);
}

async function downloadWheel(release) {
    const { name, version } = release.info;
    const wheel = release.urls.find((u) => u.packagetype === 'bdist_wheel' && u.filename.endsWith('-none-any.whl'));
    if (!wheel) throw new Error(`${name} ${version} has no pure-Python wheel on PyPI, so Pyodide can't load it`);

    const res = await fetch(wheel.url);
    if (!res.ok) throw new Error(`${wheel.url}: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    if (sha256 !== wheel.digests.sha256) throw new Error(`${wheel.filename}: sha256 mismatch (got ${sha256})`);

    fs.mkdirSync(path.join(LIBS, 'wheels'), { recursive: true });
    fs.writeFileSync(path.join(LIBS, 'wheels', wheel.filename), data);
    console.log(`${name}: downloaded ${wheel.filename}`);
    return wheel.filename;
}

async function vendorWheels() {
    const reqs = requirements();
    const releases = {};
    for (const [name, version] of Object.entries(reqs)) releases[name] = await pypi(name, version);
    for (const [name, parent] of Object.entries(PINNED_BY)) {
        if (!releases[parent]) continue;
        if (reqs[name]) throw new Error(`requirements.txt: don't pin ${name}, its version comes from ${parent}`);
        releases[name] = await pypi(name, pinnedVersion(releases[parent], name));
    }

    const versions = {};
    const wheels = [];
    for (const [name, release] of Object.entries(releases)) {
        versions[name] = release.info.version;
        wheels.push(`/libs/wheels/${await downloadWheel(release)}`);
    }
    return { versions, wheels };
}

const npm = npmVersions();
fs.rmSync(LIBS, { recursive: true, force: true });
vendorMediabunny();
vendorPyodide();
const python = await vendorWheels();

const vendor = {
    versions: { ...npm, ...python.versions },
    // scripts/package.mjs renames it for builds whose store won't take a zip
    stdlib: '/libs/pyodide/python_stdlib.zip',
    wheels: python.wheels,
};
fs.writeFileSync(
    path.join(LIBS, 'vendor.js'),
    `// Generated by scripts/vendor.mjs, do not edit.\nself.VENDOR = ${JSON.stringify(vendor, null, 4)};\n`,
);
console.log('\nlibs/ vendored:');
for (const [name, version] of Object.entries(vendor.versions)) console.log(`  ${name} ${version}`);
