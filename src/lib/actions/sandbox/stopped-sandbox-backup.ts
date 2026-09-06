// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { retryUntilAsync } from "../../core/retry";
import { resolveSandboxContainerOwner } from "../../domain/sandbox/container-owner";
import type { RuntimeProviderCommandCapture } from "../../onboard/runtime-provider/contract";
import { resolveRegisteredRuntimeProvider } from "../../onboard/runtime-provider/selection";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
import * as snapshotBackup from "./snapshot/backup-authority";

/** Read a registered sandbox's OpenShell driver, treating registry read
 * failure as unknown so callers fail closed on driver-gated decisions. */
function readSandboxDriver(name: string): string | null | undefined {
  try {
    return registry.getSandbox(name)?.openshellDriver;
  } catch {
    return undefined;
  }
}

interface SandboxLifecycleEngine {
  readonly runtimeProviderId: string;
  readonly mutationTimeoutMs: number;
  capture(args: readonly string[], timeoutMs?: number): RuntimeProviderCommandCapture;
}

function resolveSandboxLifecycleEngine(
  driverName: string | null | undefined,
): SandboxLifecycleEngine | null {
  const normalized = driverName?.trim().toLowerCase();
  if (!normalized) return null;
  const provider = resolveRegisteredRuntimeProvider(normalized);
  if (
    !provider ||
    provider.identity.id !== normalized ||
    provider.containerEngine.supported !== true
  ) {
    return null;
  }
  const containerEngine = provider.containerEngine;
  if (!containerEngine.identities.some((identity) => identity.operation === "sandbox-lifecycle")) {
    return null;
  }
  return {
    runtimeProviderId: provider.identity.id,
    mutationTimeoutMs:
      provider.lifecycle.supported === true && provider.lifecycle.containerMutationTimeoutMs
        ? provider.lifecycle.containerMutationTimeoutMs
        : CONTAINER_ENGINE_MUTATION_TIMEOUT_MS,
    capture: (args, timeoutMs) => containerEngine.capture("sandbox-lifecycle", args, timeoutMs),
  };
}

const CONTAINER_ENGINE_PROBE_TIMEOUT_MS = 5_000;
const CONTAINER_ENGINE_MUTATION_TIMEOUT_MS = 30_000;
const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
const OPENSHELL_MANAGED_BY_VALUE = "openshell";
const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";

function captureSucceeded(result: RuntimeProviderCommandCapture): boolean {
  return result.status === 0 && result.error === undefined;
}

