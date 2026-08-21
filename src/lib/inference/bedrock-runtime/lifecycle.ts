// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureLocalAdapterStateDir } from "../local-adapter-lifecycle";
import {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../../state/mcp-lifecycle-lock-acquisition";
import { getMcpLifecycleLockPath } from "../../state/mcp-lifecycle-lock-storage";

export const BEDROCK_RUNTIME_ADAPTER_STATE_VERSION = 2;
export const BEDROCK_RUNTIME_ADAPTER_UNINSTALL_JOURNAL_VERSION = 1;
export const BEDROCK_RUNTIME_ADAPTER_GENERATION_ENV = "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_GENERATION";

export type BedrockRuntimeAdapterUninstallPhase =
  | "prepared"
  | "term-sent"
  | "kill-sent"
  | "process-absent"
  | "evidence-retiring"
  | "evidence-retired";

export interface BedrockRuntimeAdapterState {
  version: typeof BEDROCK_RUNTIME_ADAPTER_STATE_VERSION;
  generation: string;
  pid: number;
  processStart: string;
  user: string;
  uid: number;
  executablePath: string;
  scriptPath: string;
  adapterPort: number;
  tokenHash: string;
  endpointUrl: string;
  region: string;
  credentialHash: string;
  updatedAt: string;
}

export interface BedrockRuntimeAdapterUninstallJournal {
  version: typeof BEDROCK_RUNTIME_ADAPTER_UNINSTALL_JOURNAL_VERSION;
  phase: BedrockRuntimeAdapterUninstallPhase;
  gatewayPort: number;
  generation: string;
  pid: number;
  processStart: string;
  user: string;
  uid: number;
  executablePath: string;
  scriptPath: string;
  adapterPort: number;
  tokenHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface BedrockRuntimeAdapterLifecyclePaths {
  directory: string;
  journalPath: string;
  lockName: string;
  lockPath: string;
  lockStateDir: string;
}

const GENERATION = /^[a-f0-9]{32}$/u;
const LEGACY_GENERATION = /^legacy:[a-f0-9]{64}$/u;
const PROCESS_START = /^[^\u0000\r\n]{1,512}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const USER = /^[^\s\u0000]{1,256}$/u;
const MAX_PRIVATE_FILE_BYTES = 16 * 1024;

function isSafePort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

function isSafePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.normalize(value) === value
  );
}

export function isBedrockRuntimeAdapterState(value: unknown): value is BedrockRuntimeAdapterState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === BEDROCK_RUNTIME_ADAPTER_STATE_VERSION &&
    typeof state.generation === "string" &&
    GENERATION.test(state.generation) &&
    isSafePid(state.pid) &&
    typeof state.processStart === "string" &&
    PROCESS_START.test(state.processStart) &&
    typeof state.user === "string" &&
    USER.test(state.user) &&
    Number.isSafeInteger(state.uid) &&
    (state.uid as number) >= 0 &&
    isCanonicalAbsolutePath(state.executablePath) &&
    isCanonicalAbsolutePath(state.scriptPath) &&
    isSafePort(state.adapterPort) &&
    typeof state.tokenHash === "string" &&
    SHA256.test(state.tokenHash) &&
    typeof state.endpointUrl === "string" &&
    state.endpointUrl.length > 0 &&
    typeof state.region === "string" &&
    state.region.length > 0 &&
    typeof state.credentialHash === "string" &&
    SHA256.test(state.credentialHash) &&
    typeof state.updatedAt === "string" &&
    !Number.isNaN(Date.parse(state.updatedAt))
  );
}

export function isBedrockRuntimeAdapterUninstallJournal(
  value: unknown,
): value is BedrockRuntimeAdapterUninstallJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  return (
    journal.version === BEDROCK_RUNTIME_ADAPTER_UNINSTALL_JOURNAL_VERSION &&
    [
      "prepared",
      "term-sent",
      "kill-sent",
      "process-absent",
      "evidence-retiring",
      "evidence-retired",
    ].includes(String(journal.phase)) &&
    isSafePort(journal.gatewayPort) &&
    typeof journal.generation === "string" &&
    (GENERATION.test(journal.generation) || LEGACY_GENERATION.test(journal.generation)) &&
    isSafePid(journal.pid) &&
    typeof journal.processStart === "string" &&
    PROCESS_START.test(journal.processStart) &&
    typeof journal.user === "string" &&
    USER.test(journal.user) &&
    Number.isSafeInteger(journal.uid) &&
    (journal.uid as number) >= 0 &&
    isCanonicalAbsolutePath(journal.executablePath) &&
    isCanonicalAbsolutePath(journal.scriptPath) &&
    isSafePort(journal.adapterPort) &&
    typeof journal.tokenHash === "string" &&
    SHA256.test(journal.tokenHash) &&
    typeof journal.createdAt === "string" &&
    !Number.isNaN(Date.parse(journal.createdAt)) &&
    typeof journal.updatedAt === "string" &&
    !Number.isNaN(Date.parse(journal.updatedAt))
  );
}

