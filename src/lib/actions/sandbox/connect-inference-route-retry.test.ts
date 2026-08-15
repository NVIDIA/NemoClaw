// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { probeSandboxInferenceRoute } from "./connect-inference-route-retry";

function result(output: string) {
  return { status: 0, output, stderr: "" };
}

describe("connect inference route retries", () => {
  it("returns the third reachable route after both scheduled delays (#9218)", () => {
    const capture = vi
      .fn(() => result("OK 200"))
      .mockReturnValueOnce(result("BROKEN 503"))
      .mockReturnValueOnce(result("BROKEN 503"));
    const sleep = vi.fn();

    const probe = probeSandboxInferenceRoute(
      "alpha",
      { name: "hermes" },
      { attempts: 3, delayMs: 2_000 },
      { capture, sleep },
    );

    expect(probe).toMatchObject({ healthy: true, broken: false, httpStatus: 200 });
    expect(capture).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2_000], [2_000]]);
  });

  it("returns the final failed route after exhausting attempts (#9218)", () => {
    const capture = vi.fn(() => result("BROKEN 503"));
    const sleep = vi.fn();

    const probe = probeSandboxInferenceRoute(
      "alpha",
      { name: "hermes" },
      { attempts: 2, delayMs: 500 },
      { capture, sleep },
    );

    expect(probe).toMatchObject({ healthy: false, broken: true, httpStatus: 503 });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);
  });
});
