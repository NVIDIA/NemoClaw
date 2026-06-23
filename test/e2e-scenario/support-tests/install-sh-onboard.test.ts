// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { installShOnboardArgs } from "../live/install-sh-onboard.ts";

const RETRY_SENSITIVE_LIVE_TESTS = [
  "test/e2e-scenario/live/agent-turn-latency-helpers.ts",
  "test/e2e-scenario/live/cron-preflight-inference-local.test.ts",
];

describe("live install.sh onboarding arguments", () => {
  it("force a fresh onboarding session so retries discard failed session state", () => {
    expect(installShOnboardArgs()).toEqual([
      "install.sh",
      "--non-interactive",
      "--yes-i-accept-third-party-software",
      "--fresh",
    ]);
  });

  it("routes retry-sensitive live install.sh callers through the fresh-session helper", () => {
    for (const relativePath of RETRY_SENSITIVE_LIVE_TESTS) {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
      expect(source, relativePath).toContain("installShOnboardArgs()");
      expect(source, relativePath).not.toContain(
        '["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"]',
      );
    }
  });
});
