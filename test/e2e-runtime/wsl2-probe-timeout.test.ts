// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

describe("WSL2 inference verification timeouts (#987)", () => {
  describe("retry logic in probeOpenAiLikeEndpoint", () => {
    function runProbeWithCurlStatuses(statuses: number[], isWsl = false) {
      const httpProbePath = require.resolve("../../src/lib/adapters/http/probe.js");
      const probesPath = require.resolve("../../src/lib/inference/onboard-probes.js");
      const httpProbe = require(httpProbePath);
      const originalRunCurlProbe = httpProbe.runCurlProbe;
      const calls: string[][] = [];
      let index = 0;
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
          isWsl,
          skipResponsesProbe: false,
        });
        return { result, calls };
      } finally {
        httpProbe.runCurlProbe = originalRunCurlProbe;
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

    it.each([6, 7])(
      "retries on curl exit codes 6 and 7 (connection failure) [case %#]",
      (status) => {
        const { result, calls } = runProbeWithCurlStatuses([status, status, 0]);
        expect(result.ok).toBe(true);
        expect(calls.length).toBe(3);
      },
    );

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

    function runProbeWithResults(
      results: ProbeResultFixture[],
      opts: {
        isWsl?: boolean;
        probeStreaming?: boolean;
        streamingResult?: { ok: boolean; missingEvents: string[]; message: string };
      } = {},
    ) {
      const httpProbePath = require.resolve("../../src/lib/adapters/http/probe.js");
      const probesPath = require.resolve("../../src/lib/inference/onboard-probes.js");
      const httpProbe = require(httpProbePath);
      const originalRunCurlProbe = httpProbe.runCurlProbe;
      const originalRunStreamingEventProbe = httpProbe.runStreamingEventProbe;
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
      if (opts.streamingResult) {
        httpProbe.runStreamingEventProbe = () => opts.streamingResult;
      }
      atomics.Atomics.wait = () => "ok";
      delete require.cache[probesPath];
      try {
        const { probeOpenAiLikeEndpoint } = require(probesPath) as {
          probeOpenAiLikeEndpoint: (
            endpointUrl: string,
            model: string,
            apiKey: string,
            options?: Record<string, unknown>,
          ) => { ok: boolean; advisory?: string; message?: string };
        };
        const result = probeOpenAiLikeEndpoint("http://localhost:8000", "test-model", "key", {
          isWsl: opts.isWsl ?? false,
          probeStreaming: opts.probeStreaming ?? false,
        });
        return { result, calls };
      } finally {
        httpProbe.runCurlProbe = originalRunCurlProbe;
        httpProbe.runStreamingEventProbe = originalRunStreamingEventProbe;
        atomics.Atomics.wait = originalWait;
        delete require.cache[probesPath];
      }
    }

    function runCalibratedProbeWithResults(
      results: ProbeResultFixture[],
      clock: number[],
      opts: { isWsl?: boolean } = {},
    ) {
      const httpProbePath = require.resolve("../../src/lib/adapters/http/probe.js");
      const probesPath = require.resolve("../../src/lib/inference/onboard-probes.js");
      const httpProbe = require(httpProbePath);
      const originalRunCurlProbe = httpProbe.runCurlProbe;
      const now = vi.spyOn(Date, "now");
      for (const value of clock) now.mockReturnValueOnce(value);
      const calls: string[][] = [];
      let index = 0;
      httpProbe.runCurlProbe = (args: string[]) => {
        calls.push(args);
        return results[index++] ?? results[results.length - 1];
      };
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
        const result = probeOpenAiLikeEndpoint("http://localhost:8000", "test-model", "key", {
          calibrateTimeouts: true,
          isWsl: opts.isWsl ?? false,
          skipResponsesProbe: true,
        });
        return { result, calls };
      } finally {
        httpProbe.runCurlProbe = originalRunCurlProbe;
        now.mockRestore();
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

    it.each([
      { label: "default budget", override: "", expectedSeconds: ["20", "30"] },
      { label: "maximum override", override: "600", expectedSeconds: ["600", "600"] },
    ])("bounds the retry timing for the $label", ({ override, expectedSeconds }) => {
      vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", override);
      try {
        const { calls } = runProbeWithCurlStatuses([28, 28, 0]);
        expect(calls[2]).toEqual(
          expect.arrayContaining([
            "--connect-timeout",
            expectedSeconds[0],
            "--max-time",
            expectedSeconds[1],
          ]),
        );
      } finally {
        vi.unstubAllEnvs();
      }
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
      // Names the lever onboarding honours; there is no validation bypass flag.
      expect(result.message).toContain("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS");
    });

    it("omits the standard timeout advice for the fixed streaming deadline (#10413)", () => {
      const success = {
        ok: true,
        curlStatus: 0,
        httpStatus: 200,
        body: "{}",
        stderr: "",
        message: "ok",
      };
      const { result } = runProbeWithResults([success], {
        isWsl: true,
        probeStreaming: true,
        streamingResult: {
          ok: false,
          missingEvents: [],
          message: "streaming validation timed out",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("streaming validation timed out");
      expect(result.advisory).toBeUndefined();
      expect(result.message).not.toContain("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS");
    });

    it("uses calibrated fast-network timing for provider validation", () => {
      const calibration = {
        ok: false,
        curlStatus: 0,
        httpStatus: 401,
        body: "",
        stderr: "",
        message: "HTTP 401",
      };
      const success = {
        ok: true,
        curlStatus: 0,
        httpStatus: 200,
        body: "{}",
        stderr: "",
        message: "ok",
      };
      const { result, calls } = runCalibratedProbeWithResults([calibration, success], [1000, 1180]);
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(
        expect.arrayContaining(["--connect-timeout", "3", "--max-time", "5"]),
      );
      expect(calls[0].at(-1)).toBe("http://localhost:8000/models");
      expect(calls[1]).toEqual(
        expect.arrayContaining(["--connect-timeout", "5", "--max-time", "15"]),
      );
    });

    it("keeps the WSL floor through production probe calibration (#10413)", () => {
      const calibration = {
        ok: false,
        curlStatus: 0,
        httpStatus: 401,
        body: "",
        stderr: "",
        message: "HTTP 401",
      };
      const success = {
        ok: true,
        curlStatus: 0,
        httpStatus: 200,
        body: "{}",
        stderr: "",
        message: "ok",
      };
      const { result, calls } = runCalibratedProbeWithResults(
        [calibration, success],
        [1000, 1180],
        { isWsl: true },
      );

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(
        expect.arrayContaining(["--connect-timeout", "20", "--max-time", "30"]),
      );
    });

    it("uses the safe fallback timing when calibration times out", () => {
      const calibrationTimeout = {
        ok: false,
        curlStatus: 28,
        httpStatus: 0,
        body: "",
        stderr: "timeout",
        message: "curl timed out",
      };
      const success = {
        ok: true,
        curlStatus: 0,
        httpStatus: 200,
        body: "{}",
        stderr: "",
        message: "ok",
      };
      const { result, calls } = runCalibratedProbeWithResults(
        [calibrationTimeout, success],
        [2000, 7000],
      );
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(
        expect.arrayContaining(["--connect-timeout", "20", "--max-time", "30"]),
      );
    });
  });
});
