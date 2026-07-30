// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PodmanManagedSandboxRecreateTransaction } from "../compute/podman/sandbox-recreate";
import { cleanupTempDir, secureTempFile } from "../temp-files";
import { MANAGED_STARTUP_RUNTIME_EXECUTABLE } from "./image-runtime";
import type { PodmanManagedStartupTransaction } from "./podman-root-apply";
import {
  assertPodmanManagedStartupRuntime,
  inspectExactPodmanManagedStartupContainer,
  type PodmanManagedStartupRuntimeDeps,
  podmanManagedStartupCommandDetail,
  runManagedStartupPodman,
} from "./podman-runtime";
import {
  MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "./shared-state-transaction";

const RECEIPT_TEMP_PREFIX = "nemoclaw-managed-startup-podman-receipt";
const MUTATION_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 90_000;
const STOP_GRACE_SECONDS = "30";
const NEUTRALIZED_PROCESS_INJECTION_ENV = [
  "--env",
  "NODE_OPTIONS=",
  "--env",
  "NODE_PATH=",
  "--env",
  "BASH_ENV=",
  "--env",
  "ENV=",
] as const;

export interface PodmanManagedStartupSharedStateOutcome {
  readonly failure: Error | null;
  readonly supervisorReady: boolean;
}

export type PodmanManagedStartupSharedStateDeps = PodmanManagedStartupRuntimeDeps;

function sameSocketAuthority(
  left: PodmanManagedStartupTransaction["runtime"]["socketAuthority"],
  right: PodmanManagedSandboxRecreateTransaction["socketAuthority"],
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.ownerUid === right.ownerUid &&
    left.socketPath === right.socketPath &&
    left.directoryChain.length === right.directoryChain.length &&
    left.directoryChain.every((component, index) => {
      const candidate = right.directoryChain[index];
      return (
        candidate?.device === component.device &&
        candidate.inode === component.inode &&
        candidate.mode === component.mode &&
        candidate.ownerUid === component.ownerUid &&
        candidate.path === component.path
      );
    })
  );
}

function hasMatchingContainerRollbackAuthority(
  transaction: PodmanManagedStartupTransaction,
  authority: PodmanManagedSandboxRecreateTransaction | null | undefined,
): boolean {
  if (!authority) return false;
  const transactionImage = transaction.image.replace(/^sha256:/u, "");
  const authorityImage = authority.immutableImage.replace(/^sha256:/u, "");
  if (
    authority.driverName !== "podman" ||
    authority.applied !== true ||
    authority.socketPath !== transaction.runtime.socketPath ||
    !sameSocketAuthority(transaction.runtime.socketAuthority, authority.socketAuthority) ||
    authority.newContainerId !== transaction.containerId ||
    authorityImage !== transactionImage
  ) {
    throw new Error(
      "Podman managed-startup rollback authority does not match the exact runtime, image, and replacement container.",
    );
  }
  return true;
}

