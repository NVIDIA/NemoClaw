// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { writeWebSocketUpgrade } = require(
  path.resolve(import.meta.dirname, "../lib/fake-discord-gateway.cjs"),
) as {
  writeWebSocketUpgrade: (
    socket: { write: (data: string | Buffer, callback?: () => void) => boolean },
    accept: string,
    onFlushed: () => void,
  ) => void;
};

describe("fake Discord Gateway", () => {
  it("flushes the protocol upgrade before sending the first Gateway frame (#10155)", () => {
    const writes: Array<string | Buffer> = [];
    let flush: (() => void) | undefined;
    const socket = {
      write: vi.fn((data: string | Buffer, callback?: () => void) => {
        writes.push(data);
        flush = callback;
        return true;
      }),
    };
    const sendHello = vi.fn(() => socket.write(Buffer.from([0x81, 0x00])));

    writeWebSocketUpgrade(socket, "fake-accept", sendHello);

    expect(writes).toHaveLength(1);
    expect(String(writes[0])).toContain("HTTP/1.1 101 Switching Protocols");
    expect(sendHello).not.toHaveBeenCalled();

    flush?.();

    expect(sendHello).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(Buffer.from([0x81, 0x00]));
  });
});
