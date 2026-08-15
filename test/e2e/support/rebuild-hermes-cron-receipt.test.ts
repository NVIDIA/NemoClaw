// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { redactString } from "../fixtures/redaction.ts";
import { hermesCronBeginIdentity } from "../live/rebuild-hermes-cron-receipt.ts";

describe("Hermes rebuild cron begin receipt", () => {
  it("reads identity only after the fixture redacts the drain token", () => {
    const raw = {
      drain_token: "a".repeat(32),
      pid: 263,
      start_time: 27_160,
    };
    const redacted = JSON.parse(redactString(JSON.stringify(raw)));

    expect(redacted.drain_token).toBe("<REDACTED>");
    expect(hermesCronBeginIdentity(redacted)).toEqual({ pid: 263, start_time: 27_160 });
  });

  it.each([
    ["raw token", { drain_token: "a".repeat(32), pid: 263, start_time: 27_160 }],
    ["alternate sentinel", { drain_token: "[REDACTED]", pid: 263, start_time: 27_160 }],
    ["missing token", { pid: 263, start_time: 27_160 }],
    ["zero pid", { drain_token: "<REDACTED>", pid: 0, start_time: 27_160 }],
    ["fractional start time", { drain_token: "<REDACTED>", pid: 263, start_time: 1.5 }],
  ])("rejects an invalid %s", (_label, payload) => {
    expect(() => hermesCronBeginIdentity(payload)).toThrow(
      "Hermes cron begin receipt identity is invalid",
    );
  });
});
