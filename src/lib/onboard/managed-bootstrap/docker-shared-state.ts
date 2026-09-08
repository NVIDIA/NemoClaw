// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  dockerRm as defaultDockerRm,
  dockerStop as defaultDockerStop,
} from "../../adapters/docker/container";
import { dockerRun as defaultDockerRun } from "../../adapters/docker/run";
import { hasZeroDockerExitStatus } from "../docker-command-result";
import {
  DOCKER_GPU_PATCH_STOP_TIMEOUT_MS,
  DOCKER_GPU_PATCH_TIMEOUT_MS,
} from "../docker-gpu-patch-constants";
import type { DockerGpuPatchDeps, DockerGpuPatchResult } from "../docker-gpu-patch-types";
import { MANAGED_STARTUP_RUNTIME_EXECUTABLE } from "../managed-startup/image-runtime";
import { MANAGED_STARTUP_AGENTS, type ManagedStartupAgent } from "../managed-startup/profile";
import {
  MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "../managed-startup/shared-state-transaction";
import { isImmutableDockerImageId } from "../openshell-docker-sandbox-containers";
import {
  cleanupDockerDaemonReceiptBestEffort,
  cleanupDockerHostReceiptBestEffort,
  dockerDaemonReceiptMount,
  protectedDockerReceiptDetail,
  transferDockerReceiptToDaemon,
  type DockerDaemonReceipt,
} from "../managed-startup/docker-receipt-transfer";
import { secureTempFile } from "../temp-files";

const RECEIPT_TEMP_PREFIX = "nemoclaw-managed-startup-receipt";
const FULL_CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const DURABLE_IDENTITY_RE = /^[a-f0-9]{64}$/u;
const DOCKER_MUTATION_OPTIONS = {
  ignoreError: true,
  suppressOutput: true,
  timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
} as const;
/**
 * The dynamic loader consumes LD_* before `/usr/bin/env -i` can clear the
 * inherited image or container environment. NODE_* is also cleared at this
 * boundary as defense in depth; the clean-Node argv below removes every other
 * variable before Node starts.
 */
const NEUTRALIZED_PRE_ENTRYPOINT_ENV = [
  "--env",
  "LD_AUDIT=",
  "--env",
  "LD_LIBRARY_PATH=",
  "--env",
  "LD_PRELOAD=",
  "--env",
  "NODE_OPTIONS=",
  "--env",
  "NODE_PATH=",
] as const;
const CLEAN_NODE_ENTRYPOINT = "/usr/bin/env";
const CLEAN_NODE_ARGV = [
  "-i",
  "HOME=/root",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "/usr/local/bin/node",
] as const;

export interface DockerManagedBootstrapSharedStateTransaction {
  readonly agent: ManagedStartupAgent;
  readonly bootstrapIdentity: string;
  readonly containerId: string;
  readonly image: string;
  readonly profileFingerprint: string;
}

export interface DockerManagedStartupSharedStateOutcome {
  /**
   * True only when the new supervisor is still eligible for successful
   * container cutover. A commit failure forces shared-state rollback first.
   */
  readonly supervisorReady: boolean;
  /** Original commit failure after a successful shared-state rollback. */
  readonly failure: Error | null;
}

export class DockerManagedStartupSharedStateCommitIndeterminateError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(
      `Managed-startup shared-state commit may have completed, but immutable status is unavailable: ${detail}`,
      options,
    );
    this.name = "DockerManagedStartupSharedStateCommitIndeterminateError";
  }
}

export class DockerManagedStartupSharedStateRestoreError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DockerManagedStartupSharedStateRestoreError";
  }
}

export function probeDockerManagedStartupSharedState(
  input: {
    readonly transaction: DockerManagedBootstrapSharedStateTransaction;
    readonly profileFingerprint: string;
  },
  deps: DockerGpuPatchDeps = {},
): "committed" | "none" | "pending" {
  const transaction = input.transaction;
  assertValidManagedStartupTransaction(transaction);
  if (input.profileFingerprint !== transaction.profileFingerprint) {
    throw new Error("Managed bootstrap shared-state status fingerprint does not match.");
  }
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
      if (verified) cleanupReceiptBestEffort(committedReceiptPath, deps);
    }
  }
  const receiptPath = copyManagedStartupReceipt(transaction, deps, true);
  if (!receiptPath) return "none";
  let verified = false;
  try {
    verifyCopiedManagedStartupReceipt(
      transaction,
      input.profileFingerprint,
      receiptPath,
      MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
      "pending",
      deps,
    );
    verified = true;
    return "pending";
  } finally {
    if (verified) cleanupReceiptBestEffort(receiptPath, deps);
  }
}

