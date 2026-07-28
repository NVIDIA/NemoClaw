// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getNemoclawStateRoot } from "../state/state-root";
import { ensureLocalAdapterStateDir } from "./local-adapter-lifecycle";
import { buildLocalDualStationDockerEnv } from "./vllm-docker-env";
import {
  type DualStationVllmPlan,
  NEMOCLAW_DGX_STATION_PEER_ENV,
  probeDualStationVllmCapability,
} from "./vllm-station-cluster";
import {
  cleanupDualStationManagedVllm,
  dualStationVllmClusterId,
} from "./vllm-station-cluster-lifecycle";
import { DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE } from "./vllm-station-runtime-receipt-path";
import {
  clearDualStationSshBinding,
  copyDualStationSshBinding,
  encodeDualStationSshBindingHandoff,
  NEMOCLAW_DGX_STATION_SSH_BINDING_ENV,
} from "./vllm-station-ssh-binding";

const RECEIPT_SCHEMA_VERSION = 1;
const MAX_RECEIPT_BYTES = 16 * 1024;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const GPU_UUID_PATTERN = /^GPU-[A-Za-z0-9-]+$/;
const RECEIPT_KEYS = [
  "clusterId",
  "localGpuUuid",
  "peerGpuUuid",
  "peerTarget",
  "schemaVersion",
  "sshBinding",
] as const;

interface DualStationVllmRuntimeReceipt {
  schemaVersion: 1;
  peerTarget: string;
  sshBinding: string;
  clusterId: string;
  localGpuUuid: string;
  peerGpuUuid: string;
}

export interface DualStationVllmRuntimeReceiptOptions {
  stateDir?: string;
  /** @internal Test seams for the external probe and lifecycle mutation. */
  probeCapability?: typeof probeDualStationVllmCapability;
  cleanupManagedVllm?: typeof cleanupDualStationManagedVllm;
}

export type DualStationVllmRuntimeCleanupResult =
  | { kind: "not-installed" }
  | { kind: "removed"; removedContainerIds: string[] };

function defaultStateDir(): string {
  return getNemoclawStateRoot(os.homedir());
}

