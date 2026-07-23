// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Runtime-only compatibility patch for OpenClaw PR 112078. VoiceClaw declares
// this preload in its channel manifest, so it is active only when that channel
// is enabled. It overlays the pinned NVIDIA provider entrypoint and manifest in
// memory; the OpenClaw installation remains read-only.
//
// Removal criterion: delete this preload and its VoiceClaw manifest entry once
// the pinned OpenClaw release includes NVIDIA batch HTTP ASR and TTS providers.

var fs = require("node:fs");
var Module = require("node:module");
var path = require("node:path");
var createHash = require("node:crypto").createHash;

var REVIEWED_NVIDIA_INDEX_SHA256 =
  "e6796729ac6d1ffaefdd7cab8906cec6f483653185c9b0e7fcd9813127ffc1bb";
var REVIEWED_NVIDIA_MANIFEST_SHA256 =
  "fea1fcff1e24818de6da10a87ba07a8772be8813730d418c81852c6f821f83c5";
var NVIDIA_INDEX_SUFFIX = "/dist/extensions/nvidia/index.js";
var NVIDIA_MANIFEST_SUFFIX = "/dist/extensions/nvidia/openclaw.plugin.json";
var PRELOAD_ROOT = "/usr/local/lib/nemoclaw/preloads";
var VIRTUAL_ASSETS = {
  "voiceclaw-nvidia-audio-transcription-provider.js":
    "voiceclaw-nvidia-audio-transcription-provider.mjs",
  "voiceclaw-nvidia-speech-config.js": "voiceclaw-nvidia-speech-config.mjs",
  "voiceclaw-nvidia-speech-http.runtime.js": "voiceclaw-nvidia-speech-http.runtime.mjs",
  "voiceclaw-nvidia-speech-provider.js": "voiceclaw-nvidia-speech-provider.mjs",
};
var PATCHED_CONTRACTS = {
  mediaUnderstandingProviders: ["nvidia"],
  speechProviders: ["nvidia"],
};
var PATCHED_MEDIA_METADATA = {
  nvidia: {
    capabilities: ["audio"],
    defaultModels: { audio: "nvidia/parakeet-tdt-0.6b-v2" },
    autoPriority: { audio: 55 },
  },
};

function sha256Hex(source) {
  return createHash("sha256").update(source).digest("hex");
}

function decodeSource(source) {
  if (typeof source === "string") return source;
  if (Buffer.isBuffer(source)) return source.toString("utf8");
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source instanceof ArrayBuffer) return Buffer.from(source).toString("utf8");
  return null;
}

function warnVoiceClawPatch(message) {
  try {
    process.stderr.write(`[channels] VoiceClaw NVIDIA speech warning: ${message}\n`);
  } catch (_error) {
    // Best-effort diagnostic only.
  }
}

function isNvidiaIndexUrl(url) {
  try {
    return new URL(url).pathname.endsWith(NVIDIA_INDEX_SUFFIX);
  } catch (_error) {
    return false;
  }
}

function virtualAssetName(url) {
  try {
    var parsed = new URL(url);
    if (!parsed.pathname.includes("/dist/extensions/nvidia/")) return;
    var name = path.posix.basename(parsed.pathname);
    return Object.prototype.hasOwnProperty.call(VIRTUAL_ASSETS, name) ? name : undefined;
  } catch (_error) {
    return;
  }
}

function patchNvidiaIndexSource(source, integrity = sha256Hex(source)) {
  if (integrity !== REVIEWED_NVIDIA_INDEX_SHA256) return source;
  var importAnchor =
    'import { n as applyNvidiaConfig, t as NVIDIA_DEFAULT_MODEL_REF } from "../../onboard-Dk2KiUua.js";';
  var closeAnchor = "\t}\n});";
  var closeIndex = source.lastIndexOf(closeAnchor);
  if (source.indexOf(importAnchor) === -1 || closeIndex === -1) return source;

  var imports = [
    'import { nvidiaMediaUnderstandingProvider } from "./voiceclaw-nvidia-audio-transcription-provider.js";',
    'import { buildNvidiaSpeechProvider } from "./voiceclaw-nvidia-speech-provider.js";',
  ].join("\n");
  var registered = [
    "\t},",
    "\tregister(api) {",
    "\t\tapi.registerMediaUnderstandingProvider(nvidiaMediaUnderstandingProvider);",
    "\t\tapi.registerSpeechProvider(buildNvidiaSpeechProvider());",
    "\t}",
    "});",
  ].join("\n");

  var withImports = source.replace(importAnchor, `${importAnchor}\n${imports}`);
  closeIndex = withImports.lastIndexOf(closeAnchor);
  return `${withImports.slice(0, closeIndex)}${registered}${withImports.slice(
    closeIndex + closeAnchor.length,
  )}`;
}