function cleanupReceiptBestEffort(receiptPath: string): void {
  try {
    cleanupTempDir(receiptPath, RECEIPT_TEMP_PREFIX);
  } catch (error) {
    console.warn(
      `  ⚠ Managed-startup shared state is finalized, but its protected Podman receipt could not be removed (${receiptPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function requireZero(result: ReturnType<typeof runManagedStartupPodman>, action: string): void {
  if (result.status === 0) return;
  const detail = podmanManagedStartupCommandDetail(result, 800);
  throw new Error(`${action}${detail ? `: ${detail}` : ""}`);
}

function assertPinnedContainer(
  transaction: PodmanManagedStartupTransaction,
  deps: PodmanManagedStartupSharedStateDeps,
  requireRunning: boolean,
): void {
  assertPodmanManagedStartupRuntime(transaction.runtime, deps);
  inspectExactPodmanManagedStartupContainer(
    transaction.runtime,
    {
      containerId: transaction.containerId,
      image: transaction.image,
      requireRunning,
    },
    deps,
  );
}

function quiesceManagedStartupContainer(
  transaction: PodmanManagedStartupTransaction,
  deps: PodmanManagedStartupSharedStateDeps,
): void {
  assertPinnedContainer(transaction, deps, false);
  requireZero(
    runManagedStartupPodman(
      transaction.runtime.socketPath,
      ["stop", "--time", STOP_GRACE_SECONDS, transaction.containerId],
      { timeout: STOP_TIMEOUT_MS },
      deps,
    ),
    "Could not quiesce the failed Podman managed-startup container before shared-state rollback",
  );
  assertPodmanManagedStartupRuntime(transaction.runtime, deps);
  const stopped = inspectExactPodmanManagedStartupContainer(
    transaction.runtime,
    { containerId: transaction.containerId, image: transaction.image },
    deps,
  );
  if (stopped.running) {
    throw new Error(
      "Podman reported success without quiescing the managed-startup container before rollback.",
    );
  }
}

function copyManagedStartupReceipt(
  transaction: PodmanManagedStartupTransaction,
  deps: PodmanManagedStartupSharedStateDeps,
): string {
  assertPinnedContainer(transaction, deps, false);
  const receiptPath = secureTempFile(RECEIPT_TEMP_PREFIX);
  try {
    requireZero(
      runManagedStartupPodman(
        transaction.runtime.socketPath,
        [
          "cp",
          `${transaction.containerId}:${MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY}`,
          receiptPath,
        ],
        { timeout: MUTATION_TIMEOUT_MS },
        deps,
      ),
      "Could not copy the managed-startup rollback receipt from the Podman container",
    );
    if (receiptPath.includes(",") || /[\0\r\n]/u.test(receiptPath)) {
      throw new Error("Managed-startup rollback receipt path is unsafe for a Podman bind mount.");
    }
    return receiptPath;
  } catch (error) {
    cleanupReceiptBestEffort(receiptPath);
    throw error;
  }
}

function transactionCommand(action: "commit" | "rollback", agent: string): string[] {
  return [
    MANAGED_STARTUP_RUNTIME_EXECUTABLE,
    `--${action}-shared-state-transaction`,
    "--agent",
    agent,
  ];
}

function rollbackManagedStartupSharedState(
  transaction: PodmanManagedStartupTransaction,
  receiptPath: string,
  deps: PodmanManagedStartupSharedStateDeps,
): void {
  assertPodmanManagedStartupRuntime(transaction.runtime, deps);
  let restored = false;
  try {
    requireZero(
      runManagedStartupPodman(
        transaction.runtime.socketPath,
        [
          "run",
          "--rm",
          "--pull",
          "never",
          "--network",
          "none",
          "--read-only",
          "--user",
          "0:0",
          "--security-opt",
          "no-new-privileges",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          "--cap-add",
          "DAC_OVERRIDE",
          "--cap-add",
          "FOWNER",
          ...NEUTRALIZED_PROCESS_INJECTION_ENV,
          "--volumes-from",
          transaction.containerId,
          "--mount",
          `type=bind,src=${receiptPath},dst=${MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY},readonly`,
          "--entrypoint",
          "/usr/local/bin/node",
          transaction.image,
          ...transactionCommand("rollback", transaction.agent),
          "--read-only-receipt",
        ],
        { timeout: MUTATION_TIMEOUT_MS },
        deps,
      ),
      `Immutable Podman managed-startup helper could not restore and verify shared state. Protected receipt retained at ${receiptPath}`,
    );
    assertPodmanManagedStartupRuntime(transaction.runtime, deps);
    restored = true;
  } finally {
    if (restored) cleanupReceiptBestEffort(receiptPath);
  }
}

function removeFailedUnbackedContainer(
  transaction: PodmanManagedStartupTransaction,
  deps: PodmanManagedStartupSharedStateDeps,
): void {
  assertPinnedContainer(transaction, deps, false);
  requireZero(
    runManagedStartupPodman(
      transaction.runtime.socketPath,
      ["rm", transaction.containerId],
      { timeout: MUTATION_TIMEOUT_MS },
      deps,
    ),
    "Could not remove the failed Podman managed-startup container after shared-state rollback",
  );
  assertPodmanManagedStartupRuntime(transaction.runtime, deps);
  const exists = runManagedStartupPodman(
    transaction.runtime.socketPath,
    ["container", "exists", transaction.containerId],
    {},
    deps,
  );
  if (exists.status !== 1) {
    throw new Error(
      `Could not prove removal of the failed Podman managed-startup container${
        exists.status === 0
          ? ": the exact container still exists."
          : `: ${podmanManagedStartupCommandDetail(exists, 800)}`
      }`,
    );
  }
}

/**
 * Finalize the shared-state half of a Podman managed-container cutover.
 *
 * `containerRollbackAuthority` is the exact runtime-level recreation
 * transaction retained by the caller. It is cross-checked against the
 * managed-startup transaction before any mutation. Without that authority this
 * layer removes a failed replacement after shared state is restored.
 */
export function finalizePodmanManagedStartupSharedState(
  input: {
    readonly containerRollbackAuthority?: PodmanManagedSandboxRecreateTransaction | null;
    readonly supervisorReady: boolean;
    readonly transaction: PodmanManagedStartupTransaction | null;
  },
  deps: PodmanManagedStartupSharedStateDeps = {},
): PodmanManagedStartupSharedStateOutcome {
  const transaction = input.transaction;
  if (!transaction) {
    return { failure: null, supervisorReady: input.supervisorReady };
  }
  deps = { ...deps, socketAuthority: transaction.runtime.socketAuthority };
  const containerRollbackArmed = hasMatchingContainerRollbackAuthority(
    transaction,
    input.containerRollbackAuthority,
  );
  assertPinnedContainer(transaction, deps, input.supervisorReady);
  if (input.supervisorReady) {
    let receiptPath: string;
    try {
      receiptPath = copyManagedStartupReceipt(transaction, deps);
    } catch (error) {
      try {
        quiesceManagedStartupContainer(transaction, deps);
      } catch (stopError) {
        throw new Error(
          `Managed-startup Podman receipt preservation failed and the new workload could not be quiesced: ${
            error instanceof Error ? error.message : String(error)
          }; ${stopError instanceof Error ? stopError.message : String(stopError)}`,
        );
      }
      throw error;
    }
    assertPodmanManagedStartupRuntime(transaction.runtime, deps);
    const commit = runManagedStartupPodman(
      transaction.runtime.socketPath,
      [
        "exec",
        "--user",
        "0:0",
        ...NEUTRALIZED_PROCESS_INJECTION_ENV,
        transaction.containerId,
        "/usr/bin/env",
        "-i",
        "HOME=/root",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "/usr/local/bin/node",
        ...transactionCommand("commit", transaction.agent),
      ],
      { timeout: MUTATION_TIMEOUT_MS },
      deps,
    );
    let failure: Error | null = null;
    if (commit.status === 0) {
      try {
        assertPinnedContainer(transaction, deps, true);
      } catch (error) {
        failure = new Error(
          `Podman managed shared-state commit returned success, but exact runtime and container identity could not be revalidated: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!failure) {
        cleanupReceiptBestEffort(receiptPath);
        return { failure: null, supervisorReady: true };
      }
    } else {
      failure = new Error(
        `OpenShell supervisor reconnected, but Podman managed shared-state commit failed: ${podmanManagedStartupCommandDetail(
          commit,
          800,
        )}`,
      );
    }
    quiesceManagedStartupContainer(transaction, deps);
    rollbackManagedStartupSharedState(transaction, receiptPath, deps);
    if (!containerRollbackArmed) {
      removeFailedUnbackedContainer(transaction, deps);
    }
    return { failure, supervisorReady: false };
  }

  quiesceManagedStartupContainer(transaction, deps);
  const receiptPath = copyManagedStartupReceipt(transaction, deps);
  rollbackManagedStartupSharedState(transaction, receiptPath, deps);
  if (!containerRollbackArmed) {
    removeFailedUnbackedContainer(transaction, deps);
  }
  return { failure: null, supervisorReady: false };
}
