// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostAssessment } from "../../../onboard/preflight";
import type { AdvisoryCheck } from "../../types";
import { hostAdvisory } from "./common";
import { wslDockerBlocksRemainingChecks } from "./docker";

export const installNodejs: AdvisoryCheck<HostAssessment> = {
  id: "install_nodejs",
  phase: "preflight.host",
  severity: "warning",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (host.nodeInstalled) return null;
    return hostAdvisory(installNodejs, {
      title: "Install Node.js",
      kind: "manual",
      reason: "NemoClaw requires Node.js for its CLI and plugin build steps.",
      commands: ["Run the NemoClaw installer to install Node.js automatically."],
    });
  },
};

export const installOpenshell: AdvisoryCheck<HostAssessment> = {
  id: "install_openshell",
  phase: "preflight.host",
  severity: "warning",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (host.openshellInstalled) return null;
    return hostAdvisory(installOpenshell, {
      title: "Install OpenShell",
      kind: "manual",
      reason: "OpenShell is required before onboarding can create or manage a gateway.",
      commands: ["Run the NemoClaw installer or `scripts/install-openshell.sh`."],
    });
  },
};

export const reviewHeadlessUiSettings: AdvisoryCheck<HostAssessment> = {
  id: "headless_remote_hint",
  phase: "preflight.host",
  severity: "info",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (!host.isHeadlessLikely || host.hasNvidiaGpu) return null;
    return hostAdvisory(reviewHeadlessUiSettings, {
      title: "Review remote/headless UI settings",
      kind: "info",
      reason:
        "Headless Linux hosts often need explicit remote UI handling if you want browser access.",
      commands: ["Set `CHAT_UI_URL` when remote browser access matters."],
    });
  },
};

export const TOOLCHAIN_HOST_ADVISORY_CHECKS = Object.freeze([
  installNodejs,
  installOpenshell,
  reviewHeadlessUiSettings,
]);
