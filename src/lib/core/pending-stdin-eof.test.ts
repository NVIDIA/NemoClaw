// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { takePendingStdinEof } from "./pending-stdin-eof";

type PromptInput = PassThrough & { isTTY?: boolean };

function makeInput(isTTY: boolean | undefined): PromptInput {
  const input = new PassThrough() as PromptInput;
  input.isTTY = isTTY;
  input.pause();
  return input;
}

describe("takePendingStdinEof", () => {
  it("returns false synchronously for piped stdin so prompt timing is unchanged", () => {
    expect(takePendingStdinEof(makeInput(false), 10)).toBe(false);
    expect(takePendingStdinEof(makeInput(undefined), 10)).toBe(false);
  });

  it("reports the cancellation when stdin ends during the window (#12169)", async () => {
    const input = makeInput(true);
    const pending = takePendingStdinEof(input, 50);
    input.end();

    await expect(pending).resolves.toBe(true);
  });

  it("reports the cancellation when stdin closes without ending", async () => {
    const input = makeInput(true);
    const pending = takePendingStdinEof(input, 50);
    input.emit("close");

    await expect(pending).resolves.toBe(true);
  });

  it("reports no cancellation for a quiet terminal and leaves stdin paused", async () => {
    const input = makeInput(true);

    await expect(takePendingStdinEof(input, 5)).resolves.toBe(false);
    expect(input.isPaused()).toBe(true);
  });

  it("hands type-ahead back so the prompt still answers with it", async () => {
    const input = makeInput(true);
    const pending = takePendingStdinEof(input, 50);
    input.write("2\n");

    await expect(pending).resolves.toBe(false);
    expect(input.read()?.toString()).toBe("2\n");
  });

  it("answers with input that arrives ahead of a closing stdin", async () => {
    const input = makeInput(true);
    const pending = takePendingStdinEof(input, 50);
    input.write("yes\n");
    input.end();

    await expect(pending).resolves.toBe(false);
    expect(input.read()?.toString()).toBe("yes\n");
  });

  it("stops listening once it settles so the prompt owns stdin alone", async () => {
    const input = makeInput(true);

    await takePendingStdinEof(input, 5);

    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });
});
