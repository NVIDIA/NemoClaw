// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import pRetry from "p-retry";
import { clean, coerce, gt, lt, valid } from "semver";
import { parse as parseYaml } from "yaml";

import { getCredsFile } from "./credentials";
import { getInstalledOpenshellVersion } from "./openshell";
import { assessHost, type HostAssessment } from "./preflight";
import { resolveOpenshell } from "./resolve-openshell";
import { ROOT } from "./runner";
import { getVersion } from "./version";

const UPDATE_USAGE = "  Usage: nemoclaw update [--check] [--auto]";
const NPM_INSTALL_ARGS = ["install", "-g", "nemoclaw@latest"];

type CaptureCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  ignoreError?: boolean;
};

type CaptureCommandFn = (
  command: string,
  args: readonly string[],
  options?: CaptureCommandOptions,
) => string;

type SpawnDetachedFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

type ExistsSyncFn = (filePath: string) => boolean;
type StatSyncFn = (filePath: string) => { mode: number };
type ChmodSyncFn = (filePath: string, mode: number) => void;
type AccessSyncFn = (filePath: string, mode?: number) => void;
type ReadFileSyncFn = (filePath: string, encoding: BufferEncoding) => string;
type AppendLogFn = (filePath: string, content: string) => void;

export interface ParsedUpdateArgs {
  check: boolean;
  auto: boolean;
  help: boolean;
}

export interface GetLatestNemoClawVersionDeps {
  captureCommandImpl?: CaptureCommandFn;
  npmCommand?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  retries?: number;
  minTimeoutMs?: number;
}

export interface SudoDecisionDeps {
  platform?: NodeJS.Platform;
  getuidImpl?: (() => number) | undefined;
  isPrefixWritableImpl?: (prefix: string) => boolean;
}

export interface OpenshellVersionWarningDeps {
  rootDir?: string;
  resolveOpenshellImpl?: () => string | null;
  getInstalledOpenshellVersionImpl?: (binary: string) => string | null;
  getBlueprintMinOpenshellVersionImpl?: (rootDir?: string) => string | null;
}

export interface CredentialFileSnapshot {
  filePath: string | null;
  exists: boolean;
  mode: number | null;
}

export interface DetachedUpdatePayload {
  npmCommand: string;
  useSudo: boolean;
  installArgs: string[];
  runSandboxSync: boolean;
  sandboxSyncCommand: string;
  credentialsFilePath: string | null;
  credentialsMode: number | null;
  logFilePath: string;
}

export interface DetachedUpdateWorkerDeps {
  spawnSyncImpl?: SpawnSyncFn;
  existsSyncImpl?: ExistsSyncFn;
  statSyncImpl?: StatSyncFn;
  chmodSyncImpl?: ChmodSyncFn;
  appendFileSyncImpl?: AppendLogFn;
}

export interface DetachedUpdateWorkerResult {
  installStatus: number;
  sandboxSyncStatus: number | null;
  warnings: string[];
}

export interface RunUpdateCommandDeps {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  npmCommand?: string;
  getVersionImpl?: () => string;
  getLatestNemoClawVersionImpl?: () => Promise<string>;
  getNpmGlobalPrefixImpl?: () => string | null;
  isPrefixWritableImpl?: (prefix: string) => boolean;
  getuidImpl?: (() => number) | undefined;
  assessHostImpl?: () => HostAssessment;
  getOpenshellVersionWarningImpl?: () => string | null;
  captureCredentialFileSnapshotImpl?: () => CredentialFileSnapshot;
  startDetachedUpdateWorkerImpl?: (payload: DetachedUpdatePayload) => number | null;
  resolveSandboxSyncCommandImpl?: (
    npmGlobalPrefix: string | null,
    platform: NodeJS.Platform,
  ) => string;
  captureCommandImpl?: CaptureCommandFn;
  log?: (message?: string) => void;
  warn?: (message?: string) => void;
}

