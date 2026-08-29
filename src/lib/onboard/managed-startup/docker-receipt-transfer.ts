// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import path from "node:path";

import { hasZeroDockerExitStatus } from "../docker-command-result";
import type { DockerGpuPatchDeps } from "../docker-gpu-patch-types";
import { cleanupTempDir } from "../temp-files";

const RECEIPT_VOLUME_DIRECTORY = "/run/nemoclaw/managed-startup-receipt-transfer";
const RECEIPT_SEED_PREFIX = "nemoclaw-managed-startup-receipt-seed";
const RECEIPT_VOLUME_PREFIX = "nemoclaw-managed-startup-receipt-volume";

export type DockerDaemonReceipt = {
  readonly hostPath: string;
  readonly volumeName: string;
};

type DockerRun = NonNullable<DockerGpuPatchDeps["dockerRun"]>;

export type DockerReceiptTransferOptions = {
  readonly image: string;
  readonly receiptPath: string;
  readonly destinations: readonly string[];
  readonly dockerOptions: Record<string, unknown>;
  readonly dockerRun: DockerRun;
};

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

function receiptName(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "")}`;
}

function receiptDirectory(destination: string): string {
  if (!destination.startsWith("/") || path.posix.normalize(destination) !== destination) {
    throw new Error("Managed-startup receipt destination is not a normalized absolute path.");
  }
  if (path.posix.dirname(destination) === "/") {
    throw new Error("Managed-startup receipt destination cannot mount over the filesystem root.");
  }
  const directory = path.posix.basename(destination);
  if (directory.length === 0 || directory === "." || directory === "/") {
    throw new Error("Managed-startup receipt destination has no directory name.");
  }
  return directory;
}

function cleanupVolumeBestEffort(
  volumeName: string,
  dockerRun: DockerRun,
  dockerOptions: Record<string, unknown>,
): boolean {
  try {
    const removed = dockerRun(["volume", "rm", volumeName], dockerOptions);
    if (!hasZeroDockerExitStatus(removed)) {
      console.warn(
        `  ⚠ Protected managed-startup daemon receipt volume could not be removed (${volumeName}): ${commandDetail(removed)}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `  ⚠ Protected managed-startup daemon receipt volume could not be removed (${volumeName}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function cleanupSeedBestEffort(
  seedName: string,
  dockerRun: DockerRun,
  dockerOptions: Record<string, unknown>,
): boolean {
  try {
    return hasZeroDockerExitStatus(dockerRun(["rm", "-f", seedName], dockerOptions));
  } catch {
    return false;
  }
}

/**
 * Copy a host-only receipt into a Docker-managed volume before an immutable
 * helper reads it. Docker creates and reads the volume inside its own daemon,
 * so the transfer does not rely on the daemon resolving a host temporary path.
 */
export function transferDockerReceiptToDaemon(
  options: DockerReceiptTransferOptions,
): DockerDaemonReceipt {
  const dockerRun = options.dockerRun;
  const volumeName = receiptName(RECEIPT_VOLUME_PREFIX);
  const seedName = receiptName(RECEIPT_SEED_PREFIX);
  let volumeCreated = false;
  let seedCreated = false;
  try {
    const volume = dockerRun(["volume", "create", volumeName], options.dockerOptions);
    if (!hasZeroDockerExitStatus(volume)) {
      throw new Error(`Could not create managed-startup receipt volume: ${commandDetail(volume)}`);
    }
    volumeCreated = true;
    const seed = dockerRun(
      [
        "create",
        "--name",
        seedName,
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
        "--mount",
        `type=volume,src=${volumeName},dst=${RECEIPT_VOLUME_DIRECTORY}`,
        options.image,
      ],
      options.dockerOptions,
    );
    if (!hasZeroDockerExitStatus(seed)) {
      throw new Error(`Could not create managed-startup receipt seed: ${commandDetail(seed)}`);
    }
    seedCreated = true;
    for (const destination of new Set(options.destinations)) {
      const destinationDirectory = receiptDirectory(destination);
      const copied = dockerRun(
        [
          "cp",
          "-a",
          options.receiptPath,
          `${seedName}:${RECEIPT_VOLUME_DIRECTORY}/${destinationDirectory}`,
        ],
        options.dockerOptions,
      );
      if (!hasZeroDockerExitStatus(copied)) {
        throw new Error(
          `Could not transfer managed-startup receipt to Docker: ${commandDetail(copied)}`,
        );
      }
    }
    const removed = dockerRun(["rm", "-f", seedName], options.dockerOptions);
    if (!hasZeroDockerExitStatus(removed)) {
      throw new Error(`Could not remove managed-startup receipt seed: ${commandDetail(removed)}`);
    }
    seedCreated = false;
    return { hostPath: options.receiptPath, volumeName };
  } catch (error) {
    const retained = [`host receipt ${options.receiptPath}`];
    if (seedCreated && !cleanupSeedBestEffort(seedName, dockerRun, options.dockerOptions)) {
      retained.push(`seed container ${seedName}`);
    }
    if (volumeCreated && !cleanupVolumeBestEffort(volumeName, dockerRun, options.dockerOptions)) {
      retained.push(`daemon volume ${volumeName}`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail} Protected managed-startup recovery artifacts retained: ${retained.join("; ")}.`,
      { cause: error },
    );
  }
}

export function dockerDaemonReceiptMount(
  receipt: DockerDaemonReceipt,
  destination: string,
): string {
  receiptDirectory(destination);
  return `type=volume,src=${receipt.volumeName},dst=${path.posix.dirname(destination)},readonly`;
}

export function cleanupDockerHostReceiptBestEffort(receiptPath: string, tempPrefix: string): void {
  try {
    cleanupTempDir(receiptPath, tempPrefix);
  } catch (error) {
    console.warn(
      `  ⚠ Managed-startup shared state is finalized, but its protected host receipt could not be removed (${receiptPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Remove a verified receipt. Failures remain visible but do not undo a safe state transition. */
export function cleanupDockerDaemonReceiptBestEffort(
  receipt: DockerDaemonReceipt,
  tempPrefix: string,
  dockerRun: DockerRun,
  dockerOptions: Record<string, unknown>,
): void {
  cleanupDockerHostReceiptBestEffort(receipt.hostPath, tempPrefix);
  cleanupVolumeBestEffort(receipt.volumeName, dockerRun, dockerOptions);
}

export function protectedDockerReceiptDetail(receipt: DockerDaemonReceipt): string {
  return `Protected receipt retained at ${receipt.hostPath} and daemon volume ${receipt.volumeName}`;
}
