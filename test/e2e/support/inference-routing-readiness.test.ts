// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compileFunction } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { BEARERLESS_VLLM_READINESS_SCRIPT } from "./bearerless-vllm-readiness.ts";

afterEach(() => vi.restoreAllMocks());

function exerciseReadiness(statuses: number[]) {
  const curl = vi.fn(() => {
    const status = statuses.shift() ?? 0;
    const success = new Map([[0, () => '{"data":[{"id":"bearerless-bridge-proof"}]}']]);
    return (
      success.get(status) ??
      (() => {
        throw Object.assign(new Error(`curl: (${status}) fixture failure`), { status });
      })
    )();
  });
  const wait = vi.fn();
  const errors = vi.fn();
  let error: unknown;
  try {
    compileFunction(BEARERLESS_VLLM_READINESS_SCRIPT, ["execFileSync", "console", "Atomics"])(
      curl,
      { error: errors },
      { wait },
    );
  } catch (caught) {
    error = caught;
  }
  return { curl, wait, errors, error };
}

it("retries a reset connection while the bearerless fixture starts", () => {
  const result = exerciseReadiness([56, 0]);
  expect(result.error).toBeUndefined();
  expect(result.curl).toHaveBeenCalledTimes(2);
  expect(result.wait).toHaveBeenCalledTimes(1);
  expect(result.errors).toHaveBeenCalledExactlyOnceWith(
    "bearerless fixture readiness attempt",
    1,
    "curl status",
    56,
  );
});

it("stops after six refused connections", () => {
  const result = exerciseReadiness(Array(6).fill(7));
  expect(result.error).toMatchObject({ status: 7 });
  expect(result.curl).toHaveBeenCalledTimes(6);
  expect(result.wait).toHaveBeenCalledTimes(5);
  expect(result.errors).toHaveBeenCalledTimes(6);
});

it("stops when the ten-second startup budget is exhausted", () => {
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10_000);
  const result = exerciseReadiness([56, 0]);
  expect(result.error).toMatchObject({ status: 56 });
  expect(result.curl).toHaveBeenCalledOnce();
  expect(result.wait).not.toHaveBeenCalled();
});

it.each([22, 28, 60])("does not retry curl error %s", (status) => {
  const result = exerciseReadiness([status, 0]);
  expect(result.error).toMatchObject({ status });
  expect(result.curl).toHaveBeenCalledOnce();
  expect(result.wait).not.toHaveBeenCalled();
});
