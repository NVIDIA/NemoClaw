// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MIN_RECOMMENDED_DOCKER_CPUS,
  MIN_RECOMMENDED_DOCKER_MEM_GIB,
} from "../../../onboard/container-runtime-resources";
import type { HostAssessment } from "../../../onboard/preflight";
import type { AdvisoryCheck } from "../../types";
import { hostAdvisory } from "./common";
import { wslDockerBlocksRemainingChecks } from "./docker";

export const increaseContainerRuntimeResources: AdvisoryCheck<HostAssessment> = {
  id: "container_runtime_under_provisioned",
  phase: "preflight.host",
  severity: "warning",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (!host.dockerReachable || !host.isContainerRuntimeUnderProvisioned) return null;
    const detected: string[] = [];
    if (typeof host.dockerCpus === "number") detected.push(`${host.dockerCpus} vCPU`);
    if (typeof host.dockerMemTotalBytes === "number") {
      detected.push(`${(host.dockerMemTotalBytes / 1024 ** 3).toFixed(1)} GiB`);
    }
    const detectedResources = detected.length > 0 ? detected.join(" / ") : "unknown";
    const recommendedResources = `${MIN_RECOMMENDED_DOCKER_CPUS} vCPU / ${MIN_RECOMMENDED_DOCKER_MEM_GIB} GiB`;
    const commands =
      host.runtime === "colima"
        ? [
            "colima stop",
            `colima start --cpu ${MIN_RECOMMENDED_DOCKER_CPUS} --memory ${MIN_RECOMMENDED_DOCKER_MEM_GIB} --disk 100`,
          ]
        : host.runtime === "docker-desktop"
          ? [
              `Open Docker Desktop → Settings → Resources and raise CPUs to ≥ ${MIN_RECOMMENDED_DOCKER_CPUS} and memory to ≥ ${MIN_RECOMMENDED_DOCKER_MEM_GIB} GiB.`,
            ]
          : [
              `Raise your container runtime's resource limits to ≥ ${MIN_RECOMMENDED_DOCKER_CPUS} vCPU and ≥ ${MIN_RECOMMENDED_DOCKER_MEM_GIB} GiB of memory before retrying.`,
            ];
    return hostAdvisory(increaseContainerRuntimeResources, {
      title: "Increase container runtime resources",
      kind: "manual",
      reason:
        `Container runtime is under-provisioned (detected ${detectedResources}; ` +
        `recommended ${recommendedResources}). Sandbox build will be slow and may stall when runtime resources are too low.`,
      commands,
    });
  },
};

export const warnUnsupportedContainerRuntime: AdvisoryCheck<HostAssessment> = {
  id: "unsupported_runtime_warning",
  phase: "preflight.host",
  severity: "warning",
  resumeSafe: false,
  skipIf: wslDockerBlocksRemainingChecks,
  check(host) {
    if (!host.isUnsupportedRuntime) return null;
    return hostAdvisory(warnUnsupportedContainerRuntime, {
      title: "Use a supported Docker runtime if problems appear",
      kind: "manual",
      reason:
        "OpenShell officially documents Docker-based runtimes. Podman may work in some environments, but it is not a supported runtime and behavior may vary.",
      commands:
        host.platform === "darwin"
          ? ["If onboarding or sandbox lifecycle fails, switch to Docker Desktop or Colima."]
          : ["If onboarding or sandbox lifecycle fails, switch to a Docker-supported runtime."],
    });
  },
};

export const RUNTIME_HOST_ADVISORY_CHECKS = Object.freeze([
  increaseContainerRuntimeResources,
  warnUnsupportedContainerRuntime,
]);
