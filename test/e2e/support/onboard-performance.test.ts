// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { maximumOutputSilenceMs, readOnboardTraceWindow } from "../fixtures/onboard-performance.ts";
import { extractOpenClawAgentPayloadText } from "../live/agent-turn-latency-helpers.ts";

function traceArtifact(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    resource_spans: [
      {
        scope_spans: [
          {
            scope: { name: "nemoclaw.onboard" },
            spans: [
              {
                name: "nemoclaw.onboard",
                start_time_unix_nano: "1000000000",
                end_time_unix_nano: "4750000000",
                status: { code: "OK" },
                ...overrides,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("onboard performance evidence", () => {
  it("reads the successful onboard root span using integer nanosecond timestamps", () => {
    expect(readOnboardTraceWindow(traceArtifact())).toEqual({
      durationMs: 3_750,
      finishedAtMs: 4_750,
      startedAtMs: 1_000,
    });
  });

  it.each([
    ["missing root", { name: "nemoclaw.onboard.phase.gateway" }],
    ["failed root", { status: { code: "ERROR" } }],
    ["malformed timestamp", { start_time_unix_nano: "yesterday" }],
    ["reversed timestamps", { end_time_unix_nano: "999999999" }],
  ])("rejects a %s trace", (_label, overrides) => {
    expect(() => readOnboardTraceWindow(traceArtifact(overrides))).toThrow();
  });

  it("measures the largest in-window gap after ordering and filtering output events", () => {
    expect(
      maximumOutputSilenceMs({ startedAtMs: 1_000, finishedAtMs: 5_000 }, [
        { atMs: 4_900 },
        { atMs: 1_100 },
        { atMs: 3_000 },
        { atMs: 999 },
        { atMs: 6_000 },
      ]),
    ).toBe(1_900);
  });

  it("treats the entire onboard window as silent when no output arrives", () => {
    expect(maximumOutputSilenceMs({ startedAtMs: 1_000, finishedAtMs: 5_000 }, [])).toBe(4_000);
  });

  it("rejects an output window that ends before it starts", () => {
    expect(() => maximumOutputSilenceMs({ startedAtMs: 5_000, finishedAtMs: 1_000 }, [])).toThrow(
      "onboard output window is invalid",
    );
  });

  it("rejects echoed user messages as first-agent-response evidence", () => {
    expect(
      extractOpenClawAgentPayloadText(
        JSON.stringify({
          messages: [{ role: "user", content: "Reply with exactly: NEMOCLAW_E2E_READY_6002" }],
        }),
      ),
    ).toBe("");
  });

  it("accepts a framed OpenClaw agent-output payload", () => {
    expect(
      extractOpenClawAgentPayloadText(
        `progress\n${JSON.stringify({ result: { payloads: [{ text: "NEMOCLAW_E2E_READY_6002" }] } })}`,
      ),
    ).toBe("NEMOCLAW_E2E_READY_6002");
  });

  it("joins top-level agent-output payload fragments", () => {
    expect(
      extractOpenClawAgentPayloadText(
        JSON.stringify({
          payloads: [{ text: "NEMOCLAW_" }, { text: "E2E_READY_6002" }],
        }),
      ),
    ).toBe("NEMOCLAW_\nE2E_READY_6002");
  });
});
