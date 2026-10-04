// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildContainerToolkitBootstrapCommands } from "../../../onboard/container-toolkit-bootstrap";
import {
  buildNvidiaCdiRefreshCommands,
  buildNvidiaCdiRepairCommands,
  buildStaleCdiManualWarnCommands,
  buildStaleCdiWarnCommands,
  explainNvidiaCdiRepairReason,
  explainStaleCdiReason,
  extractCdiMismatchFilePath,
  getNvidiaCdiSpecPath,
} from "../../../onboard/docker-cdi";
import type { HostAssessment } from "../../../onboard/preflight";
import {
  isWslDockerDesktopRuntime,
  wslDockerDesktopGpuCompatibilityAction,
} from "../../../onboard/wsl-docker-desktop-gpu";
import type { AdvisoryCheck } from "../../types";
import { hostAdvisory } from "./common";
import { wslDockerBlocksRemainingChecks } from "./docker";

function cdiRepairNeeded(host: HostAssessment): boolean {
  return host.cdiNvidiaGpuSpecNeedsRepair === true || host.cdiNvidiaGpuSpecMissing;
}

function cdiRepairDetails(host: HostAssessment): {
  commands: string[];
  missingSpec: boolean;
  reason: string;
} {
  const missingSpec = host.cdiNvidiaGpuSpecMissing;
  const flaggedFilePath = extractCdiMismatchFilePath(host.cdiNvidiaGpuSpecMismatch);
  const commands = missingSpec
    ? buildNvidiaCdiRepairCommands(host, getNvidiaCdiSpecPath(host))
    : host.systemctlAvailable
      ? buildStaleCdiWarnCommands(flaggedFilePath)
      : buildStaleCdiManualWarnCommands(flaggedFilePath);
  return {
    commands,
    missingSpec,
    reason: missingSpec
      ? explainNvidiaCdiRepairReason(host)
      : explainStaleCdiReason(host.cdiNvidiaGpuSpecMismatch),
  };
}

export const warnNvidiaCdiRefreshUnhealthy: AdvisoryCheck<HostAssessment> = {
  id: "warn_nvidia_cdi_refresh_unhealthy",
  phase: "preflight.host",
  severity: "warning",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (
      !host.cdiNvidiaGpuRefreshUnhealthy ||
      cdiRepairNeeded(host) ||
      isWslDockerDesktopRuntime(host)
    ) {
      return null;
    }
    return hostAdvisory(warnNvidiaCdiRefreshUnhealthy, {
      title: "Enable NVIDIA CDI refresh service",
      kind: "sudo",
      reason: explainNvidiaCdiRepairReason({
        ...host,
        cdiNvidiaGpuSpecMissing: false,
        cdiNvidiaGpuSpecStale: false,
        cdiNvidiaGpuSpecMismatch: undefined,
      }),
      commands: buildNvidiaCdiRefreshCommands(),
    });
  },
};

export const useWslDockerDesktopGpuCompatibility: AdvisoryCheck<HostAssessment> = {
  id: "wsl_docker_desktop_gpu_compatibility",
  phase: "preflight.host",
  severity: "info",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (!cdiRepairNeeded(host) || !isWslDockerDesktopRuntime(host)) return null;
    const action = wslDockerDesktopGpuCompatibilityAction();
    return hostAdvisory(useWslDockerDesktopGpuCompatibility, {
      title: action.title,
      kind: action.kind,
      reason: action.reason,
      commands: action.commands,
    });
  },
};

export const generateNvidiaCdiSpec: AdvisoryCheck<HostAssessment> = {
  id: "generate_nvidia_cdi_spec",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (
      !host.cdiNvidiaGpuSpecMissing ||
      isWslDockerDesktopRuntime(host) ||
      !host.nvidiaContainerToolkitInstalled
    ) {
      return null;
    }
    const details = cdiRepairDetails(host);
    return hostAdvisory(generateNvidiaCdiSpec, {
      title: "Generate NVIDIA CDI device specs",
      kind: "sudo",
      reason: details.reason,
      commands: details.commands,
    });
  },
};

export const refreshNvidiaCdiSpec: AdvisoryCheck<HostAssessment> = {
  id: "refresh_nvidia_cdi_spec",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (
      !host.cdiNvidiaGpuSpecNeedsRepair ||
      host.cdiNvidiaGpuSpecMissing ||
      isWslDockerDesktopRuntime(host) ||
      !host.nvidiaContainerToolkitInstalled
    ) {
      return null;
    }
    const details = cdiRepairDetails(host);
    return hostAdvisory(refreshNvidiaCdiSpec, {
      title: "Refresh NVIDIA CDI device specs",
      kind: host.systemctlAvailable ? "sudo" : "manual",
      reason: details.reason,
      commands: details.commands,
    });
  },
};

export const installNvidiaContainerToolkit: AdvisoryCheck<HostAssessment> = {
  id: "install_nvidia_container_toolkit",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (
      !cdiRepairNeeded(host) ||
      isWslDockerDesktopRuntime(host) ||
      host.nvidiaContainerToolkitInstalled
    ) {
      return null;
    }
    const details = cdiRepairDetails(host);
    const title = details.missingSpec
      ? "Install NVIDIA Container Toolkit and generate CDI device specs"
      : "Install NVIDIA Container Toolkit and refresh CDI device specs";
    return hostAdvisory(installNvidiaContainerToolkit, {
      title,
      kind: "sudo",
      reason: `${details.reason} The nvidia-container-toolkit package (which provides nvidia-ctk) is not installed on the host.`,
      commands: buildContainerToolkitBootstrapCommands(host.packageManager, details.commands),
    });
  },
};

export const CDI_HOST_ADVISORY_CHECKS = Object.freeze([
  warnNvidiaCdiRefreshUnhealthy,
  useWslDockerDesktopGpuCompatibility,
  generateNvidiaCdiSpec,
  refreshNvidiaCdiSpec,
  installNvidiaContainerToolkit,
]);
