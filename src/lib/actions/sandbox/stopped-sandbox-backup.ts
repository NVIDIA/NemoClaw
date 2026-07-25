// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerContainerInspectFormat } from "../../adapters/docker/inspect";
import { dockerCapture, dockerRun } from "../../adapters/docker/run";
import {
  findLabeledSandboxContainers,
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_NAME_LABEL,
} from "../../onboard/docker-driver-sandbox-recovery";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
import { resolveSandboxContainerOwner } from "./sandbox-container-owner";

/** Read a registered sandbox's OpenShell driver, treating registry read
 * failure as unknown so callers fail closed on driver-gated decisions. */
function readSandboxDriver(name: string): string | null | undefined {
  try {
    return registry.getSandbox(name)?.openshellDriver;
  } catch {
    return undefined;
  }
}

const DOCKER_ABSENCE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Backup support for registered docker-driver sandboxes whose container is
 * stopped. `backup-all` skips sandboxes the gateway does not report Ready,
 * which under installer-strict mode (#6114) fails the whole run — but a
 * stopped container's state is backupable: the backup transport is SSH+tar
 * through the container's PID 1 and does not need the agent gateway, so
 * `docker start` alone is enough to capture it (#6500). These helpers start
 * such a container for the duration of the backup and return it to its
 * stopped state afterwards, so the strict gate can pass without weakening
 * what it protects.
 *
 * Only containers whose `.State.Status` is `exited` or `created` qualify.
 * A running-but-not-Ready container (crash loop, gateway drift, paused) is
 * left alone: starting or stopping it could destroy diagnostic state, and
 * the existing skip message already names the remediation.
 */

export interface StartedForBackup {
  containerName: string;
}

interface StartDeps {
  getSandboxDriver: (name: string) => string | null | undefined;
  listSandboxNames: () => string[];
  listLabeledContainerNames: (sandboxName: string) => string[];
  dockerInspectStatus: (containerName: string) => string;
  dockerStart: (containerName: string) => string;
}

const defaultStartDeps: StartDeps = {
  getSandboxDriver: readSandboxDriver,
  listSandboxNames: () => registry.listSandboxes().sandboxes.map((entry) => entry.name),
  listLabeledContainerNames: (sandboxName) =>
    findLabeledSandboxContainers(sandboxName).map((container) => container.name),
  dockerInspectStatus: (containerName) =>
    dockerContainerInspectFormat("{{.State.Status}}", containerName, { ignoreError: true }),
  // `docker start` echoes the container name on success and prints nothing to
  // stdout on failure, so a non-empty capture doubles as the success signal.
  dockerStart: (containerName) => dockerCapture(["start", containerName], { ignoreError: true }),
};

export function startStoppedSandboxContainerForBackup(
  sandboxName: string,
  depsOverride: Partial<StartDeps> = {},
): StartedForBackup | null {
  const deps: StartDeps = { ...defaultStartDeps, ...depsOverride };
  if (deps.getSandboxDriver(sandboxName) !== "docker") return null;
  const labeledContainerNames = deps.listLabeledContainerNames(sandboxName);
  // Lifecycle mutation must fail closed on missing or ambiguous ownership.
  // Name matching alone is insufficient because starting a container executes
  // its entrypoint; label discovery establishes the OpenShell owner first.
  if (labeledContainerNames.length !== 1) return null;
  const containerName = resolveSandboxContainerOwner(
    labeledContainerNames[0] ?? "",
    sandboxName,
    deps.listSandboxNames(),
  );
  if (!containerName) return null;
  // GPU recovery siblings must be renamed through the dedicated recovery flow
  // before they are startable as the sandbox's active container.
  if (/-nemoclaw-gpu-backup-\d+$/.test(containerName)) return null;
  const status = deps.dockerInspectStatus(containerName).trim().toLowerCase();
  if (status !== "exited" && status !== "created") return null;
  if (deps.dockerStart(containerName).trim() === "") return null;
  return { containerName };
}

interface ContainerAbsenceDeps {
  getSandboxDriver: (name: string) => string | null | undefined;
  /** Labeled container names for the sandbox, or null when the listing itself
   * failed (dead daemon, timeout) and absence must not be concluded. */
  listLabeledContainerNames: (name: string) => string[] | null;
}

const defaultContainerAbsenceDeps: ContainerAbsenceDeps = {
  getSandboxDriver: readSandboxDriver,
  // findLabeledSandboxContainers swallows docker errors (a dead daemon reads
  // as "no containers"), which suits its recovery callers but not an absence
  // proof. Run the same labeled listing status-checked instead: any spawn
  // error, timeout, or non-zero exit yields null, never "absent". ignoreError
  // prevents runner.run() from exiting the process when the listing fails.
  listLabeledContainerNames: (name) => {
    const result = dockerRun(
      [
        "ps",
        "-a",
        "--filter",
        `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${name}`,
        "--format",
        "{{.Names}}",
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_ABSENCE_PROBE_TIMEOUT_MS,
      },
    );
    if (result.error || result.status !== 0) return null;
    return String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  },
};

/**
 * Returns true only when the registered sandbox uses Docker and a successful
 * labeled `docker ps -a` returns no matching container.
 *
 * Returns false when the driver is not Docker, the registry read fails, or the
 * Docker listing fails or times out. Callers must separately confirm gateway
 * absence and same-gateway binding before classifying a sandbox as stranded.
 */
export function isSandboxContainerDefinitivelyAbsent(
  sandboxName: string,
  depsOverride: Partial<ContainerAbsenceDeps> = {},
): boolean {
  const deps: ContainerAbsenceDeps = { ...defaultContainerAbsenceDeps, ...depsOverride };
  if (deps.getSandboxDriver(sandboxName) !== "docker") return false;
  const labeledContainerNames = deps.listLabeledContainerNames(sandboxName);
  return labeledContainerNames !== null && labeledContainerNames.length === 0;
}

interface StopDeps {
  dockerStop: (containerName: string) => string;
  dockerInspectStatus: (containerName: string) => string;
}

const defaultStopDeps: StopDeps = {
  dockerStop: (containerName) => dockerCapture(["stop", containerName], { ignoreError: true }),
  dockerInspectStatus: (containerName) =>
    dockerContainerInspectFormat("{{.State.Status}}", containerName, { ignoreError: true }),
};

/** Return a container started by {@link startStoppedSandboxContainerForBackup}
 * to its stopped state. Returns false when `docker stop` fails. */
export function returnSandboxContainerToStopped(
  containerName: string,
  depsOverride: Partial<StopDeps> = {},
): boolean {
  const deps: StopDeps = { ...defaultStopDeps, ...depsOverride };
  if (deps.dockerStop(containerName).trim() === "") return false;
  return deps.dockerInspectStatus(containerName).trim().toLowerCase() === "exited";
}

interface BackupRetryDeps {
  backup: (name: string) => sandboxState.BackupResult;
  sleep: (ms: number) => Promise<void>;
  attempts: number;
  delayMs: number;
}

const defaultBackupRetryDeps: BackupRetryDeps = {
  backup: (name) => sandboxState.backupSandboxState(name),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts: 5,
  delayMs: 2000,
};

/**
 * Back up a sandbox whose container was just started. The container's SSH
 * endpoint can take a few seconds to answer after `docker start`, so retry
 * while — and only while — the result is a transport-level `unreachable`
 * failure. Every other outcome (success, permission failure, precondition)
 * is returned as-is on first sight.
 */
export async function backupStartedSandboxState(
  sandboxName: string,
  depsOverride: Partial<BackupRetryDeps> = {},
): Promise<sandboxState.BackupResult> {
  const deps: BackupRetryDeps = { ...defaultBackupRetryDeps, ...depsOverride };
  let result = deps.backup(sandboxName);
  for (
    let attempt = 1;
    attempt < deps.attempts && !result.success && result.unreachable;
    attempt++
  ) {
    await deps.sleep(deps.delayMs);
    result = deps.backup(sandboxName);
  }
  return result;
}
