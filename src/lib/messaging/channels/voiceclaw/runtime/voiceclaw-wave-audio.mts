// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

export function decodeLinearPcmWav(wav: Buffer): {
  audioBuffer: Buffer;
  sampleRate: number;
} {
  if (
    wav.length < 12 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("NVIDIA Magpie returned an invalid WAV response");
  }

  let offset = 12;
  let sampleRate: number | undefined;
  let data: Buffer | undefined;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > wav.length) {
      throw new Error("NVIDIA Magpie returned a truncated WAV response");
    }
    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        throw new Error("NVIDIA Magpie returned an invalid WAV format chunk");
      }
      const audioFormat = wav.readUInt16LE(chunkStart);
      const channels = wav.readUInt16LE(chunkStart + 2);
      const bitsPerSample = wav.readUInt16LE(chunkStart + 14);
      if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
        throw new Error("NVIDIA Magpie telephony TTS requires mono 16-bit linear PCM");
      }
      sampleRate = wav.readUInt32LE(chunkStart + 4);
    } else if (chunkId === "data") {
      data = wav.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkSize % 2);
  }

  if (!sampleRate || !data?.length) {
    throw new Error("NVIDIA Magpie WAV response is missing PCM audio");
  }
  return { audioBuffer: data, sampleRate };
}
