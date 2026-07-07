// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

const {
  getKimiK26ValidationProbeCurlArgs,
  getValidationProbeCurlArgs,
} = require("./probe-http-helpers");

// Restore an env var to its pre-test value without branching at the call
// site. Centralizing the conditional keeps test bodies linear and keeps the
// codebase-growth-guardrails "if count" steady; see PR #5975 review.
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

describe("validation probe curl timing helpers", () => {
  it("allows onboard validation max-time to be raised from the environment", () => {
    const original = process.env.NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS;
    process.env.NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS = "300";
    try {
      expect(getValidationProbeCurlArgs({ isWsl: false })).toEqual([
        "--connect-timeout",
        "10",
        "--max-time",
        "300",
      ]);
      expect(getKimiK26ValidationProbeCurlArgs({ isWsl: false })).toEqual([
        "--connect-timeout",
        "10",
        "--max-time",
        "300",
      ]);
    } finally {
      restoreEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", original);
    }
  });
});
