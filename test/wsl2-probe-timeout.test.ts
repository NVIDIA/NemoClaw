// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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
    function runProbeWithCurlStatuses(statuses: number[]) {
      const httpProbePath = require.resolve("../dist/lib/http-probe.js");
      const platformPath = require.resolve("../dist/lib/platform.js");
      const probesPath = require.resolve("../dist/lib/onboard-inference-probes.js");
      const httpProbe = require(httpProbePath);
      const platform = require(platformPath);
      const originalRunCurlProbe = httpProbe.runCurlProbe;
      const originalIsWsl = platform.isWsl;
      const calls: string[][] = [];
      let index = 0;
      platform.isWsl = () => false;
      httpProbe.runCurlProbe = (args: string[]) => {
        calls.push(args);
        const status = statuses[index++] ?? 0;
        if (status === 0) {
          return {
            ok: true,
            curlStatus: 0,
            httpStatus: 200,
            body: "{}",
            stderr: "",
            message: "ok",
          };
        }
        return {
          ok: false,
          curlStatus: status,
          httpStatus: 0,
          body: "",
          stderr: `curl exited ${status}`,
          message: `curl ${status}`,
        };
      };
      delete require.cache[probesPath];
      try {
        const { probeOpenAiLikeEndpoint } = require(probesPath) as {
          probeOpenAiLikeEndpoint: (
            endpointUrl: string,
            model: string,
            apiKey: string,
            options?: Record<string, unknown>,
          ) => { ok: boolean };
        };
        const result = probeOpenAiLikeEndpoint("http://localhost:8000", "test-model", "key", {
          skipResponsesProbe: false,
        });
        return { result, calls };
      } finally {
        httpProbe.runCurlProbe = originalRunCurlProbe;
        platform.isWsl = originalIsWsl;
        delete require.cache[probesPath];
      }
    }

    it("retries on curl exit code 28 (timeout)", () => {
      const { result, calls } = runProbeWithCurlStatuses([28, 28, 0]);
      expect(result.ok).toBe(true);
      expect(calls.length).toBe(3);
      expect(calls[2]).toEqual(
        expect.arrayContaining(["--connect-timeout", "20", "--max-time", "30"]),
      );
    });

    it("retries on curl exit codes 6 and 7 (connection failure)", () => {
      for (const status of [6, 7]) {
        const { result, calls } = runProbeWithCurlStatuses([status, status, 0]);
        expect(result.ok).toBe(true);
        expect(calls.length).toBe(3);
      }
    });

    it("does not retry on curl exit code 0 (success) or 22 (HTTP error)", () => {
      expect(runProbeWithCurlStatuses([0]).calls.length).toBe(1);
      const httpError = runProbeWithCurlStatuses([22, 22]);
      expect(httpError.result.ok).toBe(false);
      expect(httpError.calls.length).toBe(2);
    });

    type ProbeResultFixture = {
      ok: boolean;
      curlStatus: number;
      httpStatus: number;
      body: string;
      stderr: string;
      message: string;
    };

    function runProbeWithResults(results: ProbeResultFixture[], opts: { isWsl?: boolean } = {}) {
      const httpProbePath = require.resolve("../dist/lib/http-probe.js");
      const platformPath = require.resolve("../dist/lib/platform.js");
      const probesPath = require.resolve("../dist/lib/onboard-inference-probes.js");
      const httpProbe = require(httpProbePath);
      const platform = require(platformPath);
      const originalRunCurlProbe = httpProbe.runCurlProbe;
      const originalIsWsl = platform.isWsl;
      const atomics = globalThis as typeof globalThis & {
        Atomics: { wait: (...args: never[]) => "ok" | "not-equal" | "timed-out" };
      };
      const originalWait = atomics.Atomics.wait;
      const calls: string[][] = [];
      let index = 0;
      httpProbe.runCurlProbe = (args: string[]) => {
        calls.push(args);
        return results[index++] ?? results[results.length - 1];
      };
      platform.isWsl = () => opts.isWsl === true;
      atomics.Atomics.wait = () => "ok";
      delete require.cache[probesPath];
      try {
        const { probeOpenAiLikeEndpoint } = require(probesPath) as {
          probeOpenAiLikeEndpoint: (
            endpointUrl: string,
            model: string,
            apiKey: string,
            options?: Record<string, unknown>,
          ) => { ok: boolean; message?: string };
        };
        const result = probeOpenAiLikeEndpoint("http://localhost:8000", "test-model", "key");
        return { result, calls };
      } finally {
        httpProbe.runCurlProbe = originalRunCurlProbe;
        platform.isWsl = originalIsWsl;
        atomics.Atomics.wait = originalWait;
        delete require.cache[probesPath];
      }
    }

    it("retries HTTP 429 validation throttling from successful curl invocations", () => {
      const throttled = {
        ok: false,
        curlStatus: 0,
        httpStatus: 429,
        body: "",
        stderr: "",
        message: "HTTP 429",
      };
      const success = {
        ok: true,
        curlStatus: 0,
        httpStatus: 200,
        body: "{}",
        stderr: "",
        message: "ok",
      };
      const { result, calls } = runProbeWithResults([throttled, success]);
      expect(result.ok).toBe(true);
      expect(calls.length).toBe(2);
    });

    it("doubles timeout values for the retry attempt", () => {
      const { calls } = runProbeWithCurlStatuses([28, 28, 0]);
      expect(calls[2]).toEqual(
        expect.arrayContaining(["--connect-timeout", "20", "--max-time", "30"]),
      );
    });

    it("appends WSL2 hint when retry fails on WSL2", () => {
      const failure = {
        ok: false,
        curlStatus: 28,
        httpStatus: 0,
        body: "",
        stderr: "curl timed out",
        message: "timeout",
      };
      const { result } = runProbeWithResults([failure, failure, failure], { isWsl: true });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("WSL2 detected");
      expect(result.message).toContain("--skip-verify");
    });
  });
});
