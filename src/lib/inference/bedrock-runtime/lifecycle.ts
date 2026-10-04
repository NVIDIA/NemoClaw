// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ensureLocalAdapterStateDir } from "../local-adapter-lifecycle";
import {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../../state/mcp-lifecycle-lock-acquisition";
import { getMcpLifecycleLockPath } from "../../state/mcp-lifecycle-lock-storage";
import { readMcpLockProcessIdentity } from "../../state/mcp-lifecycle-lock-identity";

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

export interface BedrockRuntimeAdapterProcessIdentity {
  generation: string;
  pid: number;
  processStart: string;
  user: string;
  uid: number;
  executablePath: string;
  scriptPath: string;
  adapterPort: number;
  tokenHash: string;
}

export interface BedrockRuntimeAdapterProcessRuntime {
  env: NodeJS.ProcessEnv;
  kill: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  readProcessArgv?: (pid: number) => readonly string[] | null;
  readProcessExecutable?: (pid: number) => string | null;
  readProcessEnvironment?: (pid: number) => Record<string, string> | null;
  readProcessIdentity?: (pid: number, fresh?: boolean) => string | null;
  run: (
    command: string,
    args: string[],
    options?: SpawnSyncOptions,
  ) => { status: number | null; stdout: string; stderr: string };
  sleep?: (milliseconds: number) => void;
}

export type BedrockRuntimeAdapterProcessPresence = "absent" | "present" | "unknown";

export interface ObservedBedrockRuntimeAdapterProcess {
  adapterPort: number | null;
  executablePath: string;
  generation: string | null;
  processStart: string;
  scriptPath: string;
  uid: number;
  user: string;
}

export type BedrockRuntimeAdapterProcessStopResult =
  | { ok: true; status: "absent" | "stopped" }
  | { ok: false; reason: "authority-drift" | "unresolved" };

const GENERATION = /^[a-f0-9]{32}$/u;
const LEGACY_GENERATION = /^legacy:[a-f0-9]{64}$/u;
const PROCESS_START = /^[^\u0000\r\n]{1,512}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const USER = /^[^\s\u0000]{1,256}$/u;
const MAX_PRIVATE_FILE_BYTES = 16 * 1024;
const PROCESS_EXIT_TIMEOUT_MS = 1_000;
const PROCESS_EXIT_POLL_MS = 50;
const PROCESS_EXIT_WAIT_BUFFER = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

function sleepForProcessExit(milliseconds: number): void {
  Atomics.wait(PROCESS_EXIT_WAIT_BUFFER, 0, 0, milliseconds);
}

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

export function bedrockRuntimeAdapterProcessPresence(
  pid: number,
  runtime: BedrockRuntimeAdapterProcessRuntime,
): BedrockRuntimeAdapterProcessPresence {
  const result = runtime.run("ps", ["-p", String(pid), "-o", "pid="], { env: runtime.env });
  if (result.status === 1) return "absent";
  if (result.status !== 0 || result.stdout.trim() !== String(pid)) return "unknown";
  return "present";
}

function readProcArgv(pid: number): readonly string[] | null {
  try {
    const argv = fs
      .readFileSync(`/proc/${String(pid)}/cmdline`)
      .toString("utf8")
      .split("\0");
    if (argv.at(-1) === "") argv.pop();
    return argv.length > 0 ? argv : null;
  } catch {
    return null;
  }
}

function readProcessArgv(
  pid: number,
  runtime: BedrockRuntimeAdapterProcessRuntime,
): readonly string[] | null {
  if (runtime.readProcessArgv) return runtime.readProcessArgv(pid);
  const procArgv = readProcArgv(pid);
  if (procArgv) return procArgv;
  const result = runtime.run("ps", ["-ww", "-p", String(pid), "-o", "args="], {
    env: runtime.env,
  });
  const commandLine = result.status === 0 ? result.stdout.trim() : "";
  return commandLine ? commandLine.split(/\s+/u) : null;
}

function isBedrockLauncherPath(target: string): boolean {
  return (
    path.basename(target) === "bedrock-runtime-adapter.mts" ||
    path.basename(target) === "bedrock-runtime-adapter.js"
  );
}

function observedScriptPath(argv: readonly string[], expectedPath?: string): string | null {
  const candidates = argv.filter((argument) => path.isAbsolute(argument));
  if (expectedPath) {
    const expected = canonicalPath(expectedPath);
    return candidates.some((candidate) => canonicalPath(candidate) === expected) ? expected : null;
  }
  const launchers = candidates.filter(isBedrockLauncherPath).map(canonicalPath);
  return launchers.length === 1 ? launchers[0]! : null;
}

function observedExecutablePath(
  pid: number,
  argv: readonly string[],
  runtime: BedrockRuntimeAdapterProcessRuntime,
): string | null {
  const injected = runtime.readProcessExecutable?.(pid);
  if (injected) return canonicalPath(injected);
  try {
    return fs.realpathSync.native(`/proc/${String(pid)}/exe`);
  } catch {
    const first = argv[0];
    return first && path.isAbsolute(first) ? canonicalPath(first) : null;
  }
}

function readProcessEnvironment(
  pid: number,
  runtime: BedrockRuntimeAdapterProcessRuntime,
): Record<string, string> | null | undefined {
  if (runtime.readProcessEnvironment) return runtime.readProcessEnvironment(pid);
  try {
    return Object.fromEntries(
      fs
        .readFileSync(`/proc/${String(pid)}/environ`, "utf8")
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
    );
  } catch {
    const result = runtime.run("ps", ["eww", "-p", String(pid), "-o", "command="], {
      env: runtime.env,
    });
    if (result.status !== 0) return undefined;
    const environment: Record<string, string> = {};
    for (const name of [
      BEDROCK_RUNTIME_ADAPTER_GENERATION_ENV,
      "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT",
    ]) {
      const match = new RegExp(`(?:^|\\s)${name}=([^\\s]+)(?:\\s|$)`, "u").exec(result.stdout);
      if (match?.[1]) environment[name] = match[1];
    }
    return environment;
  }
}

function observedProcessOwner(
  pid: number,
  runtime: BedrockRuntimeAdapterProcessRuntime,
): { uid: number; user: string } | null {
  const uidResult = runtime.run("ps", ["-p", String(pid), "-o", "uid="], { env: runtime.env });
  const userResult = runtime.run("ps", ["-p", String(pid), "-o", "user="], {
    env: runtime.env,
  });
  const uidText = uidResult.status === 0 ? uidResult.stdout.trim() : "";
  const uid = /^[0-9]{1,15}$/u.test(uidText) ? Number(uidText) : Number.NaN;
  const user = userResult.status === 0 ? userResult.stdout.trim() : "";
  return Number.isSafeInteger(uid) && uid >= 0 && user ? { uid, user } : null;
}

export function observeBedrockRuntimeAdapterProcess(
  pid: number,
  runtime: BedrockRuntimeAdapterProcessRuntime,
  expected?: Pick<
    BedrockRuntimeAdapterProcessIdentity,
    "adapterPort" | "executablePath" | "generation" | "processStart" | "scriptPath" | "uid" | "user"
  >,
): ObservedBedrockRuntimeAdapterProcess | null {
  if (bedrockRuntimeAdapterProcessPresence(pid, runtime) !== "present") return null;
  const readIdentity = runtime.readProcessIdentity ?? readMcpLockProcessIdentity;
  const firstIdentity = readIdentity(pid, true);
  const argv = readProcessArgv(pid, runtime);
  const owner = observedProcessOwner(pid, runtime);
  if (!firstIdentity || !argv || !owner) return null;
  const scriptPath = observedScriptPath(argv, expected?.scriptPath);
  const executablePath = observedExecutablePath(pid, argv, runtime);
  const environment = readProcessEnvironment(pid, runtime);
  const generation = environment?.[BEDROCK_RUNTIME_ADAPTER_GENERATION_ENV] ?? null;
  const portText = environment?.NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT;
  const adapterPort = portText && /^[0-9]{1,5}$/u.test(portText) ? Number(portText) : null;
  const secondIdentity = readIdentity(pid, true);
  if (
    !scriptPath ||
    !executablePath ||
    environment === undefined ||
    secondIdentity !== firstIdentity ||
    bedrockRuntimeAdapterProcessPresence(pid, runtime) !== "present"
  ) {
    return null;
  }
  const observed = {
    adapterPort,
    executablePath,
    generation,
    processStart: firstIdentity,
    scriptPath,
    uid: owner.uid,
    user: owner.user,
  };
  if (!expected) return observed;
  return observed.adapterPort === expected.adapterPort &&
    observed.executablePath === canonicalPath(expected.executablePath) &&
    observed.generation === expected.generation &&
    observed.processStart === expected.processStart &&
    observed.scriptPath === canonicalPath(expected.scriptPath) &&
    observed.uid === expected.uid &&
    observed.user === expected.user
    ? observed
    : null;
}

function waitForBedrockRuntimeAdapterExit(
  pid: number,
  runtime: BedrockRuntimeAdapterProcessRuntime,
): boolean | null {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const presence = bedrockRuntimeAdapterProcessPresence(pid, runtime);
    if (presence === "absent") return true;
    if (presence === "unknown") return null;
    (runtime.sleep ?? sleepForProcessExit)(PROCESS_EXIT_POLL_MS);
  }
  const presence = bedrockRuntimeAdapterProcessPresence(pid, runtime);
  return presence === "unknown" ? null : presence === "absent";
}

