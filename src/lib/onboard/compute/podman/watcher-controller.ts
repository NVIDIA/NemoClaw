// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createPodmanOpenShellWatcherController,
  PodmanManagedSandboxRecreateError,
  type PodmanOpenShellWatcherController,
} from "./sandbox-recreate";

const DEFAULT_RESUME_TIMEOUT_MS = 30_000;
const DEFAULT_RESUME_POLL_INTERVAL_MS = 250;
const MAX_OPAQUE_IDENTITY_LENGTH = 4_096;
const SAFE_GATEWAY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export type PodmanGatewayWatcherOwnerKind = "managed-service" | "standalone";

/**
 * Immutable, non-secret evidence identifying one target-bound host gateway
 * watcher and the lifecycle owner capable of stopping and resuming it.
 *
 * `ownerIdentity` and `launchIdentity` are deliberately opaque. The production
 * caller derives them from existing trusted service identity or the exact
 * standalone launch/runtime identity; this layer compares them but never logs
 * them. `processStartIdentity` must distinguish PID reuse (Linux `/proc` start
 * time, or an equivalent stable platform primitive).
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

export interface PodmanManagedGatewayWatcherControllerDeps {
  /**
   * Resolve the exact healthy watcher currently serving the target. Must throw
   * rather than choose when PID, listener, runtime, or lifecycle-owner evidence
   * is missing or ambiguous.
   */
  readonly captureCurrent: () => PodmanGatewayWatcherSnapshot;
  /**
   * Return every host gateway watcher bound to this exact gateway target.
   * Unknown or unclassifiable target listeners must make this callback throw,
   * not disappear from the result.
   */
  readonly listTargetWatchers: (
    target: Readonly<Pick<PodmanGatewayWatcherSnapshot, "gatewayName" | "gatewayPort">>,
  ) => readonly PodmanGatewayWatcherSnapshot[];
  /** Prove whether this exact PID/start-time process instance still exists. */
  readonly isProcessInstanceAlive: (snapshot: PodmanGatewayWatcherSnapshot) => boolean;
  /**
   * Prove the captured lifecycle owner is stopped. For a managed service this
   * means the same trusted unit/formula is inactive, not merely that MainPID
   * changed. For a standalone launch slot this means no process with the
   * captured target, owner, and launch identity is live; it becomes false again
   * when the exact resumed child appears.
   */
  readonly isOwnerStopped: (snapshot: PodmanGatewayWatcherSnapshot) => boolean;
  /**
   * Stop only the captured owner. Managed services must be stopped through the
   * exact service manager identity so automatic restart cannot escape the
   * lease; standalone launches may stop only the captured process instance.
   */
  readonly stopExactOwner: (snapshot: PodmanGatewayWatcherSnapshot) => void;
  /**
   * Idempotently resume the same captured service/standalone launch identity.
   * It must never start a second watcher over an existing target listener.
   */
  readonly resumeSameOwner: (snapshot: PodmanGatewayWatcherSnapshot) => void;
  /**
   * Prove the resumed target is operational using the production OpenShell
   * gateway health path. Process liveness alone is not health.
   */
  readonly isHealthy: (snapshot: PodmanGatewayWatcherSnapshot) => boolean;
  readonly now?: () => number;
  readonly resumePollIntervalMs?: number;
  readonly resumeTimeoutMs?: number;
  readonly sleep?: (milliseconds: number) => void;
}

class WatcherProofError extends Error {}

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
    throw new PodmanManagedSandboxRecreateError(
      `Podman OpenShell watcher ${field} is missing or unsafe.`,
    );
  }
  return value;
}

