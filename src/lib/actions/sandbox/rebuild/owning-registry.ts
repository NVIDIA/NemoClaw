// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

import type { RebuildSandboxOptions } from "../../../domain/lifecycle/options";
import { snapshotKnownCredentialEnv } from "../../../onboard/credential-env";
import { assertGatewayStatePathSafe, listGatewayStateRoots } from "../../../state/gateway-registry";
import { isCurrentPortableHostFenceHeld } from "../../../state/portable-uninstall-retirement";
import { buildSubprocessEnv } from "../../../subprocess-env";
import { findSandboxAcrossGatewayRoots } from "../../../state/registry/cross-port";
import type { RebuildSandboxExecutionOptions } from "../rebuild-prepared-recovery";
import { readRebuildRecoveryRoute } from "../rebuild-recreate-journal";

export interface RebuildOwningRegistryInput {
  readonly sandboxName: string;
  readonly options: RebuildSandboxOptions;
  readonly executionOptions: RebuildSandboxExecutionOptions;
}

export interface RetireRecoveryOwningRegistryInput {
  readonly sandboxName: string;
  readonly transactionId: string;
  readonly confirmDataRecovered: boolean;
}

export type OwningRegistryWorkerInput =
  | ({ readonly operation: "rebuild" } & RebuildOwningRegistryInput)
  | ({ readonly operation: "retire-recovery" } & RetireRecoveryOwningRegistryInput);

export interface RebuildRecoveryStorageRoot {
  readonly backupPath: string;
  readonly gatewayPort: number;
  readonly registryFile: string;
}

export type OwningRegistryWorkerResult = Readonly<{
  ok: boolean;
  operation: OwningRegistryWorkerInput["operation"];
  sandboxName: string;
  gatewayPort: number;
  message?: string;
}>;

type RebuildOwningRegistryDependencies = {
  findSandbox: typeof findSandboxAcrossGatewayRoots;
  findRecoveryRoot: typeof findRebuildRecoveryStorageRoot;
  isHostFenceHeld: typeof isCurrentPortableHostFenceHeld;
  runWorker(input: OwningRegistryWorkerInput, gatewayPort: number): Promise<void>;
};

const WORKER_PATH = path.join(__dirname, "owning-registry-worker.js");
const MAX_RECOVERY_BACKUP_ENTRIES = 1024;
const MAX_WORKER_RESULT_BYTES = 64 * 1024;
const REBUILD_ENV_NAMES = [
  "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_OPENSHELL_BIN",
  "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
  "NEMOCLAW_OPENSHELL_SANDBOX_BIN",
  "NEMOCLAW_REBUILD_VERBOSE",
  "NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH",
] as const;

function rebuildWorkerEnv(gatewayPort: number): Record<string, string> {
  const extra: Record<string, string> = {
    ...snapshotKnownCredentialEnv(),
    NEMOCLAW_GATEWAY_PORT: String(gatewayPort),
  };
  for (const name of REBUILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) extra[name] = value;
  }
  return buildSubprocessEnv(extra);
}

async function readWorkerResult(stream: Readable): Promise<OwningRegistryWorkerResult | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > MAX_WORKER_RESULT_BYTES) {
      throw new Error("Rebuild worker result is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).ok !== "boolean" ||
    ((parsed as Record<string, unknown>).operation !== "rebuild" &&
      (parsed as Record<string, unknown>).operation !== "retire-recovery") ||
    typeof (parsed as Record<string, unknown>).sandboxName !== "string" ||
    !Number.isInteger((parsed as Record<string, unknown>).gatewayPort) ||
    ((parsed as Record<string, unknown>).message !== undefined &&
      typeof (parsed as Record<string, unknown>).message !== "string")
  ) {
    return null;
  }
  return parsed as OwningRegistryWorkerResult;
}

