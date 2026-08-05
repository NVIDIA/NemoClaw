// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

const DEFAULT_RESUME_TIMEOUT_MS = 30_000;
const DEFAULT_RESUME_POLL_INTERVAL_MS = 250;
const MAX_OPAQUE_IDENTITY_LENGTH = 4_096;
const SAFE_GATEWAY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const SAFE_LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export const PODMAN_WATCHER_LEASE_SCHEMA_VERSION = 2;

export type PodmanGatewayWatcherOwnerKind = "managed-service" | "standalone";
export type PodmanGatewayWatcherLeasePhase = "acquiring" | "stopped";

/**
 * Immutable, non-secret evidence identifying one target-bound host gateway
 * watcher and the lifecycle owner capable of stopping and resuming it.
 *
 * `processStartIdentity` must distinguish PID reuse. `ownerIdentity` and
 * `launchIdentity` are opaque, stable identities supplied by the gateway
 * lifecycle owner. They are compared but never interpolated into commands.
 */
export interface PodmanGatewayWatcherSnapshot {
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly launchIdentity: string;
  readonly ownerIdentity: string;
  readonly ownerKind: PodmanGatewayWatcherOwnerKind;
  readonly pid: number;
  readonly processStartIdentity: string;
}

/** Process identity for the NemoClaw transaction that currently owns a lease. */
export interface PodmanGatewayWatcherLeaseHolder {
  readonly pid: number;
  /** Stable process-start identity that prevents PID reuse from proving liveness. */
  readonly processStartIdentity: string;
}

/**
 * Durable authority written before NemoClaw asks a gateway owner to stop.
 * Recovery treats both phases as unfinished and derives the real state from
 * independent process, owner, listener, and health probes.
 */
export interface PodmanGatewayWatcherLeaseRecord extends PodmanGatewayWatcherSnapshot {
  readonly schemaVersion: typeof PODMAN_WATCHER_LEASE_SCHEMA_VERSION;
  readonly holder: PodmanGatewayWatcherLeaseHolder;
  readonly leaseId: string;
  readonly phase: PodmanGatewayWatcherLeasePhase;
}

export interface PodmanGatewayWatcherLeaseStore {
  /** Read one exact record. Corrupt or ambiguous storage must throw. */
  readonly read: () => PodmanGatewayWatcherLeaseRecord | null;
  /** Atomically create the record only when no lease exists, then durably flush it. */
  readonly acquire: (record: PodmanGatewayWatcherLeaseRecord) => void;
  /** Atomically replace only the expected record, then durably flush it. */
  readonly advance: (expectedLeaseId: string, record: PodmanGatewayWatcherLeaseRecord) => void;
  /** Atomically clear only the expected record and durably flush the removal. */
  readonly clear: (expectedLeaseId: string) => void;
}

export interface PodmanManagedGatewayWatcherControllerDeps {
  readonly store: PodmanGatewayWatcherLeaseStore;
  readonly captureCurrent: () => PodmanGatewayWatcherSnapshot;
  readonly listTargetWatchers: (
    target: Readonly<Pick<PodmanGatewayWatcherSnapshot, "gatewayName" | "gatewayPort">>,
  ) => readonly PodmanGatewayWatcherSnapshot[];
  readonly isProcessInstanceAlive: (snapshot: PodmanGatewayWatcherSnapshot) => boolean;
  readonly captureLeaseHolder: () => PodmanGatewayWatcherLeaseHolder;
  readonly isLeaseHolderAlive: (holder: PodmanGatewayWatcherLeaseHolder) => boolean;
  readonly isOwnerStopped: (snapshot: PodmanGatewayWatcherSnapshot) => boolean;
  readonly stopExactOwner: (snapshot: PodmanGatewayWatcherSnapshot) => void;
  readonly resumeSameOwner: (snapshot: PodmanGatewayWatcherSnapshot) => void;
  readonly isHealthy: (snapshot: PodmanGatewayWatcherSnapshot) => boolean;
  readonly createLeaseId?: () => string;
  readonly now?: () => number;
  readonly resumePollIntervalMs?: number;
  readonly resumeTimeoutMs?: number;
  readonly sleep?: (milliseconds: number) => void;
}

