// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import path from "node:path";

import { hasZeroDockerExitStatus } from "../docker-command-result";
import type { DockerGpuPatchDeps } from "../docker-gpu-patch-types";

const RECEIPT_RESOURCE_PREFIX = "nemoclaw-managed-startup-receipt";
const RECEIPT_RESOURCE_NONCE_BYTES = 12;

interface DockerManagedStartupReceiptVolumeInput {
  readonly image: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly receiptDirectory: string;
  readonly receiptPath: string;
}

interface DockerManagedStartupReceiptVolumeDeps {
  readonly dockerRun: NonNullable<DockerGpuPatchDeps["dockerRun"]>;
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

/**
 * Upload one protected host receipt into daemon-owned storage, then expose it
 * to an immutable helper as a read-only volume. Docker clients can upload into
 * a stopped container across VM and remote-daemon boundaries; a host bind path
 * cannot cross that boundary (#10348).
 */
export function withDockerManagedStartupReceiptVolume<T>(
  input: DockerManagedStartupReceiptVolumeInput,
  deps: DockerManagedStartupReceiptVolumeDeps,
  useReceiptMount: (mount: string) => T,
): T {
  const { dockerRun } = deps;
  const nonce = randomBytes(RECEIPT_RESOURCE_NONCE_BYTES).toString("hex");
  const volumeName = `${RECEIPT_RESOURCE_PREFIX}-${nonce}`;
  const seedContainerName = `${RECEIPT_RESOURCE_PREFIX}-seed-${nonce}`;
  let completed = false;
  let seedCreated = false;
  let volumeCreated = false;

  try {
    const volume = dockerRun(["volume", "create", volumeName], input.options);
    if (!hasZeroDockerExitStatus(volume)) {
      throw new Error(
        `Could not create daemon storage for the managed-startup receipt: ${commandDetail(volume)}`,
      );
    }
    volumeCreated = true;

    const seed = dockerRun(
      [
        "create",
        "--name",
        seedContainerName,
        "--pull",
        "never",
        "--network",
        "none",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--mount",
        `type=volume,src=${volumeName},dst=${input.receiptDirectory},volume-nocopy`,
        "--entrypoint",
        "/usr/bin/env",
        input.image,
        "-i",
        "/bin/true",
      ],
      input.options,
    );
    if (!hasZeroDockerExitStatus(seed)) {
      throw new Error(
        `Could not create the managed-startup receipt transfer container: ${commandDetail(seed)}`,
      );
    }
    seedCreated = true;

    const upload = dockerRun(
      [
        "cp",
        "-a",
        `${input.receiptPath}${input.receiptPath.endsWith(path.sep) ? "" : path.sep}.`,
        `${seedContainerName}:${input.receiptDirectory}`,
      ],
      input.options,
    );
    if (!hasZeroDockerExitStatus(upload)) {
      throw new Error(
        `Could not upload the managed-startup receipt into daemon storage: ${commandDetail(upload)}`,
      );
    }

    const result = useReceiptMount(
      `type=volume,src=${volumeName},dst=${input.receiptDirectory},readonly,volume-nocopy`,
    );
    completed = true;
    return result;
  } finally {
    const cleanupFailures: string[] = [];
    if (seedCreated) {
      const removedSeed = dockerRun(["rm", "-f", seedContainerName], input.options);
      if (!hasZeroDockerExitStatus(removedSeed)) {
        cleanupFailures.push(`container ${seedContainerName}: ${commandDetail(removedSeed)}`);
      }
    }
    if (volumeCreated) {
      const removedVolume = dockerRun(["volume", "rm", volumeName], input.options);
      if (!hasZeroDockerExitStatus(removedVolume)) {
        cleanupFailures.push(`volume ${volumeName}: ${commandDetail(removedVolume)}`);
      }
    }
    if (cleanupFailures.length > 0) {
      const message = `Managed-startup receipt cleanup failed (${cleanupFailures.join("; ")})`;
      if (completed) throw new Error(message);
      console.warn(`  ⚠ ${message}`);
    }
  }
}
