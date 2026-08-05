// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { classifyClawHubInstallAttempt } from "./clawhub-install-retry.ts";

describe("ClawHub install retry classification", () => {
  it("retries the temporary ClawHub rate-limit outage while attempts remain", () => {
    expect(
      classifyClawHubInstallAttempt(
        1,
        "ClawHub /api/v1/packages/%40openclaw%2Fsherpa-onnx-tts failed (503): Rate limit temporarily unavailable",
        1,
        3,
      ),
    ).toBe("retry");
  });

  it("stops after the bounded attempt count reaches its limit", () => {
    expect(
      classifyClawHubInstallAttempt(
        1,
        "ClawHub /api/v1/packages/%40openclaw%2Fsherpa-onnx-tts failed (503): Rate limit temporarily unavailable",
        3,
        3,
      ),
    ).toBe("fail");
  });

  it.each([
    ["a policy denial", 1, "ClawHub request failed (403): denied"],
    ["an unrelated service failure", 1, "ClawHub request failed (503): backend unavailable"],
    ["a terminated process", null, ""],
  ] as const)("does not retry %s", (_condition, exitCode, output) => {
    expect(classifyClawHubInstallAttempt(exitCode, output, 1, 3)).toBe("fail");
  });

  it("accepts a successful install without inspecting its output", () => {
    expect(classifyClawHubInstallAttempt(0, "arbitrary output", 1, 3)).toBe("pass");
  });
});
