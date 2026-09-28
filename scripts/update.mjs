// Bumps every dependency to its latest release, then rebuilds libs/.
//   npm packages in package.json      -> latest on npm (pinned exactly)
//   wheels in requirements.txt        -> latest on PyPI (yt-dlp-ejs follows yt-dlp's pin)
//
// Usage: npm run update
// Then reload the extension and try a download before committing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const REQS = path.join(ROOT, 'requirements.txt');

const npmDeps = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies);
// vendor runs once below, after the Python pins are bumped too, so skip the postinstall run
execFileSync('npm', ['install', '--save-exact', '--ignore-scripts', ...npmDeps.map((name) => `${name}@latest`)], {
    cwd: ROOT,
    stdio: 'inherit',
});

let reqs = fs.readFileSync(REQS, 'utf8');
for (const [line, name, version] of reqs.matchAll(/^([A-Za-z0-9._-]+)\s*==\s*([^\s;#]+)/gm)) {
    const res = await fetch(`https://pypi.org/pypi/${name}/json`);
    if (!res.ok) throw new Error(`PyPI: ${name}: HTTP ${res.status}`);
    const latest = (await res.json()).info.version;
    if (latest !== version) {
        reqs = reqs.replace(line, `${name}==${latest}`);
        console.log(`${name}: ${version} -> ${latest}`);
    }
}
fs.writeFileSync(REQS, reqs);

execFileSync(process.execPath, [path.join(import.meta.dirname, 'vendor.mjs')], { cwd: ROOT, stdio: 'inherit' });
