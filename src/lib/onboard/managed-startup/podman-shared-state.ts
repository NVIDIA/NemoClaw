// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { PodmanManagedSandboxRecreateTransaction } from "../compute/podman/sandbox-recreate";
import { cleanupTempDir, secureTempFile } from "../temp-files";
import { MANAGED_STARTUP_RUNTIME_EXECUTABLE } from "./image-runtime";
import { MANAGED_STARTUP_AGENTS } from "./profile";
import type { PodmanManagedStartupTransaction } from "./podman-root-apply";
import {
  assertPodmanManagedStartupRuntime,
  inspectExactPodmanManagedStartupContainer,
  type PodmanManagedStartupRuntimeDeps,
  podmanManagedStartupCommandDetail,
  runManagedStartupPodman,
} from "./podman-runtime";
import {
  MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "./shared-state-transaction";

const RECEIPT_TEMP_PREFIX = "nemoclaw-managed-startup-podman-receipt";
const MUTATION_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 90_000;
const STOP_GRACE_SECONDS = "30";
const FULL_CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const DURABLE_IDENTITY_RE = /^[a-f0-9]{64}$/u;
const NEUTRALIZED_PROCESS_INJECTION_ENV = [
  "--env",
  "NODE_OPTIONS=",
  "--env",
  "NODE_PATH=",
  "--env",
  "BASH_ENV=",
  "--env",
  "ENV=",
  "--env",
  "LD_PRELOAD=",
  "--env",
  "LD_AUDIT=",
  "--env",
  "LD_LIBRARY_PATH=",
  "--env",
  "SHELLOPTS=",
  "--env",
  "PS4=",
] as const;

export interface PodmanManagedStartupSharedStateOutcome {
  readonly failure: Error | null;
  readonly supervisorReady: boolean;
}

export type PodmanManagedStartupSharedStateDeps = PodmanManagedStartupRuntimeDeps;

export class PodmanManagedStartupSharedStateCommitIndeterminateError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(
      `Managed-startup Podman shared-state commit may have completed, but immutable status is unavailable: ${detail}`,
      options,
    );
    this.name = "PodmanManagedStartupSharedStateCommitIndeterminateError";
  }
}

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