export interface PodmanGatewayWatcherLease {
  readonly record: PodmanGatewayWatcherLeaseRecord;
  readonly assertStillStopped: () => void;
  readonly resumeAndProve: () => void;
}

export interface PodmanManagedGatewayWatcherController {
  /** Recover a crash-left lease before another Podman transaction may start. */
  readonly recoverUnfinishedLease: () => void;
  /** Durably acquire exclusive authority and prove the exact owner is stopped. */
  readonly quiesceAndProve: () => PodmanGatewayWatcherLease;
}

export class PodmanGatewayWatcherLeaseError extends Error {
  public readonly recoveryRequired: boolean;

  public constructor(message: string, recoveryRequired = false) {
    super(message);
    this.name = "PodmanGatewayWatcherLeaseError";
    this.recoveryRequired = recoveryRequired;
  }
}

function sleepMs(milliseconds: number): void {
  if (milliseconds <= 0 || !Number.isFinite(milliseconds)) return;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

function safeOpaqueIdentity(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_OPAQUE_IDENTITY_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new PodmanGatewayWatcherLeaseError(
      `Podman OpenShell watcher ${field} is missing or unsafe.`,
    );
  }
  return value;
}

function normalizeSnapshot(
  value: PodmanGatewayWatcherSnapshot,
  expectedTarget?: Readonly<Pick<PodmanGatewayWatcherSnapshot, "gatewayName" | "gatewayPort">>,
): Readonly<PodmanGatewayWatcherSnapshot> {
  if (!value || typeof value !== "object") {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher identity proof did not return an object.",
    );
  }
  if (!SAFE_GATEWAY_NAME.test(value.gatewayName)) {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher identity has an invalid gateway name.",
    );
  }
  if (
    !Number.isSafeInteger(value.gatewayPort) ||
    value.gatewayPort < 1 ||
    value.gatewayPort > 65_535
  ) {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher identity has an invalid gateway port.",
    );
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher identity has an invalid process ID.",
    );
  }
  if (value.ownerKind !== "managed-service" && value.ownerKind !== "standalone") {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher identity has an unsupported lifecycle owner.",
    );
  }
  if (
    expectedTarget &&
    (value.gatewayName !== expectedTarget.gatewayName ||
      value.gatewayPort !== expectedTarget.gatewayPort)
  ) {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher enumeration returned a different gateway target.",
    );
  }
  return Object.freeze({
    gatewayName: value.gatewayName,
    gatewayPort: value.gatewayPort,
    launchIdentity: safeOpaqueIdentity(value.launchIdentity, "launch identity"),
    ownerIdentity: safeOpaqueIdentity(value.ownerIdentity, "owner identity"),
    ownerKind: value.ownerKind,
    pid: value.pid,
    processStartIdentity: safeOpaqueIdentity(value.processStartIdentity, "process-start identity"),
  });
}

function normalizeHolder(value: PodmanGatewayWatcherLeaseHolder): PodmanGatewayWatcherLeaseHolder {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new PodmanGatewayWatcherLeaseError(
      "Durable Podman watcher lease holder has an invalid process ID.",
      true,
    );
  }
  return Object.freeze({
    pid: value.pid,
    processStartIdentity: safeOpaqueIdentity(
      value.processStartIdentity,
      "lease-holder process-start identity",
    ),
  });
}

function normalizeRecord(value: PodmanGatewayWatcherLeaseRecord): PodmanGatewayWatcherLeaseRecord {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== PODMAN_WATCHER_LEASE_SCHEMA_VERSION ||
    !SAFE_LEASE_ID.test(value.leaseId) ||
    (value.phase !== "acquiring" && value.phase !== "stopped")
  ) {
    throw new PodmanGatewayWatcherLeaseError(
      "Durable Podman OpenShell watcher lease is invalid.",
      true,
    );
  }
  return Object.freeze({
    ...normalizeSnapshot(value),
    schemaVersion: PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
    holder: normalizeHolder(value.holder),
    leaseId: value.leaseId,
    phase: value.phase,
  });
}

