// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decodeLinearPcmWav } from "./voiceclaw-wave-audio.mjs";

function createPcmWav(audio: Buffer, sampleRate = 44_100): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + audio.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}

describe("VoiceClaw NVIDIA speech provider", () => {
  it("extracts mono 16-bit PCM for the OpenClaw telephony contract (#6387)", () => {
    const audio = Buffer.from([0x01, 0x02, 0x03, 0x04]);

    expect(decodeLinearPcmWav(createPcmWav(audio))).toEqual({
      audioBuffer: audio,
      sampleRate: 44_100,
    });
  });

  it("rejects audio that telephony conversion cannot consume (#6387)", () => {
    const stereo = createPcmWav(Buffer.from([0x01, 0x02]));
    stereo.writeUInt16LE(2, 22);

    expect(() => decodeLinearPcmWav(stereo)).toThrow(
      "NVIDIA Magpie telephony TTS requires mono 16-bit linear PCM",
    );
  });
});
