// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DOCKER_DESKTOP_CREDENTIAL_STORE_NAMES,
  isSupportedDockerContextName,
} from "../../../domain/docker-host";
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

/** The endpoint shape every onboarding Docker authority must have. */
const SUPPORTED_DOCKER_ENDPOINT_REASON =
  "Onboarding supports only an absolute unix:// Docker socket. " +
  "The socket path cannot contain a single quote or line break. " +
  "TCP and SSH endpoints and relative paths are not supported, even when reachable. ";

export function wslDockerBlocksRemainingChecks(host: HostAssessment): boolean {
  return (
    host.isWsl &&
    host.dockerProbeIssue === undefined &&
    (!host.dockerInstalled || !host.dockerReachable)
  );
}

export const enableDockerDesktopWslIntegration: AdvisoryCheck<HostAssessment> = {
  id: "enable_docker_desktop_wsl_integration",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  /** WSL guidance yields to a diagnosed authority conflict, which names the real remedy (#10622). */
  check(host) {
    if (
      host.dockerHostInvalid ||
      host.dockerAuthorityConflict !== undefined ||
      !wslDockerBlocksRemainingChecks(host)
    ) {
      return null;
    }
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
  /** Name the variable that actually selected the endpoint: DOCKER_CONTEXT selects one too (#11719). */
  check(host) {
    if (!host.dockerHostInvalid || !host.dockerInstalled) {
      return null;
    }
    const context = host.dockerContextInvalid;
    if (context === undefined) {
      return hostAdvisory(invalidDockerHost, {
        title: "Fix the DOCKER_HOST endpoint",
        kind: "manual",
        reason:
          "DOCKER_HOST is set to an endpoint onboarding cannot use. " +
          SUPPORTED_DOCKER_ENDPOINT_REASON +
          "This is a DOCKER_HOST configuration problem, not a docker-group permission or stopped-daemon issue.",
        commands: [
          "unset DOCKER_HOST   # use Docker's default socket",
          "# or point it at a local socket, for example:",
          "export DOCKER_HOST=unix:///var/run/docker.sock",
          "nemoclaw onboard",
        ],
      });
    }
    // Only Docker's bounded printable context-name grammar may reach terminal
    // output. An invalid selector still owns the authority choice, but echoing
    // it would let an environment value inject terminal controls or unbounded
    // text into the remediation.
    const contextNameIsSafe = isSupportedDockerContextName(context);
    const selectedContextReason = contextNameIsSafe
      ? `DOCKER_CONTEXT selects the Docker context ${shellSingleQuoted(context)}, which does not resolve to an endpoint onboarding can use. `
      : "DOCKER_CONTEXT selects an invalid Docker context name that onboarding cannot use. ";
    return hostAdvisory(invalidDockerHost, {
      title: "Fix the DOCKER_CONTEXT endpoint",
      kind: "manual",
      reason:
        selectedContextReason +
        "Onboarding does not fall back to the default Docker socket here: that would report readiness for a daemon you did not select. " +
        SUPPORTED_DOCKER_ENDPOINT_REASON +
        "This is a DOCKER_CONTEXT configuration problem, not a docker-group permission or stopped-daemon issue.",
      commands: [
        "unset DOCKER_CONTEXT   # use Docker's default context",
        ...(contextNameIsSafe
          ? [
              `docker context inspect ${shellSingleQuoted(context)} --format '{{.Endpoints.docker.Host}}'   # show the selected endpoint`,
            ]
          : []),
        "# or select a context whose endpoint is an absolute unix:// socket",
        "nemoclaw onboard",
      ],
    });
  },
};

export const retryDockerProbe: AdvisoryCheck<HostAssessment> = {
  id: "docker_probe_inconclusive",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  check(host) {
    const issue = host.dockerProbeIssue;
    if (!issue) return null;
    const command = issue.startsWith("version_") ? "docker version" : "docker info";
    const timedOut = issue.endsWith("_timeout");
    return hostAdvisory(retryDockerProbe, {
      title: "Retry the Docker readiness probe",
      kind: "manual",
      reason: timedOut
        ? `The selected Docker authority did not answer \`${command}\` within 15 seconds. NemoClaw kept that authority and did not classify the daemon as stopped.`
        : `NemoClaw could not start the \`${command}\` readiness probe. It kept the selected Docker authority because no daemon verdict was available.`,
      commands: [
        `${command}   # verify the selected Docker authority answers`,
        "Restart the selected Docker runtime if the command remains unresponsive, then rerun `nemoclaw onboard`.",
      ],
    });
  },
};

/** Quote a socket value for the manual POSIX-shell recovery command. */
function shellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export const chooseDockerAuthority: AdvisoryCheck<HostAssessment> = {
  id: "docker_authority_conflict",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  /** Name both engines and the DOCKER_HOST remedy when detection declined to choose (#10622). */
  check(host) {
    const conflict = host.dockerAuthorityConflict;
    if (
      conflict === undefined ||
      !host.dockerInstalled ||
      host.dockerHostInvalid ||
      host.dockerReachable
    ) {
      return null;
    }
    const [first, second] = conflict.candidates;
    const docker = first.identity === "docker" ? first : second;
    return hostAdvisory(chooseDockerAuthority, {
      title: "Choose the Docker authority",
      kind: "manual",
      reason:
        "The default Docker authority did not answer, and two engines answered on discovered sockets: " +
        `${first.identity} at ${first.socketPath} and ${second.identity} at ${second.socketPath}. ` +
        "NemoClaw did not choose between them and kept the default authority. " +
        "It did not diagnose why that authority is unreachable, and it withholds the docker-group and start-Docker remedies while two other engines answer. " +
        "Set DOCKER_HOST to the Docker socket below, or repair the default authority. " +
        "A Podman compatibility socket cannot satisfy the Docker runtime requirement." +
        (host.platform === "linux"
          ? " To use native rootless Podman on a qualified Linux host, set NEMOCLAW_GATEWAY_RUNTIME=podman before onboarding. " +
            "Review the requirements at https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/reference/platform-support#deployment-paths."
          : ""),
      commands: [
        `export DOCKER_HOST=${shellSingleQuoted(`unix://${docker.socketPath}`)}`,
        "nemoclaw onboard",
      ],
    });
  },
};

export const fixMissingDockerEndpointSocket: AdvisoryCheck<HostAssessment> = {
  id: "docker_endpoint_socket_missing",
  phase: "preflight.host",
  severity: "blocking",
  resumeSafe: false,
  /** Name the absent socket instead of a group grant or a daemon restart (#11719). */
  check(host) {
    const endpoint = host.dockerEndpointSocketMissing;
    if (endpoint === undefined || !host.dockerInstalled) return null;
    const socketPath = shellSingleQuoted(endpoint.slice("unix://".length));
    return hostAdvisory(fixMissingDockerEndpointSocket, {
      title: "Fix the selected Docker endpoint",
      kind: "manual",
      reason:
        `The selected Docker endpoint ${endpoint} has no Unix socket at that path. ` +
        "Nothing can be listening there, so this is not a docker-group permission or stopped-daemon problem, " +
        "and NemoClaw withholds both of those remedies rather than act on a wrong cause. " +
        "DOCKER_HOST or DOCKER_CONTEXT selects this endpoint, and the socket must exist before onboarding can use it.",
      commands: [
        `ls -l ${socketPath}   # confirm no socket sits at the selected path`,
        "unset DOCKER_HOST DOCKER_CONTEXT   # use Docker's default endpoint",
        "# or point the selector at a socket that exists",
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
  /**
   * Silent while an authority conflict is observed: group membership is not the
   * diagnosed cause (#10622). Silent too when the selected endpoint's socket is
   * absent, where no group can grant access to a path nothing listens on
   * (#11719).
   */
  check(host) {
    if (
      host.dockerHostInvalid ||
      host.dockerProbeIssue !== undefined ||
      host.dockerAuthorityConflict !== undefined ||
      host.dockerEndpointSocketMissing !== undefined ||
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
  /**
   * Silent while an authority conflict is observed: two engines already answer
   * (#10622). Silent too when an explicitly selected endpoint's socket is
   * absent, where starting the default daemon creates a different socket
   * (#11719).
   */
  check(host) {
    const likelyGroupIssue = host.platform === "linux" && host.dockerServiceActive === true;
    if (
      host.dockerHostInvalid ||
      host.dockerProbeIssue !== undefined ||
      host.dockerAuthorityConflict !== undefined ||
      host.dockerEndpointSocketMissing !== undefined ||
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

export const dockerDesktopCredentialStoreHeadless: AdvisoryCheck<HostAssessment> = {
  id: "docker_desktop_credential_store_headless",
  phase: "preflight.host",
  severity: "warning",
  resumeSafe: false,
  check(host) {
    if (host.runtime !== "docker-desktop") return null;
    const credsStore = host.dockerCredsStore ?? "";
    if (!DOCKER_DESKTOP_CREDENTIAL_STORE_NAMES.has(credsStore)) return null;
    // In WSL the helper runs on the Windows side: WSLg can inject DISPLAY into
    // every shell and SSH variables do not cross wsl.exe, so session markers
    // are wrong in both directions there — trust the helper probe instead.
    const headlessEvidence = host.isWsl
      ? host.dockerCredentialHelperUnresponsive === true
      : Boolean(host.isSshSession) || host.isHeadlessLikely;
    if (!headlessEvidence) return null;
    const sessionEvidence = host.isWsl
      ? "The credential helper did not answer a read-only probe from this WSL session"
      : "This session looks headless";
    const configPath = host.dockerCredsStorePath ?? "the active Docker client config";
    return hostAdvisory(dockerDesktopCredentialStoreHeadless, {
      title: "Avoid Docker Desktop credential store pull failures",
      kind: "manual",
      reason:
        `The active Docker client config (${configPath}) sets credsStore "${credsStore}", ` +
        "which needs the Docker Desktop GUI session. " +
        `${sessionEvidence}, so the credential helper can fail ` +
        "and block every image pull, even for public images.",
      commands: [
        "DOCKER_CONFIG=$(mktemp -d) nemoclaw onboard --resume   # resume with an isolated Docker config",
        `# or temporarily remove the "credsStore" entry from ${configPath}, then rerun \`nemoclaw onboard\`.`,
      ],
    });
  },
};

export const DOCKER_HOST_ADVISORY_CHECKS = Object.freeze([
  enableDockerDesktopWslIntegration,
  installDocker,
  invalidDockerHost,
  retryDockerProbe,
  chooseDockerAuthority,
  fixMissingDockerEndpointSocket,
  addUserToDockerGroup,
  startDocker,
  dockerDesktopCredentialStoreHeadless,
]);
