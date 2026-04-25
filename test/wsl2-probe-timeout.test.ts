// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

type OnboardValidationInternals = {
  getValidationProbeCurlArgs: (opts?: { isWsl?: boolean }) => string[];
};

type OnboardValidationCandidate = {
  getValidationProbeCurlArgs?: unknown;
  default?: unknown;
} | null;

function isOnboardValidationInternals(
  value: OnboardValidationCandidate,
): value is OnboardValidationInternals {
  return value !== null && typeof value.getValidationProbeCurlArgs === "function";
}

const loadedOnboardValidationModule = await import("../dist/lib/onboard.js");
const onboardValidationInternals = isOnboardValidationInternals(loadedOnboardValidationModule)
  ? loadedOnboardValidationModule
  : isOnboardValidationInternals(loadedOnboardValidationModule.default)
    ? loadedOnboardValidationModule.default
    : null;
if (!isOnboardValidationInternals(onboardValidationInternals)) {
  throw new Error("Expected onboard validation internals to expose getValidationProbeCurlArgs");
}
const { getValidationProbeCurlArgs } = onboardValidationInternals;

describe("WSL2 inference verification timeouts (issue #987)", () => {
  describe("getValidationProbeCurlArgs", () => {
    it("returns standard timeouts on non-WSL platforms", () => {
      expect(getValidationProbeCurlArgs({ isWsl: false })).toEqual([
        "--connect-timeout",
        "10",
        "--max-time",
        "15",
      ]);
    });

    it("returns widened timeouts when WSL2 is detected", () => {
      expect(getValidationProbeCurlArgs({ isWsl: true })).toEqual([
        "--connect-timeout",
        "20",
        "--max-time",
        "30",
      ]);
    });

    it("returns standard timeouts when called without opts (default path)", () => {
      // On non-WSL hosts this returns the standard values.
      // The exact values depend on the host, but the structure must be correct.
      const args = getValidationProbeCurlArgs();
      expect(args).toHaveLength(4);
      expect(args[0]).toBe("--connect-timeout");
      expect(args[2]).toBe("--max-time");
    });
  });

  describe("retry logic in probeOpenAiLikeEndpoint", () => {
    // The retry logic is embedded in probeOpenAiLikeEndpoint which is not
    // exported. Verify the retry triggers on the correct curl exit codes by
    // scanning the compiled source for the guard condition.
    const onboardSrc = fs.readFileSync(
      path.join(import.meta.dirname, "..", "dist", "lib", "onboard.js"),
      "utf-8",
    );

    it("retries on curl exit code 28 (timeout)", () => {
      // The guard function must treat exit code 28 as retriable.
      expect(onboardSrc).toMatch(/=== 28/);
    });

    it("retries on curl exit codes 6 and 7 (connection failure)", () => {
      expect(onboardSrc).toMatch(/=== 6/);
      expect(onboardSrc).toMatch(/=== 7/);
    });

    it("does not retry on curl exit code 0 (success) or 22 (HTTP error)", () => {
      // The isTimeoutOrConnFailure guard only matches 6, 7, and 28.
      // A successful probe (exit 0) returns early before reaching the retry
      // block, and HTTP errors (exit 22) are not in the retry set.
      // Verify the retry guard is exactly these three codes.
      const guardMatch = onboardSrc.match(
        /isTimeoutOrConnFailure\s*=\s*\(cs\)\s*=>\s*cs\s*===\s*28\s*\|\|\s*cs\s*===\s*6\s*\|\|\s*cs\s*===\s*7/,
      );
      expect(guardMatch).not.toBeNull();
    });

    it("doubles timeout values for the retry attempt", () => {
      // The retry maps numeric args through a doubling transform.
      expect(onboardSrc).toMatch(/String\(Number\(arg\) \* 2\)/);
    });

    it("appends WSL2 hint when retry fails on WSL2", () => {
      expect(onboardSrc).toMatch(/WSL2 detected/);
      expect(onboardSrc).toMatch(/--skip-verify/);
    });
  });
});
