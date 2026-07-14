// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  isHermesRestartTransportFailure,
  retryAfterHermesRestartTransportFailure,
} from "../live/mcp-bridge-reliability.ts";

const HERMES_BROKEN_PIPE = `Error: code: 'Unknown error', message: "h2 protocol error: error reading a body
from connection", source: hyper::Error(Body, Error { kind: Io(Custom
{ kind: BrokenPipe, error: "stream closed because of a broken pipe" }) })`;

describe("MCP bridge transient classification", () => {
  it("accepts only the Hermes managed-restart broken-pipe signature", () => {
    expect(isHermesRestartTransportFailure("hermes-config", HERMES_BROKEN_PIPE)).toBe(true);
    expect(isHermesRestartTransportFailure("mcporter", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("deepagents-config", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "h2 protocol error")).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "stream closed: broken pipe")).toBe(
      false,
    );
  });

  it("keeps the original duplicate rejection without retrying", async () => {
    const originalResult = { exitCode: 1 };
    const retry = vi.fn(async () => ({ exitCode: 2 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        diagnostic: "server already exists",
        originalResult,
        retry,
      }),
    ).resolves.toBe(originalResult);
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries the exact Hermes restart transport failure once", async () => {
    const retryResult = { exitCode: 1 };
    const retry = vi.fn(async () => retryResult);

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        diagnostic: HERMES_BROKEN_PIPE,
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).resolves.toBe(retryResult);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("fails closed for an unknown rejection", async () => {
    const retry = vi.fn(async () => ({ exitCode: 1 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        diagnostic: "unexpected transport error",
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).rejects.toThrow("not a known Hermes restart transport failure");
    expect(retry).not.toHaveBeenCalled();
  });
});
