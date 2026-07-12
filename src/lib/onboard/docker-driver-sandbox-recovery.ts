// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenShell-managed container labels — duplicated locally to keep
// the module unit-testable. `docker-gpu-patch.ts` re-exports them as
// the source of truth; a parity test pins drift.
export const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
export const OPENSHELL_MANAGED_BY_VALUE = "openshell";
export const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";

// Lazy adapter accessors. Top-level `import` from `../adapters/docker`
// pulls in `runner.ts`'s load-time `require("./platform")`, which the
// Vitest TS loader cannot resolve. Per-call lazy require keeps the
// module unit-testable in-process; the same pattern is used by
// `auto-pair-approval.ts`. Tests inject `deps` so the lazy require
// never fires.
type DockerCaptureFn = (args: readonly string[], opts?: Record<string, unknown>) => string;
type DockerOpResult = { status?: number | null };
type DockerStartFn = (name: string, opts?: Record<string, unknown>) => DockerOpResult;
type DockerRenameFn = (
  oldName: string,
  newName: string,
  opts?: Record<string, unknown>,
) => DockerOpResult;

function loadDockerCapture(): DockerCaptureFn {
  return (require("../adapters/docker") as { dockerCapture: DockerCaptureFn }).dockerCapture;
}
function loadDockerStart(): DockerStartFn {
  return (require("../adapters/docker") as { dockerStart: DockerStartFn }).dockerStart;
}
function loadDockerRename(): DockerRenameFn {
  return (require("../adapters/docker") as { dockerRename: DockerRenameFn }).dockerRename;
}

/**
 * Active Docker-driver sandbox recovery (#4423 part 2).
 *
 * After a host reboot on Linux/Spark Docker-driver hosts, the OpenShell
 * gateway can come back HEALTHY (per #4580's user-systemd unit) yet
 * report a registered sandbox as `NotFound` — its in-memory sandbox
 * registry didn't survive the reboot. The labeled Docker container is
 * still on disk, often just stopped, sometimes only present as a
 * `*-nemoclaw-gpu-backup-*` sibling that the GPU patch path produced.
 *
 * #4578 (passive guard) and #4497 (active-path tightening) made the
 * existing `missing` branches non-destructive — they preserve the
 * registry entry. This helper closes the loop by ACTIVELY recovering
 * the sandbox container so the user's next command sees a live
 * sandbox instead of guidance to retry.
 *
 * Boundary:
 *   - This module talks ONLY to Docker. It does not call OpenShell
 *     directly — callers retry the OpenShell sandbox lookup after
 *     recovery succeeds.
 *   - Lookups are by OpenShell labels
 *     (`openshell.ai/managed-by=openshell` AND
 *      `openshell.ai/sandbox-name=<name>`), the same labels
 *     `findOpenShellDockerSandboxContainerIds` already uses.
 *   - Recovery is best-effort and short-circuits at the first
 *     successful path. Failure modes are surfaced as
 *     `{ recovered: false, ... }` so the caller can fall through
 *     to the existing non-destructive guidance.
 */

const DOCKER_PROBE_TIMEOUT_MS = 5_000;
const DOCKER_OPERATION_TIMEOUT_MS = 30_000;
const MAX_DOCKER_CONTAINER_NAME_LENGTH = 253;

/**
 * Names recovery dispatched on. Stable identifiers callers can log,
 * surface in artifacts, or pin in tests. Adding a new mode requires
 * extending `recoverDockerDriverSandbox` and a unit test pinning the
 * new branch.
 */
export type DockerDriverRecoveryVia =
  | "started-running-original" // labeled container was already running; nothing to do.
  | "started-stopped-original" // labeled container existed but was stopped; `docker start`.
  | "renamed-and-started-backup"; // only a `*-nemoclaw-gpu-backup-*` sibling existed; rename back + start.

export interface DockerDriverRecoveryResult {
  recovered: boolean;
  via: DockerDriverRecoveryVia | null;
  /** Container name (post-rename if applicable) the recovery acted on. */
  containerName?: string;
  /**
   * Human-readable detail when recovery did not succeed — surface in
   * logs / guidance. Empty when recovery succeeded.
   */
  detail?: string;
}

export interface DockerDriverRecoveryDeps {
  /** `docker ps -a --filter ... --format ...` runner. */
  dockerCapture?: (args: readonly string[], opts?: Record<string, unknown>) => string;
  dockerStart?: (name: string, opts?: Record<string, unknown>) => { status?: number | null };
  dockerRename?: (
    oldName: string,
    newName: string,
    opts?: Record<string, unknown>,
  ) => { status?: number | null };
  /** Injectable clock for deterministic backup-name normalization in tests. */
  now?: () => number;
}

interface LabeledContainer {
  name: string;
  status: string;
  /** True when the container is in a Docker `running` state. */
  running: boolean;
}

function depsWithDefaults(deps: DockerDriverRecoveryDeps) {
  return {
    dockerCapture: deps.dockerCapture ?? ((args, opts) => loadDockerCapture()(args, opts)),
    dockerStart: deps.dockerStart ?? ((name, opts) => loadDockerStart()(name, opts)),
    dockerRename:
      deps.dockerRename ?? ((oldName, newName, opts) => loadDockerRename()(oldName, newName, opts)),
    now: deps.now ?? (() => Date.now()),
  };
}

