// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createSdkOpenShellSandboxStateLifecycle,
  type OpenShellSandboxStateLifecycle,
} from "../../adapters/openshell/sandbox-lifecycle-sdk";
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
 * stopped sandbox's state is backupable: the backup transport is SSH+tar
 * through the sandbox runtime and does not need the agent gateway. These
 * helpers use OpenShell to start the exact registered sandbox for the duration
 * of the backup and return it to Stopped afterwards (#6500), so the strict
 * gate can pass without weakening what it protects.
 *
 * Only containers whose `.State.Status` is `exited` or `created` qualify.
 * A running-but-not-Ready container (crash loop, gateway drift, paused) is
 * left alone: starting or stopping it could destroy diagnostic state, and
 * the existing skip message already names the remediation.
 */

export interface StartedForBackup {
  containerName: string;
  gatewayName: string;
  mutationTimeoutMs: number;
  runtimeProviderId: string;
  sandboxIdentityFingerprint: string;
  sandboxName: string;
}

interface StartDeps {
  getSandbox: typeof registry.getSandbox;
  listSandboxNames: () => string[];
  resolveLifecycleEngine: (driverName: string | null | undefined) => SandboxLifecycleEngine | null;
  listLabeledContainerNames: (
    engine: SandboxLifecycleEngine,
    sandboxName: string,
  ) => string[] | null;
  inspectStatus: (engine: SandboxLifecycleEngine, containerName: string) => string | null;
  createOpenShellLifecycle: () => OpenShellSandboxStateLifecycle;
  deadlineMs?: number;
  now: () => number;
}

const defaultStartDeps: StartDeps = {
  getSandbox: registry.getSandbox,
  listSandboxNames: () =>
    registry
      .listSandboxes()
      .sandboxes.filter(registry.isPublishedSandboxRegistration)
      .map((entry) => entry.name),
  resolveLifecycleEngine: resolveSandboxLifecycleEngine,
  listLabeledContainerNames,
  inspectStatus: inspectContainerStatus,
  createOpenShellLifecycle: () => createSdkOpenShellSandboxStateLifecycle({ env: process.env }),
  now: Date.now,
};

export async function startStoppedSandboxContainerForBackup(
  sandboxName: string,
  depsOverride: Partial<StartDeps> = {},
): Promise<StartedForBackup | null> {
  const deps: StartDeps = { ...defaultStartDeps, ...depsOverride };
  const sandbox = deps.getSandbox(sandboxName);
  const sandboxIdentityFingerprint = sandbox?.lifecycleLiveIdentityFingerprint;
  if (!sandboxIdentityFingerprint) return null;
  const engine = deps.resolveLifecycleEngine(sandbox.openshellDriver);
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
  const gatewayName = sandbox.gatewayName ?? "nemoclaw";
  const remainingMs =
    deps.deadlineMs === undefined
      ? engine.mutationTimeoutMs
      : Math.max(1, Math.floor(deps.deadlineMs - deps.now()));
  const result = await deps.createOpenShellLifecycle().startSandbox({
    sandboxName,
    sandboxIdentityFingerprint,
    target: { kind: "named", gatewayName },
    timeoutMs: Math.min(engine.mutationTimeoutMs, remainingMs),
  });
  if (result.kind === "failed") return null;
  return {
    containerName,
    gatewayName,
    mutationTimeoutMs: engine.mutationTimeoutMs,
    runtimeProviderId: engine.runtimeProviderId,
    sandboxIdentityFingerprint,
    sandboxName,
  };
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
  createOpenShellLifecycle: () => OpenShellSandboxStateLifecycle;
  deadlineMs?: number;
  now: () => number;
}

const defaultStopDeps: StopDeps = {
  createOpenShellLifecycle: () => createSdkOpenShellSandboxStateLifecycle({ env: process.env }),
  now: Date.now,
};

/** Return a sandbox started by {@link startStoppedSandboxContainerForBackup}
 * to Stopped through OpenShell. Returns false when that operation fails. */
export async function returnSandboxContainerToStopped(
  started: StartedForBackup,
  depsOverride: Partial<StopDeps> = {},
): Promise<boolean> {
  const deps: StopDeps = { ...defaultStopDeps, ...depsOverride };
  const remainingMs =
    deps.deadlineMs === undefined
      ? started.mutationTimeoutMs
      : Math.max(1, Math.floor(deps.deadlineMs - deps.now()));
  const result = await deps.createOpenShellLifecycle().stopSandbox({
    sandboxName: started.sandboxName,
    sandboxIdentityFingerprint: started.sandboxIdentityFingerprint,
    target: { kind: "named", gatewayName: started.gatewayName },
    timeoutMs: Math.min(started.mutationTimeoutMs, remainingMs),
  });
  return result.kind === "accepted";
}

interface BackupRetryDeps {
  backup: (name: string, deadlineMs: number) => sandboxState.BackupResult;
  probe: (name: string, deadlineMs: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  deadlineMs?: number;
  delayMs: number;
  now: () => number;
}

const STARTED_BACKUP_TRANSACTION_TIMEOUT_MS = 330_000;
const STARTED_BACKUP_FINAL_BACKUP_RESERVE_MS = 120_000;
const STARTED_BACKUP_STOP_RESERVE_MS = 30_000;
const STARTED_BACKUP_RETRY_DELAY_MS = 2_000;

const defaultBackupRetryDeps: BackupRetryDeps = {
  backup: (name, deadlineMs) =>
    snapshotBackup.backupSandboxStateWithManagedAuthority(
      name,
      { deadlineMs },
      {
        getSandbox: registry.getSandbox,
      },
    ),
  probe: sandboxState.probeSandboxSshReachable,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs: STARTED_BACKUP_RETRY_DELAY_MS,
  now: Date.now,
};

/** Create the deadline shared by readiness, backup, and stopped-state cleanup. */
export function startedSandboxBackupTransactionDeadline(now: () => number = Date.now): number {
  return now() + STARTED_BACKUP_TRANSACTION_TIMEOUT_MS;
}

function unreachableBackupResult(error: string): sandboxState.BackupResult {
  return {
    success: false,
    backedUpDirs: [],
    failedDirs: [],
    backedUpFiles: [],
    failedFiles: [],
    unreachable: true,
    error,
  };
}

/**
 * Wait up to 180 seconds for a started sandbox's SSH transport, then run one
 * backup with a 120-second reserve. The shared transaction deadline retains a
 * final 30 seconds for restoring the sandbox's stopped state.
 */
export async function backupStartedSandboxState(
  sandboxName: string,
  depsOverride: Partial<BackupRetryDeps> = {},
): Promise<sandboxState.BackupResult> {
  const deps: BackupRetryDeps = { ...defaultBackupRetryDeps, ...depsOverride };
  const transactionDeadlineMs =
    deps.deadlineMs ?? startedSandboxBackupTransactionDeadline(deps.now);
  const backupDeadlineMs = transactionDeadlineMs - STARTED_BACKUP_STOP_RESERVE_MS;
  const readinessDeadlineMs = backupDeadlineMs - STARTED_BACKUP_FINAL_BACKUP_RESERVE_MS;

  while (deps.now() < readinessDeadlineMs) {
    const probeDeadlineMs = Math.min(readinessDeadlineMs, deps.now() + Math.max(1, deps.delayMs));
    if (deps.probe(sandboxName, probeDeadlineMs)) {
      const result = deps.backup(sandboxName, backupDeadlineMs);
      return deps.now() <= backupDeadlineMs
        ? result
        : unreachableBackupResult("Sandbox backup exceeded its transaction deadline.");
    }
    const remainingReadinessMs = Math.floor(readinessDeadlineMs - deps.now());
    if (remainingReadinessMs <= 0) break;
    await deps.sleep(Math.min(Math.max(1, deps.delayMs), remainingReadinessMs));
  }

  return unreachableBackupResult("Sandbox SSH did not become ready before the backup deadline.");
}
