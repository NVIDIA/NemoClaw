// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntime from "./runtime";
import {
  assertObservedPolicyRequirements,
  assertOpenShellGatewayPortBinding,
  captureSandboxBasePolicy,
  inspectSandboxPolicy,
  isPolicyObservationError,
  policyStateInternals,
} from "./policy-state";

function capture(stdout: string, overrides: Record<string, unknown> = {}) {
  return { status: 0, output: stdout, stdout, stderr: "", ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenShell policy observation", () => {
  it("reads current sandbox metadata without assigning ownership", () => {
    vi.spyOn(openshellRuntime, "captureResolvedOpenshell").mockReturnValue(
      capture(
        JSON.stringify({
          scope: "sandbox",
          sandbox: "alpha",
          status: "effective",
          policy_source: "sandbox",
          hash: "sha256:policy",
          active_version: 4,
          policy: { version: 1, network_policies: { npm: { endpoints: [] } } },
        }),
      ) as never,
    );
    expect(inspectSandboxPolicy({ sandboxName: "alpha", gatewayName: "nemoclaw" })).toEqual({
      policySource: "sandbox",
      effectivePolicy: { version: 1, network_policies: { npm: { endpoints: [] } } },
      policyIdentity: { hash: "sha256:policy", activeVersion: 4 },
    });
  });

  it("uses bounded capture and classifies timeouts", () => {
    const spy = vi
      .spyOn(openshellRuntime, "captureResolvedOpenshell")
      .mockReturnValue(
        capture("", { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }) as never,
      );
    let observed: unknown;
    try {
      inspectSandboxPolicy({ sandboxName: "alpha", gatewayName: "nemoclaw" });
    } catch (error) {
      observed = error;
    }
    expect(isPolicyObservationError(observed)).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        maxBuffer: policyStateInternals.captureMaxBytes,
        timeout: policyStateInternals.captureTimeoutMs,
      }),
    );
  });

  it("reads the live base policy", () => {
    vi.spyOn(openshellRuntime, "captureResolvedOpenshell").mockReturnValue(
      capture("version: 1\nnetwork_policies: {}\n") as never,
    );
    expect(captureSandboxBasePolicy("alpha", "nemoclaw")).toContain("network_policies");
  });

  it("validates required entries while allowing unrelated host changes", () => {
    expect(() =>
      assertObservedPolicyRequirements({
        operation: "continue onboarding",
        inspection: {
          policySource: "sandbox",
          policyIdentity: { hash: "sha256:policy", activeVersion: 4 },
          effectivePolicy: {
            version: 1,
            network_policies: { required: { endpoints: [] }, host_added: { endpoints: [] } },
          },
        },
        requiredPolicy: { network_policies: { required: { endpoints: [] } } },
      }),
    ).not.toThrow();
  });

  it("checks only the recorded gateway endpoint binding", () => {
    vi.spyOn(openshellRuntime, "captureResolvedOpenshell").mockReturnValue(
      capture(
        "Gateway Info\nGateway: nemoclaw\nGateway endpoint: https://127.0.0.1:8080\n",
      ) as never,
    );
    expect(() =>
      assertOpenShellGatewayPortBinding({ gatewayName: "nemoclaw", gatewayPort: 8080 }),
    ).not.toThrow();
  });
});
