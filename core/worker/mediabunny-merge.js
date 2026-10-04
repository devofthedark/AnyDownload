(function (global) {
    'use strict';

    function mb() {
        var ns = global.Mediabunny;
        if (!ns) {
            throw new Error(
                'error'
            );
        }
        return ns;
    }
    var CONTAINER_FORMATS = {
        mp4: 'Mp4OutputFormat',
        m4a: 'Mp4OutputFormat',
        mov: 'MovOutputFormat',
        webm: 'WebMOutputFormat',
        mkv: 'MkvOutputFormat',
        mka: 'MkvOutputFormat',
        mp3: 'Mp3OutputFormat',
        wav: 'WavOutputFormat',
        ogg: 'OggOutputFormat',
        opus: 'OggOutputFormat',
        flac: 'FlacOutputFormat',
        aac: 'AdtsOutputFormat',
    };

    function formatFor(container) {
        var name = CONTAINER_FORMATS[container];
        if (!name) return null;
        var Ctor = mb()[name];
        return Ctor ? new Ctor() : null;
    }

    function createMerger(dirName, options) {
        dirName = dirName || 'downloads';
        var onProgress = (options || {}).onProgress;
        // where dirName lives: OPFS's root, unless the caller keeps its files elsewhere (see memory-fs.js)
        var getRoot = (options || {}).getRoot || function () { return navigator.storage.getDirectory(); };
        // an AbortSignal to stop the mux under way when it aborts, if the caller has one
        var getSignal = (options || {}).getSignal || function () { return null; };
        var extrasRegistered = false;

        async function dir() {
            var root = await getRoot();
            return root.getDirectoryHandle(dirName, { create: true });
        }

        async function registerExtras() {
            if (extrasRegistered) return;
            extrasRegistered = true;
            var M = mb();
            try {
                if (global.MediabunnyMp3Encoder && !(await M.canEncodeAudio('mp3'))) {
                    global.MediabunnyMp3Encoder.registerMp3Encoder();
                }
                if (global.MediabunnyAacEncoder && !(await M.canEncodeAudio('aac'))) {
                    global.MediabunnyAacEncoder.registerAacEncoder();
                }
                if (global.MediabunnyFlacEncoder && !(await M.canEncodeAudio('flac'))) {
                    global.MediabunnyFlacEncoder.registerFlacEncoder();
                }
            } catch (e) {
                console.warn('[mb] encoder extension registration failed', e);
            }
        }

        async function openInput(handle, name) {
            var M = mb();
            var fileHandle = await handle.getFileHandle(name);
            var file = await fileHandle.getFile();
            return new M.Input({
                source: new M.BlobSource(file),
                formats: M.ALL_FORMATS,
            });
        }

        async function buildTags(handle, tags) {
            var out = {};
            for (var k in tags) {
                if (k !== 'date' && k !== 'coverFrom' && tags[k] != null) out[k] = tags[k];
            }
            if (tags.date) {
                var d = new Date(tags.date);
                if (!isNaN(d.getTime())) out.date = d;
            }
            if (tags.coverFrom) {
                try {
                    var fh = await handle.getFileHandle(tags.coverFrom);
                    var img = await fh.getFile();
                    out.images = [{
                        data: new Uint8Array(await img.arrayBuffer()),
                        mimeType: img.type || 'image/jpeg',
                        kind: 'coverFront',
                    }];
                } catch (e) {
                    console.warn('[mb] cover art unavailable:', tags.coverFrom, e);
                }
            }
            return out;
        }

        // After a failed mux, let go of everything it holds. Above all the output file: while its
        // writable is open the file stays locked, so the worker can't clear the directory and this
        // job's leftovers would get saved along with the next download.
        async function abandon(output, conversions, writable) {
            await Promise.all(conversions.map(function (c) { return c.cancel().catch(function () {}); }));
            if (output) await output.cancel().catch(function () {});
            // only does anything if the output never started, as then nothing has taken the stream
            await writable.abort().catch(function () {});
        }

        return {
            supports: function (container) {
                return formatFor(container) !== null;
            },

            capabilities: async function () {
                await registerExtras();
                var M = mb();
                var containers = Object.keys(CONTAINER_FORMATS).filter(function (c) {
                    return formatFor(c) !== null;
                });
                return {
                    containers: containers,
                    audioCodecs: await M.getEncodableAudioCodecs(),
                    videoCodecs: await M.getEncodableVideoCodecs(),
                };
            },

            probeTracks: async function (name) {
                var input = await openInput(await dir(), name);
                return {
                    video: !!(await input.getPrimaryVideoTrack()),
                    audio: !!(await input.getPrimaryAudioTrack()),
                };
            },

            probeAudio: async function (name) {
                var handle = await dir();
                var input = await openInput(handle, name);
                var track = await input.getPrimaryAudioTrack();
                if (!track) return null;
                return {
                    codec: track.codec,
                    sampleRate: track.sampleRate,
                    numberOfChannels: track.numberOfChannels,
                };
            },

            mux: async function (opts) {
                await registerExtras();
                var M = mb();
                var sources = opts.sources;
                var outputName = opts.outputName;

                var format = formatFor(opts.container);
                if (!format) {
                    throw new Error('no Mediabunny output format for ".' + opts.container + '"');
                }
                for (var s = 0; s < sources.length; s++) {
                    if (sources[s].name === outputName) {
                        throw new Error('output "' + outputName + '" collides with an input');
                    }
                }

                var signal = getSignal();
                if (signal) signal.throwIfAborted();

                var handle = await dir();
                var outHandle = await handle.getFileHandle(outputName, { create: true });
                var writable = await outHandle.createWritable();
                var output = null;
                var conversions = [];
                // cancelling the conversions makes execute() below throw, which abandons the output
                function stop() {
                    conversions.forEach(function (c) { c.cancel().catch(function () {}); });
                }
                if (signal) signal.addEventListener('abort', stop);

                try {
                    output = new M.Output({
                        format: format,
                        target: new M.StreamTarget(writable, { chunked: true }),
                    });

                    if (opts.tags) {
                        output.setMetadataTags(await buildTags(handle, opts.tags));
                    }

                    var progress = new Array(sources.length).fill(0);
                    var reencoding = [];
                    function report(p) {
                        if (onProgress) {
                            onProgress({ jobId: opts.jobId, label: opts.label, reencoding: reencoding, progress: p });
                        }
                    }

                    for (var i = 0; i < sources.length; i++) {
                        var src = sources[i];
                        var audioOpts = { discard: !src.audio };
                        if (src.audio && src.audioCodec) audioOpts.codec = src.audioCodec;
                        if (src.audio && src.audioBitrate) audioOpts.bitrate = src.audioBitrate;

                        var videoOpts = { discard: !src.video };
                        if (src.video && src.videoCodec) videoOpts.codec = src.videoCodec;

                        var conversion = await M.Conversion.init({
                            input: await openInput(handle, src.name),
                            output: output,
                            composable: true, // this conversion does not own the Output
                            video: videoOpts,
                            audio: audioOpts,
                        });
                        conversions.push(conversion);

                        if (!conversion.isValid) {
                            var why = conversion.discardedTracks
                                .map(function (t) {
                                    return ((t.track && t.track.type) || '?') + ': ' + t.reason;
                                })
                                .join('; ');
                            throw new Error(
                                'cannot mux "' + src.name + '" into .' + opts.container + ' — ' + why
                            );
                        }

                        // Mediabunny copies a track as-is unless its codec doesn't fit the container
                        // or we ask for a different codec/bitrate; mirror that check so the UI can tell
                        // a quick remux apart from a slow re-encode.
                        for (var t = 0; t < conversion.utilizedTracks.length; t++) {
                            var track = conversion.utilizedTracks[t];
                            var trackOpts = track.type === 'video' ? videoOpts : audioOpts;
                            var supported = track.type === 'video'
                                ? format.getSupportedVideoCodecs()
                                : format.getSupportedAudioCodecs();
                            var codec = await track.getCodec();
                            if (!supported.includes(codec) || (trackOpts.codec && trackOpts.codec !== codec) || trackOpts.bitrate) {
                                reencoding.push({ type: track.type, from: codec, to: trackOpts.codec || null });
                            }
                        }

                        if (onProgress) {
                            (function (index) {
                                conversion.onProgress = function (p) {
                                    progress[index] = p;
                                    var total = progress.reduce(function (a, b) { return a + b; }, 0);
                                    report(total / progress.length);
                                };
                            })(i);
                        }
                    }

                    // aborted while setting up, when stop() could miss conversions made after it ran
                    if (signal) signal.throwIfAborted();
                    report(0);
                    await output.start();

                    for (var until = 1; ; until += 1) {
                        await Promise.all(
                            conversions.map(function (c) { return c.execute({ until: until }); })
                        );
                        var done = conversions.every(function (c) { return c.state === 'done'; });
                        if (done) break;
                    }

                    await output.finalize();
                } catch (err) {
                    await abandon(output, conversions, writable);
                    throw err;
                } finally {
                    if (signal) signal.removeEventListener('abort', stop);
                }

                var written = await (await handle.getFileHandle(outputName)).getFile();
                return written.size;
            },
        };
    }

    global.createMerger = createMerger;
})(globalThis);