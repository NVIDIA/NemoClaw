// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// NEMOCLAW_LOCAL_INFERENCE_TIMEOUT becomes the OpenShell route request timeout,
// which the route adapter accepts only from 1 to 3600 seconds. A value outside
// that range used to fail late with a generic route-mutation error (#13734).

import { describe, expect, it } from "vitest";

import { MAX_INFERENCE_ROUTE_TIMEOUT_SECONDS } from "../adapters/openshell/inference-route";
import { createCliOpenShellInferenceRouteMutator } from "../adapters/openshell/inference-route-cli";
import { localInferenceTimeoutRangeError } from "./env";

function check(value: string | undefined): string | null {
  return localInferenceTimeoutRangeError({ NEMOCLAW_LOCAL_INFERENCE_TIMEOUT: value });
}

describe("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT range (#13734)", () => {
  it.each(["1", "180", "3600", "3600.4", "0.5"])("accepts %s", (value) => {
    expect(check(value)).toBeNull();
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["non-numeric", "abc"],
    ["negative", "-5"],
  ])("keeps the default for an %s value", (_label, value) => {
    expect(check(value)).toBeNull();
  });

  it.each(["3601", "3600.5", "7200", "86400", "2147483", "9999999", "0", "0.4"])(
    "rejects %s with the variable name and the range",
    (value) => {
      expect(check(value)).toBe(
        `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must be from 1 to 3600 seconds; got "${value}".`,
      );
    },
  );

  it("uses the same maximum as the OpenShell route adapter", async () => {
    expect(MAX_INFERENCE_ROUTE_TIMEOUT_SECONDS).toBe(3600);
    const calls: string[][] = [];
    const mutator = createCliOpenShellInferenceRouteMutator(
      async (args) => {
        calls.push(args);
        return { status: 0, output: "", stdout: "", stderr: "" };
      },
      { environment: {} },
    );
    const request = (verificationTimeoutSeconds: number) =>
      mutator.setInferenceRoute({
        target: { kind: "named", gatewayName: "nemoclaw" },
        route: { provider: "compatible-endpoint", model: "test-model" },
        verification: "skip",
        verificationTimeoutSeconds,
      });

    const over = await request(MAX_INFERENCE_ROUTE_TIMEOUT_SECONDS + 1);
    expect(over).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(calls).toHaveLength(0);
    await request(MAX_INFERENCE_ROUTE_TIMEOUT_SECONDS);
    expect(calls[0]).toEqual(expect.arrayContaining(["--timeout", "3600"]));
  });
});
