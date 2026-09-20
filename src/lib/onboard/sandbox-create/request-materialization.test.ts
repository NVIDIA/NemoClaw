// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { withoutOpenShellSandboxCreateGpu } from "../../adapters/openshell/sandbox-lifecycle";
import { materializeOpenShellSandboxCreateRequest } from "../sandbox-create-plan-materialization";

describe("ordinary sandbox create request materialization", () => {
  it("maps the complete ordinary create plan without carrying raw argv", () => {
    const request = materializeOpenShellSandboxCreateRequest({
      createArgv: [
        "/qualified/openshell",
        "sandbox",
        "create",
        "--from",
        "/tmp/Dockerfile",
        "--name",
        "alpha",
        "--policy",
        "/tmp/policy.yaml",
        "--driver-config-json",
        '{"docker":{"cdi_devices":["nvidia.com/gpu=all"]}}',
        "--gpu",
        "--gpu-device",
        "nvidia.com/gpu=all",
        "--cpu",
        "2",
        "--memory",
        "4Gi",
        "--provider",
        "nvidia",
        "--label",
        "existing=value",
        "--",
        "nemoclaw-start",
      ],
      gatewayName: "nemoclaw",
      environment: { PATH: "/usr/bin" },
      workingDirectory: "/tmp/context",
    });

    expect(request).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw" },
      source: { reference: "/tmp/Dockerfile" },
      policyPath: "/tmp/policy.yaml",
      gpu: { device: "nvidia.com/gpu=all" },
      resources: { cpu: "2", memory: "4Gi" },
      providers: ["nvidia"],
      labels: { existing: "value" },
      startupCommand: ["nemoclaw-start"],
      workingDirectory: "/tmp/context",
    });
    expect(request).not.toHaveProperty("argv");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.target)).toBe(true);
  });

  it("rejects unsupported flags and gateway drift before lifecycle submission", () => {
    const base = [
      "openshell",
      "sandbox",
      "create",
      "--from",
      "image:tag",
      "--name",
      "alpha",
      "--",
      "start",
    ];
    expect(() =>
      materializeOpenShellSandboxCreateRequest({
        createArgv: [...base.slice(0, 7), "--unknown", "value", ...base.slice(7)],
        gatewayName: "nemoclaw",
        environment: {},
      }),
    ).toThrow("Unsupported ordinary sandbox create option");
    expect(() =>
      materializeOpenShellSandboxCreateRequest({
        createArgv: [...base.slice(0, 3), "-g", "other", ...base.slice(3)],
        gatewayName: "nemoclaw",
        environment: {},
      }),
    ).toThrow("gateway changed");
  });

  it("adds attempt identity and derives compatibility semantics without mutating the request", () => {
    const request = materializeOpenShellSandboxCreateRequest({
      createArgv: [
        "openshell",
        "sandbox",
        "create",
        "--from",
        "image:tag",
        "--name",
        "alpha",
        "--policy",
        "/tmp/native.yaml",
        "--driver-config-json",
        '{"docker":{"cdi_devices":["nvidia.com/gpu=all"],"mounts":[]}}',
        "--gpu",
        "--",
        "start",
      ],
      gatewayName: "nemoclaw",
      environment: {},
    });

    const labeled = { ...request, labels: { attempt: "nonce" } };
    const compatibility = withoutOpenShellSandboxCreateGpu(labeled, {
      sourceReference: `sha256:${"a".repeat(64)}`,
      policyPath: "/tmp/compatibility.yaml",
    });

    expect(request.labels).toBeUndefined();
    expect(compatibility).toMatchObject({
      source: { reference: `sha256:${"a".repeat(64)}` },
      policyPath: "/tmp/compatibility.yaml",
      labels: { attempt: "nonce" },
    });
    expect(compatibility.gpu).toBeUndefined();
    expect(compatibility.driverConfigJson).toBe('{"docker":{"mounts":[]}}');
  });
});