function patchNvidiaManifestSource(source, integrity = sha256Hex(source)) {
  if (integrity !== REVIEWED_NVIDIA_MANIFEST_SHA256) return source;
  var manifest;
  try {
    manifest = JSON.parse(source);
  } catch (_error) {
    return source;
  }
  if (!manifest || manifest.id !== "nvidia") return source;
  manifest.contracts = PATCHED_CONTRACTS;
  manifest.mediaUnderstandingProviderMetadata = PATCHED_MEDIA_METADATA;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function loadVirtualSources(assetRoot = PRELOAD_ROOT) {
  var sources = {};
  for (var [virtualName, packagedName] of Object.entries(VIRTUAL_ASSETS)) {
    sources[virtualName] = fs.readFileSync(path.join(assetRoot, packagedName), "utf8");
  }
  return sources;
}

function createNvidiaSpeechHooks(virtualSources, hash = sha256Hex) {
  return {
    resolve(specifier, context, nextResolve) {
      if (
        typeof specifier === "string" &&
        specifier.startsWith("./") &&
        context?.parentURL &&
        (isNvidiaIndexUrl(context.parentURL) || virtualAssetName(context.parentURL))
      ) {
        var candidate = new URL(specifier, context.parentURL).href;
        if (virtualAssetName(candidate)) return { url: candidate, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      var assetName = virtualAssetName(url);
      if (assetName) {
        return {
          format: "module",
          source: virtualSources[assetName],
          shortCircuit: true,
        };
      }
      var result = nextLoad(url, context);
      if (!isNvidiaIndexUrl(url) || result?.format !== "module") return result;
      var source = decodeSource(result.source);
      if (source === null) return result;
      var integrity = hash(source);
      var patched = patchNvidiaIndexSource(source, integrity);
      if (patched === source) {
        warnVoiceClawPatch(
          integrity === REVIEWED_NVIDIA_INDEX_SHA256
            ? "reviewed NVIDIA entrypoint shape was not recognized; runtime patch skipped"
            : "NVIDIA entrypoint integrity is unreviewed; runtime patch skipped",
        );
        return result;
      }
      return { ...result, source: patched };
    },
  };
}

function normalizeFsPath(value) {
  if (value instanceof URL) return value.pathname;
  if (Buffer.isBuffer(value)) return value.toString();
  return typeof value === "string" ? value : "";
}

function installNvidiaManifestOverlay(ioFs = fs, hash = sha256Hex) {
  var originalOpenSync = ioFs.openSync;
  var originalReadFileSync = ioFs.readFileSync;
  var originalCloseSync = ioFs.closeSync;
  var manifestFileDescriptors = new Set();

  ioFs.openSync = function (filePath, ...args) {
    var fd = originalOpenSync.call(this, filePath, ...args);
    if (normalizeFsPath(filePath).replaceAll("\\", "/").endsWith(NVIDIA_MANIFEST_SUFFIX)) {
      manifestFileDescriptors.add(fd);
    }
    return fd;
  };
  ioFs.readFileSync = function (file, options) {
    var result = originalReadFileSync.call(this, file, options);
    if (typeof file !== "number" || !manifestFileDescriptors.has(file)) return result;
    var source = decodeSource(result);
    if (source === null) return result;
    var integrity = hash(source);
    var patched = patchNvidiaManifestSource(source, integrity);
    if (patched === source) {
      warnVoiceClawPatch(
        integrity === REVIEWED_NVIDIA_MANIFEST_SHA256
          ? "reviewed NVIDIA manifest shape was not recognized; manifest overlay skipped"
          : "NVIDIA manifest integrity is unreviewed; manifest overlay skipped",
      );
      return result;
    }
    return typeof result === "string" ? patched : Buffer.from(patched);
  };
  ioFs.closeSync = function (fd) {
    manifestFileDescriptors.delete(fd);
    return originalCloseSync.call(this, fd);
  };

  return function restore() {
    ioFs.openSync = originalOpenSync;
    ioFs.readFileSync = originalReadFileSync;
    ioFs.closeSync = originalCloseSync;
    manifestFileDescriptors.clear();
  };
}

function installOpenClawNvidiaSpeechPatch(options = {}) {
  if (typeof Module.registerHooks !== "function") {
    warnVoiceClawPatch("synchronous Node module hooks are unavailable; runtime patch skipped");
    return false;
  }
  try {
    var virtualSources = options.virtualSources ?? loadVirtualSources(options.assetRoot);
    installNvidiaManifestOverlay(options.fs ?? fs, options.hash ?? sha256Hex);
    Module.registerHooks(createNvidiaSpeechHooks(virtualSources, options.hash ?? sha256Hex));
    return true;
  } catch (error) {
    warnVoiceClawPatch(
      `runtime patch installation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export {
  createNvidiaSpeechHooks,
  installNvidiaManifestOverlay,
  installOpenClawNvidiaSpeechPatch,
  isNvidiaIndexUrl,
  NVIDIA_INDEX_SUFFIX,
  NVIDIA_MANIFEST_SUFFIX,
  patchNvidiaIndexSource,
  patchNvidiaManifestSource,
  REVIEWED_NVIDIA_INDEX_SHA256,
  REVIEWED_NVIDIA_MANIFEST_SHA256,
  VIRTUAL_ASSETS,
  virtualAssetName,
  warnVoiceClawPatch,
};

// Manifest-managed preloads are injected through NODE_OPTIONS. Keeping normal
// imports inert lets the pure helpers be tested without installing global
// module and filesystem hooks in the test worker.
if ((process.env.NODE_OPTIONS ?? "").includes("openclaw-nvidia-speech")) {
  installOpenClawNvidiaSpeechPatch();
}
