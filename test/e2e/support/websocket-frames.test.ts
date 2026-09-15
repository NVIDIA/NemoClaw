// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { decodeFrame, encodeText } from "../lib/websocket-frames.mts";

describe("fake provider WebSocket frames", () => {
  it.each([
    [0, [0x81, 0]],
    [125, [0x81, 125]],
    [126, [0x81, 126, 0, 126]],
    [65535, [0x81, 126, 255, 255]],
    [65536, [0x81, 127, 0, 0, 0, 0, 0, 1, 0, 0]],
  ] as const)("encodes a text payload of %i bytes", (length, header) => {
    expect(encodeText("a".repeat(length))).toEqual(
      Buffer.concat([Buffer.from(header), Buffer.alloc(length, 97)]),
    );
  });

  it("uses UTF-8 byte length for multibyte text", () => {
    expect(encodeText("é")).toEqual(Buffer.from([0x81, 2, 0xc3, 0xa9]));
  });

  describe.each([
    [2, [0x81, 0x82]],
    [126, [0x81, 0xfe, 0, 126]],
    [65536, [0x81, 0xff, 0, 0, 0, 0, 0, 1, 0, 0]],
  ] as const)("masked payload of %i bytes", (length, header) => {
    const mask = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.alloc(length, 97);
    const masked = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]!));
    const frame = Buffer.concat([Buffer.from(header), mask, masked]);

    it("decodes the payload without changing input or consuming the next frame", () => {
      const input = Buffer.concat([frame, Buffer.from([0x88, 0])]);
      const original = Buffer.from(input);
      expect(decodeFrame(input)).toEqual({ opcode: 1, payload, totalLength: frame.length });
      expect(input).toEqual(original);
    });

    it.each([0, 1, header.length - 1, header.length + 3, frame.length - 1])(
      "waits for more bytes after a partial frame of %i bytes",
      (end) => {
        expect(decodeFrame(frame.subarray(0, end))).toBeNull();
      },
    );
  });

  it.each([1, 8, 9, 10])("preserves opcode %i on an unmasked frame", (opcode) => {
    expect(decodeFrame(Buffer.from([0x80 | opcode, 2, 65, 66]))).toEqual({
      opcode,
      payload: Buffer.from("AB"),
      totalLength: 4,
    });
  });
});