async function runWorker(input: OwningRegistryWorkerInput, gatewayPort: number): Promise<void> {
  const child = spawn(process.execPath, [WORKER_PATH], {
    env: rebuildWorkerEnv(gatewayPort),
    stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"],
  });
  const inputStream = child.stdio[3];
  if (!inputStream || !("end" in inputStream)) {
    child.kill();
    throw new Error("Cannot route rebuild input to the owning gateway registry.");
  }
  const inputWritten = new Promise<void>((resolve, reject) => {
    inputStream.once("error", reject);
    inputStream.end(JSON.stringify(input), resolve);
  });
  const resultStream = child.stdio[4] as Readable | null;
  if (!resultStream) {
    child.kill();
    throw new Error("Cannot read the rebuild worker result.");
  }
  const result = readWorkerResult(resultStream);
  const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    },
  );
  const [, exit, workerResult] = await Promise.all([inputWritten, exited, result]);
  const resultMatchesRequest =
    workerResult?.operation === input.operation &&
    workerResult.sandboxName === input.sandboxName &&
    workerResult.gatewayPort === gatewayPort;
  if (
    exit.code === 0 &&
    exit.signal === null &&
    workerResult?.ok === true &&
    resultMatchesRequest
  ) {
    return;
  }
  if (workerResult?.ok === false && resultMatchesRequest && workerResult.message) {
    throw new Error(workerResult.message, { cause: workerResult });
  }
  throw new Error("Rebuild in the owning gateway registry did not complete successfully.");
}

export const rebuildOwningRegistryDependencies: RebuildOwningRegistryDependencies = {
  findSandbox: findSandboxAcrossGatewayRoots,
  findRecoveryRoot: findRebuildRecoveryStorageRoot,
  isHostFenceHeld: isCurrentPortableHostFenceHeld,
  runWorker,
};

/** Find one exact recovery marker across bounded, non-symlink gateway roots. */
export function findRebuildRecoveryStorageRoot(
  input: RetireRecoveryOwningRegistryInput,
  homeDir: string,
): RebuildRecoveryStorageRoot | null {
  const matches: RebuildRecoveryStorageRoot[] = [];
  for (const state of listGatewayStateRoots(homeDir)) {
    const sandboxBackupRoot = path.join(state.root, "rebuild-backups", input.sandboxName);
    assertGatewayStatePathSafe(homeDir, sandboxBackupRoot);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sandboxBackupRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (entries.length > MAX_RECOVERY_BACKUP_ENTRIES) {
      throw new Error(
        `Cannot safely inspect rebuild recovery: more than ${String(MAX_RECOVERY_BACKUP_ENTRIES)} backup entries exist for sandbox '${input.sandboxName}'.`,
      );
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const backupPath = path.join(sandboxBackupRoot, entry.name);
      if (!readRebuildRecoveryRoute(input, backupPath)) continue;
      matches.push({
        backupPath,
        gatewayPort: state.gatewayPort,
        registryFile: path.join(state.root, "sandboxes.json"),
      });
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `More than one exact rebuild recovery record exists for sandbox '${input.sandboxName}' and transaction '${input.transactionId}'.`,
    );
  }
  return matches[0] ?? null;
}

/**
 * Re-enter rebuild in a fresh process whose static state paths are bound to
 * the sandbox's owning gateway root. Returns true when the worker owns the
 * operation and the caller must stop its local pipeline.
 */
export async function delegateRebuildToOwningRegistry(
  input: RebuildOwningRegistryInput,
  homeDir: string,
  currentRegistryFile: string,
): Promise<boolean> {
  const hit = rebuildOwningRegistryDependencies.findSandbox(input.sandboxName, homeDir);
  if (!hit || path.resolve(hit.registryFile) === path.resolve(currentRegistryFile)) return false;
  if (hit.registryGatewayPort === undefined) {
    throw new Error("Cannot resolve the gateway registry root that owns the sandbox.");
  }
  if (rebuildOwningRegistryDependencies.isHostFenceHeld(homeDir)) {
    throw new Error(
      `Cannot transfer rebuild for '${input.sandboxName}' while another lifecycle command owns the host fence. Run 'nemoclaw ${input.sandboxName} rebuild' directly.`,
    );
  }
  await rebuildOwningRegistryDependencies.runWorker(
    { operation: "rebuild", ...input },
    hit.registryGatewayPort,
  );
  return true;
}

/** Route exact recovery retirement to the state root that retains its marker. */
export async function delegateRecoveryRetirementToOwningRegistry(
  input: RetireRecoveryOwningRegistryInput,
  homeDir: string,
  currentRegistryFile: string,
): Promise<boolean> {
  const hit = rebuildOwningRegistryDependencies.findRecoveryRoot(input, homeDir);
  if (!hit || path.resolve(hit.registryFile) === path.resolve(currentRegistryFile)) return false;
  if (rebuildOwningRegistryDependencies.isHostFenceHeld(homeDir)) {
    throw new Error(
      `Cannot transfer recovery retirement for '${input.sandboxName}' while another lifecycle command owns the host fence. Run the retirement command directly.`,
    );
  }
  await rebuildOwningRegistryDependencies.runWorker(
    { operation: "retire-recovery", ...input },
    hit.gatewayPort,
  );
  return true;
}
