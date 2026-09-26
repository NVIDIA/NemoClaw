// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellSandboxLifecycle } from "../../adapters/openshell/sandbox-lifecycle-cli";
import { finalizeOrdinaryCreateRequest } from "./orchestration";

describe("ordinary sandbox create orchestration handoff", () => {
  it("passes the final semantic request and options through the identity-labelled create path", async () => {
    const streamCreate = vi.fn().mockResolvedValue({ status: 0, output: "created" });
    const lifecycle = createCliOpenShellSandboxLifecycle({ capture: vi.fn(), streamCreate });

    const request = finalizeOrdinaryCreateRequest({
      plan: {
        sandboxName: "alpha",
        source: { reference: "/tmp/context/Dockerfile" },
        policyPath: "/tmp/policy.yaml",
        providers: ["nvidia"],
        labels: { "nemoclaw.dev/create-attempt": "nonce-1" },
      },
      gatewayName: "nemoclaw-8091",
      startupCommand: ["env", "MODE=test", "nemoclaw-start"],
      environment: { PATH: "/usr/bin" },
      workingDirectory: "/tmp/context",
      compatibilityPolicyPath: null,
      compatibility: false,
      rebuildPolicySourcePath: null,
    });
    await lifecycle.createSandbox(request, { initialPhase: "create" });

    expect(request).toEqual(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "nemoclaw-8091" },
        source: { reference: "/tmp/context/Dockerfile" },
        policyPath: "/tmp/policy.yaml",
        providers: ["nvidia"],
        startupCommand: ["env", "MODE=test", "nemoclaw-start"],
        workingDirectory: "/tmp/context",
      }),
    );
    expect(streamCreate.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(["--label", "nemoclaw.dev/create-attempt=nonce-1"]),
    );
    expect(streamCreate.mock.calls[0]![3]).toMatchObject({
      cwd: "/tmp/context",
      initialPhase: "create",
    });
  });

  it("preserves the selected rebuild policy when compatibility routing removes GPU options", () => {
    const request = finalizeOrdinaryCreateRequest({
      plan: {
        sandboxName: "alpha",
        source: { reference: "/tmp/context/Dockerfile" },
        policyPath: "/tmp/live-policy.yaml",
        driverConfigJson: JSON.stringify({ docker: { cdi_devices: ["nvidia.com/gpu=all"] } }),
        gpu: {},
      },
      gatewayName: "nemoclaw-8091",
      startupCommand: ["nemoclaw-start"],
      environment: { PATH: "/usr/bin" },
      compatibilityPolicyPath: "/tmp/generated-compatibility-policy.yaml",
      compatibility: true,
      rebuildPolicySourcePath: "/tmp/captured-live-policy.yaml",
    });

    expect(request.policyPath).toBe("/tmp/live-policy.yaml");
    expect(request.gpu).toBeUndefined();
    expect(request.driverConfigJson).toBeUndefined();
  });
});
