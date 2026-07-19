// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HostAssessment } from "../../../onboard/preflight";
import { runAdvisories } from "../../runner";
import { RUNTIME_HOST_ADVISORY_CHECKS } from "./runtime";

function host(overrides: Partial<HostAssessment> = {}): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime: "docker",
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
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

describe("container runtime host advisories (#3213)", () => {
  it("preserves resource-specific commands and advisory order", () => {
    const result = runAdvisories(
      RUNTIME_HOST_ADVISORY_CHECKS,
      host({
        runtime: "colima",
        dockerCpus: 2,
        dockerMemTotalBytes: 4 * 1024 ** 3,
        isContainerRuntimeUnderProvisioned: true,
        isUnsupportedRuntime: true,
      }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual([
      "container_runtime_under_provisioned",
      "unsupported_runtime_warning",
    ]);
    expect(result.advisories[0]?.commands).toContain("colima start --cpu 4 --memory 8 --disk 100");
  });
});
