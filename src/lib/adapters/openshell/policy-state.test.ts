// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntime from "./runtime";
import {
  assertObservedPolicyRequirements,
  assertOpenShellGatewayPortBinding,
  captureSandboxBasePolicy,
  captureSandboxBasePolicyRevision,
  inspectActiveGlobalPolicy,
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

  it("extracts round-trippable YAML from the live base policy display", () => {
    vi.spyOn(openshellRuntime, "captureResolvedOpenshell").mockReturnValue(
      capture(
        [
          "Version: 13",
          "Hash: sha256:current",
          "Updated: 2026-08-28T00:00:00Z",
          "---",
          "version: 1",
          "network_policies: {}",
          "",
        ].join("\n"),
      ) as never,
    );
    expect(captureSandboxBasePolicy("alpha", "nemoclaw")).toBe("version: 1\nnetwork_policies: {}");
  });

  it("reads an immutable base-policy revision through the selected gateway", () => {
    const spy = vi
      .spyOn(openshellRuntime, "captureResolvedOpenshell")
      .mockReturnValue(
        capture("Version: 7\nHash: sha256:prior\n---\nversion: 1\nnetwork_policies: {}\n") as never,
      );

    expect(captureSandboxBasePolicyRevision("alpha", "nemoclaw", 7)).toBe(
      "version: 1\nnetwork_policies: {}",
    );
    expect(spy.mock.calls[0]?.[0]).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw",
      "--rev",
      "7",
      "--base",
      "alpha",
    ]);
  });

  it("rejects a metadata-only base policy display", () => {
    vi.spyOn(openshellRuntime, "captureResolvedOpenshell").mockReturnValue(
      capture("Version: 13\nHash: sha256:current\n") as never,
    );
    expect(() => captureSandboxBasePolicy("alpha", "nemoclaw")).toThrow(
      /policy inspection failed/u,
    );
  });

  it("reads active global policy through the selected gateway", () => {
    const spy = vi
      .spyOn(openshellRuntime, "captureResolvedOpenshell")
      .mockReturnValueOnce(capture("VERSION STATUS\n1 loaded\n") as never)
      .mockReturnValueOnce(
        capture(
          JSON.stringify({
            scope: "global",
            status: "loaded",
            policy_source: "global",
            hash: "sha256:global",
            active_version: 2,
            policy: { version: 1, network_policies: {} },
          }),
        ) as never,
      );

    expect(inspectActiveGlobalPolicy({ gatewayName: "nemoclaw" })).toEqual({
      state: "active",
      inspection: {
        policySource: "global",
        effectivePolicy: { version: 1, network_policies: {} },
        policyIdentity: { hash: "sha256:global", activeVersion: 2 },
      },
    });
    expect(spy.mock.calls.map(([args]) => args)).toEqual([
      ["policy", "list", "-g", "nemoclaw", "--global", "--limit", "1"],
      ["policy", "get", "-g", "nemoclaw", "--global", "--full", "--output", "json"],
    ]);
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
