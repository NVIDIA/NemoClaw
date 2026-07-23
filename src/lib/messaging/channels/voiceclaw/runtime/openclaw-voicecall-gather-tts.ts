// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Runtime-only compatibility patch for the pinned OpenClaw voice-call plugin.
// Twilio trial accounts cannot use Media Streams, so VoiceClaw synthesizes
// NVIDIA speech offline and lets Twilio Gather play it from the existing
// webhook server. The OpenClaw installation remains read-only.
//
// Removal criterion: delete this preload and its VoiceClaw manifest entry once
// the pinned voice-call plugin supports core TTS through TwiML <Play>.

var crypto = require("node:crypto");
var Module = require("node:module");
var createHash = require("node:crypto").createHash;

var REVIEWED_TWILIO_SHA256 = "3daf00a391790b792b0e89518e0dc9ebc4e79c3cd009178721002c9c7460ddeb";
var REVIEWED_RUNTIME_ENTRY_SHA256 =
  "848bd5ee749718ebe39a3e260d8c046f4c21ca56bb03203c82c553777ee23411";
var GATHER_TTS_SYMBOL_NAME = "nemoclaw.voiceclaw.gather-tts";
var GATHER_TTS_QUERY_KEY = "__voiceclaw_tts";
var DEFAULT_AUDIO_TTL_MS = 120_000;
var DEFAULT_MAX_AUDIO_ENTRIES = 32;
var DEFAULT_MAX_AUDIO_BYTES = 16 * 1024 * 1024;

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

function buildMulawWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    throw new Error("VoiceClaw Gather TTS produced no audio");
  }
  var header = Buffer.alloc(58);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(50 + audio.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(18, 16);
  header.writeUInt16LE(7, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(8_000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.writeUInt16LE(0, 36);
  header.write("fact", 38, "ascii");
  header.writeUInt32LE(4, 42);
  header.writeUInt32LE(audio.length, 46);
  header.write("data", 50, "ascii");
  header.writeUInt32LE(audio.length, 54);
  return Buffer.concat([header, audio]);
}

function createGatherTtsBridge(options = {}) {
  var now = options.now ?? Date.now;
  var randomBytes = options.randomBytes ?? crypto.randomBytes;
  var ttlMs = options.ttlMs ?? DEFAULT_AUDIO_TTL_MS;
  var maxEntries = options.maxEntries ?? DEFAULT_MAX_AUDIO_ENTRIES;
  var maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  var entries = new Map();

  function prune() {
    var currentTime = now();
    for (var [token, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(token);
    }
    while (entries.size >= maxEntries) {
      var oldest = entries.keys().next().value;
      if (!oldest) break;
      entries.delete(oldest);
    }
  }

  return {
    store(audio, publicUrl) {
      if (!Buffer.isBuffer(audio) || audio.length === 0 || audio.length > maxAudioBytes) {
        throw new Error("VoiceClaw Gather TTS audio is empty or exceeds the memory limit");
      }
      prune();
      var token = randomBytes(32).toString("hex");
      entries.set(token, {
        body: buildMulawWav(audio),
        expiresAt: now() + ttlMs,
      });
      var audioUrl = new URL(publicUrl);
      audioUrl.searchParams.set(GATHER_TTS_QUERY_KEY, token);
      return audioUrl.toString();
    },
    resolve(url, method = "GET") {
      var token = url.searchParams.get(GATHER_TTS_QUERY_KEY);
      if (!token) return null;
      var entry = entries.get(token);
      if (!entry || entry.expiresAt <= now()) {
        if (entry) entries.delete(token);
        return { statusCode: 404, body: "Not Found" };
      }
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": String(entry.body.length),
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        },
        body: method === "HEAD" ? undefined : entry.body,
      };
    },
    size() {
      return entries.size;
    },
  };
}

function isVoiceCallChunk(url, prefix) {
  try {
    var pathname = new URL(url).pathname;
    return (
      pathname.includes("/@openclaw/voice-call/dist/") &&
      pathname.split("/").pop().startsWith(prefix)
    );
  } catch (_error) {
    return false;
  }
}

function patchTwilioSource(source, integrity = sha256Hex(source)) {
  if (integrity !== REVIEWED_TWILIO_SHA256) return source;
  var anchor =
    '\t\tconsole.warn("[voice-call] Using TwiML <Say> fallback - telephony TTS not configured or media stream not active");';
  if (!source.includes(anchor)) return source;
  var gatherTts = [
    "\t\tconst voiceClawGatherTts = globalThis[Symbol.for(" +
      JSON.stringify(GATHER_TTS_SYMBOL_NAME) +
      ")];",
    "\t\tif (this.ttsProvider && this.currentPublicUrl && voiceClawGatherTts?.store) try {",
    "\t\t\tconst mulawAudio = await this.ttsProvider.synthesizeForTelephony(input.text);",
    "\t\t\tconst audioUrl = voiceClawGatherTts.store(mulawAudio, this.currentPublicUrl);",
    '\t\t\tconst twiml = `<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Play>${escapeXml(audioUrl)}</Play>",
    '  <Gather input="speech" speechTimeout="auto" action="${escapeXml(webhookUrl)}" method="POST">',
    "    <Say>.</Say>",
    "  </Gather>",
    "</Response>`;",
    '\t\t\tconsole.log("[voice-call] Using VoiceClaw NVIDIA TTS through TwiML <Play>");',
    '\t\t\tawait this.updateLiveCallTwiml(input.providerCallId, twiml, "playTts");',
    "\t\t\treturn;",
    "\t\t} catch (err) {",
    '\t\t\tconsole.warn("[voice-call] VoiceClaw Gather TTS failed; using TwiML <Say> fallback:", err instanceof Error ? err.message : err);',
    "\t\t}",
    '\t\tconsole.warn("[voice-call] Using TwiML <Say> fallback - telephony TTS not configured or media stream not active");',
  ].join("\n");
  return source.replace(anchor, gatherTts);
}

function patchRuntimeEntrySource(source, integrity = sha256Hex(source)) {
  if (integrity !== REVIEWED_RUNTIME_ENTRY_SHA256) return source;
  var routeAnchor = "\t\tconst url = buildRequestUrl(req.url);";
  var initAnchor = '\t\tif (provider.name === "twilio" && config.streaming?.enabled) {';
  var listenAnchor =
    '\tif (ctx.provider?.name !== "twilio") return true;\n\tif (!ctx.config.streaming.enabled) return true;';
  if (
    !source.includes(routeAnchor) ||
    !source.includes(initAnchor) ||
    !source.includes(listenAnchor)
  ) {
    return source;
  }

  var withRoute = source.replace(
    routeAnchor,
    [
      routeAnchor,
      "\t\tconst voiceClawGatherTts = globalThis[Symbol.for(" +
        JSON.stringify(GATHER_TTS_SYMBOL_NAME) +
        ")];",
      "\t\tconst voiceClawGatherAudio = voiceClawGatherTts?.resolve?.(url, req.method);",
      "\t\tif (voiceClawGatherAudio) {",
      '\t\t\tif (voiceClawGatherAudio.statusCode === 200) console.log(`[voice-call] VoiceClaw Gather TTS audio served to Twilio (method=${req.method ?? "GET"})`);',
      "\t\t\treturn voiceClawGatherAudio;",
      "\t\t}",
    ].join("\n"),
  );
  var withInitialization = withRoute
    .replace(
      initAnchor,
      [
        '\t\tif (provider.name === "twilio") {',
        "\t\t\tconst voiceClawStreamingEnabled = config.streaming?.enabled;",
      ].join("\n"),
    )
    .replace(
      "\t\t\tconst mediaHandler = webhookServer.getMediaStreamHandler();",
      [
        "\t\t\tconst mediaHandler = voiceClawStreamingEnabled",
        "\t\t\t\t? webhookServer.getMediaStreamHandler()",
        "\t\t\t\t: null;",
      ].join("\n"),
    );
  return withInitialization.replace(
    listenAnchor,
    [
      '\tif (ctx.provider?.name !== "twilio") return true;',
      "\tif (globalThis[Symbol.for(" +
        JSON.stringify(GATHER_TTS_SYMBOL_NAME) +
        ")] && !ctx.config.streaming.enabled) return false;",
      "\tif (!ctx.config.streaming.enabled) return true;",
    ].join("\n"),
  );
}

function createVoiceCallGatherTtsHooks(hash = sha256Hex) {
  return {
    load(url, context, nextLoad) {
      var result = nextLoad(url, context);
      if (result?.format !== "module") return result;
      var source = decodeSource(result.source);
      if (source === null) return result;
      var integrity = hash(source);
      var patched = isVoiceCallChunk(url, "twilio-")
        ? patchTwilioSource(source, integrity)
        : isVoiceCallChunk(url, "runtime-entry-")
          ? patchRuntimeEntrySource(source, integrity)
          : source;
      return patched === source ? result : { ...result, source: patched };
    },
  };
}

function installVoiceCallGatherTtsPatch(options = {}) {
  if (typeof Module.registerHooks !== "function") return false;
  var symbol = Symbol.for(GATHER_TTS_SYMBOL_NAME);
  globalThis[symbol] ??= createGatherTtsBridge(options.bridgeOptions);
  Module.registerHooks(createVoiceCallGatherTtsHooks(options.hash ?? sha256Hex));
  return true;
}

export {
  buildMulawWav,
  createGatherTtsBridge,
  createVoiceCallGatherTtsHooks,
  GATHER_TTS_QUERY_KEY,
  GATHER_TTS_SYMBOL_NAME,
  installVoiceCallGatherTtsPatch,
  patchRuntimeEntrySource,
  patchTwilioSource,
  REVIEWED_RUNTIME_ENTRY_SHA256,
  REVIEWED_TWILIO_SHA256,
};

if ((process.env.NODE_OPTIONS ?? "").includes("openclaw-voicecall-gather-tts")) {
  installVoiceCallGatherTtsPatch();
}