export function canonicalPid(raw: string): number | null {
  if (!/^[1-9][0-9]{0,15}\n?$/u.test(raw)) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
}

export function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

export function legacyBedrockRuntimeGeneration(
  stateText: string,
  pid: number,
  tokenHash: string,
): string {
  return `legacy:${crypto
    .createHash("sha256")
    .update(stateText)
    .update("\0")
    .update(String(pid))
    .update("\0")
    .update(tokenHash)
    .digest("hex")}`;
}

export function resolveBedrockRuntimeAdapterLifecyclePaths(
  home: string,
  gatewayPort: number,
): BedrockRuntimeAdapterLifecyclePaths {
  if (!isSafePort(gatewayPort)) {
    throw new Error("Bedrock Runtime adapter lifecycle gateway port is invalid.");
  }
  const directory = path.join(
    home,
    ".local",
    "state",
    "nemoclaw-bedrock-runtime-adapter",
    String(gatewayPort),
  );
  const homeIdentity = crypto.createHash("sha256").update(path.resolve(home)).digest("hex");
  const lockRoot = path.join(
    os.tmpdir(),
    `nemoclaw-bedrock-runtime-adapter-locks-${String(process.getuid?.() ?? "unknown")}`,
  );
  const lockName = `bedrock-runtime-adapter-${homeIdentity}-${String(gatewayPort)}`;
  return {
    directory,
    journalPath: path.join(directory, "uninstall.json"),
    lockName,
    lockPath: getMcpLifecycleLockPath(lockName, lockRoot),
    lockStateDir: lockRoot,
  };
}

export function readPrivateBedrockRuntimeFile(target: string): string | null {
  let descriptor: number | null = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor, { bigint: true });
    const linked = fs.lstatSync(target, { bigint: true });
    const uid = process.getuid?.();
    if (
      !before.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      before.dev !== linked.dev ||
      before.ino !== linked.ino ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(MAX_PRIVATE_FILE_BYTES) ||
      (before.mode & 0o077n) !== 0n ||
      (uid !== undefined && before.uid !== BigInt(uid))
    ) {
      return null;
    }
    const buffer = Buffer.alloc(Number(before.size));
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const linkedAfter = fs.lstatSync(target, { bigint: true });
    if (
      bytesRead !== buffer.length ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== linkedAfter.dev ||
      before.ino !== linkedAfter.ino
    ) {
      return null;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function readBedrockRuntimeAdapterUninstallJournal(
  journalPath: string,
): BedrockRuntimeAdapterUninstallJournal | null {
  const raw = readPrivateBedrockRuntimeFile(journalPath);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isBedrockRuntimeAdapterUninstallJournal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function writeDurablePrivateBedrockRuntimeJson(target: string, value: unknown): void {
  const directory = path.dirname(target);
  ensureLocalAdapterStateDir(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.tmp.${String(process.pid)}.${crypto.randomUUID()}`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, target);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file was never created or was already renamed.
    }
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function removeDurableBedrockRuntimeFile(target: string): void {
  try {
    fs.unlinkSync(target);
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function withBedrockRuntimeAdapterLifecycleLock<T>(
  lifecycle: BedrockRuntimeAdapterLifecyclePaths,
  operation: () => T,
): T {
  ensureLocalAdapterStateDir(lifecycle.lockStateDir);
  return withMcpLifecycleLockSync(lifecycle.lockName, operation, {
    stateDir: lifecycle.lockStateDir,
  });
}

export async function withBedrockRuntimeAdapterLifecycleLockAsync<T>(
  lifecycle: BedrockRuntimeAdapterLifecyclePaths,
  operation: () => Promise<T>,
): Promise<T> {
  ensureLocalAdapterStateDir(lifecycle.lockStateDir);
  return withMcpLifecycleLock(lifecycle.lockName, operation, {
    stateDir: lifecycle.lockStateDir,
  });
}
