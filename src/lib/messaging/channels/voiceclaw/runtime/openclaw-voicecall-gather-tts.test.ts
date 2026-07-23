// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildMulawWav,
  createGatherTtsBridge,
  createVoiceCallGatherTtsHooks,
  GATHER_TTS_QUERY_KEY,
  patchRuntimeEntrySource,
  patchTwilioSource,
  REVIEWED_RUNTIME_ENTRY_SHA256,
  REVIEWED_TWILIO_SHA256,
} from "./openclaw-voicecall-gather-tts";

const TWILIO_FIXTURE = [
  "async playTts(input) {",
  "\t\tconst webhookUrl = this.callWebhookUrls.get(input.providerCallId);",
  '\t\tconsole.warn("[voice-call] Using TwiML <Say> fallback - telephony TTS not configured or media stream not active");',
  "}",
].join("\n");

const RUNTIME_FIXTURE = [
  "async runWebhookPipeline(req, webhookPath) {",
  "\t\tconst url = buildRequestUrl(req.url);",
  "}",
  "function shouldStartListeningAfterInitialMessage(ctx) {",
  '\tif (ctx.provider?.name !== "twilio") return true;',
  "\tif (!ctx.config.streaming.enabled) return true;",
  "}",
  '\t\tif (provider.name === "twilio" && config.streaming?.enabled) {',
  "\t\t\tconst mediaHandler = webhookServer.getMediaStreamHandler();",
  "\t\t}",
].join("\n");

describe("VoiceClaw Twilio Gather TTS preload", () => {
  it("wraps 8 kHz mu-law audio in a Twilio-compatible WAV container (#6387)", () => {
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

  it("serves short-lived tokenized audio without exposing it at the webhook path (#6387)", () => {
    let now = 1_000;
    const bridge = createGatherTtsBridge({
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 0xab),
      ttlMs: 100,
    });

    const audioUrl = new URL(
      bridge.store(Buffer.from([0xff]), "https://voice.example.test/voice/webhook"),
    );
    const response = bridge.resolve(audioUrl);

    expect(audioUrl.pathname).toBe("/voice/webhook");
    expect(audioUrl.searchParams.get(GATHER_TTS_QUERY_KEY)).toBe("ab".repeat(32));
    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "Content-Type": "audio/wav",
        "X-Content-Type-Options": "nosniff",
      },
      body: expect.any(Buffer),
    });
    expect(bridge.resolve(new URL("https://voice.example.test/voice/webhook"))).toBeNull();

    now += 101;
    expect(bridge.resolve(audioUrl)).toEqual({ statusCode: 404, body: "Not Found" });
  });

  it("bounds the in-memory audio cache before storing another response (#6387)", () => {
    let token = 0;
    const bridge = createGatherTtsBridge({
      randomBytes: () => Buffer.alloc(32, token++),
      maxEntries: 2,
    });

    bridge.store(Buffer.from([1]), "https://voice.example.test/voice/webhook");
    bridge.store(Buffer.from([2]), "https://voice.example.test/voice/webhook");
    bridge.store(Buffer.from([3]), "https://voice.example.test/voice/webhook");

    expect(bridge.size()).toBe(2);
  });

  it("uses core telephony TTS and TwiML Play in the reviewed Twilio chunk (#6387)", () => {
    const patched = patchTwilioSource(TWILIO_FIXTURE, REVIEWED_TWILIO_SHA256);

    expect(patched).toContain("this.ttsProvider.synthesizeForTelephony(input.text)");
    expect(patched).toContain("<Play>${escapeXml(audioUrl)}</Play>");
    expect(patched).toContain("VoiceClaw NVIDIA TTS through TwiML <Play>");
  });

  it("initializes telephony TTS without streaming and serves cached audio (#6387)", () => {
    const patched = patchRuntimeEntrySource(RUNTIME_FIXTURE, REVIEWED_RUNTIME_ENTRY_SHA256);

    expect(patched).toContain("voiceClawGatherTts?.resolve?.(url, req.method)");
    expect(patched).toContain("VoiceClaw Gather TTS audio served to Twilio");
    expect(patched).toContain('if (provider.name === "twilio")');
    expect(patched).toContain("const voiceClawStreamingEnabled = config.streaming?.enabled");
    expect(patched).toContain("const mediaHandler = voiceClawStreamingEnabled");
    expect(patched).toContain(
      `Symbol.for("nemoclaw.voiceclaw.gather-tts")] && !ctx.config.streaming.enabled) return false`,
    );
  });

  it("leaves unreviewed voice-call chunks unchanged (#6387)", () => {
    expect(patchTwilioSource(TWILIO_FIXTURE, "0".repeat(64))).toBe(TWILIO_FIXTURE);
    expect(patchRuntimeEntrySource(RUNTIME_FIXTURE, "0".repeat(64))).toBe(RUNTIME_FIXTURE);
  });

  it("rewrites only reviewed installed voice-call modules (#6387)", () => {
    const hooks = createVoiceCallGatherTtsHooks((source) =>
      source === TWILIO_FIXTURE ? REVIEWED_TWILIO_SHA256 : REVIEWED_RUNTIME_ENTRY_SHA256,
    );
    const nextLoad = vi.fn((_url: string) => ({ format: "module", source: TWILIO_FIXTURE }));
    const url =
      "file:///sandbox/.openclaw/npm/projects/test/node_modules/@openclaw/voice-call/dist/twilio-fixture.js";

    const result = hooks.load(url, {}, nextLoad);

    expect(result).toMatchObject({
      format: "module",
      source: expect.stringContaining("synthesizeForTelephony"),
    });
  });
});
