// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getGatewayHostPreflightActions,
  warnOrRejectGatewayHostConflicts,
} from "../../../dist/lib/onboard/gateway-host-preflight";
import type { HostAssessment } from "../../../dist/lib/onboard/preflight";

function assessment(overrides: Partial<HostAssessment> = {}): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime: "docker",
    packageManager: "apt",
    systemctlAvailable: true,
    dockerServiceActive: true,
    dockerServiceEnabled: true,
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
    dockerCgroupVersion: "v2",
    dockerDefaultCgroupnsMode: "unknown",
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: false,
    isHeadlessLikely: false,
    hasNvidiaGpu: false,
    dockerCdiSpecDirs: [],
    cdiNvidiaGpuSpecMissing: false,
    nvidiaContainerToolkitInstalled: true,
    notes: [],
    ...overrides,
  };
}

describe("gateway host preflight remediation", () => {
  it("returns no actions for a clean host", () => {
    expect(getGatewayHostPreflightActions(assessment())).toEqual([]);
  });

  it("filters gateway host preflight actions to stale cgroupns warnings", () => {
    const actions = getGatewayHostPreflightActions(
      assessment({
        dockerDefaultCgroupnsMode: "host",
        isContainerRuntimeUnderProvisioned: true,
        dockerCpus: 2,
        dockerMemTotalBytes: 2 * 1024 ** 3,
      }),
    );

    expect(actions.map((action) => action.id)).toEqual(["stale_docker_cgroupns_host"]);
  });

  it("prints stale cgroupns-only actions without prompting when they are not blocking", async () => {
    const deps = {
      printRemediationActions: vi.fn(),
      promptYesNoOrDefault: vi.fn(async () => false),
      error: vi.fn(),
      exitProcess: vi.fn((_code: number): never => {
        throw new Error("unexpected exit");
      }),
    };

    await warnOrRejectGatewayHostConflicts(
      assessment({ dockerDefaultCgroupnsMode: "host", hasNvidiaGpu: false }),
      deps,
    );

    expect(deps.printRemediationActions).toHaveBeenCalledOnce();
    expect(deps.promptYesNoOrDefault).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("aborts when a blocking action is not explicitly accepted", async () => {
    const exitError = new Error("exit");
    const deps = {
      printRemediationActions: vi.fn(),
      promptYesNoOrDefault: vi.fn(async () => false),
      error: vi.fn(),
      exitProcess: vi.fn((_code: number): never => {
        throw exitError;
      }),
    };

    await expect(
      warnOrRejectGatewayHostConflicts(
        assessment({
          dockerDefaultCgroupnsMode: "host",
          hasNvidiaGpu: true,
        }),
        deps,
      ),
    ).rejects.toThrow(exitError);
    expect(deps.printRemediationActions).toHaveBeenCalledOnce();
    expect(deps.promptYesNoOrDefault).toHaveBeenCalledWith("  Continue anyway?", null, false);
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
  });
});
