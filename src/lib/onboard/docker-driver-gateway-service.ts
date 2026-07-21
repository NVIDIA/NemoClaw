// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepSeconds, waitUntil, waitUntilAsync } from "../core/wait";
import { isGatewayHealthy } from "../state/gateway";
import { envInt } from "./env";
import {
  createGatewayHealthWaitOptions,
  formatGatewayHealthWaitLimit,
} from "./gateway-health-wait";
import { isDockerDriverGatewayHttpReady } from "./gateway-http-readiness";

export const OPENSHELL_GATEWAY_USER_SERVICE = "openshell-gateway";
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE = "nemoclaw-openshell-gateway";
export const OPENSHELL_GATEWAY_HOMEBREW_SERVICE = "openshell";
export const OPENSHELL_GATEWAY_HOMEBREW_TAP = "nvidia/openshell";
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER =
  "NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1";
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE = `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`;
const HOMEBREW_SERVICE_STATUS_POLL_ATTEMPTS = 5;
const HOMEBREW_SERVICE_STATUS_POLL_INTERVAL_SECONDS = 0.25;

export interface OpenShellGatewayUserServiceOptions {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  home?: string;
  lstatSync?: typeof fs.lstatSync;
  platform?: NodeJS.Platform;
  preparePortForServiceStart?: () => void;
  prepareServiceEnv?: () => void;
  readFileSync?: (filePath: string, encoding: BufferEncoding) => string;
  rmSync?: typeof fs.rmSync;
  sleepSeconds?: (seconds: number) => void;
  spawnSyncImpl?: SpawnSyncLike;
  validatePortOwnerForServiceStart?: () => void;
}

export interface OpenShellGatewayUserServiceStartResult {
  attempted: boolean;
  fallbackAllowed: boolean;
  manager?: "homebrew" | "systemd";
  reason?: string;
  serviceName?: string;
  statusCommand?: string;
  started: boolean;
}

export interface InstallNemoclawOpenShellGatewayUserServiceOptions
  extends Pick<
    OpenShellGatewayUserServiceOptions,
    "env" | "existsSync" | "home" | "lstatSync" | "platform" | "readFileSync"
  > {
  chmodSync?: (filePath: string, mode: number) => void;
  gatewayBin: string | null;
  mkdirSync?: typeof fs.mkdirSync;
  rmSync?: typeof fs.rmSync;
  writeFileSync?: typeof fs.writeFileSync;
}

export interface InstallNemoclawOpenShellGatewayUserServiceResult {
  installed: boolean;
  path?: string;
  reason?: string;
}

