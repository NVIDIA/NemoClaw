// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HostAssessment } from "../../../onboard/preflight";
import { runAdvisories } from "../../runner";
import { DOCKER_HOST_ADVISORY_CHECKS } from "./docker";

function host(overrides: Partial<HostAssessment> = {}): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime: "unknown",
    packageManager: "apt",
    systemctlAvailable: true,
    dockerServiceActive: false,
    dockerServiceEnabled: true,
    dockerInstalled: true,
    dockerRunning: false,
    dockerReachable: false,
    nodeInstalled: true,
    openshellInstalled: true,
    dockerCgroupVersion: "unknown",
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

describe("Docker host advisories (#3213)", () => {
  it("preserves the mutually exclusive Docker reachability actions", () => {
    const cases: Array<[HostAssessment, string]> = [
      [host({ dockerInstalled: false }), "install_docker"],
      [host({ dockerServiceActive: true }), "docker_group_permission"],
      [host(), "start_docker"],
      [host({ isWsl: true }), "enable_docker_desktop_wsl_integration"],
    ];

    for (const [context, expectedId] of cases) {
      const result = runAdvisories(DOCKER_HOST_ADVISORY_CHECKS, context, {
        phase: "preflight.host",
      });
      expect(result.advisories.map((advisory) => advisory.id)).toEqual([expectedId]);
    }
  });

  it("re-evaluates Docker state on resume", () => {
    const context = host({ dockerInstalled: false });
    const cachedResults = new Map([["install_docker", null]]);

    const result = runAdvisories(DOCKER_HOST_ADVISORY_CHECKS, context, {
      phase: "preflight.host",
      resuming: true,
      cachedResults,
    });

    expect(result.executedCheckIds).toEqual([
      "enable_docker_desktop_wsl_integration",
      "install_docker",
      "docker_group_permission",
      "start_docker",
    ]);
    expect(result.reusedCheckIds).toEqual([]);
    expect(result.advisories.map((advisory) => advisory.id)).toEqual(["install_docker"]);
  });
});