function sameLaunchOwner(
  left: Readonly<PodmanGatewayWatcherSnapshot>,
  right: Readonly<PodmanGatewayWatcherSnapshot>,
): boolean {
  return (
    left.gatewayName === right.gatewayName &&
    left.gatewayPort === right.gatewayPort &&
    left.ownerKind === right.ownerKind &&
    left.ownerIdentity === right.ownerIdentity &&
    left.launchIdentity === right.launchIdentity
  );
}

function sameProcessInstance(
  left: Readonly<PodmanGatewayWatcherSnapshot>,
  right: Readonly<PodmanGatewayWatcherSnapshot>,
): boolean {
  return (
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    sameLaunchOwner(left, right)
  );
}

function readTargetWatchers(
  receipt: Readonly<PodmanGatewayWatcherSnapshot>,
  deps: PodmanManagedGatewayWatcherControllerDeps,
): readonly Readonly<PodmanGatewayWatcherSnapshot>[] {
  const target = { gatewayName: receipt.gatewayName, gatewayPort: receipt.gatewayPort } as const;
  const watchers = deps.listTargetWatchers(target);
  if (!Array.isArray(watchers)) {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher enumeration did not return an array.",
    );
  }
  return watchers.map((entry) => normalizeSnapshot(entry, target));
}

function requireExclusiveCurrent(
  receipt: Readonly<PodmanGatewayWatcherSnapshot>,
  deps: PodmanManagedGatewayWatcherControllerDeps,
): void {
  const watchers = readTargetWatchers(receipt, deps);
  if (watchers.length !== 1 || !sameProcessInstance(receipt, watchers[0] as typeof receipt)) {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman bootstrap requires exactly one target-bound OpenShell watcher matching the captured process and lifecycle owner.",
    );
  }
  if (!deps.isProcessInstanceAlive(receipt) || deps.isOwnerStopped(receipt)) {
    throw new PodmanGatewayWatcherLeaseError(
      "The captured Podman OpenShell watcher or its lifecycle owner changed before cutover.",
    );
  }
  if (!deps.isHealthy(receipt)) {
    throw new PodmanGatewayWatcherLeaseError(
      "The captured Podman OpenShell watcher is not healthy before cutover.",
    );
  }
}

function assertStopped(
  receipt: Readonly<PodmanGatewayWatcherSnapshot>,
  deps: PodmanManagedGatewayWatcherControllerDeps,
): void {
  if (deps.isProcessInstanceAlive(receipt)) {
    throw new PodmanGatewayWatcherLeaseError(
      "The captured OpenShell watcher process instance is still alive.",
      true,
    );
  }
  if (!deps.isOwnerStopped(receipt)) {
    throw new PodmanGatewayWatcherLeaseError(
      "The captured OpenShell watcher lifecycle owner is not proven stopped.",
      true,
    );
  }
  if (readTargetWatchers(receipt, deps).length !== 0) {
    throw new PodmanGatewayWatcherLeaseError(
      "A target-bound OpenShell watcher appeared while the durable stop lease was held.",
      true,
    );
  }
}

function readinessWaitOptions(deps: PodmanManagedGatewayWatcherControllerDeps) {
  const timeoutMs = deps.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS;
  const pollIntervalMs = deps.resumePollIntervalMs ?? DEFAULT_RESUME_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher resume timeout must be positive.",
    );
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher resume poll interval must be non-negative.",
    );
  }
  const now = deps.now ?? Date.now;
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new PodmanGatewayWatcherLeaseError(
      "Podman OpenShell watcher resume clock is unavailable.",
    );
  }
  return {
    deadlineMs: startedAt + timeoutMs,
    maxAttempts: Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollIntervalMs)) + 1),
    now,
    pollIntervalMs,
    sleep: deps.sleep ?? sleepMs,
  };
}

