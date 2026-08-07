// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { waitForHermesInferenceRouteConvergence } from "./inference-convergence";

function probe(status: number, output: string) {
  return { status, stdout: output, stderr: "" };
}

describe("Hermes inference convergence after a Shields policy transition", () => {
  it("returns on the first healthy route probe", () => {
    const run = vi.fn((_command: readonly string[], _options: object) => probe(0, "OK 200"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence("hermes-box", { run, sleep });

    expect(result).toEqual({ ok: true, attempts: 1, httpStatus: 200 });
    expect(sleep).not.toHaveBeenCalled();
    expect(run.mock.calls[0]?.[0]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "hermes-box",
      "--",
      "sh",
      "-c",
      expect.stringContaining("https://inference.local/v1/models"),
    ]);
  });

  it("waits for a transient HTTP 503 to converge", () => {
    const run = vi
      .fn((_command: readonly string[], _options: object) => probe(0, "OK 200"))
      .mockReturnValueOnce(probe(0, "BROKEN 503"))
      .mockReturnValueOnce(probe(0, "OK 200"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence("hermes-box", {
      retryDelayMs: 750,
      run,
      sleep,
    });

    expect(result).toEqual({ ok: true, attempts: 2, httpStatus: 200 });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(750);
  });

  it("fails after the bounded probe budget instead of reporting Shields down ready", () => {
    const run = vi.fn((_command: readonly string[], _options: object) => probe(0, "BROKEN 503"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence("hermes-box", {
      maxAttempts: 3,
      run,
      sleep,
    });

    expect(result).toEqual({ ok: false, attempts: 3, httpStatus: 503 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not accept preambled probe output as convergence even when the command succeeds", () => {
    const run = vi.fn((_command: readonly string[], _options: object) => ({
      status: 0,
      stdout: "attacker preamble\nOK 200",
      stderr: "",
    }));

    const result = waitForHermesInferenceRouteConvergence("hermes-box", {
      maxAttempts: 1,
      run,
    });

    expect(result).toEqual({ ok: false, attempts: 1, httpStatus: 0 });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("uses the bounded default attempt budget for non-finite maxAttempts (%s)", (maxAttempts) => {
    const run = vi.fn((_command: readonly string[], _options: object) => probe(0, "BROKEN 503"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence("hermes-box", {
      maxAttempts,
      run,
      sleep,
    });

    expect(result).toEqual({ ok: false, attempts: 4, httpStatus: 503 });
    expect(run).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("uses the default delay for non-finite retryDelayMs (%s)", (retryDelayMs) => {
    const run = vi
      .fn((_command: readonly string[], _options: object) => probe(0, "OK 200"))
      .mockReturnValueOnce(probe(0, "BROKEN 503"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence("hermes-box", {
      retryDelayMs,
      run,
      sleep,
    });

    expect(result).toEqual({ ok: true, attempts: 2, httpStatus: 200 });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);
  });
});
