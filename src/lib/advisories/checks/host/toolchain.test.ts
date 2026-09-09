// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HostAssessment } from "../../../onboard/preflight";
import { runAdvisories } from "../../runner";
import { TOOLCHAIN_HOST_ADVISORY_CHECKS } from "./toolchain";

const BASE_HOST = {
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
} satisfies HostAssessment;

describe("host toolchain advisories (#3213)", () => {
  it("emits stable advisories in legacy remediation order", () => {
    const result = runAdvisories(
      TOOLCHAIN_HOST_ADVISORY_CHECKS,
      {
        ...BASE_HOST,
        nodeInstalled: false,
        openshellInstalled: false,
        isHeadlessLikely: true,
      },
      { phase: "preflight.host" },
    );

    expect(result.advisories.map(({ id, severity }) => ({ id, severity }))).toEqual([
      { id: "install_nodejs", severity: "warning" },
      { id: "install_openshell", severity: "warning" },
      { id: "headless_remote_hint", severity: "info" },
    ]);
  });

  it("keeps the headless remote hint platform-neutral on macOS (#10734)", () => {
    const result = runAdvisories(
      TOOLCHAIN_HOST_ADVISORY_CHECKS,
      {
        ...BASE_HOST,
        platform: "darwin",
        runtime: "docker-desktop",
        isHeadlessLikely: true,
      },
      { phase: "preflight.host" },
    );

    const hint = result.advisories.find(({ id }) => id === "headless_remote_hint");
    expect(hint).toMatchObject({
      reason: "Headless hosts often need explicit remote UI handling if you want browser access.",
      commands: [
        "Prefer SSH port forwarding for remote browser access. If the dashboard needs an external origin, set `CHAT_UI_URL` to its HTTPS URL before onboarding.",
      ],
    });
  });

  it("preserves the WSL Docker short-circuit", () => {
    const result = runAdvisories(
      TOOLCHAIN_HOST_ADVISORY_CHECKS,
      {
        ...BASE_HOST,
        isWsl: true,
        dockerReachable: false,
        nodeInstalled: false,
        openshellInstalled: false,
        isHeadlessLikely: true,
      },
      { phase: "preflight.host" },
    );

    expect(result.advisories).toEqual([]);
    expect(result.executedCheckIds).toEqual([]);
  });
});