function isBackupSiblingName(name: string): boolean {
  return /-nemoclaw-gpu-backup-\d+$/.test(name);
}

function originalNameFromBackup(backupName: string): string {
  return backupName.replace(/-nemoclaw-gpu-backup-\d+$/, "");
}

/**
 * Discover OpenShell-labeled Docker containers for the given sandbox
 * name across all states (running, exited, paused, dead). Empty array
 * means recovery has nothing to act on.
 *
 * Output rows are tab-separated `<name>\t<status>` from
 * `--format '{{.Names}}\t{{.Status}}'`. `Status` strings start with
 * `Up` for running containers (e.g. `Up 5 minutes`) and `Exited` /
 * `Created` / `Paused` / `Dead` otherwise.
 */
export function findLabeledSandboxContainers(
  sandboxName: string,
  deps: DockerDriverRecoveryDeps = {},
): LabeledContainer[] {
  const d = depsWithDefaults(deps);
  const output = d.dockerCapture(
    [
      "ps",
      "-a",
      "--filter",
      `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
      "--filter",
      `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--format",
      "{{.Names}}\t{{.Status}}",
    ],
    { ignoreError: true, timeout: DOCKER_PROBE_TIMEOUT_MS },
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split("\t");
      const status = rest.join("\t").trim();
      return { name, status, running: status.startsWith("Up") };
    });
}

function classifyCandidate(containers: LabeledContainer[]): {
  runningOriginal?: LabeledContainer;
  stoppedOriginal?: LabeledContainer;
  backup?: LabeledContainer;
} {
  let runningOriginal: LabeledContainer | undefined;
  let stoppedOriginal: LabeledContainer | undefined;
  let backup: LabeledContainer | undefined;
  for (const container of containers) {
    if (isBackupSiblingName(container.name)) {
      // Prefer the most recent backup if there are multiple (timestamp
      // suffix is monotonically increasing in `buildBackupContainerName`).
      if (!backup || container.name > backup.name) {
        backup = container;
      }
      continue;
    }
    if (container.running) {
      runningOriginal = container;
    } else {
      stoppedOriginal = container;
    }
  }
  return { runningOriginal, stoppedOriginal, backup };
}

function buildBackupRestoreName(originalName: string): string {
  if (originalName.length <= MAX_DOCKER_CONTAINER_NAME_LENGTH) {
    return originalName;
  }
  return originalName.slice(0, MAX_DOCKER_CONTAINER_NAME_LENGTH);
}

/**
 * Attempt to recover the labeled sandbox container so OpenShell sees
 * the sandbox again. Caller must retry `openshell sandbox get <name>`
 * after a successful return.
 *
 * Order of operations:
 *   1. Already-running labeled container → no-op success.
 *   2. Stopped labeled original → `docker start <name>`.
 *   3. Backup-only (`*-nemoclaw-gpu-backup-*` sibling) → `docker
 *      rename <backup> <original>` then `docker start <original>`.
 *   4. Conflict (backup AND a stale stopped original with the same
 *      base name) → start the original; leave the backup alone.
 *   5. No labeled container at all → `{ recovered: false }`.
 */
export function recoverDockerDriverSandbox(
  sandboxName: string,
  deps: DockerDriverRecoveryDeps = {},
): DockerDriverRecoveryResult {
  const d = depsWithDefaults(deps);
  const containers = findLabeledSandboxContainers(sandboxName, deps);
  if (containers.length === 0) {
    return {
      recovered: false,
      via: null,
      detail: `no Docker container labeled '${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}'`,
    };
  }

  const { runningOriginal, stoppedOriginal, backup } = classifyCandidate(containers);

  if (runningOriginal) {
    return {
      recovered: true,
      via: "started-running-original",
      containerName: runningOriginal.name,
    };
  }

  if (stoppedOriginal) {
    const result = d.dockerStart(stoppedOriginal.name, {
      ignoreError: true,
      timeout: DOCKER_OPERATION_TIMEOUT_MS,
    });
    if (result.status === 0) {
      return {
        recovered: true,
        via: "started-stopped-original",
        containerName: stoppedOriginal.name,
      };
    }
    return {
      recovered: false,
      via: null,
      detail: `docker start ${stoppedOriginal.name} failed (exit ${result.status ?? "unknown"})`,
    };
  }

  if (backup) {
    const restoreName = buildBackupRestoreName(originalNameFromBackup(backup.name));
    const renameResult = d.dockerRename(backup.name, restoreName, {
      ignoreError: true,
      timeout: DOCKER_OPERATION_TIMEOUT_MS,
    });
    if (renameResult.status !== 0) {
      return {
        recovered: false,
        via: null,
        detail: `docker rename ${backup.name} ${restoreName} failed (exit ${renameResult.status ?? "unknown"})`,
      };
    }
    const startResult = d.dockerStart(restoreName, {
      ignoreError: true,
      timeout: DOCKER_OPERATION_TIMEOUT_MS,
    });
    if (startResult.status === 0) {
      return {
        recovered: true,
        via: "renamed-and-started-backup",
        containerName: restoreName,
      };
    }
    return {
      recovered: false,
      via: null,
      detail: `docker start ${restoreName} after backup rename failed (exit ${startResult.status ?? "unknown"})`,
    };
  }

  return {
    recovered: false,
    via: null,
    detail: "no recoverable container shape (running original / stopped original / backup sibling)",
  };
}