function snapshot(
  value: PodmanGatewayWatcherSnapshot,
  expectedTarget?: Readonly<Pick<PodmanGatewayWatcherSnapshot, "gatewayName" | "gatewayPort">>,
): Readonly<PodmanGatewayWatcherSnapshot> {
  if (!value || typeof value !== "object") {
    throw new PodmanManagedSandboxRecreateError(
      "Podman OpenShell watcher identity proof did not return an object.",
    );
  }
  if (!SAFE_GATEWAY_NAME.test(value.gatewayName)) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman OpenShell watcher identity has an invalid gateway name.",
    );
  }
  if (
    !Number.isSafeInteger(value.gatewayPort) ||
    value.gatewayPort < 1 ||
    value.gatewayPort > 65_535
  ) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman OpenShell watcher identity has an invalid gateway port.",
    );
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman OpenShell watcher identity has an invalid process ID.",
    );
  }
  if (value.ownerKind !== "managed-service" && value.ownerKind !== "standalone") {
    throw new PodmanManagedSandboxRecreateError(
      "Podman OpenShell watcher identity has an unsupported lifecycle owner.",
    );
  }
  if (
    expectedTarget &&
    (value.gatewayName !== expectedTarget.gatewayName ||
      value.gatewayPort !== expectedTarget.gatewayPort)
  ) {
    throw new PodmanManagedSandboxRecreateError(
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

function readTargetWatchers(
  receipt: Readonly<PodmanGatewayWatcherSnapshot>,
  deps: PodmanManagedGatewayWatcherControllerDeps,
): readonly Readonly<PodmanGatewayWatcherSnapshot>[] {
  const target = {
    gatewayName: receipt.gatewayName,
    gatewayPort: receipt.gatewayPort,
  } as const;
  const watchers = deps.listTargetWatchers(target);
  if (!Array.isArray(watchers)) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman OpenShell watcher enumeration did not return an array.",
    );
  }
  return watchers.map((entry) => snapshot(entry, target));
}

function requireExclusiveCurrent(
  receipt: Readonly<PodmanGatewayWatcherSnapshot>,
  deps: PodmanManagedGatewayWatcherControllerDeps,
): void {
  const watchers = readTargetWatchers(receipt, deps);
  if (watchers.length !== 1 || !sameProcessInstance(receipt, watchers[0] as typeof receipt)) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman sandbox recreation requires exactly one target-bound OpenShell watcher matching the captured process and lifecycle owner.",
    );
  }
  if (!deps.isProcessInstanceAlive(receipt) || deps.isOwnerStopped(receipt)) {
    throw new PodmanManagedSandboxRecreateError(
      "The captured Podman OpenShell watcher or its lifecycle owner changed before cutover.",
    );
  }
  if (!deps.isHealthy(receipt)) {
    throw new PodmanManagedSandboxRecreateError(
      "The captured Podman OpenShell watcher is not healthy before cutover.",
    );
  }
}

function assertStopped(
  receipt: Readonly<PodmanGatewayWatcherSnapshot>,
  deps: PodmanManagedGatewayWatcherControllerDeps,
): void {
  if (deps.isProcessInstanceAlive(receipt)) {
    throw new WatcherProofError("the captured OpenShell watcher process instance is still alive");
  }
  if (!deps.isOwnerStopped(receipt)) {
    throw new WatcherProofError(
      "the captured OpenShell watcher lifecycle owner is not proven stopped",
    );
  }
  if (readTargetWatchers(receipt, deps).length !== 0) {
    throw new WatcherProofError(
      "a target-bound OpenShell watcher appeared while the stop lease was held",
    );
  }
}