function waitForExactHealthy(
  condition: () => boolean,
  options: ReturnType<typeof readinessWaitOptions>,
): boolean {
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    const now = options.now();
    if (!Number.isFinite(now) || now >= options.deadlineMs) return false;
    if (condition()) return true;
    if (attempt + 1 >= options.maxAttempts) return false;
    const remainingMs = options.deadlineMs - options.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return false;
    options.sleep(Math.min(options.pollIntervalMs, remainingMs));
  }
  return false;
}

function exactHealthyReplacement(
  receipt: Readonly<PodmanGatewayWatcherSnapshot>,
  deps: PodmanManagedGatewayWatcherControllerDeps,
): Readonly<PodmanGatewayWatcherSnapshot> | null {
  if (deps.isProcessInstanceAlive(receipt) || deps.isOwnerStopped(receipt)) return null;
  const watchers = readTargetWatchers(receipt, deps);
  if (watchers.length === 0) return null;
  if (watchers.length !== 1) {
    throw new PodmanGatewayWatcherLeaseError(
      "Multiple target-bound OpenShell watchers appeared while resuming the captured owner.",
      true,
    );
  }
  const resumed = watchers[0] as Readonly<PodmanGatewayWatcherSnapshot>;
  if (!sameLaunchOwner(receipt, resumed)) {
    throw new PodmanGatewayWatcherLeaseError(
      "The resumed OpenShell watcher does not match the captured lifecycle owner and launch identity.",
      true,
    );
  }
  if (!deps.isProcessInstanceAlive(resumed) || !deps.isHealthy(resumed)) return null;
  return resumed;
}

function resumeAndProve(
  receipt: Readonly<PodmanGatewayWatcherSnapshot>,
  deps: PodmanManagedGatewayWatcherControllerDeps,
): void {
  const existing = readTargetWatchers(receipt, deps);
  if (existing.length > 1) {
    throw new PodmanGatewayWatcherLeaseError(
      "Multiple target-bound OpenShell watchers exist; refusing to start another.",
      true,
    );
  }
  if (existing.length === 1) {
    const current = existing[0] as Readonly<PodmanGatewayWatcherSnapshot>;
    if (
      !sameLaunchOwner(receipt, current) ||
      deps.isOwnerStopped(receipt) ||
      !deps.isProcessInstanceAlive(current) ||
      !deps.isHealthy(current)
    ) {
      throw new PodmanGatewayWatcherLeaseError(
        "A target-bound OpenShell watcher exists without exact healthy owner proof.",
        true,
      );
    }
    return;
  }
  if (!deps.isOwnerStopped(receipt)) {
    throw new PodmanGatewayWatcherLeaseError(
      "The captured owner is neither stopped nor serving an exact healthy watcher.",
      true,
    );
  }

  let resumeError: unknown = null;
  try {
    deps.resumeSameOwner(receipt);
  } catch (error) {
    // The service boundary may lose its reply after completing the start. The
    // independent owner/process/health proof below remains authoritative.
    resumeError = error;
  }
  let resumed: Readonly<PodmanGatewayWatcherSnapshot> | null = null;
  const healthy = waitForExactHealthy(() => {
    resumed = exactHealthyReplacement(receipt, deps);
    return resumed !== null;
  }, readinessWaitOptions(deps));
  if (!healthy || resumed === null) {
    throw new PodmanGatewayWatcherLeaseError(
      `The same OpenShell watcher lifecycle owner did not resume one exact healthy target-bound watcher within the bounded deadline${
        resumeError === null ? "." : " after its start operation failed."
      }`,
      true,
    );
  }
}

function readLease(deps: PodmanManagedGatewayWatcherControllerDeps) {
  const value = deps.store.read();
  return value === null ? null : normalizeRecord(value);
}

function sameLease(
  left: PodmanGatewayWatcherLeaseRecord,
  right: PodmanGatewayWatcherLeaseRecord,
): boolean {
  return (
    left.leaseId === right.leaseId &&
    left.holder.pid === right.holder.pid &&
    left.holder.processStartIdentity === right.holder.processStartIdentity &&
    sameProcessInstance(left, right)
  );
}