export interface InstallAndReportNemoclawOpenShellGatewayUserServiceOptions
  extends InstallNemoclawOpenShellGatewayUserServiceOptions {
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface SpawnSyncLikeResult {
  error?: Error;
  status: number | null;
  stderr?: Buffer | string | null;
  stdout?: Buffer | string | null;
}

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => SpawnSyncLikeResult;

export interface PackageManagedDockerDriverGatewayOptions {
  clearDockerDriverGatewayRuntimeFiles: () => void;
  exitOnFailure: boolean;
  gatewayName: string;
  getHomebrewServiceRunningState?: () => { ok: boolean; reason?: string };
  hasOpenShellGatewayUserService?: () => boolean;
  healthPollCount?: number;
  healthPollInterval?: number;
  isDockerDriverGatewayReady?: () => Promise<boolean>;
  now?: () => number;
  registerDockerDriverGatewayEndpoint: () => boolean;
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  sleepSeconds?: (seconds: number) => void;
  prepareOpenShellGatewayUserServiceEnv?: () => void;
  preparePortForOpenShellGatewayUserServiceStart?: () => void;
  skipSandboxBridgeReachability: boolean;
  startOpenShellGatewayUserService?: (
    opts?: Pick<
      OpenShellGatewayUserServiceOptions,
      "preparePortForServiceStart" | "prepareServiceEnv" | "validatePortOwnerForServiceStart"
    >,
  ) => OpenShellGatewayUserServiceStartResult;
  validatePortOwnerForOpenShellGatewayUserServiceStart?: () => void;
  verifySandboxBridgeGatewayReachableOrExit: (
    exitOnFailure: boolean,
    options?: { skip?: boolean },
  ) => Promise<void>;
}

interface OpenShellGatewayUserServiceIdentity {
  execStart: string;
  fragmentPath: string;
}

interface OpenShellGatewayUserServiceTarget {
  manager: "homebrew" | "systemd";
  serviceName: string;
  statusCommand: string;
  trustedBinaryPaths: string[];
  trustedUnitPaths: string[];
}

export function getOpenShellGatewayUserServicePaths(): string[] {
  return [
    "/usr/local/lib/systemd/user/openshell-gateway.service",
    "/usr/lib/systemd/user/openshell-gateway.service",
    "/lib/systemd/user/openshell-gateway.service",
  ];
}

export function getOpenShellGatewayUserServiceBinaryPaths(): string[] {
  return ["/usr/local/bin/openshell-gateway", "/usr/bin/openshell-gateway"];
}

function effectiveHome(home: string | undefined, env: NodeJS.ProcessEnv | undefined): string {
  return home ?? env?.HOME ?? os.homedir();
}

export function getOpenShellUserConfigHome(home = os.homedir(), env?: NodeJS.ProcessEnv): string {
  const configured = env?.XDG_CONFIG_HOME?.trim();
  if (configured && path.isAbsolute(configured)) return path.normalize(configured);
  return path.join(home, ".config");
}

export function getNemoclawOpenShellGatewayUserServicePath(
  home = os.homedir(),
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(
    getOpenShellUserConfigHome(home, env),
    "systemd",
    "user",
    `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`,
  );
}

export function getNemoclawOpenShellGatewayUserServiceBinaryPaths(home = os.homedir()): string[] {
  return [
    path.join(home, ".local", "bin", "openshell-gateway"),
    ...getOpenShellGatewayUserServiceBinaryPaths(),
  ];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prepareServicePort(
  opts: Pick<OpenShellGatewayUserServiceOptions, "preparePortForServiceStart">,
  result: Omit<OpenShellGatewayUserServiceStartResult, "reason" | "started">,
): OpenShellGatewayUserServiceStartResult | null {
  try {
    opts.preparePortForServiceStart?.();
    return null;
  } catch (error) {
    return {
      ...result,
      fallbackAllowed: false,
      reason: `failed to prepare the OpenShell gateway port: ${formatError(error)}`,
      started: false,
    };
  }
}

function validateServicePortOwner(
  opts: Pick<OpenShellGatewayUserServiceOptions, "validatePortOwnerForServiceStart">,
  result: Omit<OpenShellGatewayUserServiceStartResult, "reason" | "started">,
): OpenShellGatewayUserServiceStartResult | null {
  try {
    opts.validatePortOwnerForServiceStart?.();
    return null;
  } catch (error) {
    return {
      ...result,
      fallbackAllowed: false,
      reason: `OpenShell gateway port ownership validation failed: ${formatError(error)}`,
      started: false,
    };
  }
}

function readTextFileIfPresent(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "readFileSync"> = {},
): string {
  const readFileSync = opts.readFileSync ?? fs.readFileSync;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function hasNemoclawOpenShellGatewayUserServiceMarker(unit: string): boolean {
  return unit
    .split(/\r?\n/)
    .some((line) => line.trimEnd() === NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE);
}

function isNemoclawManagedOpenShellGatewayUserServiceUnit(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "readFileSync"> = {},
): boolean {
  return hasNemoclawOpenShellGatewayUserServiceMarker(readTextFileIfPresent(filePath, opts));
}

function isSymbolicLink(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "lstatSync"> = {},
): boolean {
  try {
    return (opts.lstatSync ?? fs.lstatSync)(filePath).isSymbolicLink();
  } catch {
    return true;
  }
}

function hasUpstreamOpenShellGatewayUserService(
  opts: Pick<OpenShellGatewayUserServiceOptions, "existsSync" | "platform"> = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  const existsSync = opts.existsSync ?? fs.existsSync;
  return getOpenShellGatewayUserServicePaths().some((candidate) => existsSync(candidate));
}

function hasHomebrewOpenShellGatewayService(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    "commandExists" | "env" | "platform" | "spawnSyncImpl"
  > = {},
): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return false;
  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  if (!commandExists("brew")) return false;
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const result = runBrew(["list", "--formula", OPENSHELL_GATEWAY_HOMEBREW_SERVICE], {
    env,
    spawnSyncImpl,
  });
  if (!result.ok) return false;
  const info = runBrew(["info", "--json=v2", OPENSHELL_GATEWAY_HOMEBREW_SERVICE], {
    env,
    spawnSyncImpl,
  });
  if (!info.ok) {
    throw new Error(`OpenShell Homebrew formula identity check failed: ${info.reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(info.stdout ?? "");
  } catch {
    throw new Error("OpenShell Homebrew formula identity check returned invalid JSON");
  }
  const formula =
    typeof parsed === "object" && parsed !== null && "formulae" in parsed
      ? (parsed as { formulae?: unknown }).formulae
      : undefined;
  const record = Array.isArray(formula)
    ? formula.find(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" &&
          entry !== null &&
          entry.name === OPENSHELL_GATEWAY_HOMEBREW_SERVICE,
      )
    : undefined;
  if (record?.tap !== OPENSHELL_GATEWAY_HOMEBREW_TAP) {
    throw new Error(`OpenShell Homebrew formula must come from ${OPENSHELL_GATEWAY_HOMEBREW_TAP}`);
  }
  return true;
}

export function hasNemoclawOpenShellGatewayUserService(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    "env" | "existsSync" | "home" | "lstatSync" | "platform" | "readFileSync"
  > = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  const env = opts.env ?? process.env;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const home = effectiveHome(opts.home, opts.env);
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
  return (
    existsSync(servicePath) &&
    !isSymbolicLink(servicePath, opts) &&
    isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, {
      readFileSync: opts.readFileSync,
    })
  );
}

function resolveOpenShellGatewayUserService(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    | "commandExists"
    | "env"
    | "existsSync"
    | "home"
    | "lstatSync"
    | "platform"
    | "readFileSync"
    | "spawnSyncImpl"
  > = {},
): OpenShellGatewayUserServiceTarget | null {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    const env = opts.env ?? process.env;
    const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
    if (!commandExists("brew")) return null;
    if (!hasHomebrewOpenShellGatewayService(opts)) {
      throw new Error(
        `OpenShell Homebrew formula is not installed from ${OPENSHELL_GATEWAY_HOMEBREW_TAP}`,
      );
    }
    return {
      manager: "homebrew",
      serviceName: OPENSHELL_GATEWAY_HOMEBREW_SERVICE,
      statusCommand: `brew services info ${OPENSHELL_GATEWAY_HOMEBREW_SERVICE}`,
      trustedBinaryPaths: [],
      trustedUnitPaths: [],
    };
  }
  if (platform !== "linux") return null;
  if (hasUpstreamOpenShellGatewayUserService(opts)) {
    return {
      manager: "systemd",
      serviceName: OPENSHELL_GATEWAY_USER_SERVICE,
      statusCommand: `systemctl --user status ${OPENSHELL_GATEWAY_USER_SERVICE}`,
      trustedBinaryPaths: getOpenShellGatewayUserServiceBinaryPaths(),
      trustedUnitPaths: getOpenShellGatewayUserServicePaths(),
    };
  }
  const env = opts.env ?? process.env;
  const home = effectiveHome(opts.home, opts.env);
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
  const existsSync = opts.existsSync ?? fs.existsSync;
  if (existsSync(servicePath)) {
    if (isSymbolicLink(servicePath, opts)) {
      throw new Error(`Refusing symlinked NemoClaw gateway user service: ${servicePath}`);
    }
    if (!isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, opts)) {
      throw new Error(`Refusing foreign NemoClaw gateway user service: ${servicePath}`);
    }
    return {
      manager: "systemd",
      serviceName: NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
      statusCommand: `systemctl --user status ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}`,
      trustedBinaryPaths: getNemoclawOpenShellGatewayUserServiceBinaryPaths(home),
      trustedUnitPaths: [servicePath],
    };
  }
  return null;
}

export function hasOpenShellGatewayUserService(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    | "commandExists"
    | "env"
    | "existsSync"
    | "home"
    | "lstatSync"
    | "platform"
    | "readFileSync"
    | "spawnSyncImpl"
  > = {},
): boolean {
  return resolveOpenShellGatewayUserService(opts) !== null;
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  return (
    spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      encoding: "utf-8",
      env,
    }).status === 0
  );
}

function text(value: Buffer | string | null | undefined): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function userManagerLooksUnavailable(reason: string): boolean {
  return /Failed to connect to bus|No medium found|XDG_RUNTIME_DIR|System has not been booted|Host is down/i.test(
    reason,
  );
}

function runSystemctlUser(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { ok: boolean; reason?: string; stdout?: string } {
  const result = opts.spawnSyncImpl("systemctl", ["--user", ...args], {
    encoding: "utf-8",
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  } satisfies SpawnSyncOptions);
  if (result.error) {
    return { ok: false, reason: result.error.message };
  }
  if (result.status !== 0) {
    const detail =
      text(result.stderr).trim() || text(result.stdout).trim() || `exit ${String(result.status)}`;
    return { ok: false, reason: detail };
  }
  return { ok: true, stdout: text(result.stdout) };
}

function runBrew(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { ok: boolean; reason?: string; stdout?: string } {
  const result = opts.spawnSyncImpl("brew", args, {
    encoding: "utf-8",
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  } satisfies SpawnSyncOptions);
  if (result.error) {
    return { ok: false, reason: result.error.message };
  }
  if (result.status !== 0) {
    const detail =
      text(result.stderr).trim() || text(result.stdout).trim() || `exit ${String(result.status)}`;
    return { ok: false, reason: detail };
  }
  return { ok: true, stdout: text(result.stdout) };
}

function parseHomebrewServiceRunningState(
  output: string,
  serviceName: string,
): { ok: boolean; reason?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { ok: false, reason: "returned invalid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "returned a non-array response" };
  const service = parsed.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && entry.name === serviceName,
  );
  if (!service) return { ok: false, reason: `did not report service ${serviceName}` };
  if (service.loaded === true && service.running === true) return { ok: true };
  return {
    ok: false,
    reason: `${serviceName} is not running (loaded=${String(service.loaded ?? "<missing>")}, running=${String(service.running ?? "<missing>")}, status=${String(service.status ?? "<missing>")}, exit_code=${String(service.exit_code ?? "<missing>")})`,
  };
}

function readHomebrewServiceRunningState(
  opts: Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl"> & {
    serviceName?: string;
  } = {},
): { ok: boolean; reason?: string } {
  const env = opts.env ?? process.env;
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const serviceName = opts.serviceName ?? OPENSHELL_GATEWAY_HOMEBREW_SERVICE;
  const statusArgs = ["services", "info", "--json", serviceName];
  const status = runBrew(statusArgs, { env, spawnSyncImpl });
  if (!status.ok) {
    return { ok: false, reason: `brew ${statusArgs.join(" ")} failed: ${status.reason}` };
  }
  const running = parseHomebrewServiceRunningState(status.stdout ?? "", serviceName);
  if (!running.ok) {
    return { ok: false, reason: `brew ${statusArgs.join(" ")} ${running.reason}` };
  }
  return { ok: true };
}

function waitForHomebrewServiceRunning(
  opts: Pick<OpenShellGatewayUserServiceOptions, "env" | "sleepSeconds" | "spawnSyncImpl"> & {
    serviceName?: string;
  } = {},
): { ok: boolean; reason?: string } {
  const sleepSecondsImpl = opts.sleepSeconds ?? sleepSeconds;
  let latest: { ok: boolean; reason?: string } = {
    ok: false,
    reason: "Homebrew service status was not checked",
  };
  const running = waitUntil(
    () => {
      latest = readHomebrewServiceRunningState(opts);
      return latest.ok;
    },
    {
      backoffFactor: 1,
      initialIntervalMs: HOMEBREW_SERVICE_STATUS_POLL_INTERVAL_SECONDS * 1000,
      maxAttempts: HOMEBREW_SERVICE_STATUS_POLL_ATTEMPTS,
      maxIntervalMs: HOMEBREW_SERVICE_STATUS_POLL_INTERVAL_SECONDS * 1000,
      sleep: (ms) => sleepSecondsImpl(ms / 1000),
    },
  );
  return running ? { ok: true } : latest;
}

function parseSystemctlShowProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return properties;
}

function isTrustedOpenShellGatewayUserServiceIdentity(
  service: OpenShellGatewayUserServiceTarget,
  identity: OpenShellGatewayUserServiceIdentity,
): boolean {
  const fragmentPath = path.normalize(identity.fragmentPath.trim());
  const trustedUnit = service.trustedUnitPaths.some(
    (candidate) => path.normalize(candidate) === fragmentPath,
  );
  if (!trustedUnit) return false;
  const execStartPath = extractSystemdExecStartPath(identity.execStart);
  if (!execStartPath) return false;
  const normalizedExecStartPath = path.normalize(execStartPath);
  return service.trustedBinaryPaths.some(
    (candidate) => path.normalize(candidate) === normalizedExecStartPath,
  );
}

function extractSystemdExecStartPath(execStart: string): string | null {
  const pathMatch = /(?:^|[\s;])path=([^\s;]+)/.exec(execStart);
  if (!pathMatch) return null;
  const execStartPath = pathMatch[1]?.trim();
  return execStartPath && path.isAbsolute(execStartPath) ? execStartPath : null;
}

function readTrustedOpenShellGatewayUserServiceIdentity(
  service: OpenShellGatewayUserServiceTarget,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { fallbackAllowed: boolean; ok: boolean; reason?: string } {
  const result = runSystemctlUser(
    ["show", service.serviceName, "--property=FragmentPath", "--property=ExecStart"],
    opts,
  );
  if (!result.ok) {
    return {
      fallbackAllowed: userManagerLooksUnavailable(result.reason ?? ""),
      ok: false,
      reason: `systemctl --user show ${service.serviceName} failed: ${result.reason}`,
    };
  }

  const properties = parseSystemctlShowProperties(result.stdout ?? "");
  const identity = {
    execStart: properties.ExecStart ?? "",
    fragmentPath: properties.FragmentPath ?? "",
  };
  if (!identity.fragmentPath || !identity.execStart) {
    return {
      fallbackAllowed: false,
      ok: false,
      reason: "service identity is incomplete",
    };
  }
  if (!isTrustedOpenShellGatewayUserServiceIdentity(service, identity)) {
    return {
      fallbackAllowed: false,
      ok: false,
      reason: `service identity is not a trusted OpenShell gateway (${identity.fragmentPath})`,
    };
  }
  return { fallbackAllowed: false, ok: true };
}

function removeCompetingNemoclawGatewayUserService(
  service: OpenShellGatewayUserServiceTarget,
  opts: Required<
    Pick<OpenShellGatewayUserServiceOptions, "env" | "existsSync" | "home" | "spawnSyncImpl">
  > &
    Pick<OpenShellGatewayUserServiceOptions, "lstatSync" | "readFileSync" | "rmSync">,
): { ok: boolean; reason?: string } {
  if (service.manager !== "systemd" || service.serviceName !== OPENSHELL_GATEWAY_USER_SERVICE) {
    return { ok: true };
  }
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(opts.home, opts.env);
  if (!opts.existsSync(servicePath)) return { ok: true };
  if (isSymbolicLink(servicePath, opts)) {
    return { ok: false, reason: `refusing to reconcile symlinked unit ${servicePath}` };
  }
  if (
    !isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, {
      readFileSync: opts.readFileSync,
    })
  ) {
    return { ok: false, reason: `refusing to reconcile foreign unit ${servicePath}` };
  }

  const disabled = runSystemctlUser(
    ["disable", "--now", NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE],
    opts,
  );
  if (!disabled.ok) {
    return {
      ok: false,
      reason: `systemctl --user disable --now ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE} failed: ${disabled.reason}`,
    };
  }
  try {
    (opts.rmSync ?? fs.rmSync)(servicePath, { force: true });
  } catch (error) {
    return { ok: false, reason: `failed to remove ${servicePath}: ${formatError(error)}` };
  }
  const reloaded = runSystemctlUser(["daemon-reload"], opts);
  if (!reloaded.ok) {
    return { ok: false, reason: `systemctl --user daemon-reload failed: ${reloaded.reason}` };
  }
  return { ok: true };
}

function assertSafeSystemdExecPath(filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error("OpenShell gateway service ExecStart must be an absolute path");
  }
  if (/[\0\r\n\t ]/.test(filePath)) {
    throw new Error("OpenShell gateway service ExecStart path cannot contain whitespace");
  }
}

function isTrustedNemoclawGatewayServiceBinaryPath(filePath: string, home: string): boolean {
  const normalizedPath = path.normalize(filePath);
  return getNemoclawOpenShellGatewayUserServiceBinaryPaths(home).some(
    (candidate) => path.normalize(candidate) === normalizedPath,
  );
}

export function buildNemoclawOpenShellGatewayUserService(gatewayBin: string): string {
  assertSafeSystemdExecPath(gatewayBin);
  return [
    "# NemoClaw-managed OpenShell gateway user service",
    NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
    "[Unit]",
    "Description=OpenShell Gateway",
    "Documentation=https://github.com/NVIDIA/OpenShell",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    "StateDirectory=openshell/gateway",
    "Environment=OPENSHELL_LOCAL_TLS_DIR=%h/.local/state/openshell/tls",
    "EnvironmentFile=-%E/openshell/gateway.env",
    `ExecStartPre=${gatewayBin} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal --server-san localhost --server-san 127.0.0.1`,
    `ExecStart=${gatewayBin}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "PrivateTmp=true",
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function installNemoclawOpenShellGatewayUserService(
  opts: InstallNemoclawOpenShellGatewayUserServiceOptions,
): InstallNemoclawOpenShellGatewayUserServiceResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return { installed: false, reason: "not a Linux host" };
  const home = effectiveHome(opts.home, opts.env);
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, opts.env);
  const existsSync = opts.existsSync ?? fs.existsSync;
  if (hasUpstreamOpenShellGatewayUserService(opts)) {
    if (existsSync(servicePath)) {
      if (isSymbolicLink(servicePath, opts)) {
        return {
          installed: false,
          path: servicePath,
          reason: "refusing to reconcile a symlinked NemoClaw gateway user service",
        };
      }
      if (
        !isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, {
          readFileSync: opts.readFileSync,
        })
      ) {
        return {
          installed: false,
          path: servicePath,
          reason: "refusing to reconcile a foreign NemoClaw gateway user service",
        };
      }
    }
    return { installed: false, reason: "upstream OpenShell gateway service is installed" };
  }
  if (!opts.gatewayBin) return { installed: false, reason: "OpenShell gateway binary not found" };

  const alreadyExists = existsSync(servicePath);
  if (alreadyExists && isSymbolicLink(servicePath, opts)) {
    return {
      installed: false,
      path: servicePath,
      reason: "refusing to overwrite a symlinked gateway user service",
    };
  }
  if (
    alreadyExists &&
    !isNemoclawManagedOpenShellGatewayUserServiceUnit(servicePath, {
      readFileSync: opts.readFileSync,
    })
  ) {
    return {
      installed: false,
      path: servicePath,
      reason: "refusing to overwrite a non-NemoClaw gateway user service",
    };
  }

  let unit: string;
  try {
    unit = buildNemoclawOpenShellGatewayUserService(opts.gatewayBin);
  } catch (error) {
    return {
      installed: false,
      path: servicePath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isTrustedNemoclawGatewayServiceBinaryPath(opts.gatewayBin, home)) {
    return {
      installed: false,
      path: servicePath,
      reason: "OpenShell gateway service ExecStart path is not in a trusted install path",
    };
  }

  const serviceDir = path.dirname(servicePath);
  const mkdirSync = opts.mkdirSync ?? fs.mkdirSync;
  const chmodSync = opts.chmodSync ?? fs.chmodSync;
  const writeFileSync = opts.writeFileSync ?? fs.writeFileSync;
  try {
    mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
    chmodSync(serviceDir, 0o700);
    writeFileSync(servicePath, unit, { encoding: "utf-8", mode: 0o600 });
    chmodSync(servicePath, 0o600);
  } catch (error) {
    return {
      installed: false,
      path: servicePath,
      reason: `failed to write OpenShell gateway user service: ${formatError(error)}`,
    };
  }
  return { installed: true, path: servicePath };
}

function isBenignGatewayUserServiceInstallSkip(reason: string | undefined): boolean {
  return (
    reason === "not a Linux host" || reason === "upstream OpenShell gateway service is installed"
  );
}

export function installAndReportNemoclawOpenShellGatewayUserService(
  opts: InstallAndReportNemoclawOpenShellGatewayUserServiceOptions,
): InstallNemoclawOpenShellGatewayUserServiceResult {
  const result = installNemoclawOpenShellGatewayUserService(opts);
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;
  if (result.installed && result.path) {
    log(`  Installed OpenShell gateway user service: ${result.path}`);
  } else if (result.reason && !isBenignGatewayUserServiceInstallSkip(result.reason)) {
    warn(`  OpenShell gateway user service not installed: ${result.reason}.`);
  }
  return result;
}

export function startOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): OpenShellGatewayUserServiceStartResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    return {
      attempted: false,
      fallbackAllowed: true,
      started: false,
      reason: "unsupported service platform",
    };
  }
  const env = opts.env ?? process.env;
  const home = effectiveHome(opts.home, opts.env);
  const existsSync = opts.existsSync ?? fs.existsSync;
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const service = resolveOpenShellGatewayUserService({
    commandExists,
    env,
    existsSync,
    home,
    lstatSync: opts.lstatSync,
    platform,
    readFileSync: opts.readFileSync,
    spawnSyncImpl,
  });
  if (!service) {
    return {
      attempted: false,
      fallbackAllowed: true,
      started: false,
      reason: "service unit not installed",
    };
  }

  if (service.manager === "homebrew") {
    if (!commandExists("brew")) {
      return {
        attempted: true,
        fallbackAllowed: true,
        manager: service.manager,
        reason: "brew is not available",
        serviceName: service.serviceName,
        started: false,
        statusCommand: service.statusCommand,
      };
    }

    const ownershipFailure = validateServicePortOwner(opts, {
      attempted: true,
      fallbackAllowed: false,
      manager: service.manager,
      serviceName: service.serviceName,
      statusCommand: service.statusCommand,
    });
    if (ownershipFailure) return ownershipFailure;

    try {
      opts.prepareServiceEnv?.();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        attempted: true,
        fallbackAllowed: false,
        manager: service.manager,
        reason: `failed to prepare OpenShell gateway service environment: ${detail}`,
        serviceName: service.serviceName,
        started: false,
        statusCommand: service.statusCommand,
      };
    }

    const stopped = runBrew(["services", "stop", service.serviceName], { env, spawnSyncImpl });
    if (!stopped.ok) {
      return {
        attempted: true,
        fallbackAllowed: false,
        manager: service.manager,
        reason: `brew services stop ${service.serviceName} failed: ${stopped.reason}`,
        serviceName: service.serviceName,
        started: false,
        statusCommand: service.statusCommand,
      };
    }

    const portFailure = prepareServicePort(opts, {
      attempted: true,
      fallbackAllowed: false,
      manager: service.manager,
      serviceName: service.serviceName,
      statusCommand: service.statusCommand,
    });
    if (portFailure) return portFailure;

    const result = runBrew(["services", "restart", service.serviceName], { env, spawnSyncImpl });
    if (!result.ok) {
      return {
        attempted: true,
        fallbackAllowed: false,
        manager: service.manager,
        reason: `brew services restart ${service.serviceName} failed: ${result.reason}`,
        serviceName: service.serviceName,
        started: false,
        statusCommand: service.statusCommand,
      };
    }

    const running = waitForHomebrewServiceRunning({
      env,
      serviceName: service.serviceName,
      sleepSeconds: opts.sleepSeconds,
      spawnSyncImpl,
    });
    if (!running.ok) {
      return {
        attempted: true,
        fallbackAllowed: false,
        manager: service.manager,
        reason: running.reason,
        serviceName: service.serviceName,
        started: false,
        statusCommand: service.statusCommand,
      };
    }

    return {
      attempted: true,
      fallbackAllowed: false,
      manager: service.manager,
      serviceName: service.serviceName,
      started: true,
      statusCommand: service.statusCommand,
    };
  }

  if (!commandExists("systemctl")) {
    return {
      attempted: true,
      fallbackAllowed: true,
      manager: service.manager,
      started: false,
      reason: "systemctl is not available",
      serviceName: service.serviceName,
      statusCommand: service.statusCommand,
    };
  }

  for (const args of [["daemon-reload"]]) {
    const result = runSystemctlUser(args, { env, spawnSyncImpl });
    if (!result.ok) {
      const reason = `systemctl --user ${args.join(" ")} failed: ${result.reason}`;
      return {
        attempted: true,
        fallbackAllowed: userManagerLooksUnavailable(result.reason ?? ""),
        manager: service.manager,
        reason,
        serviceName: service.serviceName,
        started: false,
        statusCommand: service.statusCommand,
      };
    }
  }

  const identity = readTrustedOpenShellGatewayUserServiceIdentity(service, { env, spawnSyncImpl });
  if (!identity.ok) {
    return {
      attempted: true,
      fallbackAllowed: identity.fallbackAllowed,
      manager: service.manager,
      reason: identity.reason,
      serviceName: service.serviceName,
      started: false,
      statusCommand: service.statusCommand,
    };
  }

  const ownershipFailure = validateServicePortOwner(opts, {
    attempted: true,
    fallbackAllowed: false,
    manager: service.manager,
    serviceName: service.serviceName,
    statusCommand: service.statusCommand,
  });
  if (ownershipFailure) return ownershipFailure;

  const competingService = removeCompetingNemoclawGatewayUserService(service, {
    env,
    existsSync,
    home,
    lstatSync: opts.lstatSync,
    readFileSync: opts.readFileSync,
    rmSync: opts.rmSync,
    spawnSyncImpl,
  });
  if (!competingService.ok) {
    return {
      attempted: true,
      fallbackAllowed: false,
      manager: service.manager,
      reason: competingService.reason,
      serviceName: service.serviceName,
      started: false,
      statusCommand: service.statusCommand,
    };
  }

  try {
    opts.prepareServiceEnv?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      fallbackAllowed: false,
      manager: service.manager,
      reason: `failed to prepare OpenShell gateway service environment: ${detail}`,
      serviceName: service.serviceName,
      started: false,
      statusCommand: service.statusCommand,
    };
  }

  const stopped = runSystemctlUser(["stop", service.serviceName], { env, spawnSyncImpl });
  if (!stopped.ok) {
    return {
      attempted: true,
      fallbackAllowed: false,
      manager: service.manager,
      reason: `systemctl --user stop ${service.serviceName} failed: ${stopped.reason}`,
      serviceName: service.serviceName,
      started: false,
      statusCommand: service.statusCommand,
    };
  }

  const portFailure = prepareServicePort(opts, {
    attempted: true,
    fallbackAllowed: false,
    manager: service.manager,
    serviceName: service.serviceName,
    statusCommand: service.statusCommand,
  });
  if (portFailure) return portFailure;

  for (const args of [
    ["enable", service.serviceName],
    ["restart", service.serviceName],
  ]) {
    const result = runSystemctlUser(args, { env, spawnSyncImpl });
    if (!result.ok) {
      const reason = `systemctl --user ${args.join(" ")} failed: ${result.reason}`;
      return {
        attempted: true,
        fallbackAllowed: false,
        manager: service.manager,
        reason,
        serviceName: service.serviceName,
        started: false,
        statusCommand: service.statusCommand,
      };
    }
  }

  const active = runSystemctlUser(["is-active", "--quiet", service.serviceName], {
    env,
    spawnSyncImpl,
  });
  if (!active.ok) {
    const reason = `systemctl --user is-active --quiet ${service.serviceName} failed: ${active.reason}`;
    return {
      attempted: true,
      fallbackAllowed: false,
      manager: service.manager,
      reason,
      serviceName: service.serviceName,
      started: false,
      statusCommand: service.statusCommand,
    };
  }

  return {
    attempted: true,
    fallbackAllowed: false,
    manager: service.manager,
    serviceName: service.serviceName,
    started: true,
    statusCommand: service.statusCommand,
  };
}

