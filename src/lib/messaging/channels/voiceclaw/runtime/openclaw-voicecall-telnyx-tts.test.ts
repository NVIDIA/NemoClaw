// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildMulawWav,
  createVoiceCallTelnyxTtsHooks,
  patchRuntimeEntrySource,
  patchTelnyxSource,
  REVIEWED_RUNTIME_ENTRY_SHA256,
  REVIEWED_TELNYX_SHA256,
} from "./openclaw-voicecall-telnyx-tts";

const TELNYX_FIXTURE = [
  "\tasync initiateCall(input) {",
  "\t\tconst body = {",
  "\t\t\ttimeout_secs: 30,",
  "\t\t};",
  "\t}",
  "\tasync playTts(input) {",
  "\t\tawait this.apiRequest(`/calls/${input.providerCallId}/actions/speak`, {",
  "\t\t\tcommand_id: crypto.randomUUID(),",
  "\t\t\tpayload: input.text,",
  '\t\t\tvoice: input.voice || "female",',
  '\t\t\tlanguage: input.locale || "en-US"',
  "\t\t});",
  "\t}",
  "\tasync startListening(input) {",
  "\t\tawait this.apiRequest(`/calls/${input.providerCallId}/actions/transcription_start`, {",
  "\t\t\tcommand_id: crypto.randomUUID(),",
  '\t\t\tlanguage: input.language || "en"',
  "\t\t});",
  "\t}",
].join("\n");

const RUNTIME_FIXTURE = [
  '\t\tif (provider.name === "twilio" && config.streaming?.enabled) {',
  "\t\t\tconst twilioProvider = provider;",
  "\t\t\tif (ttsRuntime?.textToSpeechTelephony) try {",
  "\t\t\t\tconst ttsProvider = createTelephonyTtsProvider({});",
  "\t\t\t\ttwilioProvider.setTTSProvider(ttsProvider);",
  "\t\t\t} catch (err) {}",
  "\t\t\tconst mediaHandler = webhookServer.getMediaStreamHandler();",
  "\t\t\tif (mediaHandler) {",
  "\t\t\t\ttwilioProvider.setMediaStreamHandler(mediaHandler);",
  '\t\t\t\tlog.info("[voice-call] Media stream handler wired to provider");',
  "\t\t\t}",
  "\t\t}",
].join("\n");

describe("VoiceClaw Telnyx NVIDIA TTS preload", () => {
  it("wraps 8 kHz mu-law audio in a Telnyx playback WAV (#6387)", () => {
    const wav = buildMulawWav(Buffer.from([0xff, 0x7f]));

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(7);
    expect(wav.readUInt32LE(24)).toBe(8_000);
    expect(wav.toString("ascii", 38, 42)).toBe("fact");
    expect(wav.toString("ascii", 50, 54)).toBe("data");
    expect(wav.readUInt32LE(54)).toBe(2);
    expect([...wav.subarray(58)]).toEqual([0xff, 0x7f]);
  });

  it("rejects empty or oversized playback audio (#6387)", () => {
    expect(() => buildMulawWav(Buffer.alloc(0))).toThrow("empty or exceeds");
    expect(() => buildMulawWav(Buffer.alloc(2), 1)).toThrow("empty or exceeds");
  });

  it("uses NVIDIA telephony TTS and inline Telnyx playback in the reviewed chunk (#6387)", () => {
    const patched = patchTelnyxSource(TELNYX_FIXTURE, REVIEWED_TELNYX_SHA256);

    expect(patched).toContain("this.ttsProvider.synthesizeForTelephony(input.text)");
    expect(patched).toContain("/actions/playback_start");
    expect(patched).toContain('audio_type: "wav"');
    expect(patched).toContain('playback_content: wav.toString("base64")');
  });

  it("selects Telnyx inbound speech-to-text in the reviewed chunk (#6387)", () => {
    const patched = patchTelnyxSource(TELNYX_FIXTURE, REVIEWED_TELNYX_SHA256);

    expect(patched).toContain('transcription_engine: "Telnyx"');
    expect(patched).toContain('transcription_tracks: "inbound"');
  });

  it("extends the Telnyx outbound answer timeout to 120 seconds (#6387)", () => {
    const patched = patchTelnyxSource(TELNYX_FIXTURE, REVIEWED_TELNYX_SHA256);

    expect(patched).toContain("timeout_secs: 120");
    expect(patched).not.toContain("timeout_secs: 30");
  });

  it("initializes telephony TTS for Telnyx without enabling media streaming (#6387)", () => {
    const patched = patchRuntimeEntrySource(RUNTIME_FIXTURE, REVIEWED_RUNTIME_ENTRY_SHA256);

    expect(patched).toContain('|| provider.name === "telnyx"');
    expect(patched).toContain("const voiceProvider = provider");
    expect(patched).toContain("voiceProvider.setTTSProvider(ttsProvider)");
    expect(patched).toContain('if (provider.name === "twilio")');
  });

  it("leaves unreviewed voice-call chunks unchanged (#6387)", () => {
    expect(patchTelnyxSource(TELNYX_FIXTURE, "0".repeat(64))).toBe(TELNYX_FIXTURE);
    expect(patchRuntimeEntrySource(RUNTIME_FIXTURE, "0".repeat(64))).toBe(RUNTIME_FIXTURE);
  });

  it("rewrites only reviewed installed voice-call modules (#6387)", () => {
    const hooks = createVoiceCallTelnyxTtsHooks((source) =>
      source === TELNYX_FIXTURE ? REVIEWED_TELNYX_SHA256 : REVIEWED_RUNTIME_ENTRY_SHA256,
    );
    const nextLoad = vi.fn((_url: string) => ({ format: "module", source: TELNYX_FIXTURE }));
    const url =
      "file:///sandbox/.openclaw/npm/projects/test/node_modules/@openclaw/voice-call/dist/telnyx-fixture.js";

    const result = hooks.load(url, {}, nextLoad);

    expect(result).toMatchObject({
      format: "module",
      source: expect.stringContaining("playback_content"),
    });
  });
});
