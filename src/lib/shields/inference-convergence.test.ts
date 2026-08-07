// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { waitForHermesInferenceRouteConvergence } from "./inference-convergence";

function probe(status: number, output: string) {
  return { status, output, stderr: "" };
}

describe("Hermes inference convergence after a Shields policy transition", () => {
  it("returns on the first healthy route probe", () => {
    const capture = vi.fn(() => probe(0, "OK 200"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence("hermes-box", { capture, sleep });

    expect(result).toEqual({ ok: true, attempts: 1, httpStatus: 200 });
    expect(sleep).not.toHaveBeenCalled();
    expect(capture.mock.calls[0]?.[0]).toEqual([
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
    const capture = vi
      .fn()
      .mockReturnValueOnce(probe(0, "BROKEN 503"))
      .mockReturnValueOnce(probe(0, "OK 200"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence("hermes-box", {
      capture,
      retryDelayMs: 750,
      sleep,
    });

    expect(result).toEqual({ ok: true, attempts: 2, httpStatus: 200 });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(750);
  });

  it("fails after the bounded probe budget instead of reporting Shields down ready", () => {
    const capture = vi.fn(() => probe(0, "BROKEN 503"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence("hermes-box", {
      capture,
      maxAttempts: 3,
      sleep,
    });

    expect(result).toEqual({ ok: false, attempts: 3, httpStatus: 503 });
    expect(capture).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not accept untrusted or unavailable probe output as convergence", () => {
    const capture = vi.fn(() => ({ status: 1, output: "attacker preamble\nOK 200", stderr: "" }));

    const result = waitForHermesInferenceRouteConvergence("hermes-box", {
      capture,
      maxAttempts: 1,
    });

    expect(result).toEqual({ ok: false, attempts: 1, httpStatus: 0 });
  });
});
