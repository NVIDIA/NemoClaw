// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Runtime-only compatibility patch for the pinned OpenClaw voice-call plugin.
// VoiceClaw synthesizes NVIDIA speech offline, wraps the 8 kHz mu-law result in
// WAV, and sends it through Telnyx Call Control playback. The OpenClaw
// installation remains read-only.
//
// Removal criterion: delete this preload and its VoiceClaw manifest entry once
// the pinned voice-call plugin supports core TTS through Telnyx playback.

var Module = require("node:module");
var createHash = require("node:crypto").createHash;

var REVIEWED_TELNYX_SHA256 = "abb6170a407e03c7be1cdec0d6fea97cf07af52e7b23b6f982aef59b1b380282";
var REVIEWED_RUNTIME_ENTRY_SHA256 =
  "848bd5ee749718ebe39a3e260d8c046f4c21ca56bb03203c82c553777ee23411";
var TELNYX_TTS_SYMBOL_NAME = "nemoclaw.voiceclaw.telnyx-tts";
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

function warnVoiceClawPatch(message) {
  try {
    process.stderr.write(`[channels] VoiceClaw Telnyx TTS warning: ${message}\n`);
  } catch (_error) {
    // Best-effort diagnostic only.
  }
}

function buildMulawWav(audio, maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES) {
  if (!Buffer.isBuffer(audio) || audio.length === 0 || audio.length > maxAudioBytes) {
    throw new Error("VoiceClaw Telnyx TTS audio is empty or exceeds the memory limit");
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

function patchTelnyxSource(source, integrity = sha256Hex(source)) {
  if (integrity !== REVIEWED_TELNYX_SHA256) return source;
  var playAnchor = [
    "\tasync playTts(input) {",
    "\t\tawait this.apiRequest(`/calls/${input.providerCallId}/actions/speak`, {",
    "\t\t\tcommand_id: crypto.randomUUID(),",
    "\t\t\tpayload: input.text,",
    '\t\t\tvoice: input.voice || "female",',
    '\t\t\tlanguage: input.locale || "en-US"',
    "\t\t});",
    "\t}",
  ].join("\n");
  var listenAnchor = [
    "\tasync startListening(input) {",
    "\t\tawait this.apiRequest(`/calls/${input.providerCallId}/actions/transcription_start`, {",
    "\t\t\tcommand_id: crypto.randomUUID(),",
    '\t\t\tlanguage: input.language || "en"',
    "\t\t});",
    "\t}",
  ].join("\n");
  var dialTimeoutAnchor = "\t\t\ttimeout_secs: 30,";
  if (
    !source.includes(playAnchor) ||
    !source.includes(listenAnchor) ||
    !source.includes(dialTimeoutAnchor)
  ) {
    return source;
  }

  var playReplacement = [
    "\tsetTTSProvider(provider) {",
    "\t\tthis.ttsProvider = provider;",
    "\t}",
    "\tasync playTts(input) {",
    '\t\tif (!this.ttsProvider) throw new Error("VoiceClaw NVIDIA TTS is unavailable for Telnyx playback");',
    "\t\tconst mulawAudio = await this.ttsProvider.synthesizeForTelephony(input.text);",
    "\t\tconst voiceClawTelnyxTts = globalThis[Symbol.for(" +
      JSON.stringify(TELNYX_TTS_SYMBOL_NAME) +
      ")];",
    "\t\tconst wav = voiceClawTelnyxTts?.buildMulawWav?.(mulawAudio);",
    '\t\tif (!wav) throw new Error("VoiceClaw Telnyx TTS WAV conversion is unavailable");',
    "\t\tawait this.apiRequest(`/calls/${input.providerCallId}/actions/playback_start`, {",
    "\t\t\tcommand_id: crypto.randomUUID(),",
    '\t\t\taudio_type: "wav",',
    '\t\t\tplayback_content: wav.toString("base64"),',
    '\t\t\ttarget_legs: "self"',
    "\t\t});",
    "\t}",
  ].join("\n");
  var listenReplacement = [
    "\tasync startListening(input) {",
    "\t\tawait this.apiRequest(`/calls/${input.providerCallId}/actions/transcription_start`, {",
    "\t\t\tcommand_id: crypto.randomUUID(),",
    '\t\t\tlanguage: input.language || "en",',
    '\t\t\ttranscription_engine: "Telnyx",',
    '\t\t\ttranscription_tracks: "inbound"',
    "\t\t});",
    "\t}",
  ].join("\n");
  return source
    .replace(playAnchor, playReplacement)
    .replace(listenAnchor, listenReplacement)
    .replace(dialTimeoutAnchor, "\t\t\ttimeout_secs: 120,");
}

function patchRuntimeEntrySource(source, integrity = sha256Hex(source)) {
  if (integrity !== REVIEWED_RUNTIME_ENTRY_SHA256) return source;
  var initAnchor = '\t\tif (provider.name === "twilio" && config.streaming?.enabled) {';
  var providerAnchor = "\t\t\tconst twilioProvider = provider;";
  var setTtsAnchor = "\t\t\t\ttwilioProvider.setTTSProvider(ttsProvider);";
  var mediaAnchor = [
    "\t\t\tconst mediaHandler = webhookServer.getMediaStreamHandler();",
    "\t\t\tif (mediaHandler) {",
    "\t\t\t\ttwilioProvider.setMediaStreamHandler(mediaHandler);",
    '\t\t\t\tlog.info("[voice-call] Media stream handler wired to provider");',
    "\t\t\t}",
  ].join("\n");
  if (
    !source.includes(initAnchor) ||
    !source.includes(providerAnchor) ||
    !source.includes(setTtsAnchor) ||
    !source.includes(mediaAnchor)
  ) {
    return source;
  }
  return source
    .replace(
      initAnchor,
      '\t\tif ((provider.name === "twilio" && config.streaming?.enabled) || provider.name === "telnyx") {',
    )
    .replace(providerAnchor, "\t\t\tconst voiceProvider = provider;")
    .replace(setTtsAnchor, "\t\t\t\tvoiceProvider.setTTSProvider(ttsProvider);")
    .replace(
      mediaAnchor,
      [
        '\t\t\tif (provider.name === "twilio") {',
        "\t\t\t\tconst mediaHandler = webhookServer.getMediaStreamHandler();",
        "\t\t\t\tif (mediaHandler) {",
        "\t\t\t\t\tvoiceProvider.setMediaStreamHandler(mediaHandler);",
        '\t\t\t\t\tlog.info("[voice-call] Media stream handler wired to provider");',
        "\t\t\t\t}",
        "\t\t\t}",
      ].join("\n"),
    );
}

function createVoiceCallTelnyxTtsHooks(hash = sha256Hex) {
  return {
    load(url, context, nextLoad) {
      var result = nextLoad(url, context);
      if (result?.format !== "module") return result;
      var source = decodeSource(result.source);
      if (source === null) return result;
      var integrity = hash(source);
      var reviewedIntegrity;
      var patched;
      if (isVoiceCallChunk(url, "telnyx-")) {
        reviewedIntegrity = REVIEWED_TELNYX_SHA256;
        patched = patchTelnyxSource(source, integrity);
      } else if (isVoiceCallChunk(url, "runtime-entry-")) {
        reviewedIntegrity = REVIEWED_RUNTIME_ENTRY_SHA256;
        patched = patchRuntimeEntrySource(source, integrity);
      } else {
        return result;
      }
      if (patched === source) {
        warnVoiceClawPatch(
          integrity === reviewedIntegrity
            ? "reviewed voice-call source shape was not recognized; runtime patch skipped"
            : "voice-call source integrity is unreviewed; runtime patch skipped",
        );
        return result;
      }
      return { ...result, source: patched };
    },
  };
}

function installVoiceCallTelnyxTtsPatch(options = {}) {
  if (typeof Module.registerHooks !== "function") {
    warnVoiceClawPatch("synchronous Node module hooks are unavailable; runtime patch skipped");
    return false;
  }
  var symbol = Symbol.for(TELNYX_TTS_SYMBOL_NAME);
  globalThis[symbol] ??= { buildMulawWav };
  Module.registerHooks(createVoiceCallTelnyxTtsHooks(options.hash ?? sha256Hex));
  return true;
}

export {
  buildMulawWav,
  createVoiceCallTelnyxTtsHooks,
  installVoiceCallTelnyxTtsPatch,
  patchRuntimeEntrySource,
  patchTelnyxSource,
  REVIEWED_RUNTIME_ENTRY_SHA256,
  REVIEWED_TELNYX_SHA256,
  TELNYX_TTS_SYMBOL_NAME,
};

if ((process.env.NODE_OPTIONS ?? "").includes("openclaw-voicecall-telnyx-tts")) {
  installVoiceCallTelnyxTtsPatch();
}
