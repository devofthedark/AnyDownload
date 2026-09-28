/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
"use strict";
var MediabunnyMp3Encoder = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __commonJS = (cb, mod) => function __require2() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // external-global-plugin:mediabunny
  var require_mediabunny = __commonJS({
    "external-global-plugin:mediabunny"(exports, module) {
      module.exports = Mediabunny;
    }
  });

  // packages/mp3-encoder/src/index.ts
  var index_exports = {};
  __export(index_exports, {
    registerMp3Encoder: () => registerMp3Encoder
  });
  var import_mediabunny = __toESM(require_mediabunny());

  // shared/mp3-misc.ts
  var MP3_FRAME_HEADER_SIZE = 4;
  var SAMPLING_RATES = [44100, 48e3, 32e3];
  var KILOBIT_RATES = [
    // lowSamplingFrequency === 0
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    // layer = 0
    -1,
    32,
    40,
    48,
    56,
    64,
    80,
    96,
    112,
    128,
    160,
    192,
    224,
    256,
    320,
    -1,
    // layer 1
    -1,
    32,
    48,
    56,
    64,
    80,
    96,
    112,
    128,
    160,
    192,
    224,
    256,
    320,
    384,
    -1,
    // layer = 2
    -1,
    32,
    64,
    96,
    128,
    160,
    192,
    224,
    256,
    288,
    320,
    352,
    384,
    416,
    448,
    -1,
    // layer = 3
    // lowSamplingFrequency === 1
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    // layer = 0
    -1,
    8,
    16,
    24,
    32,
    40,
    48,
    56,
    64,
    80,
    96,
    112,
    128,
    144,
    160,
    -1,
    // layer = 1
    -1,
    8,
    16,
    24,
    32,
    40,
    48,
    56,
    64,
    80,
    96,
    112,
    128,
    144,
    160,
    -1,
    // layer = 2
    -1,
    32,
    48,
    56,
    64,
    80,
    96,
    112,
    128,
    144,
    160,
    176,
    192,
    224,
    256,
    -1
    // layer = 3
  ];
  var computeMp3FrameSize = (lowSamplingFrequency, layer, bitrate, sampleRate, padding) => {
    if (layer === 0) {
      return 0;
    } else if (layer === 1) {
      return Math.floor(144 * bitrate / (sampleRate << lowSamplingFrequency)) + padding;
    } else if (layer === 2) {
      return Math.floor(144 * bitrate / sampleRate) + padding;
    } else {
      return (Math.floor(12 * bitrate / sampleRate) + padding) * 4;
    }
  };
  var readMp3FrameHeader = (word, remainingBytes) => {
    const firstByte = word >>> 24;
    const secondByte = word >>> 16 & 255;
    const thirdByte = word >>> 8 & 255;
    const fourthByte = word & 255;
    if (firstByte !== 255 && secondByte !== 255 && thirdByte !== 255 && fourthByte !== 255) {
      return {
        header: null,
        bytesAdvanced: 4
      };
    }
    if (firstByte !== 255) {
      return { header: null, bytesAdvanced: 1 };
    }
    if ((secondByte & 224) !== 224) {
      return { header: null, bytesAdvanced: 1 };
    }
    let lowSamplingFrequency = 0;
    let mpeg25 = 0;
    if (secondByte & 1 << 4) {
      lowSamplingFrequency = secondByte & 1 << 3 ? 0 : 1;
    } else {
      lowSamplingFrequency = 1;
      mpeg25 = 1;
    }
    const mpegVersionId = secondByte >> 3 & 3;
    const layer = secondByte >> 1 & 3;
    const bitrateIndex = thirdByte >> 4 & 15;
    const frequencyIndex = (thirdByte >> 2 & 3) % 3;
    const padding = thirdByte >> 1 & 1;
    const channel = fourthByte >> 6 & 3;
    const modeExtension = fourthByte >> 4 & 3;
    const copyright = fourthByte >> 3 & 1;
    const original = fourthByte >> 2 & 1;
    const emphasis = fourthByte & 3;
    const kilobitRate = KILOBIT_RATES[lowSamplingFrequency * 16 * 4 + layer * 16 + bitrateIndex];
    if (kilobitRate === -1) {
      return { header: null, bytesAdvanced: 1 };
    }
    const bitrate = kilobitRate * 1e3;
    const sampleRate = SAMPLING_RATES[frequencyIndex] >> lowSamplingFrequency + mpeg25;
    const frameLength = computeMp3FrameSize(lowSamplingFrequency, layer, bitrate, sampleRate, padding);
    if (remainingBytes !== null && remainingBytes < frameLength) {
      return { header: null, bytesAdvanced: 1 };
    }
    let audioSamplesInFrame;
    if (mpegVersionId === 3) {
      audioSamplesInFrame = layer === 3 ? 384 : 1152;
    } else {
      if (layer === 3) {
        audioSamplesInFrame = 384;
      } else if (layer === 2) {
        audioSamplesInFrame = 1152;
      } else {
        audioSamplesInFrame = 576;
      }
    }
    return {
      header: {
        totalSize: frameLength,
        mpegVersionId,
        lowSamplingFrequency,
        layer,
        bitrate,
        frequencyIndex,
        sampleRate,
        channel,
        modeExtension,
        copyright,
        original,
        emphasis,
        audioSamplesInFrame
      },
      bytesAdvanced: 1
    };
  };

  // inline-worker:__inline-worker
  async function inlineWorker(scriptText) {
    if (typeof Worker !== "undefined" && typeof Bun === "undefined") {
      const blob = new Blob([scriptText], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url, { type: typeof Deno !== "undefined" ? "module" : void 0 });
      URL.revokeObjectURL(url);
      return worker;
    } else {
      let Worker3;
      try {
        Worker3 = (await import("worker_threads")).Worker;
      } catch {
        Worker3 = __require("worker_threads").Worker;
      }
      const worker = new Worker3(scriptText, { eval: true });
      return worker;
    }
  }

  // packages/mp3-encoder/src/encode.worker.ts
  function Worker2() {
    return Promise.resolve(new Worker("/libs/mediabunny-mp3-encoder.worker.js"));
  }

  // packages/mp3-encoder/src/index.ts
  var MP3_ENCODER_LOADED_SYMBOL = Symbol.for("@mediabunny/mp3-encoder loaded");
  if (globalThis[MP3_ENCODER_LOADED_SYMBOL]) {
    import_mediabunny.Logging._error(
      "[WARNING]\n@mediabunny/mp3-encoder was loaded twice. This will likely cause the encoder not to work correctly. Check if multiple dependencies are importing different versions of @mediabunny/mp3-encoder, or if something is being bundled incorrectly."
    );
  }
  globalThis[MP3_ENCODER_LOADED_SYMBOL] = true;
  var Mp3Encoder = class extends import_mediabunny.CustomAudioEncoder {
    constructor() {
      super(...arguments);
      this.worker = null;
      this.workerError = null;
      this.nextMessageId = 0;
      this.pendingMessages = /* @__PURE__ */ new Map();
      this.buffer = new Uint8Array(2 ** 16);
      this.currentBufferOffset = 0;
      this.currentTimestamp = null;
      this.chunkMetadata = {};
    }
    static supports(codec, config) {
      return codec === "mp3" && (config.numberOfChannels === 1 || config.numberOfChannels === 2) && Object.values(SAMPLING_RATES).some(
        (x) => x === config.sampleRate || x / 2 === config.sampleRate || x / 4 === config.sampleRate
      );
    }
    async init() {
      this.worker = await Worker2();
      const onMessage = (data) => {
        const pending = this.pendingMessages.get(data.id);
        assert(pending !== void 0);
        this.pendingMessages.delete(data.id);
        if (data.success) {
          pending.resolve(data.data);
        } else {
          pending.reject(data.error);
        }
      };
      const onError = (error) => {
        this.workerError = error;
        for (const pending of this.pendingMessages.values()) {
          pending.reject(error);
        }
        this.pendingMessages.clear();
        this.worker?.terminate();
        this.worker = null;
      };
      if (this.worker.addEventListener) {
        this.worker.addEventListener("message", (event) => onMessage(event.data));
        this.worker.addEventListener("error", (event) => {
          onError(new Error(event.message || "MP3 encoder worker failed to load or crashed."));
        });
      } else {
        const nodeWorker = this.worker;
        nodeWorker.on("message", onMessage);
        nodeWorker.on("error", onError);
      }
      assert(this.config.bitrate);
      await this.sendCommand({
        type: "init",
        data: {
          numberOfChannels: this.config.numberOfChannels,
          sampleRate: this.config.sampleRate,
          bitrate: this.config.bitrate
        }
      });
      this.resetInternalState();
    }
    resetInternalState() {
      this.currentBufferOffset = 0;
      this.currentTimestamp = null;
      this.chunkMetadata = {
        decoderConfig: {
          codec: "mp3",
          numberOfChannels: this.config.numberOfChannels,
          sampleRate: this.config.sampleRate
        }
      };
    }
    async encode(audioSample) {
      if (this.currentTimestamp === null) {
        this.currentTimestamp = audioSample.timestamp;
      }
      const sizePerChannel = audioSample.allocationSize({
        format: "s16-planar",
        planeIndex: 0
      });
      const requiredBytes = audioSample.numberOfChannels * sizePerChannel;
      const audioData = new ArrayBuffer(requiredBytes);
      const audioBytes = new Uint8Array(audioData);
      for (let i = 0; i < audioSample.numberOfChannels; i++) {
        audioSample.copyTo(audioBytes.subarray(i * sizePerChannel), {
          format: "s16-planar",
          // LAME wants it in this format
          planeIndex: i
        });
      }
      const result = await this.sendCommand({
        type: "encode",
        data: {
          audioData,
          numberOfFrames: audioSample.numberOfFrames
        }
      }, [audioData]);
      this.digestOutput(new Uint8Array(result.encodedData));
    }
    async flush() {
      const result = await this.sendCommand({ type: "flush" });
      this.digestOutput(new Uint8Array(result.flushedData));
      this.resetInternalState();
    }
    close() {
      this.worker?.terminate();
    }
    /**
     * LAME returns data in chunks, but a chunk doesn't need to contain a full MP3 frame. Therefore, we must accumulate
     * these chunks and extract the MP3 frames only when they're complete.
     */
    digestOutput(bytes) {
      assert(this.currentTimestamp !== null);
      const requiredBufferSize = this.currentBufferOffset + bytes.length;
      if (requiredBufferSize > this.buffer.length) {
        const newSize = 1 << Math.ceil(Math.log2(requiredBufferSize));
        const newBuffer = new Uint8Array(newSize);
        newBuffer.set(this.buffer);
        this.buffer = newBuffer;
      }
      this.buffer.set(bytes, this.currentBufferOffset);
      this.currentBufferOffset = requiredBufferSize;
      let pos = 0;
      while (pos <= this.currentBufferOffset - MP3_FRAME_HEADER_SIZE) {
        const word = new DataView(this.buffer.buffer).getUint32(pos, false);
        const header = readMp3FrameHeader(word, null).header;
        if (!header) {
          break;
        }
        const fits = header.totalSize <= this.currentBufferOffset - pos;
        if (!fits) {
          break;
        }
        const data = this.buffer.slice(pos, pos + header.totalSize);
        const duration = header.audioSamplesInFrame / header.sampleRate;
        this.onPacket(new import_mediabunny.EncodedPacket(data, "key", this.currentTimestamp, duration), this.chunkMetadata);
        this.chunkMetadata = {};
        this.currentTimestamp += duration;
        pos += header.totalSize;
      }
      if (pos > 0) {
        this.buffer.set(this.buffer.subarray(pos, this.currentBufferOffset), 0);
        this.currentBufferOffset -= pos;
      }
    }
    sendCommand(command, transferables) {
      return new Promise((resolve, reject) => {
        if (this.workerError) {
          reject(this.workerError);
          return;
        }
        const id = this.nextMessageId++;
        this.pendingMessages.set(id, {
          resolve,
          reject
        });
        assert(this.worker);
        if (transferables) {
          this.worker.postMessage({ id, command }, transferables);
        } else {
          this.worker.postMessage({ id, command });
        }
      });
    }
  };
  var registered = false;
  var registerMp3Encoder = () => {
    if (registered) {
      return;
    }
    registered = true;
    (0, import_mediabunny.registerEncoder)(Mp3Encoder);
  };
  function assert(x) {
    if (!x) {
      throw new Error("Assertion failed.");
    }
  }
  return __toCommonJS(index_exports);
})();
if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, MediabunnyMp3Encoder)
