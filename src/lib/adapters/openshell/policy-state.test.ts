// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntime from "./runtime";
import {
  assertObservedPolicyRequirements,
  assertOpenShellGatewayPortBinding,
  inspectActiveGlobalPolicy,
} from "./policy-state";

function capture(stdout: string, overrides: Record<string, unknown> = {}) {
  return { status: 0, output: stdout, stdout, stderr: "", ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenShell policy observation", () => {
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
