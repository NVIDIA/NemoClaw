// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

import type { RebuildSandboxOptions } from "../../../domain/lifecycle/options";
import { resolveGatewayName } from "../../../gateway-runtime-action";
import { webSearchEnvFor } from "../../../inference/web-search";
import { snapshotCredentialEnv } from "../../../onboard/credential-env";
import {
  assertGatewayStatePathSafe,
  isValidName,
  listGatewayStateRoots,
} from "../../../state/gateway-registry";
import { isCurrentPortableHostFenceHeld } from "../../../state/portable-uninstall-retirement";
import { buildSubprocessEnv } from "../../../subprocess-env";
import { findSandboxAcrossGatewayRoots } from "../../../state/registry/cross-port";
import { getMessagingPlanFromEntry } from "../../../state/registry-messaging";
import type { SandboxEntry } from "../../../state/registry/types";
import { confirmDelegatedRebuildIntent } from "../rebuild-preflight-confirmation";
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

function assertWorkerPlatformSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error(
      "Delegated owning-registry rebuild work is unsupported on native Windows. Run NemoClaw inside WSL.",
    );
  }
}

type RebuildOwningRegistryDependencies = {
  assertWorkerPlatformSupported: typeof assertWorkerPlatformSupported;
  confirmInteractiveRebuild: typeof confirmDelegatedRebuildIntent;
  findSandbox: typeof findSandboxAcrossGatewayRoots;
  findRecoveryRoot: typeof findRebuildRecoveryStorageRoot;
  isHostFenceHeld: typeof isCurrentPortableHostFenceHeld;
  runWorker(
    input: OwningRegistryWorkerInput,
    gatewayPort: number,
    options?: RebuildWorkerOptions,
  ): Promise<void>;
};

type RebuildWorkerOptions = Readonly<{
  credentialEnvNames?: readonly string[];
  terminationGraceMs?: number;
  timeoutMs?: number;
}>;

const WORKER_PATH = path.join(__dirname, "owning-registry-worker.js");
const MAX_RECOVERY_BACKUP_ENTRIES = 1024;
const MAX_WORKER_RESULT_BYTES = 64 * 1024;
const REBUILD_WORKER_TIMEOUT_MS = 45 * 60_000;
const REBUILD_WORKER_TERMINATION_GRACE_MS = 5_000;
const REBUILD_WORKER_REAP_TIMEOUT_MS = 2_000;
const REBUILD_WORKER_REAP_POLL_MS = 10;
const REBUILD_ENV_NAMES = [
  "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_OPENSHELL_BIN",
  "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
  "NEMOCLAW_OPENSHELL_SANDBOX_BIN",
  "NEMOCLAW_REBUILD_VERBOSE",
  "NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH",
] as const;

function rebuildWorkerEnv(
  gatewayPort: number,
  credentialEnvNames: readonly string[],
): Record<string, string> {
  const extra: Record<string, string> = {
    ...snapshotCredentialEnv(credentialEnvNames),
    NEMOCLAW_GATEWAY_PORT: String(gatewayPort),
  };
  for (const name of REBUILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) extra[name] = value;
  }
  return buildSubprocessEnv(extra);
}

function rebuildCredentialEnvNames(entry: SandboxEntry): readonly string[] {
  const names = new Set<string>();
  if (entry.credentialEnv) names.add(entry.credentialEnv);
  const webSearchProvider =
    entry.webSearchProvider === "brave" || entry.webSearchProvider === "tavily"
      ? entry.webSearchProvider
      : entry.webSearchEnabled === true
        ? "brave"
        : null;
  if (webSearchProvider) names.add(webSearchEnvFor(webSearchProvider));
  for (const binding of getMessagingPlanFromEntry(entry)?.credentialBindings ?? []) {
    names.add(binding.providerEnvKey);
  }
  return [...names].sort();
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

function workerProcessGroupIsRunning(child: ChildProcess, dedicatedProcessGroup: boolean): boolean {
  if (!dedicatedProcessGroup || typeof child.pid !== "number") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalWorkerProcessGroup(
  child: ChildProcess,
  dedicatedProcessGroup: boolean,
  signal: NodeJS.Signals,
): void {
  if (dedicatedProcessGroup && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the leader when the group is already gone or unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The leader already exited.
  }
}

async function waitForWorkerProcessGroupExit(
  child: ChildProcess,
  dedicatedProcessGroup: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (workerProcessGroupIsRunning(child, dedicatedProcessGroup)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, REBUILD_WORKER_REAP_POLL_MS));
  }
  return true;
}

async function settleWorkerPromises(
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  let deadline: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    deadline = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(promises), timeout]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

async function terminateWorkerProcessGroup(
  child: ChildProcess,
  dedicatedProcessGroup: boolean,
  terminationGraceMs: number,
): Promise<boolean> {
  signalWorkerProcessGroup(child, dedicatedProcessGroup, "SIGTERM");
  let workerReaped = await waitForWorkerProcessGroupExit(
    child,
    dedicatedProcessGroup,
    terminationGraceMs,
  );
  if (!workerReaped) {
    signalWorkerProcessGroup(child, dedicatedProcessGroup, "SIGKILL");
    workerReaped = await waitForWorkerProcessGroupExit(
      child,
      dedicatedProcessGroup,
      REBUILD_WORKER_REAP_TIMEOUT_MS,
    );
  }
  return workerReaped;
}