function listLabeledContainerNames(
  engine: SandboxLifecycleEngine,
  sandboxName: string,
): string[] | null {
  const result = engine.capture(
    [
      "ps",
      "-a",
      "--filter",
      `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
      "--filter",
      `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--format",
      "{{.Names}}",
    ],
    CONTAINER_ENGINE_PROBE_TIMEOUT_MS,
  );
  if (!captureSucceeded(result)) return null;
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function inspectContainerStatus(
  engine: SandboxLifecycleEngine,
  containerName: string,
): string | null {
  const result = engine.capture(
    ["inspect", "--format", "{{.State.Status}}", containerName],
    CONTAINER_ENGINE_PROBE_TIMEOUT_MS,
  );
  return captureSucceeded(result) ? result.stdout.trim().toLowerCase() : null;
}

/**
 * Backup support for registered container-backed sandboxes whose container is
 * stopped. `backup-all` skips sandboxes the gateway does not report Ready,
 * which under installer-strict mode (#6114) fails the whole run — but a
 * stopped container's state is backupable: the backup transport is SSH+tar
 * through the container's PID 1 and does not need the agent gateway, so
 * starting the provider-owned container is enough to capture it (#6500).
 * These helpers start such a container for the duration of the backup and
 * return it to its stopped state afterwards, so the strict gate can pass
 * without weakening what it protects.
 *
 * Only containers whose `.State.Status` is `exited` or `created` qualify.
 * A running-but-not-Ready container (crash loop, gateway drift, paused) is
 * left alone: starting or stopping it could destroy diagnostic state, and
 * the existing skip message already names the remediation.
 */

export interface StartedForBackup {
  containerName: string;
  runtimeProviderId: string;
}

interface StartDeps {
  getSandboxDriver: (name: string) => string | null | undefined;
  listSandboxNames: () => string[];
  resolveLifecycleEngine: (driverName: string | null | undefined) => SandboxLifecycleEngine | null;
  listLabeledContainerNames: (
    engine: SandboxLifecycleEngine,
    sandboxName: string,
  ) => string[] | null;
  inspectStatus: (engine: SandboxLifecycleEngine, containerName: string) => string | null;
  start: (engine: SandboxLifecycleEngine, containerName: string) => boolean;
}

const defaultStartDeps: StartDeps = {
  getSandboxDriver: readSandboxDriver,
  listSandboxNames: () =>
    registry
      .listSandboxes()
      .sandboxes.filter(registry.isPublishedSandboxRegistration)
      .map((entry) => entry.name),
  resolveLifecycleEngine: resolveSandboxLifecycleEngine,
  listLabeledContainerNames,
  inspectStatus: inspectContainerStatus,
  start: (engine, containerName) =>
    captureSucceeded(engine.capture(["start", containerName], engine.mutationTimeoutMs)),
};

export function startStoppedSandboxContainerForBackup(
  sandboxName: string,
  depsOverride: Partial<StartDeps> = {},
): StartedForBackup | null {
  const deps: StartDeps = { ...defaultStartDeps, ...depsOverride };
  const engine = deps.resolveLifecycleEngine(deps.getSandboxDriver(sandboxName));
  if (!engine) return null;
  const labeledContainerNames = deps.listLabeledContainerNames(engine, sandboxName);
  // Lifecycle mutation must fail closed on missing or ambiguous ownership.
  // Name matching alone is insufficient because starting a container executes
  // its entrypoint; label discovery establishes the OpenShell owner first.
  if (labeledContainerNames === null || labeledContainerNames.length !== 1) return null;
  const containerName = resolveSandboxContainerOwner(
    labeledContainerNames[0] ?? "",
    sandboxName,
    deps.listSandboxNames(),
  );
  if (!containerName) return null;
  // GPU recovery siblings must be renamed through the dedicated recovery flow
  // before they are startable as the sandbox's active container.
  if (/-nemoclaw-gpu-backup-\d+$/.test(containerName)) return null;
  const status = deps.inspectStatus(engine, containerName);
  if (status !== "exited" && status !== "created") return null;
  if (!deps.start(engine, containerName)) return null;
  return { containerName, runtimeProviderId: engine.runtimeProviderId };
}

interface ContainerAbsenceDeps {
  getSandboxDriver: (name: string) => string | null | undefined;
  resolveLifecycleEngine: (driverName: string | null | undefined) => SandboxLifecycleEngine | null;
  /** Labeled container names for the sandbox, or null when the listing itself
   * failed (dead daemon, timeout) and absence must not be concluded. */
  listLabeledContainerNames: (
    engine: SandboxLifecycleEngine,
    sandboxName: string,
  ) => string[] | null;
}

const defaultContainerAbsenceDeps: ContainerAbsenceDeps = {
  getSandboxDriver: readSandboxDriver,
  resolveLifecycleEngine: resolveSandboxLifecycleEngine,
  listLabeledContainerNames,
};

/**
 * Returns true only when the registered sandbox has a container lifecycle
 * engine and a successful labeled listing returns no matching container.
 *
 * Returns false when the provider has no container lifecycle, the registry
 * read fails, or the listing fails or times out. Callers must separately
 * confirm gateway absence and same-gateway binding before classifying a
 * sandbox as stranded.
 */
export function isSandboxContainerDefinitivelyAbsent(
  sandboxName: string,
  depsOverride: Partial<ContainerAbsenceDeps> = {},
): boolean {
  const deps: ContainerAbsenceDeps = { ...defaultContainerAbsenceDeps, ...depsOverride };
  const engine = deps.resolveLifecycleEngine(deps.getSandboxDriver(sandboxName));
  if (!engine) return false;
  const labeledContainerNames = deps.listLabeledContainerNames(engine, sandboxName);
  return labeledContainerNames !== null && labeledContainerNames.length === 0;
}

interface StopDeps {
  resolveLifecycleEngine: (driverName: string | null | undefined) => SandboxLifecycleEngine | null;
  stop: (engine: SandboxLifecycleEngine, containerName: string) => boolean;
  inspectStatus: (engine: SandboxLifecycleEngine, containerName: string) => string | null;
}

const defaultStopDeps: StopDeps = {
  resolveLifecycleEngine: resolveSandboxLifecycleEngine,
  stop: (engine, containerName) =>
    captureSucceeded(engine.capture(["stop", containerName], engine.mutationTimeoutMs)),
  inspectStatus: inspectContainerStatus,
};

/** Return a container started by {@link startStoppedSandboxContainerForBackup}
 * to its stopped state. Returns false when the provider operation fails. */
export function returnSandboxContainerToStopped(
  started: StartedForBackup,
  depsOverride: Partial<StopDeps> = {},
): boolean {
  const deps: StopDeps = { ...defaultStopDeps, ...depsOverride };
  const engine = deps.resolveLifecycleEngine(started.runtimeProviderId);
  if (!engine || !deps.stop(engine, started.containerName)) return false;
  return deps.inspectStatus(engine, started.containerName) === "exited";
}

interface BackupRetryDeps {
  backup: (name: string) => sandboxState.BackupResult;
  sleep: (ms: number) => Promise<void>;
  attempts: number;
  delayMs: number;
}

const STARTED_BACKUP_READY_TIMEOUT_MS = 90_000;
const STARTED_BACKUP_RETRY_DELAY_MS = 2_000;

const defaultBackupRetryDeps: BackupRetryDeps = {
  backup: (name) =>
    snapshotBackup.backupSandboxStateWithManagedAuthority(
      name,
      {},
      {
        getSandbox: registry.getSandbox,
      },
    ),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Managed-profile containers run their provider-owned startup before the
  // OpenShell SSH transport becomes reachable. Keep this inside backup-all's
  // 180-second command budget while allowing a cold managed restart to finish.
  attempts: Math.floor(STARTED_BACKUP_READY_TIMEOUT_MS / STARTED_BACKUP_RETRY_DELAY_MS) + 1,
  delayMs: STARTED_BACKUP_RETRY_DELAY_MS,
};

/**
 * Back up a sandbox whose container was just started. The container's SSH
 * endpoint can take up to the managed cold-start window after `docker start`, so retry
 * while — and only while — the result is a transport-level `unreachable`
 * failure. Every other outcome (success, permission failure, precondition)
 * is returned as-is on first sight.
 */
export async function backupStartedSandboxState(
  sandboxName: string,
  depsOverride: Partial<BackupRetryDeps> = {},
): Promise<sandboxState.BackupResult> {
  const deps: BackupRetryDeps = { ...defaultBackupRetryDeps, ...depsOverride };
  return retryUntilAsync(() => deps.backup(sandboxName), {
    accept: (result) => result.success || !result.unreachable,
    retryDelaysMs: Array.from(
      { length: Math.max(0, Math.ceil(deps.attempts) - 1) },
      () => deps.delayMs,
    ),
    sleep: deps.sleep,
  });
}