export interface RunUpdateCommandResult {
  checkOnly: boolean;
  auto: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  npmGlobalPrefix: string | null;
  requiresSudo: boolean;
  openshellWarning: string | null;
  sandboxSyncPlanned: boolean;
  detachedWorkerPid: number | null;
}

function resolveHomeDirectory(env: NodeJS.ProcessEnv): string {
  const candidate = env.HOME ?? env.USERPROFILE;
  if (candidate && candidate.trim()) {
    return candidate;
  }
  return os.homedir();
}

function getDefaultNpmCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function getDefaultGetuid(): (() => number) | undefined {
  if (typeof process.getuid === "function") {
    return process.getuid.bind(process);
  }
  return undefined;
}

function captureCommand(
  command: string,
  args: readonly string[],
  options: CaptureCommandOptions = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    if (options.ignoreError) return "";
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    if (options.ignoreError) return "";
    const stderr = String(result.stderr || "").trim();
    throw new Error(stderr || `Command failed: ${command} ${args.join(" ")}`);
  }

  return String(result.stdout || "").trim();
}

function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

export function normalizeSemver(value: string): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return valid(normalized) ?? clean(normalized) ?? coerce(normalized)?.version ?? null;
}

export function parseUpdateArgs(args: string[]): ParsedUpdateArgs {
  const allowed = new Set(["--check", "--auto", "--help", "-h"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown update option(s): ${unknown.join(", ")}`);
  }

  return {
    check: args.includes("--check"),
    auto: args.includes("--auto"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

export function printUpdateUsage(log: (message?: string) => void = console.log): void {
  log(UPDATE_USAGE);
}

export function isUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  const current = normalizeSemver(currentVersion);
  const latest = normalizeSemver(latestVersion);
  if (!current || !latest) return false;
  return gt(latest, current);
}

export async function getLatestNemoClawVersion(
  deps: GetLatestNemoClawVersionDeps = {},
): Promise<string> {
  const captureCommandImpl = deps.captureCommandImpl ?? captureCommand;
  const npmCommand = deps.npmCommand ?? getDefaultNpmCommand();

  return pRetry(
    async () => {
      const raw = captureCommandImpl(npmCommand, ["view", "nemoclaw", "version"], {
        cwd: deps.cwd,
        env: deps.env,
      });
      const normalized = normalizeSemver(raw);
      if (!normalized) {
        throw new Error(`Invalid npm version response for nemoclaw: '${raw}'`);
      }
      return normalized;
    },
    {
      retries: deps.retries ?? 2,
      minTimeout: deps.minTimeoutMs ?? 500,
      factor: 2,
    },
  );
}

export function getNpmGlobalPrefix(
  deps: {
    captureCommandImpl?: CaptureCommandFn;
    npmCommand?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | null {
  const captureCommandImpl = deps.captureCommandImpl ?? captureCommand;
  const npmCommand = deps.npmCommand ?? getDefaultNpmCommand();
  const prefix = captureCommandImpl(npmCommand, ["config", "get", "prefix"], {
    cwd: deps.cwd,
    env: deps.env,
    ignoreError: true,
  }).trim();
  if (!prefix || prefix === "undefined" || prefix === "null") {
    return null;
  }
  return prefix;
}

function isPrefixWritable(prefix: string, accessSyncImpl: AccessSyncFn = fs.accessSync): boolean {
  try {
    accessSyncImpl(prefix, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function shouldUseSudoForPrefix(
  prefix: string | null,
  deps: SudoDecisionDeps = {},
): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return false;
  if (!prefix) return false;

  const getuidImpl = deps.getuidImpl ?? getDefaultGetuid();
  if (typeof getuidImpl === "function" && getuidImpl() === 0) {
    return false;
  }

  const isPrefixWritableImpl = deps.isPrefixWritableImpl ?? ((value) => isPrefixWritable(value));
  return !isPrefixWritableImpl(prefix);
}

export function resolveSandboxSyncCommand(
  npmGlobalPrefix: string | null,
  platform: NodeJS.Platform = process.platform,
  deps: {
    existsSyncImpl?: ExistsSyncFn;
  } = {},
): string {
  if (!npmGlobalPrefix) {
    return "nemoclaw";
  }

  const existsSyncImpl = deps.existsSyncImpl ?? fs.existsSync;
  const candidates =
    platform === "win32"
      ? [
          path.join(npmGlobalPrefix, "nemoclaw.cmd"),
          path.join(npmGlobalPrefix, "nemoclaw.exe"),
          path.join(npmGlobalPrefix, "nemoclaw"),
        ]
      : [path.join(npmGlobalPrefix, "bin", "nemoclaw"), path.join(npmGlobalPrefix, "nemoclaw")];

  for (const candidate of candidates) {
    if (existsSyncImpl(candidate)) {
      return candidate;
    }
  }

  return "nemoclaw";
}

export function getBlueprintMinOpenshellVersion(
  rootDir = ROOT,
  deps: {
    existsSyncImpl?: ExistsSyncFn;
    readFileSyncImpl?: ReadFileSyncFn;
  } = {},
): string | null {
  const existsSyncImpl = deps.existsSyncImpl ?? fs.existsSync;
  const readFileSyncImpl = deps.readFileSyncImpl ?? fs.readFileSync;

  try {
    const blueprintPath = path.join(rootDir, "nemoclaw-blueprint", "blueprint.yaml");
    if (!existsSyncImpl(blueprintPath)) return null;
    const parsed = parseYaml(readFileSyncImpl(blueprintPath, "utf-8"));
    const value = parsed && parsed.min_openshell_version;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return normalizeSemver(trimmed);
  } catch {
    return null;
  }
}

export function getOpenshellVersionWarning(
  deps: OpenshellVersionWarningDeps = {},
): string | null {
  const getBlueprintMinOpenshellVersionImpl =
    deps.getBlueprintMinOpenshellVersionImpl ?? getBlueprintMinOpenshellVersion;
  const minVersion = getBlueprintMinOpenshellVersionImpl(deps.rootDir);
  if (!minVersion) return null;

  const resolveOpenshellImpl = deps.resolveOpenshellImpl ?? resolveOpenshell;
  const openshellBinary = resolveOpenshellImpl();
  if (!openshellBinary) return null;

  const getInstalledOpenshellVersionImpl =
    deps.getInstalledOpenshellVersionImpl ?? getInstalledOpenshellVersion;
  const installedRaw = getInstalledOpenshellVersionImpl(openshellBinary);
  const installed = normalizeSemver(installedRaw || "");
  if (!installed) return null;

  if (lt(installed, minVersion)) {
    return `openshell ${installed} is below blueprint min_openshell_version ${minVersion}.`;
  }

  return null;
}

function captureCredentialFileSnapshot(
  filePath: string,
  deps: {
    existsSyncImpl?: ExistsSyncFn;
    statSyncImpl?: StatSyncFn;
  } = {},
): CredentialFileSnapshot {
  const existsSyncImpl = deps.existsSyncImpl ?? fs.existsSync;
  const statSyncImpl = deps.statSyncImpl ?? fs.statSync;

  if (!existsSyncImpl(filePath)) {
    return {
      filePath,
      exists: false,
      mode: null,
    };
  }

  const mode = statSyncImpl(filePath).mode & 0o777;
  return {
    filePath,
    exists: true,
    mode,
  };
}

function captureCredentialFileSnapshotSafe(): CredentialFileSnapshot {
  try {
    return captureCredentialFileSnapshot(getCredsFile());
  } catch {
    return {
      filePath: null,
      exists: false,
      mode: null,
    };
  }
}

export function buildInstallInvocation(payload: DetachedUpdatePayload): {
  command: string;
  args: string[];
} {
  if (payload.useSudo) {
    return {
      command: "sudo",
      args: ["-n", payload.npmCommand, ...payload.installArgs],
    };
  }

  return {
    command: payload.npmCommand,
    args: [...payload.installArgs],
  };
}

function runWorkerCommand(
  spawnSyncImpl: SpawnSyncFn,
  command: string,
  args: readonly string[],
): SpawnSyncReturns<string> {
  return spawnSyncImpl(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function appendWorkerLog(
  logFilePath: string,
  message: string,
  appendFileSyncImpl: AppendLogFn = (filePath, content) => {
    fs.appendFileSync(filePath, content);
  },
) {
  try {
    appendFileSyncImpl(logFilePath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Best effort logging only.
  }
}

function trimWorkerOutput(value: string | null | undefined, maxLength = 2000): string {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...(truncated)`;
}

function describeWorkerResult(result: SpawnSyncReturns<string>): string {
  if (typeof result.status === "number") {
    return `exit ${result.status}`;
  }
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  return "unknown exit";
}

function appendWorkerCommandResult(
  logFilePath: string,
  label: string,
  result: SpawnSyncReturns<string>,
  appendFileSyncImpl: AppendLogFn,
) {
  appendWorkerLog(logFilePath, `${label}: ${describeWorkerResult(result)}.`, appendFileSyncImpl);
  const stdout = trimWorkerOutput(result.stdout);
  const stderr = trimWorkerOutput(result.stderr);
  if (stdout) {
    appendWorkerLog(logFilePath, `${label} stdout: ${stdout}`, appendFileSyncImpl);
  }
  if (stderr) {
    appendWorkerLog(logFilePath, `${label} stderr: ${stderr}`, appendFileSyncImpl);
  }
}

function resolveUpdateLogFilePath(
  credentialFilePath: string | null,
  env: NodeJS.ProcessEnv,
): string {
  const baseDir = credentialFilePath
    ? path.dirname(credentialFilePath)
    : path.join(resolveHomeDirectory(env), ".nemoclaw");
  try {
    fs.mkdirSync(baseDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create update log directory '${baseDir}': ${message}`);
  }
  return path.join(baseDir, "update.log");
}

export function runDetachedUpdateWorker(
  payload: DetachedUpdatePayload,
  deps: DetachedUpdateWorkerDeps = {},
): DetachedUpdateWorkerResult {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const existsSyncImpl = deps.existsSyncImpl ?? fs.existsSync;
  const statSyncImpl = deps.statSyncImpl ?? fs.statSync;
  const chmodSyncImpl = deps.chmodSyncImpl ?? fs.chmodSync;
  const appendFileSyncImpl: AppendLogFn =
    deps.appendFileSyncImpl ??
    ((filePath, content) => {
      fs.appendFileSync(filePath, content);
    });
  const warnings: string[] = [];

  const installInvocation = buildInstallInvocation(payload);
  const installResult = runWorkerCommand(
    spawnSyncImpl,
    installInvocation.command,
    installInvocation.args,
  );
  appendWorkerCommandResult(
    payload.logFilePath,
    "Detached npm install",
    installResult,
    appendFileSyncImpl,
  );
  const installStatus = installResult.status ?? 1;

  if (installStatus !== 0) {
    if (payload.useSudo) {
      warnings.push(
        `Detached install failed (${describeWorkerResult(installResult)}) while using sudo. Run update manually with sudo.`,
      );
    } else {
      warnings.push(
        `Detached install failed (${describeWorkerResult(installResult)}). Run update manually.`,
      );
    }
  }

  let sandboxSyncStatus: number | null = null;
  if (installStatus === 0 && payload.runSandboxSync) {
    const sandboxSyncResult = runWorkerCommand(spawnSyncImpl, payload.sandboxSyncCommand, [
      "upgrade-sandboxes",
      "--auto",
    ]);
    appendWorkerCommandResult(payload.logFilePath, "Sandbox sync", sandboxSyncResult, appendFileSyncImpl);
    sandboxSyncStatus = sandboxSyncResult.status ?? 1;
    if (sandboxSyncStatus !== 0) {
      warnings.push(
        `Sandbox synchronization failed (${describeWorkerResult(sandboxSyncResult)}).`,
      );
    }
  }

  if (payload.credentialsFilePath && payload.credentialsMode !== null) {
    if (existsSyncImpl(payload.credentialsFilePath)) {
      const currentMode = statSyncImpl(payload.credentialsFilePath).mode & 0o777;
      if (currentMode !== payload.credentialsMode) {
        try {
          chmodSyncImpl(payload.credentialsFilePath, payload.credentialsMode);
          warnings.push(
            `Credential permissions changed. Restored to ${formatMode(payload.credentialsMode)}.`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(
            `Credential permissions changed. Failed to restore to ${formatMode(payload.credentialsMode)}: ${message}`,
          );
        }
      }
    }
  }

  if (installStatus !== 0) {
    appendWorkerLog(payload.logFilePath, `Update failed with status ${installStatus}.`, appendFileSyncImpl);
  } else {
    appendWorkerLog(payload.logFilePath, "Update completed.", appendFileSyncImpl);
  }

  for (const warning of warnings) {
    appendWorkerLog(payload.logFilePath, `Warning: ${warning}`, appendFileSyncImpl);
  }

  return {
    installStatus,
    sandboxSyncStatus,
    warnings,
  };
}

function decodeDetachedPayload(encodedPayload: string): DetachedUpdatePayload {
  const json = Buffer.from(encodedPayload, "base64").toString("utf-8");
  return JSON.parse(json) as DetachedUpdatePayload;
}

export function runDetachedUpdateWorkerFromPayload(
  encodedPayload: string,
  deps: DetachedUpdateWorkerDeps = {},
): DetachedUpdateWorkerResult {
  return runDetachedUpdateWorker(decodeDetachedPayload(encodedPayload), deps);
}

export function startDetachedUpdateWorker(
  payload: DetachedUpdatePayload,
  deps: {
    spawnImpl?: SpawnDetachedFn;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): number | null {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
  const workerScript = [
    `const worker = require(${JSON.stringify(__filename)});`,
    `const result = worker.runDetachedUpdateWorkerFromPayload(${JSON.stringify(encodedPayload)});`,
    "process.exit(result.installStatus === 0 ? 0 : result.installStatus || 1);",
  ].join(" ");

  let child: ChildProcess;
  try {
    child = spawnImpl(process.execPath, ["-e", workerScript], {
      detached: true,
      stdio: "ignore",
      env: deps.env ?? process.env,
      cwd: deps.cwd ?? ROOT,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendWorkerLog(payload.logFilePath, `Failed to spawn detached worker: ${message}`);
    return null;
  }

  child.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    appendWorkerLog(payload.logFilePath, `Detached worker process error: ${message}`);
  });

  if (child.pid === undefined || child.pid === null) {
    appendWorkerLog(payload.logFilePath, "Detached worker spawn returned no PID.");
    return null;
  }

  child.unref();

  return child.pid;
}


export async function runUpdateCommand(
  args: string[],
  deps: RunUpdateCommandDeps = {},
): Promise<RunUpdateCommandResult> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const rootDir = deps.rootDir ?? ROOT;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const npmCommand = deps.npmCommand ?? getDefaultNpmCommand(platform);
  const captureCommandImpl = deps.captureCommandImpl ?? captureCommand;

  const parsedArgs = parseUpdateArgs(args);
  if (parsedArgs.help) {
    printUpdateUsage(log);
    return {
      checkOnly: parsedArgs.check,
      auto: parsedArgs.auto,
      currentVersion: "",
      latestVersion: "",
      updateAvailable: false,
      npmGlobalPrefix: null,
      requiresSudo: false,
      openshellWarning: null,
      sandboxSyncPlanned: false,
      detachedWorkerPid: null,
    };
  }

  const currentVersion = (deps.getVersionImpl ?? getVersion)();
  const latestVersion = deps.getLatestNemoClawVersionImpl
    ? await deps.getLatestNemoClawVersionImpl()
    : await getLatestNemoClawVersion({
        captureCommandImpl,
        npmCommand,
        cwd: rootDir,
        env,
      });

  const updateAvailable = isUpdateAvailable(currentVersion, latestVersion);
  const npmGlobalPrefix = deps.getNpmGlobalPrefixImpl
    ? deps.getNpmGlobalPrefixImpl()
    : getNpmGlobalPrefix({
        captureCommandImpl,
        npmCommand,
        cwd: rootDir,
        env,
      });

  const requiresSudo = shouldUseSudoForPrefix(npmGlobalPrefix, {
    platform,
    getuidImpl: deps.getuidImpl,
    isPrefixWritableImpl: deps.isPrefixWritableImpl,
  });

  const openshellWarning = deps.getOpenshellVersionWarningImpl
    ? deps.getOpenshellVersionWarningImpl()
    : getOpenshellVersionWarning({
        rootDir,
      });

  let sandboxSyncPlanned = false;
  if (parsedArgs.auto) {
    const hostAssessment = (deps.assessHostImpl ?? assessHost)();
    sandboxSyncPlanned = hostAssessment.dockerReachable;
    if (!sandboxSyncPlanned) {
      warn("  Docker is not reachable. Skipping automatic sandbox synchronization.");
    }
  }

  log(`  Current NemoClaw version: ${currentVersion}`);
  log(`  Latest NemoClaw version:  ${latestVersion}`);
  log(`  Update available:         ${updateAvailable ? "yes" : "no"}`);
  if (npmGlobalPrefix) {
    log(`  npm global prefix:        ${npmGlobalPrefix}`);
  }
  if (requiresSudo) {
    log("  Global npm prefix is not writable; detached update will use sudo.");
  }
  if (openshellWarning) {
    warn(`  Warning: ${openshellWarning}`);
  }

  if (parsedArgs.check) {
    if (parsedArgs.auto) {
      log(
        `  --auto requested: ${sandboxSyncPlanned ? "sandbox sync would run" : "sandbox sync would be skipped"}.`,
      );
    }
    return {
      checkOnly: true,
      auto: parsedArgs.auto,
      currentVersion,
      latestVersion,
      updateAvailable,
      npmGlobalPrefix,
      requiresSudo,
      openshellWarning,
      sandboxSyncPlanned,
      detachedWorkerPid: null,
    };
  }

  if (!updateAvailable) {
    log("  NemoClaw is already up to date.");
    return {
      checkOnly: false,
      auto: parsedArgs.auto,
      currentVersion,
      latestVersion,
      updateAvailable: false,
      npmGlobalPrefix,
      requiresSudo,
      openshellWarning,
      sandboxSyncPlanned: false,
      detachedWorkerPid: null,
    };
  }

  const credentialSnapshot = deps.captureCredentialFileSnapshotImpl
    ? deps.captureCredentialFileSnapshotImpl()
    : captureCredentialFileSnapshotSafe();

  const logFilePath = resolveUpdateLogFilePath(credentialSnapshot.filePath, env);
  const sandboxSyncCommand = (deps.resolveSandboxSyncCommandImpl ?? resolveSandboxSyncCommand)(
    npmGlobalPrefix,
    platform,
  );

  const payload: DetachedUpdatePayload = {
    npmCommand,
    useSudo: requiresSudo,
    installArgs: [...NPM_INSTALL_ARGS],
    runSandboxSync: sandboxSyncPlanned,
    sandboxSyncCommand,
    credentialsFilePath: credentialSnapshot.filePath,
    credentialsMode: credentialSnapshot.mode,
    logFilePath,
  };

  const detachedWorkerPid = (deps.startDetachedUpdateWorkerImpl ?? startDetachedUpdateWorker)(
    payload,
  );

  if (detachedWorkerPid === null) {
    throw new Error(
      `Failed to start detached update worker. Update was not started. Check ${logFilePath}.`,
    );
  }

  log("  Started detached update worker.");
  log(`  Detached worker PID: ${detachedWorkerPid}`);
  log(`  Update progress log: ${logFilePath}`);

  return {
    checkOnly: false,
    auto: parsedArgs.auto,
    currentVersion,
    latestVersion,
    updateAvailable: true,
    npmGlobalPrefix,
    requiresSudo,
    openshellWarning,
    sandboxSyncPlanned,
    detachedWorkerPid,
  };
}
