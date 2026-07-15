// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { type MessagingStatusHookRunResult, readChannelHealthOutputs } from "./status-runner";

function runResult(
  outputs: Record<string, { kind: string; value: unknown }>,
): MessagingStatusHookRunResult {
  return {
    channelId: "telegram",
    hookId: "telegram-status-health",
    outputs,
  } as unknown as MessagingStatusHookRunResult;
}

const VALID_REPORT = {
  schemaVersion: 1,
  channel: "telegram",
  agent: "openclaw",
  verdict: "healthy",
  probedAt: "2026-07-15T00:00:00.000Z",
  signals: [],
  hints: [],
};

describe("readChannelHealthOutputs (#6888)", () => {
  it("returns a well-formed messaging-channel-health report", () => {
    const out = readChannelHealthOutputs(
      runResult({
        channelHealth: {
          kind: "status",
          value: { type: "messaging-channel-health", report: VALID_REPORT },
        },
      }),
    );
    expect(out).toEqual([VALID_REPORT]);
  });

  it("drops a malformed report (missing signals) instead of passing it through", () => {
    const out = readChannelHealthOutputs(
      runResult({
        channelHealth: {
          kind: "status",
          value: {
            type: "messaging-channel-health",
            report: { ...VALID_REPORT, signals: undefined },
          },
        },
      }),
    );
    expect(out).toEqual([]);
  });

  it("ignores non-health status outputs (e.g. bridge conflicts)", () => {
    const out = readChannelHealthOutputs(
      runResult({
        bridgeHealth: {
          kind: "status",
          value: { type: "messaging-bridge-health", channel: "telegram", conflicts: 1 },
        },
      }),
    );
    expect(out).toEqual([]);
  });
});
