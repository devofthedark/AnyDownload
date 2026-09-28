// Mediabunny's encoder extensions (mp3/aac/flac) embed their encoder worker as a string and
// start it from a blob: URL. The extension CSP only allows `worker-src 'self'` (MV3 doesn't
// permit blob: there), so those workers fail to load. This moves each embedded worker into
// its own file under libs/ and points the library at it.
//
// Re-run after updating the encoder libs:  node scripts/unblob-encoder-workers.mjs
// Already-patched libs are left alone.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const LIBS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'libs');

// the string literal starting at `start` (a quote or backtick), as source text
function literalAt(src, start) {
    const q = src[start];
    for (let i = start + 1; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
            throw new Error('worker source is a template literal with substitutions');
        }
        if (src[i] === q) return src.slice(start, i + 1);
    }
    throw new Error('unterminated string literal');
}

for (const codec of ['mp3', 'aac', 'flac']) {
    const libFile = path.join(LIBS, `mediabunny-${codec}-encoder.js`);
    const workerName = `mediabunny-${codec}-encoder.worker.js`;
    let src = fs.readFileSync(libFile, 'utf8');

    const staticCall = `return Promise.resolve(new Worker(${JSON.stringify(`/libs/${workerName}`)}))`;
    if (src.includes(staticCall)) {
        console.log(`${codec}: already patched, skipping`);
        continue;
    }
    // async function inlineWorker(scriptText) { if (typeof Worker !== "undefined" && ...
    // (or the minified `async function y(g){if(typeof Worker<"u"&&...`)
    const factory = src.match(/async function (\w+)\(\w+\)\s*\{\s*if\s*\(typeof Worker\s*(?:<\s*"u"|!==?\s*"undefined")/);
    if (!factory) throw new Error(`${codec}: blob worker factory not found`);
    const call = new RegExp(`return ${factory[1]}\\(\\s*(?=['"\`])`).exec(src);
    if (!call) throw new Error(`${codec}: found factory ${factory[1]} but not its call site`);

    const litStart = call.index + call[0].length;
    const literal = literalAt(src, litStart);
    const callEnd = /^\s*\)/.exec(src.slice(litStart + literal.length));
    if (!callEnd) throw new Error(`${codec}: unexpected call shape`);
    const workerSrc = vm.runInNewContext(literal);

    fs.writeFileSync(path.join(LIBS, workerName), workerSrc);
    src = src.slice(0, call.index) + staticCall + src.slice(litStart + literal.length + callEnd[0].length);
    fs.writeFileSync(libFile, src);
    console.log(`${codec}: wrote libs/${workerName} (${workerSrc.length} bytes), patched ${path.basename(libFile)}`);
}
