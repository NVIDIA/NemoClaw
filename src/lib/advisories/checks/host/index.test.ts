// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HostAssessment } from "../../../onboard/preflight";
import { planHostAdvisories, planHostRemediation } from "../../../onboard/preflight";
import { HOST_ADVISORY_CHECKS } from ".";

function host(overrides: Partial<HostAssessment> = {}): HostAssessment {
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
    dockerDefaultCgroupnsMode: "private",
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: false,
    isHeadlessLikely: false,
    hasNvidiaGpu: true,
    dockerCdiSpecDirs: ["/etc/cdi"],
    cdiNvidiaGpuSpecMissing: false,
    cdiNvidiaGpuSpecNeedsRepair: false,
    nvidiaContainerToolkitInstalled: true,
    notes: [],
    ...overrides,
  };
}

describe("host advisory registry (#3213)", () => {
  it("keeps stable unique ids in legacy remediation order", () => {
    const ids = HOST_ADVISORY_CHECKS.map((check) => check.id);

    expect(ids).toEqual([
      "enable_docker_desktop_wsl_integration",
      "install_docker",
      "docker_group_permission",
      "start_docker",
      "container_runtime_under_provisioned",
      "unsupported_runtime_warning",
      "install_nodejs",
      "install_openshell",
      "headless_remote_hint",
      "warn_nvidia_cdi_refresh_unhealthy",
      "wsl_docker_desktop_gpu_compatibility",
      "generate_nvidia_cdi_spec",
      "refresh_nvidia_cdi_spec",
      "install_nvidia_container_toolkit",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves cross-category action order and blocking semantics", () => {
    const assessment = host({
      isContainerRuntimeUnderProvisioned: true,
      dockerCpus: 2,
      dockerMemTotalBytes: 4 * 1024 ** 3,
      isUnsupportedRuntime: true,
      nodeInstalled: false,
      openshellInstalled: false,
      cdiNvidiaGpuSpecMissing: true,
    });

    expect(planHostAdvisories(assessment).map((advisory) => advisory.id)).toEqual([
      "container_runtime_under_provisioned",
      "unsupported_runtime_warning",
      "install_nodejs",
      "install_openshell",
      "generate_nvidia_cdi_spec",
    ]);
    expect(planHostRemediation(assessment).map(({ id, blocking }) => ({ id, blocking }))).toEqual([
      { id: "container_runtime_under_provisioned", blocking: false },
      { id: "unsupported_runtime_warning", blocking: false },
      { id: "install_nodejs", blocking: false },
      { id: "install_openshell", blocking: false },
      { id: "generate_nvidia_cdi_spec", blocking: true },
    ]);
  });

  it("preserves the WSL Docker early-return contract across the full registry", () => {
    const assessment = host({
      isWsl: true,
      dockerReachable: false,
      nodeInstalled: false,
      openshellInstalled: false,
      cdiNvidiaGpuSpecMissing: true,
    });

    expect(planHostRemediation(assessment).map((action) => action.id)).toEqual([
      "enable_docker_desktop_wsl_integration",
    ]);
  });
});
