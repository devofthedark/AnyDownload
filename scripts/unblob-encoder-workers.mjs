// Mediabunny's encoder extensions (mp3/aac/flac) embed their encoder worker as a string and
// start it from a blob: URL. The extension CSP only allows `worker-src 'self'` (MV3 doesn't
// permit blob: there), so those workers fail to load. This moves each embedded worker into
// its own file next to the library and points the library at it.
//
// Called by scripts/vendor.mjs on freshly copied libs; already-patched libs are left alone.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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

// the codec library compiled into each worker, credited in the worker's header
const ENCODER_LIBS = {
    mp3: 'the LAME MP3 encoder (https://lame.sourceforge.io/), licensed under the GNU LGPL 2.0 or later',
    aac: "FFmpeg's AAC encoder (https://ffmpeg.org/), licensed under the GNU LGPL 2.1 or later",
    flac: 'libFLAC (https://xiph.org/flac/), licensed under the BSD 3-Clause License',
};

// dir: where mediabunny-<codec>-encoder.js lives on disk; urlPrefix: the same dir as the extension serves it
export function unblobEncoderWorkers(dir, urlPrefix) {
    for (const codec of ['mp3', 'aac', 'flac']) {
        const libFile = path.join(dir, `mediabunny-${codec}-encoder.js`);
        const workerName = `mediabunny-${codec}-encoder.worker.js`;
        let src = fs.readFileSync(libFile, 'utf8');

        const staticCall = `return Promise.resolve(new Worker(${JSON.stringify(`${urlPrefix}/${workerName}`)}))`;
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

        // The worker is cut out of an MPL-2.0 file, so it keeps that file's license header
        const header = /^\/\*![^]*?\*\//.exec(src);
        if (!header) throw new Error(`${codec}: no license header to copy to the worker`);
        const notice = `/*!\n * Contains a WebAssembly build of ${ENCODER_LIBS[codec]}.\n * See THIRD_PARTY_LICENSES.txt.\n */`;
        fs.writeFileSync(path.join(dir, workerName), `${header[0]}\n${notice}\n${workerSrc}`);
        src = src.slice(0, call.index) + staticCall + src.slice(litStart + literal.length + callEnd[0].length);
        fs.writeFileSync(libFile, src);
        console.log(`${codec}: split out ${workerName} (${workerSrc.length} bytes)`);
    }
}