async function runWorker(
  input: OwningRegistryWorkerInput,
  gatewayPort: number,
  options: RebuildWorkerOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? REBUILD_WORKER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Rebuild worker timeout must be a positive integer.");
  }
  const terminationGraceMs = options.terminationGraceMs ?? REBUILD_WORKER_TERMINATION_GRACE_MS;
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs <= 0) {
    throw new Error("Rebuild worker termination grace must be a positive integer.");
  }
  assertWorkerPlatformSupported(process.platform);
  const dedicatedProcessGroup = true;
  let resolveInterrupted:
    | ((outcome: Readonly<{ kind: "interrupted"; signal: NodeJS.Signals }>) => void)
    | undefined;
  const interrupted = new Promise<Readonly<{ kind: "interrupted"; signal: NodeJS.Signals }>>(
    (resolve) => {
      resolveInterrupted = resolve;
    },
  );
  const onSigint = () => resolveInterrupted?.({ kind: "interrupted", signal: "SIGINT" });
  const onSigterm = () => resolveInterrupted?.({ kind: "interrupted", signal: "SIGTERM" });
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    const child = spawn(process.execPath, [WORKER_PATH], {
      detached: dedicatedProcessGroup,
      env: rebuildWorkerEnv(gatewayPort, options.credentialEnvNames ?? []),
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
    const completion = Promise.all([inputWritten, exited, result] as const);
    let deadline: NodeJS.Timeout | undefined;
    const timeout = new Promise<Readonly<{ kind: "timeout" }>>((resolve) => {
      deadline = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });
    let outcome:
      | Readonly<{
          kind: "completed";
          value: Awaited<typeof completion>;
        }>
      | Readonly<{ kind: "timeout" }>
      | Readonly<{ kind: "interrupted"; signal: NodeJS.Signals }>
      | undefined;
    try {
      outcome = await Promise.race([
        completion.then((value) => ({ kind: "completed" as const, value })),
        timeout,
        interrupted,
      ]);
    } catch (error) {
      await terminateWorkerProcessGroup(child, dedicatedProcessGroup, terminationGraceMs);
      await settleWorkerPromises([inputWritten, exited, result], REBUILD_WORKER_REAP_TIMEOUT_MS);
      throw error;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    if (!outcome) throw new Error("Rebuild in the owning gateway registry did not complete.");
    if (outcome.kind !== "completed") {
      const workerReaped = await terminateWorkerProcessGroup(
        child,
        dedicatedProcessGroup,
        terminationGraceMs,
      );
      await settleWorkerPromises([inputWritten, exited, result], REBUILD_WORKER_REAP_TIMEOUT_MS);
      const operation = input.operation === "rebuild" ? "rebuild" : "recovery retirement";
      if (outcome.kind === "interrupted") {
        if (!workerReaped) {
          const workerPid = typeof child.pid === "number" ? String(child.pid) : "unavailable";
          console.error(
            `Delegated ${operation} for sandbox '${input.sandboxName}' was interrupted, but termination is unconfirmed for worker PID ${workerPid}. The operation outcome is unknown; inspect that worker, the sandbox, and retained recovery state before retrying.`,
          );
        }
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        process.kill(process.pid, outcome.signal);
        throw new Error(`Delegated ${operation} was interrupted by ${outcome.signal}.`);
      }
      if (!workerReaped) {
        const workerPid = typeof child.pid === "number" ? String(child.pid) : "unavailable";
        throw new Error(
          `Delegated ${operation} for sandbox '${input.sandboxName}' on owning gateway port ${String(gatewayPort)} exceeded its ${String(timeoutMs)} ms deadline. Termination is unconfirmed for worker PID ${workerPid}, so the worker or one of its descendants may still be active and the operation outcome is unknown. NemoClaw did not remove retained recovery state; inspect that worker, the sandbox, and recovery state before retrying.`,
        );
      }
      throw new Error(
        `Delegated ${operation} for sandbox '${input.sandboxName}' on owning gateway port ${String(gatewayPort)} exceeded its ${String(timeoutMs)} ms deadline. The worker was terminated, but the operation outcome is unknown. NemoClaw did not remove retained recovery state; inspect the sandbox and recovery state before retrying.`,
      );
    }
    const [, exit, workerResult] = outcome.value;
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
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

export const rebuildOwningRegistryDependencies: RebuildOwningRegistryDependencies = {
  assertWorkerPlatformSupported,
  confirmInteractiveRebuild: confirmDelegatedRebuildIntent,
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
  if (!isValidName(input.sandboxName)) {
    throw new Error("Invalid sandbox name.");
  }
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
      const route = readRebuildRecoveryRoute(input, backupPath);
      if (!route) continue;
      if (route.gatewayPort !== state.gatewayPort) {
        throw new Error(
          `Rebuild recovery gateway port ${String(route.gatewayPort)} does not match state root port ${String(state.gatewayPort)}. Recovery remains at '${backupPath}'.`,
        );
      }
      const stateGatewayName = resolveGatewayName(state.gatewayPort);
      if (route.gatewayName !== stateGatewayName) {
        throw new Error(
          `Rebuild recovery gateway name '${route.gatewayName}' does not match state root gateway '${stateGatewayName}'. Recovery remains at '${backupPath}'.`,
        );
      }
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
  let workerInput = input;
  if (!input.options.yes && !input.options.force) {
    const confirmed = await rebuildOwningRegistryDependencies.confirmInteractiveRebuild(
      input.sandboxName,
      input.options.dcodeAutoApprovalMode,
    );
    if (!confirmed) return true;
    workerInput = { ...input, options: { ...input.options, yes: true } };
  }
  await rebuildOwningRegistryDependencies.runWorker(
    { operation: "rebuild", ...workerInput },
    hit.registryGatewayPort,
    { credentialEnvNames: rebuildCredentialEnvNames(hit.entry) },
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