function assertValidManagedStartupTransaction(
  transaction: PodmanManagedStartupTransaction,
): asserts transaction is PodmanManagedStartupTransaction & {
  readonly bootstrapIdentity: string;
  readonly profileFingerprint: string;
} {
  if (!(MANAGED_STARTUP_AGENTS as readonly string[]).includes(transaction.agent)) {
    throw new Error("Managed bootstrap Podman shared-state transaction agent is invalid.");
  }
  if (!FULL_CONTAINER_ID_RE.test(transaction.containerId)) {
    throw new Error(
      "Managed bootstrap Podman shared-state transaction container identity is invalid.",
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(transaction.image)) {
    throw new Error(
      "Managed bootstrap Podman shared-state transaction image identity is not immutable.",
    );
  }
  if (
    !transaction.bootstrapIdentity ||
    !DURABLE_IDENTITY_RE.test(transaction.bootstrapIdentity)
  ) {
    throw new Error(
      "Managed bootstrap Podman shared-state transaction identity is missing or invalid.",
    );
  }
  if (
    !transaction.profileFingerprint ||
    !DURABLE_IDENTITY_RE.test(transaction.profileFingerprint)
  ) {
    throw new Error(
      "Managed bootstrap Podman shared-state transaction profile fingerprint is missing or invalid.",
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

function isExactMissingReceiptCopy(
  transaction: PodmanManagedStartupTransaction,
  sourcePath: string,
  result: ReturnType<typeof runManagedStartupPodman>,
): boolean {
  const detail = podmanManagedStartupCommandDetail(result, 1200);
  const escapedPath = sourcePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedContainer = transaction.containerId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [
    new RegExp(
      `^(?:Error: )?(?:stat|lstat) ${escapedPath}: no such file or directory$`,
      "iu",
    ),
    new RegExp(
      `^(?:Error: )?.*${escapedContainer}:${escapedPath}.*(?:no such file or directory|does not exist)$`,
      "iu",
    ),
  ].some((pattern) => pattern.test(detail));
}

function copyManagedStartupReceiptAt(
  transaction: PodmanManagedStartupTransaction,
  sourcePath: string,
  deps: PodmanManagedStartupSharedStateDeps,
  allowAbsent = false,
): string | null {
  assertPinnedContainer(transaction, deps, false);
  const tempSeed = secureTempFile(RECEIPT_TEMP_PREFIX);
  const receiptPath = path.join(path.dirname(tempSeed), path.basename(sourcePath));
  try {
    const copied = runManagedStartupPodman(
      transaction.runtime.socketPath,
      ["cp", `${transaction.containerId}:${sourcePath}`, receiptPath],
      { timeout: MUTATION_TIMEOUT_MS },
      deps,
    );
    if (copied.status !== 0) {
      if (allowAbsent && isExactMissingReceiptCopy(transaction, sourcePath, copied)) {
        cleanupReceiptBestEffort(receiptPath);
        return null;
      }
      const detail = podmanManagedStartupCommandDetail(copied, 800);
      throw new Error(
        `Could not copy the managed-startup receipt from the Podman container${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    if (receiptPath.includes(",") || /[\0\r\n]/u.test(receiptPath)) {
      throw new Error("Managed-startup rollback receipt path is unsafe for a Podman bind mount.");
    }
    return receiptPath;
  } catch (error) {
    cleanupReceiptBestEffort(receiptPath);
    throw error;
  }
}

function copyManagedStartupReceipt(
  transaction: PodmanManagedStartupTransaction,
  deps: PodmanManagedStartupSharedStateDeps,
  allowAbsent = false,
): string | null {
  return copyManagedStartupReceiptAt(
    transaction,
    MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
    deps,
    allowAbsent,
  );
}

function transactionCommand(
  action: "clear-shared-state-commit-receipt" | "commit" | "rollback",
  transaction: PodmanManagedStartupTransaction,
): string[] {
  assertValidManagedStartupTransaction(transaction);
  return [
    MANAGED_STARTUP_RUNTIME_EXECUTABLE,
    action === "clear-shared-state-commit-receipt"
      ? "--clear-shared-state-commit-receipt"
      : `--${action}-shared-state-transaction`,
    "--agent",
    transaction.agent,
    "--bootstrap-identity",
    transaction.bootstrapIdentity,
  ];
}

function transactionReceiptMount(receiptPath: string, receiptDirectory: string): string {
  return `type=bind,src=${receiptPath},dst=${receiptDirectory},readonly`;
}

function verifyCopiedManagedStartupReceipt(
  transaction: PodmanManagedStartupTransaction,
  profileFingerprint: string,
  receiptPath: string,
  receiptDirectory: string,
  expectedStatus: "committed" | "pending",
  deps: PodmanManagedStartupSharedStateDeps,
): void {
  assertValidManagedStartupTransaction(transaction);
  const verified = runManagedStartupPodman(
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
      ...NEUTRALIZED_PROCESS_INJECTION_ENV,
      "--mount",
      transactionReceiptMount(receiptPath, receiptDirectory),
      "--entrypoint",
      "/usr/local/bin/node",
      transaction.image,
      MANAGED_STARTUP_RUNTIME_EXECUTABLE,
      "--shared-state-transaction-status",
      "--agent",
      transaction.agent,
      "--profile-fingerprint",
      profileFingerprint,
      "--bootstrap-identity",
      transaction.bootstrapIdentity,
    ],
    { timeout: MUTATION_TIMEOUT_MS },
    deps,
  );
  if (verified.status !== 0) {
    throw new Error(
      `Immutable Podman managed-startup helper could not verify shared-state status. Protected receipt retained at ${receiptPath}`,
    );
  }
  if (String(verified.stdout ?? "").trim() !== expectedStatus) {
    throw new Error(
      `Immutable Podman managed-startup helper returned an invalid copied transaction status. Protected receipt retained at ${receiptPath}`,
    );
  }
}

export function probePodmanManagedStartupSharedState(
  input: {
    readonly transaction: PodmanManagedStartupTransaction;
    readonly profileFingerprint: string;
  },
  deps: PodmanManagedStartupSharedStateDeps = {},
): "committed" | "none" | "pending" {
  const { transaction } = input;
  assertValidManagedStartupTransaction(transaction);
  if (input.profileFingerprint !== transaction.profileFingerprint) {
    throw new Error("Managed bootstrap Podman shared-state status fingerprint does not match.");
  }
  deps = { ...deps, socketAuthority: transaction.runtime.socketAuthority };
  const committedReceiptPath = copyManagedStartupReceiptAt(
    transaction,
    MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
    deps,
    true,
  );
  if (committedReceiptPath) {
    let verified = false;
    try {
      verifyCopiedManagedStartupReceipt(
        transaction,
        input.profileFingerprint,
        committedReceiptPath,
        MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
        "committed",
        deps,
      );
      verified = true;
      return "committed";
    } finally {
      if (verified) cleanupReceiptBestEffort(committedReceiptPath);
    }
  }
  const pendingReceiptPath = copyManagedStartupReceipt(transaction, deps, true);
  if (!pendingReceiptPath) return "none";
  let verified = false;
  try {
    verifyCopiedManagedStartupReceipt(
      transaction,
      input.profileFingerprint,
      pendingReceiptPath,
      MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
      "pending",
      deps,
    );
    verified = true;
    return "pending";
  } finally {
    if (verified) cleanupReceiptBestEffort(pendingReceiptPath);
  }
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
          ...transactionCommand("rollback", transaction),
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

function commitManagedStartupSharedState(
  transaction: PodmanManagedStartupTransaction,
  deps: PodmanManagedStartupSharedStateDeps,
): void {
  assertValidManagedStartupTransaction(transaction);
  const committed = runManagedStartupPodman(
    transaction.runtime.socketPath,
    [
      "exec",
      "--user",
      "0:0",
      "--workdir",
      "/",
      ...NEUTRALIZED_PROCESS_INJECTION_ENV,
      transaction.containerId,
      "/usr/bin/env",
      "-i",
      "HOME=/root",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "/usr/local/bin/node",
      ...transactionCommand("commit", transaction),
    ],
    { timeout: MUTATION_TIMEOUT_MS },
    deps,
  );
  let status: "committed" | "none" | "pending";
  try {
    status = probePodmanManagedStartupSharedState(
      { transaction, profileFingerprint: transaction.profileFingerprint },
      deps,
    );
  } catch (error) {
    throw new PodmanManagedStartupSharedStateCommitIndeterminateError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (status === "committed") return;
  const detail = podmanManagedStartupCommandDetail(committed, 800);
  if (committed.status !== 0) {
    throw new Error(
      `Managed-startup Podman shared-state commit helper failed and durable commit was not proven (status=${status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  throw new Error(
    `Managed-startup Podman shared-state commit helper returned success, but durable commit was not proven (status=${status}).`,
  );
}

export function clearPodmanManagedStartupSharedStateCommitReceipt(
  transaction: PodmanManagedStartupTransaction,
  deps: PodmanManagedStartupSharedStateDeps = {},
): void {
  assertValidManagedStartupTransaction(transaction);
  deps = { ...deps, socketAuthority: transaction.runtime.socketAuthority };
  const cleared = runManagedStartupPodman(
    transaction.runtime.socketPath,
    [
      "exec",
      "--user",
      "0:0",
      "--workdir",
      "/",
      ...NEUTRALIZED_PROCESS_INJECTION_ENV,
      transaction.containerId,
      "/usr/bin/env",
      "-i",
      "HOME=/root",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "/usr/local/bin/node",
      ...transactionCommand("clear-shared-state-commit-receipt", transaction),
    ],
    { timeout: MUTATION_TIMEOUT_MS },
    deps,
  );
  let status: "committed" | "none" | "pending";
  try {
    status = probePodmanManagedStartupSharedState(
      { transaction, profileFingerprint: transaction.profileFingerprint },
      deps,
    );
  } catch (error) {
    throw new PodmanManagedStartupSharedStateCommitIndeterminateError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (status === "none") return;
  const detail = podmanManagedStartupCommandDetail(cleared, 800);
  if (cleared.status !== 0) {
    throw new Error(
      `Managed-startup Podman durable commit receipt cleanup failed and exact absence was not proven (status=${status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  throw new Error(
    `Managed-startup Podman durable commit receipt cleanup returned success, but exact absence was not proven (status=${status}).`,
  );
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
  assertValidManagedStartupTransaction(transaction);
  deps = { ...deps, socketAuthority: transaction.runtime.socketAuthority };
  const containerRollbackArmed = hasMatchingContainerRollbackAuthority(
    transaction,
    input.containerRollbackAuthority,
  );
  assertPinnedContainer(transaction, deps, input.supervisorReady);
  if (input.supervisorReady) {
    let receiptPath: string;
    try {
      const copiedReceipt = copyManagedStartupReceipt(transaction, deps);
      if (!copiedReceipt) {
        throw new Error("Managed-startup Podman pending receipt disappeared before commit.");
      }
      receiptPath = copiedReceipt;
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
    let commitFailure: Error | null = null;
    try {
      verifyCopiedManagedStartupReceipt(
        transaction,
        transaction.profileFingerprint,
        receiptPath,
        MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
        "pending",
        deps,
      );
      commitManagedStartupSharedState(transaction, deps);
      cleanupReceiptBestEffort(receiptPath);
      return { failure: null, supervisorReady: true };
    } catch (error) {
      if (error instanceof PodmanManagedStartupSharedStateCommitIndeterminateError) {
        throw error;
      }
      commitFailure = error instanceof Error ? error : new Error(String(error));
    }
    const failure = new Error(
      `OpenShell supervisor reconnected, but Podman managed shared-state logical commit validation failed: ${commitFailure.message}`,
    );
    quiesceManagedStartupContainer(transaction, deps);
    rollbackManagedStartupSharedState(transaction, receiptPath, deps);
    if (!containerRollbackArmed) {
      removeFailedUnbackedContainer(transaction, deps);
    }
    return { failure, supervisorReady: false };
  }

  quiesceManagedStartupContainer(transaction, deps);
  const receiptPath = copyManagedStartupReceipt(transaction, deps, true);
  if (!receiptPath) {
    if (!containerRollbackArmed) removeFailedUnbackedContainer(transaction, deps);
    return { failure: null, supervisorReady: false };
  }
  rollbackManagedStartupSharedState(transaction, receiptPath, deps);
  if (!containerRollbackArmed) {
    removeFailedUnbackedContainer(transaction, deps);
  }
  return { failure: null, supervisorReady: false };
}