function verifyCopiedManagedStartupReceipt(
  transaction: DockerManagedBootstrapSharedStateTransaction,
  profileFingerprint: string,
  receipt: DockerDaemonReceipt,
  receiptDirectory: string,
  expectedStatus: "committed" | "pending",
  deps: DockerGpuPatchDeps,
): void {
  if (!transaction.bootstrapIdentity || !/^[a-f0-9]{64}$/u.test(profileFingerprint)) {
    throw new Error("Managed bootstrap copied-receipt identity is incomplete.");
  }
  const dockerRun = deps.dockerRun ?? defaultDockerRun;
  const result = dockerRun(
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
      // docker cp can leave the protected 0700/0400 receipt owned by the
      // invoking host UID. Restore only DAC_OVERRIDE so the root verifier can
      // read that copy and its write probe reaches the read-only volume mount;
      // every other capability remains dropped.
      "--cap-add",
      "DAC_OVERRIDE",
      ...NEUTRALIZED_PRE_ENTRYPOINT_ENV,
      "--mount",
      dockerDaemonReceiptMount(receipt, receiptDirectory),
      "--entrypoint",
      CLEAN_NODE_ENTRYPOINT,
      transaction.image,
      ...CLEAN_NODE_ARGV,
      MANAGED_STARTUP_RUNTIME_EXECUTABLE,
      "--shared-state-transaction-status",
      "--agent",
      transaction.agent,
      "--profile-fingerprint",
      profileFingerprint,
      "--bootstrap-identity",
      transaction.bootstrapIdentity,
      "--read-only-receipt",
    ],
    DOCKER_MUTATION_OPTIONS,
  );
  if (!hasZeroDockerExitStatus(result)) {
    throw new Error(
      `Immutable managed-startup helper could not verify shared-state status: ${commandDetail(result)}. ` +
        protectedDockerReceiptDetail(receipt),
    );
  }
  if (String(result.stdout ?? "").trim() !== expectedStatus) {
    throw new Error(
      `Immutable managed-startup helper returned an invalid copied transaction status. ${protectedDockerReceiptDetail(receipt)}`,
    );
  }
}

function commandDetail(result: {
  readonly stderr?: string | Buffer | null;
  readonly stdout?: string | Buffer | null;
  readonly error?: Error | null;
}): string {
  return `${String(result.stderr ?? "")} ${String(result.stdout ?? "")} ${String(
    result.error?.message ?? "",
  )}`
    .trim()
    .slice(-800);
}

function cleanupReceiptBestEffort(receipt: DockerDaemonReceipt, deps: DockerGpuPatchDeps): void {
  cleanupDockerDaemonReceiptBestEffort(
    receipt,
    RECEIPT_TEMP_PREFIX,
    deps.dockerRun ?? defaultDockerRun,
    DOCKER_MUTATION_OPTIONS,
  );
}

function assertValidManagedStartupTransaction(
  transaction: DockerManagedBootstrapSharedStateTransaction,
): asserts transaction is DockerManagedBootstrapSharedStateTransaction & {
  readonly bootstrapIdentity: string;
  readonly profileFingerprint: string;
} {
  if (!(MANAGED_STARTUP_AGENTS as readonly string[]).includes(transaction.agent)) {
    throw new Error("Managed bootstrap shared-state transaction agent is invalid.");
  }
  if (!FULL_CONTAINER_ID_RE.test(transaction.containerId)) {
    throw new Error("Managed bootstrap shared-state transaction container identity is invalid.");
  }
  if (!isImmutableDockerImageId(transaction.image)) {
    throw new Error("Managed bootstrap shared-state transaction image identity is not immutable.");
  }
  if (!transaction.bootstrapIdentity || !DURABLE_IDENTITY_RE.test(transaction.bootstrapIdentity)) {
    throw new Error("Managed bootstrap shared-state transaction identity is missing or invalid.");
  }
  if (
    !transaction.profileFingerprint ||
    !DURABLE_IDENTITY_RE.test(transaction.profileFingerprint)
  ) {
    throw new Error(
      "Managed bootstrap shared-state transaction profile fingerprint is missing or invalid.",
    );
  }
}

