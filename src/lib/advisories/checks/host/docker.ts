// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostAssessment, PackageManager } from "../../../onboard/preflight";
import type { AdvisoryCheck } from "../../types";
import { hostAdvisory } from "./common";

const INSTALL_DOCKER_COMMANDS: Readonly<Record<PackageManager, string>> = {
  apt: "Install Docker Engine, then rerun `nemoclaw onboard`.",
  dnf: "Install Docker Engine with your package manager, then rerun `nemoclaw onboard`.",
  yum: "Install Docker Engine with your package manager, then rerun `nemoclaw onboard`.",
  brew: "Install Docker Desktop or Colima, then rerun `nemoclaw onboard`.",
  pacman: "Install Docker Engine with your package manager, then rerun `nemoclaw onboard`.",
  unknown: "Install Docker, then rerun `nemoclaw onboard`.",
};

export function wslDockerBlocksRemainingChecks(host: HostAssessment): boolean {
  return host.isWsl && (!host.dockerInstalled || !host.dockerReachable);
}

export const enableDockerDesktopWslIntegration: AdvisoryCheck<HostAssessment> = {
  id: "enable_docker_desktop_wsl_integration",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  check(host) {
    if (!wslDockerBlocksRemainingChecks(host)) return null;
    const dockerMissing = !host.dockerInstalled;
    return hostAdvisory(enableDockerDesktopWslIntegration, {
      title: "Enable Docker Desktop WSL integration",
      kind: "manual",
      reason: dockerMissing
        ? "Docker is not available inside this WSL distro. When using Docker Desktop on Windows, WSL integration must be enabled for the Ubuntu distro before NemoClaw can create a gateway or sandbox."
        : "Docker is installed but this WSL distro cannot reach the Docker daemon. Docker Desktop may not be running, or WSL integration may be disabled for this distro.",
      commands: dockerMissing
        ? [
            "Open Docker Desktop → Settings → Resources → WSL integration.",
            "Enable integration for this Ubuntu distro, apply the change, then run `wsl --shutdown` from Windows PowerShell.",
            "Reopen Ubuntu, verify `docker info`, then rerun `nemoclaw onboard`.",
          ]
        : [
            "Start Docker Desktop on Windows.",
            "Open Docker Desktop → Settings → Resources → WSL integration and enable integration for this Ubuntu distro.",
            "Apply the change, run `wsl --shutdown` from Windows PowerShell, reopen Ubuntu, verify `docker info`, then rerun `nemoclaw onboard`.",
          ],
    });
  },
};

export const installDocker: AdvisoryCheck<HostAssessment> = {
  id: "install_docker",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  check(host) {
    if (host.dockerInstalled || host.isWsl) return null;
    return hostAdvisory(installDocker, {
      title: "Install Docker",
      kind: "manual",
      reason: "Docker is required before onboarding can create a gateway or sandbox.",
      commands:
        host.platform === "darwin"
          ? ["Install Docker Desktop or Colima, then rerun `nemoclaw onboard`."]
          : [INSTALL_DOCKER_COMMANDS[host.packageManager ?? "unknown"]],
    });
  },
};

export const invalidDockerHost: AdvisoryCheck<HostAssessment> = {
  id: "invalid_docker_host",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  check(host) {
    if (!host.dockerHostInvalid || !host.dockerInstalled || host.isWsl) {
      return null;
    }
    return hostAdvisory(invalidDockerHost, {
      title: "Fix the DOCKER_HOST endpoint",
      kind: "manual",
      reason:
        "DOCKER_HOST is set to an endpoint onboarding cannot use. " +
        "Onboarding supports only an absolute unix:// Docker socket. " +
        "The socket path cannot contain a single quote or line break. " +
        "TCP and SSH endpoints and relative paths are not supported, even when reachable. " +
        "This is a DOCKER_HOST configuration problem, not a docker-group permission or stopped-daemon issue.",
      commands: [
        "unset DOCKER_HOST   # use Docker's default socket",
        "# or point it at a local socket, for example:",
        "export DOCKER_HOST=unix:///var/run/docker.sock",
        "nemoclaw onboard",
      ],
    });
  },
};

export const addUserToDockerGroup: AdvisoryCheck<HostAssessment> = {
  id: "docker_group_permission",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  check(host) {
    if (
      host.dockerHostInvalid ||
      !host.dockerInstalled ||
      host.dockerReachable ||
      host.isWsl ||
      host.platform !== "linux" ||
      host.dockerServiceActive !== true
    ) {
      return null;
    }
    return hostAdvisory(addUserToDockerGroup, {
      title: "Add user to docker group",
      kind: "sudo",
      reason:
        "Docker is installed and the service is running, but the current user cannot reach the daemon. " +
        "This usually means your user is not in the docker group. " +
        "NemoClaw needs Docker access. " +
        "On personal Linux development machines, adding your user to the docker group is the standard way to run Docker without sudo. " +
        "Docker group members can control the daemon with root-level impact, so grant this access only to trusted local accounts; on shared or managed systems, use your organization's approved Docker access path. " +
        "Background: https://docs.docker.com/engine/security/#docker-daemon-attack-surface.",
      commands: [
        "sudo usermod -aG docker $USER",
        "newgrp docker   # or log out and back in",
        "nemoclaw onboard",
      ],
    });
  },
};

export const startDocker: AdvisoryCheck<HostAssessment> = {
  id: "start_docker",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  check(host) {
    const likelyGroupIssue = host.platform === "linux" && host.dockerServiceActive === true;
    if (
      host.dockerHostInvalid ||
      !host.dockerInstalled ||
      host.dockerReachable ||
      host.isWsl ||
      likelyGroupIssue
    )
      return null;
    return hostAdvisory(startDocker, {
      title: "Start Docker",
      kind: "manual",
      reason: "Docker is installed but NemoClaw could not talk to the Docker daemon.",
      commands:
        host.platform === "darwin"
          ? ["Start Docker Desktop or Colima, then rerun `nemoclaw onboard`."]
          : host.systemctlAvailable
            ? ["sudo systemctl start docker", "nemoclaw onboard"]
            : ["Start the Docker daemon, then rerun `nemoclaw onboard`."],
    });
  },
};

export const DOCKER_HOST_ADVISORY_CHECKS = Object.freeze([
  enableDockerDesktopWslIntegration,
  installDocker,
  invalidDockerHost,
  addUserToDockerGroup,
  startDocker,
]);