function readinessWaitOptions(deps: PodmanManagedGatewayWatcherControllerDeps) {
  const timeoutMs = deps.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS;
  const pollIntervalMs = deps.resumePollIntervalMs ?? DEFAULT_RESUME_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman OpenShell watcher resume timeout must be positive.",
    );
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman OpenShell watcher resume poll interval must be non-negative.",
    );
  }
  const now = deps.now ?? Date.now;
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman OpenShell watcher resume clock is unavailable.",
    );
  }
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollIntervalMs)) + 1);
  return {
    deadlineMs: startedAt + timeoutMs,
    maxAttempts,
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
    throw new WatcherProofError(
      "multiple target-bound OpenShell watchers appeared while resuming the captured owner",
    );
  }
  const resumed = watchers[0] as Readonly<PodmanGatewayWatcherSnapshot>;
  if (!sameLaunchOwner(receipt, resumed)) {
    throw new WatcherProofError(
      "the resumed OpenShell watcher does not match the captured lifecycle owner and launch identity",
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
    throw new WatcherProofError(
      "multiple target-bound OpenShell watchers exist; refusing to start another",
    );
  }
  if (existing.length === 1) {
    const current = existing[0] as Readonly<PodmanGatewayWatcherSnapshot>;
    if (!sameLaunchOwner(receipt, current)) {
      throw new WatcherProofError(
        "a different target-bound OpenShell watcher exists; refusing to replace it",
      );
    }
    if (
      !deps.isOwnerStopped(receipt) &&
      deps.isProcessInstanceAlive(current) &&
      deps.isHealthy(current)
    ) {
      return;
    }
    throw new WatcherProofError(
      "a target-bound OpenShell watcher exists without the exact captured owner and healthy process proof; refusing to start another",
    );
  }

  if (!deps.isOwnerStopped(receipt)) {
    throw new WatcherProofError(
      "the captured lifecycle owner is neither stopped nor serving an exact healthy watcher",
    );
  }
  let resumeError: unknown = null;
  try {
    deps.resumeSameOwner(receipt);
  } catch (error) {
    // A service manager or spawn boundary can lose its reply after completing
    // the requested start. Do not report failure until the same exact launch
    // identity also fails the independent bounded process/health proof.
    resumeError = error;
  }
  let resumed: Readonly<PodmanGatewayWatcherSnapshot> | null = null;
  const healthy = waitForExactHealthy(() => {
    resumed = exactHealthyReplacement(receipt, deps);
    return resumed !== null;
  }, readinessWaitOptions(deps));
  if (!healthy || resumed === null) {
    throw new WatcherProofError(
      `the same OpenShell watcher lifecycle owner did not resume one exact healthy target-bound watcher within the bounded deadline${
        resumeError === null ? "" : " after its start operation failed"
      }`,
    );
  }
}

/**
 * Construct the production-safe host watcher lease used by native Podman
 * sandbox recreation.
 *
 * The caller supplies platform/runtime probes, but cannot weaken the sequence:
 * exclusive healthy identity -> exact owner stop -> repeated absence proof ->
 * same owner/launch resume -> exact process and health proof. This deliberately
 * excludes externally supervised gateways: only the lifecycle owner captured
 * as NemoClaw-managed may be quiesced.
 */
export function createPodmanManagedGatewayWatcherController(
  deps: PodmanManagedGatewayWatcherControllerDeps,
): PodmanOpenShellWatcherController {
  return createPodmanOpenShellWatcherController({
    stopAndProve: () => {
      const receipt = snapshot(deps.captureCurrent());
      requireExclusiveCurrent(receipt, deps);
      try {
        deps.stopExactOwner(receipt);
        return receipt;
      } catch (error) {
        let recoveryError: unknown = null;
        try {
          resumeAndProve(receipt, deps);
        } catch (caught) {
          recoveryError = caught;
        }
        const message = error instanceof Error ? error.message : String(error);
        const recoveryMessage =
          recoveryError === null
            ? "The exact captured watcher was restored."
            : `Exact watcher recovery failed: ${
                recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
              }.`;
        throw new PodmanManagedSandboxRecreateError(
          `Stopping the exact Podman OpenShell watcher failed: ${message}. ${recoveryMessage}`,
          recoveryError === null,
        );
      }
    },
    assertStopped: (receipt) => assertStopped(receipt, deps),
    resumeAndProve: (receipt) => resumeAndProve(receipt, deps),
  });
}
