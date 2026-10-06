// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertOnboardHostReadiness,
  assertOnboardSystemReadiness,
} from "./fatal-runtime-preflight";
import type { HostAssessment } from "./preflight";

const HOST: HostAssessment = {
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
  nvidiaContainerToolkitInstalled: false,
  notes: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OS release onboarding warnings (#11026)", () => {
  it.each([
    [
      "host.os.release_unqualified",
      "The detected host operating-system release has not been qualified for host-level onboarding.",
    ],
    [
      "host.os.release_inconclusive",
      "The host operating-system distribution and version could not be identified from /etc/os-release.",
    ],
  ])("presents the %s warning before admitted onboarding", (id, summary) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readiness = {
      ...assertOnboardHostReadiness(HOST, null, {
        explicitlyOptedOutGpuPassthrough: true,
        presentAdvisories: false,
      }),
      findings: [{ id, severity: "warning" as const, summary }],
    };

    expect(
      assertOnboardSystemReadiness(readiness, HOST, {
        explicitlyOptedOutGpuPassthrough: true,
      }),
    ).toBe(readiness);
    expect(error.mock.calls.map(([line]) => line).join("\n")).toContain(summary);
  });
});
