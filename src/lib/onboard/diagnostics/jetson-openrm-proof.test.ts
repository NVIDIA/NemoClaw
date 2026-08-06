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

function dockerRunForBoundaryProof() {
  return vi.fn((args: readonly string[]) =>
    args.includes("0")
      ? {
          status: 0,
          stdout: ["/dev/nvidia-caps/nvidia-cap2", "/dev/nvhost-ctrl-pva0", "/dev/nvmap"].join(
            "\n",
          ),
          stderr: "",
        }
      : { status: 0, stdout: "cuInit(0)=0", stderr: "" },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Jetson OpenRM policy proof", () => {
  it("isolates missing injected devices from sysfs and restores the baseline policy", () => {
    const appliedPolicies: string[] = [];
    const runOpenshell = vi.fn((args: string[]) => {
      appliedPolicies.push(fs.readFileSync(args[3] ?? "", "utf8"));
      return { status: 0 };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const verifyDirectSandboxGpu = vi
      .fn()
      .mockReturnValueOnce({
        status: "verified" as const,
        cudaVerified: true,
        at: "2026-08-06T00:00:00.000Z",
      })
      .mockReturnValueOnce({
        status: "failed" as const,
        cudaVerified: false,
        detail: "cuInit(0)=801",
        at: "2026-08-06T00:00:00.000Z",
      })
      .mockReturnValueOnce({
        status: "verified" as const,
        cudaVerified: true,
        at: "2026-08-06T00:00:00.000Z",
      });

    maybeRunJetsonOpenRmPolicyProof({
      backend: "jetson",
      enabled: true,
      failure: new Error("cuInit(0)=801"),
      preserveJetsonDeviceGroupMembership: true,
      result: result(),
      sandboxName: "alpha",
      verifyDirectSandboxGpu,
      deps: {
        dockerRun: dockerRunForBoundaryProof(),
        runCaptureOpenshell: vi.fn(() => BASE_POLICY),
        runOpenshell,
      },
    });

    expect(appliedPolicies).toHaveLength(4);
    expect(appliedPolicies[0]).toContain("/dev/nvidia-caps/nvidia-cap2");
    expect(appliedPolicies[0]).toContain("/dev/nvhost-ctrl-pva0");
    expect(appliedPolicies[0]).not.toContain("- /sys");
    expect(appliedPolicies[1]).toContain("- /sys");
    expect(appliedPolicies[1]).not.toContain("/dev/nvidia-caps/nvidia-cap2");
    expect(appliedPolicies[2]).toContain("/dev/nvidia-caps/nvidia-cap2");
    expect(appliedPolicies[2]).toContain("- /sys");
    expect(appliedPolicies[3]).not.toContain("/dev/nvidia-caps/nvidia-cap2");
    expect(appliedPolicies[3]).not.toContain("- /sys");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("devices_cuInit=0 sysfs_cuInit=801"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ISOLATED:"));
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
          dockerRun: dockerRunForBoundaryProof(),
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
          dockerRun: dockerRunForBoundaryProof(),
          runCaptureOpenshell: vi.fn(() => BASE_POLICY),
          runOpenshell,
        },
      }),
    ).toThrow("devices.yaml");

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
