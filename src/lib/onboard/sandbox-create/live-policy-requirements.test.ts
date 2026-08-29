// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assertGateway: vi.fn(),
  captureBasePolicy: vi.fn(),
  inspectPolicy: vi.fn(),
  inspectReadiness: vi.fn(),
}));

vi.mock("../../adapters/openshell/policy-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/policy-state")>()),
  assertOpenShellGatewayPortBinding: state.assertGateway,
  captureSandboxBasePolicy: state.captureBasePolicy,
  inspectOpenShellSandboxPolicyReadiness: state.inspectReadiness,
  inspectSandboxPolicy: state.inspectPolicy,
}));

import { verifyLiveCreatedSandboxPolicyRequirements } from "./live-policy-requirements";

const IDENTITY = "a".repeat(64);
const REQUIRED_POLICY = `
version: 1
network_policies:
  required:
    name: required
    endpoints:
      - host: example.com
        port: 443
`;

function inspection(activeVersion: number) {
  return {
    policySource: "sandbox" as const,
    effectivePolicy: {
      version: 1,
      network_policies: {
        required: {
          name: "provider-composed-drift",
          endpoints: [{ host: "provider.example.com", port: 443 }],
        },
      },
    },
    policyIdentity: { hash: `hash-${String(activeVersion)}`, activeVersion },
  };
}

function verify(sleep = vi.fn()) {
  verifyLiveCreatedSandboxPolicyRequirements(
    {
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleLiveIdentityFingerprint: IDENTITY,
      policySourcePath: "/tmp/required-policy.yaml",
      operation: "continue onboarding",
    },
    { readFile: () => REQUIRED_POLICY, sleep },
  );
  return sleep;
}

describe("live created sandbox policy requirements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.captureBasePolicy.mockReturnValue(REQUIRED_POLICY);
    state.inspectPolicy.mockReturnValue(inspection(7));
  });

  it("waits for OpenShell's exact live policy version without recording ownership", () => {
    state.inspectReadiness
      .mockReturnValueOnce({ state: "transient", reason: "policy-version-pending" })
      .mockReturnValueOnce({ state: "ready" });

    const sleep = verify();

    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(state.inspectReadiness).toHaveBeenCalledTimes(2);
    expect(state.inspectReadiness).toHaveBeenLastCalledWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      sandboxIdentityFingerprint: IDENTITY,
      policyVersion: 7,
    });
    expect(state.inspectPolicy).toHaveBeenCalledTimes(3);
    expect(state.captureBasePolicy).toHaveBeenCalledTimes(3);
  });

  it("checks requirements against OpenShell's base policy, not provider composition", () => {
    state.inspectReadiness.mockReturnValue({ state: "ready" });

    verify();

    expect(state.inspectPolicy).toHaveBeenCalledTimes(2);
    expect(state.captureBasePolicy).toHaveBeenCalledTimes(2);
  });

  it("fails after the bounded OpenShell convergence window", () => {
    state.inspectReadiness.mockReturnValue({
      state: "transient",
      reason: "sandbox-not-ready",
    });
    const sleep = vi.fn();

    expect(() => verify(sleep)).toThrow(
      "Refusing to continue onboarding: the exact sandbox is not Ready.",
    );
    expect(state.inspectReadiness).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });
});
