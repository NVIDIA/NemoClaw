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
import { cleanupTempDir, secureTempFile } from "../temp-files";
import type { DockerManagedStartupTransaction } from "./docker-root-apply";
import { MANAGED_STARTUP_RUNTIME_EXECUTABLE } from "./image-runtime";
import {
  MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "./shared-state-transaction";

const RECEIPT_TEMP_PREFIX = "nemoclaw-managed-startup-receipt";
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

export interface DockerManagedStartupSharedStateOutcome {
  /**
   * True only when the new supervisor is still eligible for successful
   * container cutover. A commit failure forces shared-state rollback first.
   */
  readonly supervisorReady: boolean;
  /** Original commit failure after a successful shared-state rollback. */
  readonly failure: Error | null;
}

export function probeDockerManagedStartupSharedState(
  input: {
    readonly transaction: DockerManagedStartupTransaction;
    readonly profileFingerprint: string;
  },
  deps: DockerGpuPatchDeps = {},
): "none" | "pending" {
  const transaction = input.transaction;
  if (!transaction.bootstrapIdentity) {
    throw new Error("Managed bootstrap shared-state status identity is missing.");
  }
  const receiptPath = copyManagedStartupReceipt(transaction, deps, true);
  if (!receiptPath) return "none";
  let verified = false;
  try {
    verifyCopiedManagedStartupReceipt(transaction, input.profileFingerprint, receiptPath, deps);
    verified = true;
    return "pending";
  } finally {
    if (verified) cleanupReceiptBestEffort(receiptPath);
  }
}

function verifyCopiedManagedStartupReceipt(
  transaction: DockerManagedStartupTransaction,
  profileFingerprint: string,
  receiptPath: string,
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
      ...NEUTRALIZED_PROCESS_INJECTION_ENV,
      "--mount",
      transactionReceiptMount(receiptPath),
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
    DOCKER_MUTATION_OPTIONS,
  );
  if (!hasZeroDockerExitStatus(result)) {
    throw new Error(
      `Immutable managed-startup helper could not verify shared-state status: ${commandDetail(result)}. ` +
        `Protected receipt retained at ${receiptPath}`,
    );
  }
  if (String(result.stdout ?? "").trim() !== "pending") {
    throw new Error(
      `Immutable managed-startup helper returned an invalid copied transaction status. Protected receipt retained at ${receiptPath}`,
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

function cleanupReceiptBestEffort(receiptPath: string): void {
  try {
    cleanupTempDir(receiptPath, RECEIPT_TEMP_PREFIX);
  } catch (error) {
    console.warn(
      `  ⚠ Managed-startup shared state is finalized, but its protected host receipt could not be removed (${receiptPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function transactionCommand(
  action: "rollback",
  transaction: DockerManagedStartupTransaction,
): string[] {
  if (!transaction.bootstrapIdentity) {
    throw new Error("Managed bootstrap shared-state transaction identity is missing.");
  }
  return [
    MANAGED_STARTUP_RUNTIME_EXECUTABLE,
    `--${action}-shared-state-transaction`,
    "--agent",
    transaction.agent,
    "--bootstrap-identity",
    transaction.bootstrapIdentity,
  ];
}

const DOCKER_MUTATION_OPTIONS = {
  ignoreError: true,
  suppressOutput: true,
  timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
} as const;

function quiesceManagedStartupContainer(
  transaction: DockerManagedStartupTransaction,
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
  transaction: DockerManagedStartupTransaction,
  result: {
    readonly stderr?: string | Buffer | null;
    readonly stdout?: string | Buffer | null;
    readonly error?: Error | null;
  },
): boolean {
  const detail = commandDetail(result);
  const escapedPath = MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  const escapedContainer = transaction.containerId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [
    new RegExp(
      `^(?:Error response from daemon: )?Could not find the file ${escapedPath} in container ${escapedContainer}$`,
      "u",
    ),
    new RegExp(`^(?:lstat|stat) ${escapedPath}: no such file or directory$`, "u"),
  ].some((pattern) => pattern.test(detail));
}

function transactionReceiptMount(receiptPath: string): string {
  return `type=bind,src=${receiptPath},dst=${MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY},readonly`;
}

function copyManagedStartupReceipt(
  transaction: DockerManagedStartupTransaction,
  deps: DockerGpuPatchDeps,
  allowAbsent = false,
): string | null {
  const dockerRun = deps.dockerRun ?? defaultDockerRun;
  const tempSeed = secureTempFile(RECEIPT_TEMP_PREFIX);
  const receiptPath = path.join(
    path.dirname(tempSeed),
    path.basename(MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY),
  );
  try {
    const copy = dockerRun(
      [
        "cp",
        "-a",
        `${transaction.containerId}:${MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY}`,
        receiptPath,
      ],
      DOCKER_MUTATION_OPTIONS,
    );
    if (!hasZeroDockerExitStatus(copy)) {
      if (allowAbsent && isExactMissingReceiptCopy(transaction, copy)) {
        cleanupReceiptBestEffort(receiptPath);
        return null;
      }
      throw new Error(
        `Could not copy the managed-startup rollback receipt from the failed container: ${commandDetail(copy)}`,
      );
    }
    if (receiptPath.includes(",") || /[\r\n\0]/u.test(receiptPath)) {
      throw new Error("Managed-startup rollback receipt path is unsafe for a Docker bind mount");
    }
    return receiptPath;
  } catch (error) {
    cleanupReceiptBestEffort(receiptPath);
    throw error;
  }
}

function rollbackManagedStartupSharedState(
  transaction: DockerManagedStartupTransaction,
  receiptPath: string,
  deps: DockerGpuPatchDeps,
): void {
  const dockerRun = deps.dockerRun ?? defaultDockerRun;
  let restored = false;
  try {
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
      DOCKER_MUTATION_OPTIONS,
    );
    if (!hasZeroDockerExitStatus(helper)) {
      throw new Error(
        `Immutable managed-startup helper could not restore and verify shared state: ${commandDetail(helper)}. ` +
          `Protected receipt retained at ${receiptPath}`,
      );
    }
    restored = true;
  } finally {
    if (restored) {
      cleanupReceiptBestEffort(receiptPath);
    }
  }
}

function removeFailedUnbackedContainer(
  transaction: DockerManagedStartupTransaction,
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
    readonly transaction: DockerManagedStartupTransaction | null;
    readonly patchResult?: DockerGpuPatchResult | null;
    readonly supervisorReady: boolean;
  },
  deps: DockerGpuPatchDeps = {},
): DockerManagedStartupSharedStateOutcome {
  const transaction = input.transaction;
  if (!transaction) {
    return { supervisorReady: input.supervisorReady, failure: null };
  }
  if (input.supervisorReady) {
    // Preserve and validate an explicit writable-layer receipt before logical
    // commit. The helper receives the copy read-only and does not delete it;
    // this keeps rollback possible when Docker loses the helper acknowledgement.
    // --volumes-from exposes shared mounts only; it cannot expose this
    // container-local transaction directory to an immutable helper.
    let receiptPath: string;
    try {
      const copiedReceipt = copyManagedStartupReceipt(transaction, deps);
      if (!copiedReceipt) {
        throw new Error("Managed-startup pending receipt disappeared before commit.");
      }
      receiptPath = copiedReceipt;
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
      if (!transaction.profileFingerprint) {
        throw new Error("Managed bootstrap transaction profile fingerprint is missing.");
      }
      verifyCopiedManagedStartupReceipt(
        transaction,
        transaction.profileFingerprint,
        receiptPath,
        deps,
      );
      cleanupReceiptBestEffort(receiptPath);
      return { supervisorReady: true, failure: null };
    } catch (error) {
      commitFailure = error instanceof Error ? error : new Error(String(error));
    }
    const failure = new Error(
      `OpenShell supervisor reconnected, but managed shared-state logical commit validation failed: ${commitFailure.message}`,
    );
    quiesceManagedStartupContainer(transaction, deps);
    rollbackManagedStartupSharedState(transaction, receiptPath, deps);
    if (!input.patchResult) removeFailedUnbackedContainer(transaction, deps);
    return { supervisorReady: false, failure };
  }

  quiesceManagedStartupContainer(transaction, deps);
  const receiptPath = copyManagedStartupReceipt(transaction, deps, true);
  if (!receiptPath) {
    if (!input.patchResult) removeFailedUnbackedContainer(transaction, deps);
    return { supervisorReady: false, failure: null };
  }
  rollbackManagedStartupSharedState(transaction, receiptPath, deps);
  if (!input.patchResult) removeFailedUnbackedContainer(transaction, deps);
  return { supervisorReady: false, failure: null };
}
