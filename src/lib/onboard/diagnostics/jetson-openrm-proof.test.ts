// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerGpuPatchResult } from "../docker-gpu-patch-types";
import { maybeRunJetsonOpenRmPolicyProof } from "./jetson-openrm-proof";

const BASE_POLICY = `Version: 2
Hash: fixture
---
version: 1
filesystem_policy:
  read_only:
    - /opt/nvidia
  read_write:
    - /dev/nvmap
network_policies: {}
`;

function result(): DockerGpuPatchResult {
  return {
    applied: true,
    oldContainerId: "a".repeat(64),
    newContainerId: "b".repeat(64),
    originalName: "openshell-alpha-fixture",
    backupContainerName: "openshell-alpha-fixture-backup",
    mode: {
      kind: "nvidia-runtime",
      label: "--runtime nvidia",
      device: "all",
      args: ["--runtime", "nvidia"],
    },
    backupRemoved: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Jetson OpenRM policy proof", () => {
  it("proves the exact one-path A/B and restores the baseline policy", () => {
    const appliedPolicies: string[] = [];
    const runOpenshell = vi.fn((args: string[]) => {
      appliedPolicies.push(fs.readFileSync(args[3] ?? "", "utf8"));
      return { status: 0 };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    maybeRunJetsonOpenRmPolicyProof({
      backend: "jetson",
      enabled: true,
      failure: new Error("cuInit(0)=801"),
      preserveJetsonDeviceGroupMembership: true,
      result: result(),
      sandboxName: "alpha",
      verifyDirectSandboxGpu: vi.fn(() => ({
        status: "verified" as const,
        cudaVerified: true,
        at: "2026-08-06T00:00:00.000Z",
      })),
      deps: {
        dockerRun: vi.fn(() => ({ status: 0, stdout: "cuInit(0)=0", stderr: "" })),
        isCharacterDevice: () => true,
        runCaptureOpenshell: vi.fn(() => BASE_POLICY),
        runOpenshell,
      },
    });

    expect(appliedPolicies).toHaveLength(2);
    expect(appliedPolicies[0]).toContain("/dev/nvidia-caps/nvidia-cap2");
    expect(appliedPolicies[1]).not.toContain("/dev/nvidia-caps/nvidia-cap2");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("direct_docker_cuInit=0 baseline_openshell_cuInit=801"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PROVEN:"));
  });

  it("restores the baseline when the candidate CUDA proof throws", () => {
    const appliedPolicies: string[] = [];
    const runOpenshell = vi.fn((args: string[]) => {
      appliedPolicies.push(fs.readFileSync(args[3] ?? "", "utf8"));
      return { status: 0 };
    });

    expect(() =>
      maybeRunJetsonOpenRmPolicyProof({
        backend: "jetson",
        enabled: true,
        failure: new Error("cuInit(0)=801"),
        preserveJetsonDeviceGroupMembership: true,
        result: result(),
        sandboxName: "alpha",
        verifyDirectSandboxGpu: vi.fn(() => {
          throw new Error("candidate probe failed");
        }),
        deps: {
          dockerRun: vi.fn(() => ({ status: 0, stdout: "cuInit(0)=0", stderr: "" })),
          isCharacterDevice: () => true,
          runCaptureOpenshell: vi.fn(() => BASE_POLICY),
          runOpenshell,
        },
      }),
    ).toThrow("candidate probe failed");

    expect(appliedPolicies).toHaveLength(2);
    expect(appliedPolicies[0]).toContain("/dev/nvidia-caps/nvidia-cap2");
    expect(appliedPolicies[1]).not.toContain("/dev/nvidia-caps/nvidia-cap2");
  });

  it("attempts baseline restoration when candidate policy application reports failure", () => {
    const appliedPolicies: string[] = [];
    const runOpenshell = vi.fn((args: string[]) => {
      appliedPolicies.push(fs.readFileSync(args[3] ?? "", "utf8"));
      return { status: appliedPolicies.length === 1 ? 1 : 0 };
    });

    expect(() =>
      maybeRunJetsonOpenRmPolicyProof({
        backend: "jetson",
        enabled: true,
        failure: new Error("cuInit(0)=801"),
        preserveJetsonDeviceGroupMembership: true,
        result: result(),
        sandboxName: "alpha",
        verifyDirectSandboxGpu: vi.fn(),
        deps: {
          dockerRun: vi.fn(() => ({ status: 0, stdout: "cuInit(0)=0", stderr: "" })),
          isCharacterDevice: () => true,
          runCaptureOpenshell: vi.fn(() => BASE_POLICY),
          runOpenshell,
        },
      }),
    ).toThrow("candidate.yaml");

    expect(appliedPolicies).toHaveLength(2);
    expect(appliedPolicies[0]).toContain("/dev/nvidia-caps/nvidia-cap2");
    expect(appliedPolicies[1]).not.toContain("/dev/nvidia-caps/nvidia-cap2");
  });

  it("does nothing outside the exact Jetson cuInit 801 failure", () => {
    const dockerRun = vi.fn();
    maybeRunJetsonOpenRmPolicyProof({
      backend: "jetson",
      enabled: true,
      failure: new Error("cuInit(0)=100"),
      preserveJetsonDeviceGroupMembership: true,
      result: result(),
      sandboxName: "alpha",
      verifyDirectSandboxGpu: vi.fn(),
      deps: { dockerRun },
    });
    expect(dockerRun).not.toHaveBeenCalled();
  });
});