function transactionCommand(
  action: "clear-shared-state-commit-receipt" | "commit" | "rollback",
  transaction: DockerManagedBootstrapSharedStateTransaction,
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

export function clearDockerManagedStartupSharedStateCommitReceipt(
  transaction: DockerManagedBootstrapSharedStateTransaction,
  deps: DockerGpuPatchDeps = {},
): void {
  const dockerRun = deps.dockerRun ?? defaultDockerRun;
  assertValidManagedStartupTransaction(transaction);
  const command = transactionCommand("clear-shared-state-commit-receipt", transaction);
  const cleared = dockerRun(
    [
      "exec",
      "--user",
      "0:0",
      "--workdir",
      "/",
      ...NEUTRALIZED_PRE_ENTRYPOINT_ENV,
      transaction.containerId,
      CLEAN_NODE_ENTRYPOINT,
      ...CLEAN_NODE_ARGV,
      ...command,
    ],
    DOCKER_MUTATION_OPTIONS,
  );
  // Accept a lost Docker acknowledgement only when both exact image-owned
  // receipt paths are independently proven absent by the immutable helper.
  let status: "committed" | "none" | "pending";
  try {
    status = probeDockerManagedStartupSharedState(
      {
        transaction,
        profileFingerprint: transaction.profileFingerprint,
      },
      deps,
    );
  } catch (error) {
    throw new DockerManagedStartupSharedStateCommitIndeterminateError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (status === "none") return;
  if (!hasZeroDockerExitStatus(cleared)) {
    throw new Error(
      `Managed-startup durable commit receipt cleanup failed and exact absence was not proven (status=${status}): ${commandDetail(cleared)}`,
    );
  }
  throw new Error(
    `Managed-startup durable commit receipt cleanup returned success, but exact absence was not proven (status=${status}).`,
  );
}

function commitManagedStartupSharedState(
  transaction: DockerManagedBootstrapSharedStateTransaction,
  deps: DockerGpuPatchDeps,
): void {
  const dockerRun = deps.dockerRun ?? defaultDockerRun;
  assertValidManagedStartupTransaction(transaction);
  const command = transactionCommand("commit", transaction);
  const commit = dockerRun(
    [
      "exec",
      "--user",
      "0:0",
      "--workdir",
      "/",
      ...NEUTRALIZED_PRE_ENTRYPOINT_ENV,
      transaction.containerId,
      CLEAN_NODE_ENTRYPOINT,
      ...CLEAN_NODE_ARGV,
      ...command,
    ],
    DOCKER_MUTATION_OPTIONS,
  );
  // The commit helper atomically renames the rollback receipt into a compact
  // identity-bound commit receipt before Docker returns. Always probe it
  // afterward so a lost daemon acknowledgement is accepted only when durable
  // commit state is independently proven.
  let status: "committed" | "none" | "pending";
  try {
    status = probeDockerManagedStartupSharedState(
      {
        transaction,
        profileFingerprint: transaction.profileFingerprint,
      },
      deps,
    );
  } catch (error) {
    throw new DockerManagedStartupSharedStateCommitIndeterminateError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (status === "committed") return;
  if (!hasZeroDockerExitStatus(commit)) {
    throw new Error(
      `Managed-startup shared-state commit helper failed and durable commit was not proven (status=${status}): ${commandDetail(commit)}`,
    );
  }
  throw new Error(
    `Managed-startup shared-state commit helper returned success, but durable commit was not proven (status=${status}).`,
  );
}

function quiesceManagedStartupContainer(
  transaction: DockerManagedBootstrapSharedStateTransaction,
  deps: DockerGpuPatchDeps,
): void {
  const dockerStop = deps.dockerStop ?? defaultDockerStop;
  const stopped = dockerStop(transaction.containerId, {
    ...DOCKER_MUTATION_OPTIONS,
    timeout: DOCKER_GPU_PATCH_STOP_TIMEOUT_MS,
  });
  if (!hasZeroDockerExitStatus(stopped)) {
    throw new Error(
      `Could not quiesce the failed managed-startup container before shared-state rollback: ${commandDetail(stopped)}`,
    );
  }
}

function isExactMissingReceiptCopy(
  transaction: DockerManagedBootstrapSharedStateTransaction,
  sourcePath: string,
  result: {
    readonly stderr?: string | Buffer | null;
    readonly stdout?: string | Buffer | null;
    readonly error?: Error | null;
  },
): boolean {
  const detail = commandDetail(result);
  const escapedPath = sourcePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedContainer = transaction.containerId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [
    new RegExp(
      `^(?:Error response from daemon: )?Could not find the file ${escapedPath} in container ${escapedContainer}$`,
      "u",
    ),
    new RegExp(`^(?:lstat|stat) ${escapedPath}: no such file or directory$`, "u"),
  ].some((pattern) => pattern.test(detail));
}

function copyManagedStartupReceiptAt(
  transaction: DockerManagedBootstrapSharedStateTransaction,
  sourcePath: string,
  deps: DockerGpuPatchDeps,
  allowAbsent = false,
): DockerDaemonReceipt | null {
  const dockerRun = deps.dockerRun ?? defaultDockerRun;
  const tempSeed = secureTempFile(RECEIPT_TEMP_PREFIX);
  const receiptPath = path.join(path.dirname(tempSeed), path.basename(sourcePath));
  let copied = false;
  try {
    const copy = dockerRun(
      ["cp", "-a", `${transaction.containerId}:${sourcePath}`, receiptPath],
      DOCKER_MUTATION_OPTIONS,
    );
    if (!hasZeroDockerExitStatus(copy)) {
      if (allowAbsent && isExactMissingReceiptCopy(transaction, sourcePath, copy)) {
        cleanupDockerHostReceiptBestEffort(receiptPath, RECEIPT_TEMP_PREFIX);
        return null;
      }
      throw new Error(
        `Could not copy the managed-startup rollback receipt from the failed container: ${commandDetail(copy)}`,
      );
    }
    copied = true;
    return transferDockerReceiptToDaemon({
      image: transaction.image,
      receiptPath,
      destinations:
        sourcePath === MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY
          ? [
              MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
              MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
            ]
          : [sourcePath],
      dockerOptions: DOCKER_MUTATION_OPTIONS,
      dockerRun,
    });
  } catch (error) {
    // Keep a copied receipt when daemon staging fails: it is the only recovery
    // authority available while the shared-state transaction remains pending.
    if (!copied) cleanupDockerHostReceiptBestEffort(receiptPath, RECEIPT_TEMP_PREFIX);
    throw error;
  }
}

function copyManagedStartupReceipt(
  transaction: DockerManagedBootstrapSharedStateTransaction,
  deps: DockerGpuPatchDeps,
  allowAbsent = false,
): DockerDaemonReceipt | null {
  return copyManagedStartupReceiptAt(
    transaction,
    MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
    deps,
    allowAbsent,
  );
}

function rollbackManagedStartupSharedState(
  transaction: DockerManagedBootstrapSharedStateTransaction,
  deps: DockerGpuPatchDeps,
  preservedReceipt?: DockerDaemonReceipt,
): boolean {
  const dockerRun = deps.dockerRun ?? defaultDockerRun;
  const status = probeDockerManagedStartupSharedState(
    { transaction, profileFingerprint: transaction.profileFingerprint },
    deps,
  );
  if (status === "committed") {
    throw new Error("Managed-startup shared state is durably committed and cannot be rolled back.");
  }
  const receipt =
    preservedReceipt ??
    (status === "pending" ? copyManagedStartupReceipt(transaction, deps) : null);
  if (!receipt) return false;
  let restored = false;
  try {
    // The immutable image owns the canonical receipt parser and exact
    // post-restore verification. Keep the host receipt opaque so that its
    // validator cannot drift from the image contract. After dropping every
    // capability, rollback retains only CHOWN for original ownership,
    // DAC_OVERRIDE for owner-restricted state, and FOWNER for original modes.
    const helper = dockerRun(
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
        // Hermes keeps its shared state root setgid. FSETID lets this isolated
        // helper restore that bit after CHOWN changes the directory group.
        "--cap-add",
        "FSETID",
        ...NEUTRALIZED_PRE_ENTRYPOINT_ENV,
        "--volumes-from",
        transaction.containerId,
        "--mount",
        dockerDaemonReceiptMount(receipt, MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY),
        "--entrypoint",
        CLEAN_NODE_ENTRYPOINT,
        transaction.image,
        ...CLEAN_NODE_ARGV,
        ...transactionCommand("rollback", transaction),
        "--read-only-receipt",
      ],
      DOCKER_MUTATION_OPTIONS,
    );
    if (!hasZeroDockerExitStatus(helper)) {
      throw new DockerManagedStartupSharedStateRestoreError(
        `Immutable managed-startup helper could not restore and verify shared state: ${commandDetail(helper)}. ` +
          protectedDockerReceiptDetail(receipt),
      );
    }
    restored = true;
  } finally {
    if (restored) cleanupReceiptBestEffort(receipt, deps);
  }
  return true;
}

function removeFailedUnbackedContainer(
  transaction: DockerManagedBootstrapSharedStateTransaction,
  deps: DockerGpuPatchDeps,
): void {
  const dockerRm = deps.dockerRm ?? defaultDockerRm;
  const removed = dockerRm(transaction.containerId, DOCKER_MUTATION_OPTIONS);
  if (!hasZeroDockerExitStatus(removed)) {
    throw new Error(
      `Could not remove the failed managed-startup container after shared-state rollback: ${commandDetail(removed)}`,
    );
  }
}

/**
 * Finalize the shared-state half of managed container cutover before generic
 * backup removal or rollback. A shared-state rollback failure deliberately
 * throws so callers cannot remove the new container or restart the old one
 * while `/sandbox` remains partially applied.
 */
export function finalizeDockerManagedStartupSharedState(
  input: {
    readonly transaction: DockerManagedBootstrapSharedStateTransaction | null;
    readonly patchResult?: DockerGpuPatchResult | null;
    /**
     * The managed-bootstrap journal owns exact replacement removal. Retaining
     * it lets the caller publish rollback authorization after shared-state
     * restoration and before the first runtime deletion.
     */
    readonly retainContainerAfterRollback?: boolean;
    readonly supervisorReady: boolean;
  },
  deps: DockerGpuPatchDeps = {},
): DockerManagedStartupSharedStateOutcome {
  const transaction = input.transaction;
  if (!transaction) {
    return { supervisorReady: input.supervisorReady, failure: null };
  }
  assertValidManagedStartupTransaction(transaction);
  if (input.supervisorReady) {
    // Preserve and validate an explicit writable-layer receipt before logical
    // commit. The helper receives the copy read-only and does not delete it;
    // this keeps rollback possible when Docker loses the helper acknowledgement.
    // --volumes-from exposes shared mounts only; it cannot expose this
    // container-local transaction directory to an immutable helper.
    let receipt: DockerDaemonReceipt;
    try {
      const copiedReceipt = copyManagedStartupReceipt(transaction, deps);
      if (!copiedReceipt) {
        throw new Error("Managed-startup pending receipt disappeared before commit.");
      }
      receipt = copiedReceipt;
    } catch (error) {
      try {
        quiesceManagedStartupContainer(transaction, deps);
      } catch (stopError) {
        throw new Error(
          `Managed-startup receipt preservation failed and the new workload could not be quiesced: ${
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
        receipt,
        MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
        "pending",
        deps,
      );
      commitManagedStartupSharedState(transaction, deps);
      cleanupReceiptBestEffort(receipt, deps);
      return { supervisorReady: true, failure: null };
    } catch (error) {
      if (error instanceof DockerManagedStartupSharedStateCommitIndeterminateError) {
        throw error;
      }
      commitFailure = error instanceof Error ? error : new Error(String(error));
    }
    const failure = new Error(
      `OpenShell supervisor reconnected, but managed shared-state logical commit validation failed: ${commitFailure.message}`,
    );
    try {
      quiesceManagedStartupContainer(transaction, deps);
    } catch (stopError) {
      throw new Error(
        `${failure.message}; the new workload could not be quiesced: ${
          stopError instanceof Error ? stopError.message : String(stopError)
        }`,
        { cause: stopError },
      );
    }
    const restoredSharedState = rollbackManagedStartupSharedState(transaction, deps, receipt);
    if (!restoredSharedState && !input.patchResult && !input.retainContainerAfterRollback) {
      removeFailedUnbackedContainer(transaction, deps);
    }
    return { supervisorReady: false, failure };
  }

  quiesceManagedStartupContainer(transaction, deps);
  const restoredSharedState = rollbackManagedStartupSharedState(transaction, deps);
  if (!restoredSharedState && !input.patchResult && !input.retainContainerAfterRollback) {
    removeFailedUnbackedContainer(transaction, deps);
  }
  return { supervisorReady: false, failure: null };
}