export function dualStationVllmRuntimeReceiptPath(stateDir = defaultStateDir()): string {
  return path.join(stateDir, DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string, pattern: RegExp, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseReceipt(value: unknown): DualStationVllmRuntimeReceipt {
  if (!isRecord(value) || value.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error("Dual-Station vLLM runtime receipt schema is unsupported");
  }
  const keys = Object.keys(value).sort();
  const expected = [...RECEIPT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Dual-Station vLLM runtime receipt fields are invalid");
  }
  return {
    schemaVersion: 1,
    peerTarget: requireString(
      value.peerTarget,
      "Dual-Station vLLM runtime peer",
      /^(?:[A-Za-z_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/,
      286,
    ),
    sshBinding: requireString(
      value.sshBinding,
      "Dual-Station vLLM runtime SSH binding",
      /^[A-Za-z0-9_-]+$/,
      8192,
    ),
    clusterId: requireString(
      value.clusterId,
      "Dual-Station vLLM runtime cluster",
      SHA256_HEX_PATTERN,
      64,
    ),
    localGpuUuid: requireString(
      value.localGpuUuid,
      "Dual-Station vLLM local GPU",
      GPU_UUID_PATTERN,
      128,
    ),
    peerGpuUuid: requireString(
      value.peerGpuUuid,
      "Dual-Station vLLM peer GPU",
      GPU_UUID_PATTERN,
      128,
    ),
  };
}

function assertPrivateReceipt(stat: fs.Stats, filePath: string): void {
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(
      `Dual-Station vLLM runtime receipt must be a private regular file: ${filePath}`,
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(
      `Dual-Station vLLM runtime receipt is not owned by the current user: ${filePath}`,
    );
  }
}

function loadReceipt(
  options: DualStationVllmRuntimeReceiptOptions = {},
): DualStationVllmRuntimeReceipt | null {
  const filePath = dualStationVllmRuntimeReceiptPath(options.stateDir ?? defaultStateDir());
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform");
  }
  const nonBlock = fs.constants.O_NONBLOCK ?? 0;
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlock);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") {
        throw new Error(
          `Refusing to read dual-Station vLLM runtime receipt through a symbolic link: ${filePath}`,
        );
      }
      throw error;
    }
    const opened = fs.fstatSync(fd);
    assertPrivateReceipt(opened, filePath);
    if (opened.size < 2 || opened.size > MAX_RECEIPT_BYTES) {
      throw new Error(`Dual-Station vLLM runtime receipt is malformed: ${filePath}`);
    }
    return parseReceipt(JSON.parse(fs.readFileSync(fd, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Dual-Station vLLM runtime receipt is malformed: ${filePath}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeReceipt(
  receipt: DualStationVllmRuntimeReceipt,
  options: DualStationVllmRuntimeReceiptOptions = {},
): void {
  const stateDir = options.stateDir ?? defaultStateDir();
  ensureLocalAdapterStateDir(stateDir);
  const filePath = dualStationVllmRuntimeReceiptPath(stateDir);
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now().toString(16)}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    assertPrivateReceipt(fs.fstatSync(fd), temporary);
    fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    fsyncDirectory(stateDir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Persist the exact trusted peer needed to remove a successful managed pair. */
export function persistDualStationVllmRuntimeReceipt(
  plan: DualStationVllmPlan,
  options: DualStationVllmRuntimeReceiptOptions = {},
): void {
  const stateDir = options.stateDir ?? defaultStateDir();
  ensureLocalAdapterStateDir(stateDir);
  const clusterId = dualStationVllmClusterId(plan);
  const existing = loadReceipt({ stateDir });
  if (
    existing &&
    (existing.peerTarget !== plan.peerSshBinding.peerTarget ||
      existing.clusterId !== clusterId ||
      existing.localGpuUuid !== plan.local.gpu.uuid ||
      existing.peerGpuUuid !== plan.peer.gpu.uuid)
  ) {
    throw new Error("A different managed dual-Station runtime receipt already owns rollback state");
  }
  const receiptPath = dualStationVllmRuntimeReceiptPath(stateDir);
  const runtimeBinding = copyDualStationSshBinding(receiptPath, plan.peerSshBinding);
  writeReceipt(
    {
      schemaVersion: 1,
      peerTarget: runtimeBinding.peerTarget,
      sshBinding: encodeDualStationSshBindingHandoff(runtimeBinding),
      clusterId,
      localGpuUuid: plan.local.gpu.uuid,
      peerGpuUuid: plan.peer.gpu.uuid,
    },
    { stateDir },
  );
}

function clearReceipt(stateDir: string): void {
  const filePath = dualStationVllmRuntimeReceiptPath(stateDir);
  fs.unlinkSync(filePath);
  clearDualStationSshBinding(filePath);
  fsyncDirectory(stateDir);
}

/**
 * Remove both exact owned containers before ordinary uninstall can retire the
 * controller state required to reach the worker.
 */
export async function cleanupInstalledDualStationVllmRuntime(
  options: DualStationVllmRuntimeReceiptOptions = {},
): Promise<DualStationVllmRuntimeCleanupResult> {
  const stateDir = options.stateDir ?? defaultStateDir();
  const receipt = loadReceipt({ stateDir });
  if (!receipt) return { kind: "not-installed" };
  const capability = (options.probeCapability ?? probeDualStationVllmCapability)({
    env: buildLocalDualStationDockerEnv({
      [NEMOCLAW_DGX_STATION_PEER_ENV]: receipt.peerTarget,
      [NEMOCLAW_DGX_STATION_SSH_BINDING_ENV]: receipt.sshBinding,
    }),
  });
  if (capability.kind !== "ready") {
    const reason =
      capability.kind === "unavailable" ? capability.reason : "runtime peer is not configured";
    throw new Error(`Could not revalidate the managed dual-Station pair: ${reason}`);
  }
  if (
    dualStationVllmClusterId(capability.plan) !== receipt.clusterId ||
    capability.plan.local.gpu.uuid !== receipt.localGpuUuid ||
    capability.plan.peer.gpu.uuid !== receipt.peerGpuUuid
  ) {
    throw new Error("Managed dual-Station runtime identity changed; refusing pair cleanup");
  }
  const cleanup = await (options.cleanupManagedVllm ?? cleanupDualStationManagedVllm)(
    capability.plan,
  );
  if (!cleanup.ok) throw new Error(cleanup.reason);
  clearReceipt(stateDir);
  return { kind: "removed", removedContainerIds: cleanup.removedContainerIds };
}
