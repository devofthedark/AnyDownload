/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
"use strict";
var MediabunnyAacEncoder = (() => {
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

  // packages/aac-encoder/src/index.ts
  var index_exports = {};
  __export(index_exports, {
    registerAacEncoder: () => registerAacEncoder
  });
  var import_mediabunny2 = __toESM(require_mediabunny());

  // shared/bitstream.ts
  var Bitstream = class _Bitstream {
    constructor(bytes) {
      this.bytes = bytes;
      /** Current offset in bits. */
      this.pos = 0;
    }
    seekToByte(byteOffset) {
      this.pos = 8 * byteOffset;
    }
    readBit() {
      const byteIndex = Math.floor(this.pos / 8);
      const byte = this.bytes[byteIndex] ?? 0;
      const bitIndex = 7 - (this.pos & 7);
      const bit = (byte & 1 << bitIndex) >> bitIndex;
      this.pos++;
      return bit;
    }
    readBits(n) {
      if (n === 1) {
        return this.readBit();
      }
      let result = 0;
      for (let i = 0; i < n; i++) {
        result <<= 1;
        result |= this.readBit();
      }
      return result;
    }
    writeBits(n, value) {
      const end = this.pos + n;
      for (let i = this.pos; i < end; i++) {
        const byteIndex = Math.floor(i / 8);
        let byte = this.bytes[byteIndex];
        const bitIndex = 7 - (i & 7);
        byte &= ~(1 << bitIndex);
        byte |= (value & 1 << end - i - 1) >> end - i - 1 << bitIndex;
        this.bytes[byteIndex] = byte;
      }
      this.pos = end;
    }
    copyBits(n, other) {
      let i = 0;
      for (i; i < n - 7; i += 8) {
        this.writeBits(8, other.readBits(8));
      }
      const leftover = n - i;
      if (leftover > 0) {
        this.writeBits(leftover, other.readBits(leftover));
      }
    }
    readAlignedByte() {
      if (this.pos % 8 !== 0) {
        throw new Error("Bitstream is not byte-aligned.");
      }
      const byteIndex = this.pos / 8;
      const byte = this.bytes[byteIndex] ?? 0;
      this.pos += 8;
      return byte;
    }
    skipBits(n) {
      this.pos += n;
    }
    getBitsLeft() {
      return this.bytes.length * 8 - this.pos;
    }
    clone() {
      const clone = new _Bitstream(this.bytes);
      clone.pos = this.pos;
      return clone;
    }
  };

  // shared/aac-misc.ts
  var aacFrequencyTable = [
    96e3,
    88200,
    64e3,
    48e3,
    44100,
    32e3,
    24e3,
    22050,
    16e3,
    12e3,
    11025,
    8e3,
    7350
  ];
  var aacChannelMap = [-1, 1, 2, 3, 4, 5, 6, 8];
  var parseAacAudioSpecificConfig = (bytes) => {
    if (!bytes || bytes.byteLength < 2) {
      throw new TypeError("AAC description must be at least 2 bytes long.");
    }
    const bitstream = new Bitstream(bytes);
    const objectType = readAacObjectType(bitstream);
    const { frequencyIndex, sampleRate } = readAacSamplingFrequency(bitstream);
    const channelConfiguration = bitstream.readBits(4);
    let numberOfChannels = null;
    if (channelConfiguration >= 1 && channelConfiguration <= 7) {
      numberOfChannels = aacChannelMap[channelConfiguration];
    }
    let coreObjectType = objectType;
    let psPresent = false;
    let outputSampleRate = sampleRate;
    if (objectType === 5 || objectType === 29) {
      psPresent = objectType === 29;
      outputSampleRate = readAacSamplingFrequency(bitstream).sampleRate;
      coreObjectType = readAacObjectType(bitstream);
      if (coreObjectType === 22) {
        bitstream.skipBits(4);
      }
    } else {
      while (bitstream.getBitsLeft() > 15) {
        const searchStart = bitstream.pos;
        if (bitstream.readBits(11) !== 695) {
          bitstream.pos = searchStart + 1;
          continue;
        }
        if (readAacObjectType(bitstream) === 5 && bitstream.readBits(1)) {
          outputSampleRate = readAacSamplingFrequency(bitstream).sampleRate;
          if (bitstream.getBitsLeft() > 11 && bitstream.readBits(11) === 1352) {
            psPresent = !!bitstream.readBits(1);
          }
        }
        break;
      }
    }
    if (numberOfChannels !== null && numberOfChannels > 1) {
      psPresent = false;
    }
    return {
      objectType,
      coreObjectType,
      frequencyIndex,
      channelConfiguration,
      outputSampleRate,
      outputNumberOfChannels: psPresent && numberOfChannels === 1 ? 2 : numberOfChannels
    };
  };
  var readAacObjectType = (bitstream) => {
    const objectType = bitstream.readBits(5);
    return objectType === 31 ? 32 + bitstream.readBits(6) : objectType;
  };
  var readAacSamplingFrequency = (bitstream) => {
    const frequencyIndex = bitstream.readBits(4);
    if (frequencyIndex === 15) {
      return {
        frequencyIndex,
        sampleRate: bitstream.readBits(24)
      };
    }
    return {
      frequencyIndex,
      sampleRate: frequencyIndex < aacFrequencyTable.length ? aacFrequencyTable[frequencyIndex] : null
    };
  };
  var buildAdtsHeaderTemplate = (config) => {
    const header = new Uint8Array(7);
    const bitstream = new Bitstream(header);
    const { coreObjectType, frequencyIndex, channelConfiguration } = config;
    const profile = coreObjectType - 1;
    bitstream.writeBits(12, 4095);
    bitstream.writeBits(1, 0);
    bitstream.writeBits(2, 0);
    bitstream.writeBits(1, 1);
    bitstream.writeBits(2, profile);
    bitstream.writeBits(4, frequencyIndex);
    bitstream.writeBits(1, 0);
    bitstream.writeBits(3, channelConfiguration);
    bitstream.writeBits(1, 0);
    bitstream.writeBits(1, 0);
    bitstream.writeBits(1, 0);
    bitstream.writeBits(1, 0);
    bitstream.skipBits(13);
    bitstream.writeBits(11, 2047);
    bitstream.writeBits(2, 0);
    return { header, bitstream };
  };
  var writeAdtsFrameLength = (bitstream, frameLength) => {
    bitstream.pos = 30;
    bitstream.writeBits(13, frameLength);
  };

  // packages/aac-encoder/src/encoder.ts
  var import_mediabunny = __toESM(require_mediabunny());

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

  // packages/aac-encoder/src/encode.worker.ts
  function Worker2() {
    return Promise.resolve(new Worker("/libs/mediabunny-aac-encoder.worker.js"));
  }

  // packages/aac-encoder/src/encoder.ts
  var AAC_SAMPLE_RATES = [
    96e3,
    88200,
    64e3,
    48e3,
    44100,
    32e3,
    24e3,
    22050,
    16e3,
    12e3,
    11025,
    8e3,
    7350
  ];
  var AacEncoder = class extends import_mediabunny.CustomAudioEncoder {
    constructor() {
      super(...arguments);
      this.worker = null;
      this.workerError = null;
      this.nextMessageId = 0;
      this.pendingMessages = /* @__PURE__ */ new Map();
      this.ctx = 0;
      this.encoderFrameSize = 0;
      this.sampleRate = 0;
      this.numberOfChannels = 0;
      this.chunkMetadata = {};
      this.useAdts = false;
      this.adtsHeaderTemplate = null;
      this.description = null;
      // Accumulate interleaved f32 samples until we have a full frame
      this.pendingBuffer = new Float32Array(2 ** 16);
      this.pendingFrames = 0;
      this.nextSampleTimestampInSamples = null;
      this.nextPacketTimestampInSamples = null;
    }
    static supports(codec, config) {
      return codec === "aac" && config.numberOfChannels >= 1 && config.numberOfChannels <= 8 && AAC_SAMPLE_RATES.includes(config.sampleRate) && config.bitrate !== void 0;
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
          onError(new Error(event.message || "AAC encoder worker failed to load or crashed."));
        });
      } else {
        const nodeWorker = this.worker;
        nodeWorker.on("message", onMessage);
        nodeWorker.on("error", onError);
      }
      assert(this.config.bitrate !== void 0);
      this.sampleRate = this.config.sampleRate;
      this.numberOfChannels = this.config.numberOfChannels;
      const result = await this.sendCommand({
        type: "init",
        data: {
          numberOfChannels: this.config.numberOfChannels,
          sampleRate: this.config.sampleRate,
          bitrate: this.config.bitrate
        }
      });
      this.ctx = result.ctx;
      this.encoderFrameSize = result.frameSize;
      const description = new Uint8Array(result.extradata);
      const aacConfig = this.config.aac;
      this.useAdts = aacConfig?.format === "adts";
      if (this.useAdts) {
        const audioSpecificConfig = parseAacAudioSpecificConfig(description);
        this.adtsHeaderTemplate = buildAdtsHeaderTemplate(audioSpecificConfig);
      }
      this.description = this.useAdts ? null : description;
      this.resetInternalState();
    }
    resetInternalState() {
      this.pendingFrames = 0;
      this.nextSampleTimestampInSamples = null;
      this.nextPacketTimestampInSamples = null;
      this.chunkMetadata = {
        decoderConfig: {
          codec: "mp4a.40.2",
          numberOfChannels: this.config.numberOfChannels,
          sampleRate: this.config.sampleRate,
          ...this.description ? { description: this.description } : {}
        }
      };
    }
    async encode(audioSample) {
      if (this.nextSampleTimestampInSamples === null) {
        this.nextSampleTimestampInSamples = Math.round(audioSample.timestamp * this.sampleRate);
        this.nextPacketTimestampInSamples = this.nextSampleTimestampInSamples;
      }
      const channels = this.numberOfChannels;
      const incomingFrames = audioSample.numberOfFrames;
      const totalBytes = audioSample.allocationSize({ format: "f32", planeIndex: 0 });
      const audioBytes = new Uint8Array(totalBytes);
      audioSample.copyTo(audioBytes, { format: "f32", planeIndex: 0 });
      const incomingData = new Float32Array(audioBytes.buffer);
      const requiredSamples = (this.pendingFrames + incomingFrames) * channels;
      if (requiredSamples > this.pendingBuffer.length) {
        let newSize = this.pendingBuffer.length;
        while (newSize < requiredSamples) {
          newSize *= 2;
        }
        const newBuffer = new Float32Array(newSize);
        newBuffer.set(this.pendingBuffer.subarray(0, this.pendingFrames * channels));
        this.pendingBuffer = newBuffer;
      }
      this.pendingBuffer.set(incomingData, this.pendingFrames * channels);
      this.pendingFrames += incomingFrames;
      while (this.pendingFrames >= this.encoderFrameSize) {
        await this.encodeOneFrame();
      }
    }
    async flush() {
      if (this.pendingFrames > 0) {
        const channels = this.numberOfChannels;
        const frameSize = this.encoderFrameSize;
        const usedSamples = this.pendingFrames * channels;
        const frameSamples = frameSize * channels;
        this.pendingBuffer.fill(0, usedSamples, frameSamples);
        this.pendingFrames = frameSize;
        await this.encodeOneFrame();
      }
      const result = await this.sendCommand({ type: "flush", data: { ctx: this.ctx } });
      this.emitPackets(result.packets);
      this.resetInternalState();
    }
    close() {
      this.worker?.terminate();
    }
    async encodeOneFrame() {
      assert(this.nextSampleTimestampInSamples !== null);
      assert(this.nextPacketTimestampInSamples !== null);
      const channels = this.numberOfChannels;
      const frameSize = this.encoderFrameSize;
      const frameSamples = frameSize * channels;
      const frameData = this.pendingBuffer.slice(0, frameSamples);
      this.pendingFrames -= frameSize;
      if (this.pendingFrames > 0) {
        this.pendingBuffer.copyWithin(0, frameSamples, frameSamples + this.pendingFrames * channels);
      }
      const audioData = frameData.buffer;
      const result = await this.sendCommand({
        type: "encode",
        data: {
          ctx: this.ctx,
          audioData,
          timestamp: this.nextSampleTimestampInSamples
        }
      }, [audioData]);
      this.nextSampleTimestampInSamples += frameSize;
      this.emitPackets(result.packets);
    }
    emitPackets(packets) {
      assert(this.nextPacketTimestampInSamples !== null);
      for (const p of packets) {
        let data = new Uint8Array(p.encodedData);
        if (this.useAdts) {
          assert(this.adtsHeaderTemplate !== null);
          const { header, bitstream } = this.adtsHeaderTemplate;
          const frameLength = header.byteLength + data.byteLength;
          writeAdtsFrameLength(bitstream, frameLength);
          const adtsFrame = new Uint8Array(frameLength);
          adtsFrame.set(header, 0);
          adtsFrame.set(data, header.byteLength);
          data = adtsFrame;
        }
        const packet = new import_mediabunny.EncodedPacket(
          data,
          "key",
          this.nextPacketTimestampInSamples / this.sampleRate,
          p.duration / this.sampleRate
        );
        this.nextPacketTimestampInSamples += p.duration;
        this.onPacket(
          packet,
          this.chunkMetadata
        );
        this.chunkMetadata = {};
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
  var registerAacEncoder = () => {
    if (registered) {
      return;
    }
    registered = true;
    (0, import_mediabunny.registerEncoder)(AacEncoder);
  };
  function assert(x) {
    if (!x) {
      throw new Error("Assertion failed.");
    }
  }

  // packages/aac-encoder/src/index.ts
  var AAC_ENCODER_LOADED_SYMBOL = Symbol.for("@mediabunny/aac-encoder loaded");
  if (globalThis[AAC_ENCODER_LOADED_SYMBOL]) {
    import_mediabunny2.Logging._error(
      "[WARNING]\n@mediabunny/aac-encoder was loaded twice. This will likely cause the encoder not to work correctly. Check if multiple dependencies are importing different versions of @mediabunny/aac-encoder, or if something is being bundled incorrectly."
    );
  }
  globalThis[AAC_ENCODER_LOADED_SYMBOL] = true;
  return __toCommonJS(index_exports);
})();
if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, MediabunnyAacEncoder)
