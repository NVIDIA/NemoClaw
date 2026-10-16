// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPolicyTierEnvGate } from "./policy-tier-env";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function stubInvalidEnvTier() {
  vi.stubEnv("NEMOCLAW_POLICY_TIER", "locked");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as typeof process.exit);
}

describe("policy tier environment gate (#13180)", () => {
  it("fails fast on an invalid environment tier without --policy-tier", () => {
    stubInvalidEnvTier();
    const gate = createPolicyTierEnvGate({}, false, () => true);
    expect(() => gate.beforeRuntime()).toThrow("exit:1");
  });

  it("does not validate an unused environment tier when --policy-tier is set", () => {
    const exit = stubInvalidEnvTier();
    const fresh = createPolicyTierEnvGate({ requestedPolicyTier: "restricted" }, false, () => true);
    fresh.beforeRuntime();
    fresh.afterRuntime(() => null);
    const resumed = createPolicyTierEnvGate(
      { requestedPolicyTier: "restricted" },
      true,
      () => true,
    );
    resumed.afterRuntime(() => null);
    expect(exit).not.toHaveBeenCalled();
  });

  it("uses a recorded resume tier instead of validating the environment", () => {
    const exit = stubInvalidEnvTier();
    const gate = createPolicyTierEnvGate({}, true, () => true);
    gate.beforeRuntime();
    gate.afterRuntime(() => ({ policyTier: "restricted" }));
    expect(exit).not.toHaveBeenCalled();
    expect(() => gate.afterRuntime(() => ({ policyTier: null }))).toThrow("exit:1");
  });
});
