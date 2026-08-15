// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOpenshell } from "../adapters/openshell/resolve";
import {
  type InferenceRouteConvergenceOptions,
  waitForHermesInferenceRouteConvergence,
} from "./inference-convergence";

vi.mock("../adapters/openshell/resolve", () => ({
  resolveOpenshell: vi.fn(() => "/opt/nvidia/bin/openshell"),
}));

function probe(status: number, output: string) {
  return { status, stdout: output, stderr: "" };
}

const OPENSHELL_BINARY = "/opt/nvidia/bin/openshell";

function buildOpenshellCommand(args: readonly string[]): string[] {
  return [OPENSHELL_BINARY, ...args];
}

function convergenceOptions(
  run: InferenceRouteConvergenceOptions["run"],
  options: Omit<InferenceRouteConvergenceOptions, "buildOpenshellCommand" | "run"> = {},
): InferenceRouteConvergenceOptions {
  return { ...options, buildOpenshellCommand, run };
}

describe("Hermes inference convergence after a Shields policy transition", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns on the first healthy route probe", () => {
    const run = vi.fn((_command: readonly string[], _options: object) => probe(0, "OK 200"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence("hermes-box", { run, sleep });

    expect(result).toEqual({ ok: true, attempts: 1, httpStatus: 200 });
    expect(resolveOpenshell).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(run.mock.calls[0]?.[0]).toEqual([
      OPENSHELL_BINARY,
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

    const result = waitForHermesInferenceRouteConvergence(
      "hermes-box",
      convergenceOptions(run, { retryDelayMs: 750, sleep }),
    );

    expect(result).toEqual({ ok: true, attempts: 2, httpStatus: 200 });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(750);
  });

  it("fails after the bounded probe budget instead of reporting Shields down ready", () => {
    const run = vi.fn((_command: readonly string[], _options: object) => probe(0, "BROKEN 503"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence(
      "hermes-box",
      convergenceOptions(run, { maxAttempts: 3, sleep }),
    );

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

    const result = waitForHermesInferenceRouteConvergence(
      "hermes-box",
      convergenceOptions(run, { maxAttempts: 1 }),
    );

    expect(result).toEqual({ ok: false, attempts: 1, httpStatus: 0 });
  });

  it.each([
    401, 403, 404,
  ])("does not accept HTTP %i as a usable Hermes inference response", (httpStatus) => {
    const run = vi.fn((_command: readonly string[], _options: object) =>
      probe(0, `OK ${String(httpStatus)}`),
    );
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence(
      "hermes-box",
      convergenceOptions(run, { maxAttempts: 2, sleep }),
    );

    expect(result).toEqual({ ok: false, attempts: 2, httpStatus });
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("uses the bounded default attempt budget for non-finite maxAttempts (%s)", (maxAttempts) => {
    const run = vi.fn((_command: readonly string[], _options: object) => probe(0, "BROKEN 503"));
    const sleep = vi.fn();

    const result = waitForHermesInferenceRouteConvergence(
      "hermes-box",
      convergenceOptions(run, { maxAttempts, sleep }),
    );

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

    const result = waitForHermesInferenceRouteConvergence(
      "hermes-box",
      convergenceOptions(run, { retryDelayMs, sleep }),
    );

    expect(result).toEqual({ ok: true, attempts: 2, httpStatus: 200 });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);
  });
});