export async function startPackageManagedDockerDriverGateway({
  clearDockerDriverGatewayRuntimeFiles,
  exitOnFailure,
  gatewayName,
  getHomebrewServiceRunningState:
    getHomebrewServiceRunningStateImpl = readHomebrewServiceRunningState,
  hasOpenShellGatewayUserService:
    hasOpenShellGatewayUserServiceImpl = hasOpenShellGatewayUserService,
  healthPollCount,
  healthPollInterval,
  isDockerDriverGatewayReady = isDockerDriverGatewayHttpReady,
  now = Date.now,
  registerDockerDriverGatewayEndpoint,
  runCaptureOpenshell,
  sleepSeconds: sleepSecondsImpl = sleepSeconds,
  prepareOpenShellGatewayUserServiceEnv,
  preparePortForOpenShellGatewayUserServiceStart,
  skipSandboxBridgeReachability,
  startOpenShellGatewayUserService:
    startOpenShellGatewayUserServiceImpl = startOpenShellGatewayUserService,
  validatePortOwnerForOpenShellGatewayUserServiceStart,
  verifySandboxBridgeGatewayReachableOrExit,
}: PackageManagedDockerDriverGatewayOptions): Promise<boolean> {
  if (!hasOpenShellGatewayUserServiceImpl()) return false;

  console.log("  Starting OpenShell Docker-driver gateway via package-managed service...");
  const serviceStart = startOpenShellGatewayUserServiceImpl({
    preparePortForServiceStart: preparePortForOpenShellGatewayUserServiceStart,
    prepareServiceEnv: prepareOpenShellGatewayUserServiceEnv,
    validatePortOwnerForServiceStart: validatePortOwnerForOpenShellGatewayUserServiceStart,
  });
  if (!serviceStart.started) {
    const detail = serviceStart.reason ? ` (${serviceStart.reason})` : "";
    if (serviceStart.fallbackAllowed) {
      console.warn(
        `  OpenShell gateway package-managed service is unavailable${detail}; using standalone fallback.`,
      );
      return false;
    }
    const message = `OpenShell gateway service failed to start${detail}.`;
    console.error(`  ${message}`);
    console.error(
      `  Check: ${
        serviceStart.statusCommand ??
        `systemctl --user status ${serviceStart.serviceName ?? OPENSHELL_GATEWAY_USER_SERVICE}`
      }`,
    );
    if (exitOnFailure) process.exit(1);
    throw new Error(message);
  }

  const pollCount = healthPollCount ?? envInt("NEMOCLAW_HEALTH_POLL_COUNT", 30);
  const pollInterval = healthPollInterval ?? envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  const waitOptions = createGatewayHealthWaitOptions(pollCount, pollInterval, now, (ms) =>
    sleepSecondsImpl(ms / 1000),
  );
  let lastReadiness = {
    cliHealthy: false,
    grpcHealthy: false,
    registered: false,
  };
  const healthy =
    waitOptions !== null &&
    (await waitUntilAsync(async () => {
      const registered = registerDockerDriverGatewayEndpoint();
      if (!registered) {
        lastReadiness = { cliHealthy: false, grpcHealthy: false, registered };
        return false;
      }
      const status = runCaptureOpenshell(["status"], { ignoreError: true });
      const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
        ignoreError: true,
      });
      const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
      const cliHealthy = isGatewayHealthy(status, namedInfo, currentInfo);
      const grpcHealthy = await isDockerDriverGatewayReady();
      lastReadiness = { cliHealthy, grpcHealthy, registered };
      return cliHealthy && grpcHealthy;
    }, waitOptions));
  if (healthy) {
    if (serviceStart.manager === "homebrew") {
      const running = getHomebrewServiceRunningStateImpl();
      if (!running.ok) {
        const detail = running.reason ? ` (${running.reason})` : "";
        const message = `OpenShell gateway service stopped after startup${detail}.`;
        console.error(`  ${message}`);
        console.error(`  Check: ${serviceStart.statusCommand}`);
        if (exitOnFailure) process.exit(1);
        throw new Error(message);
      }
    }
    clearDockerDriverGatewayRuntimeFiles();
    await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, {
      skip: skipSandboxBridgeReachability,
    });
    console.log("  ✓ OpenShell gateway package-managed service is healthy");
    return true;
  }

  const message = `OpenShell gateway service started but did not become healthy within the configured ${formatGatewayHealthWaitLimit(
    pollCount,
    pollInterval,
  )}.`;
  console.error(`  ${message}`);
  console.error(
    `  Last readiness check: endpoint registered=${lastReadiness.registered ? "yes" : "no"}, OpenShell CLI health=${lastReadiness.cliHealthy ? "yes" : "no"}, direct gRPC health=${lastReadiness.grpcHealthy ? "yes" : "no"}.`,
  );
  console.error(
    `  Check: ${
      serviceStart.statusCommand ??
      `systemctl --user status ${serviceStart.serviceName ?? OPENSHELL_GATEWAY_USER_SERVICE}`
    }`,
  );
  if (exitOnFailure) process.exit(1);
  throw new Error(message);
}
