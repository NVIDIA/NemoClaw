// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

function transactionCommand(action: "commit" | "rollback", agent: string): string[] {
  return [
    MANAGED_STARTUP_RUNTIME_EXECUTABLE,
    `--${action}-shared-state-transaction`,
    "--agent",
    agent,
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

function copyManagedStartupReceipt(
  transaction: DockerManagedStartupTransaction,
  deps: DockerGpuPatchDeps,
): string {
  const dockerRun = deps.dockerRun ?? defaultDockerRun;
  const receiptPath = secureTempFile(RECEIPT_TEMP_PREFIX);
  try {
    const copy = dockerRun(
      [
        "cp",
        `${transaction.containerId}:${MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY}`,
        receiptPath,
      ],
      DOCKER_MUTATION_OPTIONS,
    );
    if (!hasZeroDockerExitStatus(copy)) {
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
        ...transactionCommand("rollback", transaction.agent),
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
  const dockerRun = deps.dockerRun ?? defaultDockerRun;
  if (input.supervisorReady) {
    // Preserve a verified rollback source before commit deletes the
    // container-local receipt. If Docker loses the exec acknowledgement after
    // deletion, this copy still makes the cutover reversible.
    let receiptPath: string;
    try {
      receiptPath = copyManagedStartupReceipt(transaction, deps);
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
    const commit = dockerRun(
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
      DOCKER_MUTATION_OPTIONS,
    );
    if (hasZeroDockerExitStatus(commit)) {
      cleanupReceiptBestEffort(receiptPath);
      return { supervisorReady: true, failure: null };
    }
    const failure = new Error(
      `OpenShell supervisor reconnected, but managed shared-state commit failed: ${commandDetail(commit)}`,
    );
    quiesceManagedStartupContainer(transaction, deps);
    rollbackManagedStartupSharedState(transaction, receiptPath, deps);
    if (!input.patchResult) removeFailedUnbackedContainer(transaction, deps);
    return { supervisorReady: false, failure };
  }

  quiesceManagedStartupContainer(transaction, deps);
  const receiptPath = copyManagedStartupReceipt(transaction, deps);
  rollbackManagedStartupSharedState(transaction, receiptPath, deps);
  if (!input.patchResult) removeFailedUnbackedContainer(transaction, deps);
  return { supervisorReady: false, failure: null };
}
