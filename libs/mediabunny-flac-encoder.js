/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
"use strict";
var MediabunnyFlacEncoder = (() => {
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

  // packages/flac-encoder/src/index.ts
  var index_exports = {};
  __export(index_exports, {
    registerFlacEncoder: () => registerFlacEncoder
  });
  var import_mediabunny2 = __toESM(require_mediabunny());

  // packages/flac-encoder/src/encoder.ts
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

  // packages/flac-encoder/src/encode.worker.ts
  function Worker2() {
    return Promise.resolve(new Worker("/libs/mediabunny-flac-encoder.worker.js"));
  }

  // packages/flac-encoder/src/encoder.ts
  var FLAC_SAMPLE_RATES = [
    8e3,
    16e3,
    22050,
    24e3,
    32e3,
    44100,
    48e3,
    88200,
    96e3,
    176400,
    192e3
  ];
  var FlacEncoder = class extends import_mediabunny.CustomAudioEncoder {
    constructor() {
      super(...arguments);
      this.worker = null;
      this.workerError = null;
      this.nextMessageId = 0;
      this.pendingMessages = /* @__PURE__ */ new Map();
      this.ctx = null;
      this.chunkMetadata = {};
      this.description = null;
      this.nextTimestampInSamples = null;
    }
    static supports(codec, config) {
      return codec === "flac" && config.numberOfChannels >= 1 && config.numberOfChannels <= 8 && FLAC_SAMPLE_RATES.includes(config.sampleRate);
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
          onError(new Error(event.message || "FLAC encoder worker failed to load or crashed."));
        });
      } else {
        const nodeWorker = this.worker;
        nodeWorker.on("message", onMessage);
        nodeWorker.on("error", onError);
      }
    }
    resetInternalState() {
      this.nextTimestampInSamples = null;
      this.chunkMetadata = {
        decoderConfig: {
          codec: "flac",
          numberOfChannels: this.config.numberOfChannels,
          sampleRate: this.config.sampleRate,
          description: this.description
        }
      };
    }
    async encode(audioSample) {
      if (this.ctx === null) {
        let bitsPerSample;
        switch (audioSample.format) {
          case "u8":
          case "u8-planar":
          case "s16":
          case "s16-planar":
            bitsPerSample = 16;
            break;
          case "s32":
          case "s32-planar":
          case "f32":
          case "f32-planar":
            bitsPerSample = 24;
            break;
          default:
            assertNever(audioSample.format);
            assert(false);
        }
        const result2 = await this.sendCommand({
          type: "init",
          data: {
            numberOfChannels: this.config.numberOfChannels,
            sampleRate: this.config.sampleRate,
            bitsPerSample
          }
        });
        this.ctx = result2.ctx;
        this.description = new Uint8Array(result2.header);
        this.resetInternalState();
      }
      if (this.nextTimestampInSamples === null) {
        this.nextTimestampInSamples = Math.round(audioSample.timestamp * this.config.sampleRate);
      }
      const totalBytes = audioSample.allocationSize({ format: "s32", planeIndex: 0 });
      const audioData = new ArrayBuffer(totalBytes);
      audioSample.copyTo(audioData, { format: "s32", planeIndex: 0 });
      const result = await this.sendCommand({
        type: "encode",
        data: {
          ctx: this.ctx,
          audioData,
          numSamples: audioSample.numberOfFrames
        }
      }, [audioData]);
      this.emitPackets(result.packets);
    }
    async flush() {
      if (this.ctx === null) {
        return;
      }
      const result = await this.sendCommand({ type: "flush", data: { ctx: this.ctx } });
      this.emitPackets(result.packets);
      this.resetInternalState();
    }
    close() {
      this.worker?.terminate();
    }
    emitPackets(packets) {
      assert(this.nextTimestampInSamples !== null);
      for (const p of packets) {
        const data = new Uint8Array(p.encodedData);
        const packet = new import_mediabunny.EncodedPacket(
          data,
          "key",
          this.nextTimestampInSamples / this.config.sampleRate,
          p.samples / this.config.sampleRate
        );
        this.nextTimestampInSamples += p.samples;
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
  var registerFlacEncoder = () => {
    if (registered) {
      return;
    }
    registered = true;
    (0, import_mediabunny.registerEncoder)(FlacEncoder);
  };
  function assert(x) {
    if (!x) {
      throw new Error("Assertion failed.");
    }
  }
  var assertNever = (x) => {
    throw new Error(`Unexpected value: ${x}`);
  };

  // packages/flac-encoder/src/index.ts
  var FLAC_ENCODER_LOADED_SYMBOL = Symbol.for("@mediabunny/flac-encoder loaded");
  if (globalThis[FLAC_ENCODER_LOADED_SYMBOL]) {
    import_mediabunny2.Logging._error(
      "[WARNING]\n@mediabunny/flac-encoder was loaded twice. This will likely cause the encoder not to work correctly. Check if multiple dependencies are importing different versions of @mediabunny/flac-encoder, or if something is being bundled incorrectly."
    );
  }
  globalThis[FLAC_ENCODER_LOADED_SYMBOL] = true;
  return __toCommonJS(index_exports);
})();
if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, MediabunnyFlacEncoder)