/**
 * Build the inert watcher authority needed by native Podman replacement.
 *
 * The lease is persisted before the first stop request. Crash recovery never
 * guesses whether that request completed: it probes the exact captured owner
 * and either proves it healthy or resumes that same launch identity. The lease
 * record is cleared only after the independent health proof succeeds.
 */
export function createPodmanManagedGatewayWatcherController(
  deps: PodmanManagedGatewayWatcherControllerDeps,
): PodmanManagedGatewayWatcherController {
  const recoverUnfinishedLease = () => {
    const record = readLease(deps);
    if (!record) return;
    if (deps.isLeaseHolderAlive(record.holder)) {
      throw new PodmanGatewayWatcherLeaseError(
        "Durable Podman watcher lease is still owned by a live transaction process.",
        true,
      );
    }
    resumeAndProve(record, deps);
    deps.store.clear(record.leaseId);
  };

  return Object.freeze({
    recoverUnfinishedLease,
    quiesceAndProve: () => {
      recoverUnfinishedLease();

      const captured = normalizeSnapshot(deps.captureCurrent());
      requireExclusiveCurrent(captured, deps);
      const leaseId = (deps.createLeaseId ?? randomUUID)();
      if (!SAFE_LEASE_ID.test(leaseId)) {
        throw new PodmanGatewayWatcherLeaseError("Podman watcher lease identity is invalid.");
      }
      const holder = normalizeHolder(deps.captureLeaseHolder());
      const acquiring = Object.freeze({
        ...captured,
        schemaVersion: PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
        holder,
        leaseId,
        phase: "acquiring" as const,
      });
      deps.store.acquire(acquiring);

      try {
        deps.stopExactOwner(captured);
        assertStopped(captured, deps);
      } catch (error) {
        try {
          resumeAndProve(captured, deps);
          deps.store.clear(leaseId);
        } catch {
          throw new PodmanGatewayWatcherLeaseError(
            `Stopping the exact Podman OpenShell watcher failed: ${
              error instanceof Error ? error.message : String(error)
            }. Durable recovery is required.`,
            true,
          );
        }
        throw new PodmanGatewayWatcherLeaseError(
          `Stopping the exact Podman OpenShell watcher failed: ${
            error instanceof Error ? error.message : String(error)
          }. The exact captured watcher was restored.`,
        );
      }

      const stopped = Object.freeze({ ...acquiring, phase: "stopped" as const });
      try {
        deps.store.advance(leaseId, stopped);
      } catch (error) {
        try {
          resumeAndProve(stopped, deps);
          deps.store.clear(leaseId);
        } catch {
          throw new PodmanGatewayWatcherLeaseError(
            "The watcher stopped, but persisting the stopped lease failed and exact recovery did not complete.",
            true,
          );
        }
        throw new PodmanGatewayWatcherLeaseError(
          `Persisting the stopped Podman watcher lease failed: ${
            error instanceof Error ? error.message : String(error)
          }. The exact captured watcher was restored.`,
        );
      }

      let released = false;
      return Object.freeze({
        record: stopped,
        assertStillStopped: () => {
          if (released) {
            throw new PodmanGatewayWatcherLeaseError("Podman watcher lease was already released.");
          }
          const durable = readLease(deps);
          if (!durable || !sameLease(stopped, durable) || durable.phase !== "stopped") {
            throw new PodmanGatewayWatcherLeaseError(
              "Durable Podman watcher lease changed while it was held.",
              true,
            );
          }
          assertStopped(stopped, deps);
        },
        resumeAndProve: () => {
          if (released) return;
          const durable = readLease(deps);
          if (!durable || !sameLease(stopped, durable)) {
            throw new PodmanGatewayWatcherLeaseError(
              "Durable Podman watcher lease changed before release.",
              true,
            );
          }
          resumeAndProve(stopped, deps);
          deps.store.clear(leaseId);
          released = true;
        },
      });
    },
  });
}