export function stopExactBedrockRuntimeAdapterProcess(
  expected: BedrockRuntimeAdapterProcessIdentity,
  runtime: BedrockRuntimeAdapterProcessRuntime,
): BedrockRuntimeAdapterProcessStopResult {
  const initialPresence = bedrockRuntimeAdapterProcessPresence(expected.pid, runtime);
  if (initialPresence === "absent") return { ok: true, status: "absent" };
  if (
    initialPresence !== "present" ||
    !observeBedrockRuntimeAdapterProcess(expected.pid, runtime, expected)
  ) {
    return { ok: false, reason: "authority-drift" };
  }
  runtime.kill(expected.pid, "SIGTERM");
  const termExit = waitForBedrockRuntimeAdapterExit(expected.pid, runtime);
  if (termExit) return { ok: true, status: "stopped" };
  if (termExit === null || !observeBedrockRuntimeAdapterProcess(expected.pid, runtime, expected)) {
    return { ok: false, reason: "authority-drift" };
  }
  runtime.kill(expected.pid, "SIGKILL");
  return waitForBedrockRuntimeAdapterExit(expected.pid, runtime)
    ? { ok: true, status: "stopped" }
    : { ok: false, reason: "unresolved" };
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
  const lifecycleRoot = path.join(home, ".local", "state", "nemoclaw-bedrock-runtime-adapter");
  const directory = path.join(lifecycleRoot, String(gatewayPort));
  const homeIdentity = crypto.createHash("sha256").update(path.resolve(home)).digest("hex");
  const lockRoot = path.join(lifecycleRoot, "locks");
  const lockName = `bedrock-runtime-adapter-${homeIdentity}-${String(gatewayPort)}`;
  return {
    directory,
    journalPath: path.join(directory, "uninstall.json"),
    lockName,
    lockPath: getMcpLifecycleLockPath(lockName, lockRoot),
    lockStateDir: lockRoot,
  };
}

function ensureOwnedPrivateBedrockRuntimeDirectory(directory: string): void {
  ensureLocalAdapterStateDir(directory);
  const stat = fs.lstatSync(directory);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `Refusing to use Bedrock Runtime adapter lifecycle directory owned by another user: ${directory}`,
    );
  }
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
  ensureOwnedPrivateBedrockRuntimeDirectory(directory);
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
  operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  ensureOwnedPrivateBedrockRuntimeDirectory(lifecycle.lockStateDir);
  return withMcpLifecycleLockSync(lifecycle.lockName, operation, {
    stateDir: lifecycle.lockStateDir,
  });
}

export async function withBedrockRuntimeAdapterLifecycleLockAsync<T>(
  lifecycle: BedrockRuntimeAdapterLifecyclePaths,
  operation: () => Promise<T>,
): Promise<T> {
  ensureOwnedPrivateBedrockRuntimeDirectory(lifecycle.lockStateDir);
  return withMcpLifecycleLock(lifecycle.lockName, operation, {
    stateDir: lifecycle.lockStateDir,
  });
}
