// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  isHermesRestartTransportFailure,
  retryAfterHermesRestartTransportFailure,
} from "../live/mcp-bridge-reliability.ts";

const HERMES_BROKEN_PIPE = `  Widening sandbox egress — adding: fixture.trycloudflare.com
  Applied preset: mcp-bridge-concurrent
  Narrowing sandbox egress — removing: fixture.trycloudflare.com
  Removed preset: mcp-bridge-concurrent
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 3 submitted (hash: abcdef0123)
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 3 loaded (active version: 3)
  Preset not found: mcp-bridge-concurrent
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 4 submitted (hash: 0123abcdef)
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 4 loaded (active version: 4)
  Error:   \u00d7 code: 'Unknown error', message: "h2 protocol error: error reading a body
  \u2502 from connection", source: hyper::Error(Body, Error { kind: Io(Custom
  \u2502 { kind: BrokenPipe, error: "stream closed because of a broken pipe" }) })
  \u251c\u2500\u25b6 error reading a body from connection
  \u2570\u2500\u25b6 stream closed because of a broken pipe`;

describe("MCP bridge transient classification", () => {
  it("accepts only the Hermes managed-restart broken-pipe signature (#6692)", () => {
    expect(isHermesRestartTransportFailure("hermes-config", HERMES_BROKEN_PIPE)).toBe(true);
    expect(isHermesRestartTransportFailure("mcporter", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("deepagents-config", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "h2 protocol error")).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "stream closed: broken pipe")).toBe(
      false,
    );
    expect(
      isHermesRestartTransportFailure(
        "hermes-config",
        HERMES_BROKEN_PIPE.replace("error reading a body from connection", "unrelated failure"),
      ),
    ).toBe(false);
    expect(
      isHermesRestartTransportFailure(
        "hermes-config",
        `unexpected diagnostic before retry evidence\n${HERMES_BROKEN_PIPE}`,
      ),
    ).toBe(false);
    expect(
      isHermesRestartTransportFailure(
        "hermes-config",
        `${HERMES_BROKEN_PIPE}\nadditional failure after transport closed`,
      ),
    ).toBe(false);
  });

  it("keeps the original duplicate rejection without retrying", async () => {
    const originalResult = { exitCode: 1 };
    const retry = vi.fn(async () => ({ exitCode: 2 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: true,
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
        committedBridgeVerified: true,
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
        committedBridgeVerified: true,
        diagnostic: "unexpected transport error",
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).rejects.toThrow("not a known Hermes restart transport failure");
    expect(retry).not.toHaveBeenCalled();
  });

  it("refuses retry before the committed bridge is verified", async () => {
    const retry = vi.fn(async () => ({ exitCode: 1 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: false,
        diagnostic: HERMES_BROKEN_PIPE,
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).rejects.toThrow("requires a verified committed bridge");
    expect(retry).not.toHaveBeenCalled();
  });
});
