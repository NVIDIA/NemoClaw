// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { finalizeOpenShellSandboxCreateRequest } from "../sandbox-create-plan-materialization";

describe("ordinary sandbox create request materialization", () => {
  const plan = Object.freeze({
    sandboxName: "alpha",
    source: Object.freeze({ reference: "/tmp/Dockerfile" }),
    policyPath: "/tmp/native.yaml",
    driverConfigJson:
      '{"docker":{"cdi_devices":["nvidia.com/gpu=all"],"mounts":[]},"podman":{"cdi_devices":["nvidia.com/gpu=all"],"mounts":[{"type":"bind","source":"/src","target":"/dst"}]}}',
    gpu: Object.freeze({ device: "nvidia.com/gpu=all" }),
    resources: Object.freeze({ cpu: "2", memory: "4Gi" }),
    providers: Object.freeze(["nvidia"]),
    labels: Object.freeze({ existing: "value" }),
  });

  it("binds runtime fields to the final typed plan without carrying raw argv", () => {
    const request = finalizeOpenShellSandboxCreateRequest({
      plan,
      gatewayName: "nemoclaw",
      startupCommand: ["nemoclaw-start"],
      environment: { PATH: "/usr/bin" },
      workingDirectory: "/tmp/context",
    });

    expect(request).toMatchObject({
      ...plan,
      target: { kind: "named", gatewayName: "nemoclaw" },
      startupCommand: ["nemoclaw-start"],
      environment: { PATH: "/usr/bin" },
      workingDirectory: "/tmp/context",
    });
    expect(request).not.toHaveProperty("argv");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.target)).toBe(true);
  });

  it("derives compatibility semantics without mutating the typed plan", () => {
    const request = finalizeOpenShellSandboxCreateRequest({
      plan,
      gatewayName: "nemoclaw",
      startupCommand: ["start"],
      environment: {},
      compatibilityPolicyPath: "/tmp/compatibility.yaml",
    });

    expect(plan.gpu).toEqual({ device: "nvidia.com/gpu=all" });
    expect(request).toMatchObject({
      source: { reference: "/tmp/Dockerfile" },
      policyPath: "/tmp/compatibility.yaml",
    });
    expect(request.gpu).toBeUndefined();
    expect(request.driverConfigJson).toBe(
      '{"docker":{"mounts":[]},"podman":{"mounts":[{"type":"bind","source":"/src","target":"/dst"}]}}',
    );
  });

  it("rejects compatibility materialization without its route-owned policy", () => {
    expect(() =>
      finalizeOpenShellSandboxCreateRequest({
        plan,
        gatewayName: "nemoclaw",
        startupCommand: ["start"],
        environment: {},
        compatibilityPolicyPath: null,
      }),
    ).toThrow("route-specific sandbox policy");
  });
});
