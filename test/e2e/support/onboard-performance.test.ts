// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { maximumOutputSilenceMs, readOnboardTraceWindow } from "../fixtures/onboard-performance.ts";

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
});
