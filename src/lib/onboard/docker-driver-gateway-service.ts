// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepSeconds, waitUntilAsync } from "../core/wait";
import { isGatewayHealthy } from "../state/gateway";
import {
  captureHostProcessIdentity,
  type HostProcessIdentity,
} from "./compute/host-process-identity";
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

export interface OpenShellGatewayUserServiceOptions {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  home?: string;
  lstatSync?: typeof fs.lstatSync;
  platform?: NodeJS.Platform;
  preparePortForServiceStart?: () => void;
  prepareServiceEnv?: () => void;
  readProcessIdentity?: (pid: number) => OpenShellGatewayProcessIdentity | null;
  readFileSync?: (filePath: string, encoding: BufferEncoding) => string;
  rmSync?: typeof fs.rmSync;
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

export type OpenShellGatewayProcessIdentity = HostProcessIdentity;

export interface PackageManagedDriverGatewayOptions {
  clearDockerDriverGatewayRuntimeFiles: () => void;
  driverLabel?: string;
  exitOnFailure: boolean;
  gatewayName: string;
  hasOpenShellGatewayUserService?: () => boolean;
  healthPollCount?: number;
  healthPollInterval?: number;
  isDockerDriverGatewayReady?: () => Promise<boolean>;
  now?: () => number;
  prepareOpenShellGatewayUserServiceEnv?: () => void;
  preparePortForOpenShellGatewayUserServiceStart?: () => void;
  registerDockerDriverGatewayEndpoint: () => boolean;
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  skipSandboxBridgeReachability: boolean;
  sleepSeconds?: (seconds: number) => void;
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

export type PackageManagedDockerDriverGatewayOptions = PackageManagedDriverGatewayOptions;

interface OpenShellGatewayUserServiceTarget {
  manager: "homebrew" | "systemd";
  serviceName: string;
  statusCommand: string;
  trustedBinaryPaths: string[];
  trustedUnitPaths: string[];
}

const TRUSTED_GATEWAY_SERVICE_IDENTITY = Symbol("trusted-openshell-gateway-service-identity");

interface TrustedOpenShellGatewayUserServiceIdentityBase {
  readonly [TRUSTED_GATEWAY_SERVICE_IDENTITY]: true;
  readonly pid: number;
  readonly processArgv: readonly string[];
  readonly processStartIdentity: string;
  readonly serviceName: string;
}

export interface TrustedHomebrewOpenShellGatewayUserServiceIdentity
  extends TrustedOpenShellGatewayUserServiceIdentityBase {
  readonly formulaName: typeof OPENSHELL_GATEWAY_HOMEBREW_SERVICE;
  readonly formulaTap: typeof OPENSHELL_GATEWAY_HOMEBREW_TAP;
  readonly manager: "homebrew";
  readonly serviceIdentity: string;
}

export interface TrustedSystemdOpenShellGatewayUserServiceIdentity
  extends TrustedOpenShellGatewayUserServiceIdentityBase {
  readonly execStart: string;
  readonly execStartPath: string;
  readonly invocationId: string;
  readonly manager: "systemd";
  readonly unitPath: string;
}

/**
 * Opaque, immutable evidence for one active trusted package-managed gateway.
 *
 * Callers may retain and inspect this receipt, but only this module can mint
 * one. Every lifecycle mutation re-resolves the package-managed authority and
 * proves that its exact unit/formula identity still matches this receipt.
 */
export type TrustedActiveOpenShellGatewayUserServiceIdentity =
  | TrustedHomebrewOpenShellGatewayUserServiceIdentity
  | TrustedSystemdOpenShellGatewayUserServiceIdentity;

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
  return configured && path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.join(home, ".config");
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

function getNemoclawOpenShellGatewayUserServiceBinaryPaths(
  home = os.homedir(),
  env?: NodeJS.ProcessEnv,
): string[] {
  const configured = env?.XDG_BIN_HOME?.trim();
  const userBinHome =
    configured && path.isAbsolute(configured)
      ? path.normalize(configured)
      : path.join(home, ".local", "bin");
  return [
    path.join(userBinHome, "openshell-gateway"),
    ...getOpenShellGatewayUserServiceBinaryPaths(),
  ];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(value: Buffer | string | null | undefined): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf-8") : "";
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  return (
    spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      encoding: "utf-8",
      env,
    }).status === 0
  );
}

function runCommand(
  command: string,
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { ok: boolean; reason?: string; stdout?: string } {
  const result = opts.spawnSyncImpl(command, args, {
    encoding: "utf-8",
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  } satisfies SpawnSyncOptions);
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      reason:
        text(result.stderr).trim() || text(result.stdout).trim() || `exit ${String(result.status)}`,
    };
  }
  return { ok: true, stdout: text(result.stdout) };
}

function runSystemctlUser(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
) {
  return runCommand("systemctl", ["--user", ...args], opts);
}

function runBrew(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
) {
  return runCommand("brew", args, opts);
}

function readTextFileIfPresent(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "readFileSync"> = {},
): string {
  try {
    return (opts.readFileSync ?? fs.readFileSync)(filePath, "utf-8");
  } catch {
    return "";
  }
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

function isNemoclawManagedUnit(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "readFileSync"> = {},
): boolean {
  return readTextFileIfPresent(filePath, opts)
    .split(/\r?\n/)
    .some((line) => line.trimEnd() === NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE);
}

function hasUpstreamOpenShellGatewayUserService(
  opts: Pick<OpenShellGatewayUserServiceOptions, "existsSync" | "platform"> = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  const existsSync = opts.existsSync ?? fs.existsSync;
  return getOpenShellGatewayUserServicePaths().some(existsSync);
}

function hasOfficialHomebrewFormula(
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    "commandExists" | "env" | "platform" | "spawnSyncImpl"
  >,
): boolean {
  if ((opts.platform ?? process.platform) !== "darwin") return false;
  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  if (!commandExists("brew")) return false;
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  if (
    !runBrew(["list", "--formula", OPENSHELL_GATEWAY_HOMEBREW_SERVICE], { env, spawnSyncImpl }).ok
  ) {
    throw new Error("The official OpenShell Homebrew formula is not installed");
  }
  const info = runBrew(["info", "--json=v2", OPENSHELL_GATEWAY_HOMEBREW_SERVICE], {
    env,
    spawnSyncImpl,
  });
  if (!info.ok) throw new Error(`OpenShell Homebrew formula identity check failed: ${info.reason}`);
  try {
    const parsed = JSON.parse(info.stdout ?? "") as {
      formulae?: Array<{ name?: string; tap?: string }>;
    };
    const formula = parsed.formulae?.find(
      (candidate) => candidate.name === OPENSHELL_GATEWAY_HOMEBREW_SERVICE,
    );
    if (formula?.tap !== OPENSHELL_GATEWAY_HOMEBREW_TAP) {
      throw new Error(
        `OpenShell Homebrew formula must come from ${OPENSHELL_GATEWAY_HOMEBREW_TAP}`,
      );
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("OpenShell Homebrew formula identity check returned invalid JSON");
    }
    throw error;
  }
  return true;
}

function resolveOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): OpenShellGatewayUserServiceTarget | null {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    return hasOfficialHomebrewFormula(opts)
      ? {
          manager: "homebrew",
          serviceName: OPENSHELL_GATEWAY_HOMEBREW_SERVICE,
          statusCommand: `brew services info ${OPENSHELL_GATEWAY_HOMEBREW_SERVICE}`,
          trustedBinaryPaths: [],
          trustedUnitPaths: [],
        }
      : null;
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
  if (!(opts.existsSync ?? fs.existsSync)(servicePath)) return null;
  if (isSymbolicLink(servicePath, opts)) {
    throw new Error(`Refusing symlinked NemoClaw gateway user service: ${servicePath}`);
  }
  if (!isNemoclawManagedUnit(servicePath, opts)) {
    throw new Error(`Refusing foreign NemoClaw gateway user service: ${servicePath}`);
  }
  return {
    manager: "systemd",
    serviceName: NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
    statusCommand: `systemctl --user status ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}`,
    trustedBinaryPaths: getNemoclawOpenShellGatewayUserServiceBinaryPaths(home, env),
    trustedUnitPaths: [servicePath],
  };
}

export function hasOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): boolean {
  return resolveOpenShellGatewayUserService(opts) !== null;
}

function userManagerLooksUnavailable(reason: string): boolean {
  return /Failed to connect to bus|No medium found|XDG_RUNTIME_DIR|System has not been booted|Host is down/i.test(
    reason,
  );
}

function parseSystemctlShow(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1).trim()] : null;
      })
      .filter((entry): entry is [string, string] => entry !== null),
  );
}

function extractSystemdExecStartPath(execStart: string): string | null {
  const candidate = /(?:^|[\s;])path=([^\s;]+)/.exec(execStart)?.[1]?.trim();
  return candidate && path.isAbsolute(candidate) ? path.normalize(candidate) : null;
}

function isSystemdInvocationId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value);
}

function validateSystemdServiceIdentity(
  service: OpenShellGatewayUserServiceTarget,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { ok: boolean; reason?: string } {
  const result = runSystemctlUser(
    ["show", service.serviceName, "--property=FragmentPath", "--property=ExecStart"],
    opts,
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  const properties = parseSystemctlShow(result.stdout ?? "");
  return validateSystemdServiceIdentityFromProperties(service, properties);
}

function validateSystemdServiceIdentityFromProperties(
  service: OpenShellGatewayUserServiceTarget,
  properties: Record<string, string>,
): { ok: boolean; reason?: string } {
  const fragmentPath = path.normalize(properties.FragmentPath ?? "");
  const execStartPath = extractSystemdExecStartPath(properties.ExecStart ?? "");
  const trustedUnit = service.trustedUnitPaths.some(
    (candidate) => path.normalize(candidate) === fragmentPath,
  );
  const trustedBinary =
    execStartPath !== null &&
    service.trustedBinaryPaths.some((candidate) => path.normalize(candidate) === execStartPath);
  return trustedUnit && trustedBinary
    ? { ok: true }
    : {
        ok: false,
        reason: `service identity is not a trusted OpenShell gateway (${fragmentPath})`,
      };
}

interface TrustedServiceContext {
  commandExists: (command: string) => boolean;
  env: NodeJS.ProcessEnv;
  readProcessIdentity: (pid: number) => OpenShellGatewayProcessIdentity | null;
  service: OpenShellGatewayUserServiceTarget;
  spawnSyncImpl: SpawnSyncLike;
}

interface SystemdServiceState {
  activeState: string;
  execStart: string;
  execStartPath: string;
  invocationId: string;
  mainPid: number;
  unitPath: string;
}

interface HomebrewServiceState {
  loaded: boolean;
  pid: number | null;
  running: boolean;
  serviceIdentity: string;
}

function freezeProcessIdentity(
  identity: OpenShellGatewayProcessIdentity | null,
): OpenShellGatewayProcessIdentity | null {
  if (identity === null) return null;
  if (
    !Array.isArray(identity.argv) ||
    identity.argv.length === 0 ||
    identity.argv.some((value) => typeof value !== "string") ||
    typeof identity.startIdentity !== "string" ||
    !identity.startIdentity.trim()
  ) {
    throw new Error("OpenShell gateway process identity is incomplete");
  }
  return Object.freeze({
    argv: Object.freeze([...identity.argv]),
    startIdentity: identity.startIdentity,
  });
}

function trustedServiceContext(opts: OpenShellGatewayUserServiceOptions): TrustedServiceContext {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`OpenShell gateway service lifecycle is unsupported on ${platform}`);
  }
  const env = opts.env ?? process.env;
  const home = effectiveHome(opts.home, opts.env);
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const readProcessIdentity =
    opts.readProcessIdentity ??
    ((pid: number) =>
      captureHostProcessIdentity(pid, {
        env,
        platform,
        run: spawnSyncImpl,
      }));
  const service = resolveOpenShellGatewayUserService({ ...opts, env, home });
  if (!service) {
    throw new Error("No trusted package-managed OpenShell gateway service is installed");
  }
  const command = service.manager === "homebrew" ? "brew" : "systemctl";
  if (!commandExists(command)) {
    throw new Error(`${command} is unavailable for the trusted OpenShell gateway service`);
  }
  return { commandExists, env, readProcessIdentity, service, spawnSyncImpl };
}

function queryTrustedSystemdServiceState(context: TrustedServiceContext): SystemdServiceState {
  const result = runSystemctlUser(
    [
      "show",
      context.service.serviceName,
      "--property=FragmentPath",
      "--property=ExecStart",
      "--property=ActiveState",
      "--property=InvocationID",
      "--property=MainPID",
    ],
    context,
  );
  if (!result.ok) {
    throw new Error(
      `Failed to query trusted OpenShell gateway systemd service: ${result.reason ?? "unknown error"}`,
    );
  }
  const properties = parseSystemctlShow(result.stdout ?? "");
  const identity = validateSystemdServiceIdentityFromProperties(context.service, properties);
  if (!identity.ok) {
    throw new Error(identity.reason ?? "OpenShell gateway systemd service identity is invalid");
  }
  const unitPath = path.normalize(properties.FragmentPath ?? "");
  const execStart = (properties.ExecStart ?? "").trim();
  const execStartPath = extractSystemdExecStartPath(execStart);
  const invocationId = (properties.InvocationID ?? "").trim();
  const mainPid = Number(properties.MainPID);
  if (
    !execStart ||
    execStartPath === null ||
    !Number.isSafeInteger(mainPid) ||
    mainPid < 0 ||
    !(properties.ActiveState ?? "").trim()
  ) {
    throw new Error("OpenShell gateway systemd service returned incomplete lifecycle state");
  }
  return {
    activeState: properties.ActiveState,
    execStart,
    execStartPath,
    invocationId,
    mainPid,
    unitPath,
  };
}

function queryTrustedHomebrewServiceState(context: TrustedServiceContext): HomebrewServiceState {
  const result = runBrew(["services", "info", context.service.serviceName, "--json"], context);
  if (!result.ok) {
    throw new Error(
      `Failed to query trusted OpenShell gateway Homebrew service: ${result.reason ?? "unknown error"}`,
    );
  }
  let records: unknown;
  try {
    records = JSON.parse(result.stdout ?? "");
  } catch {
    throw new Error("OpenShell gateway Homebrew service state returned invalid JSON");
  }
  if (!Array.isArray(records)) {
    throw new Error("OpenShell gateway Homebrew service state did not return an array");
  }
  const namedRecords = records.filter(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as Record<string, unknown>).name === context.service.serviceName,
  );
  if (namedRecords.length !== 1) {
    throw new Error("OpenShell gateway Homebrew service identity is missing or ambiguous");
  }
  const record = namedRecords[0];
  const expectedServiceIdentity = `homebrew.mxcl.${context.service.serviceName}`;
  if (
    record.service_name !== expectedServiceIdentity ||
    typeof record.loaded !== "boolean" ||
    typeof record.running !== "boolean"
  ) {
    throw new Error("OpenShell gateway Homebrew service identity is foreign or incomplete");
  }
  const rawPid = record.pid;
  const pid =
    rawPid === null || rawPid === undefined
      ? null
      : typeof rawPid === "number" && Number.isSafeInteger(rawPid) && rawPid >= 0
        ? rawPid
        : Number.NaN;
  if (Number.isNaN(pid)) {
    throw new Error("OpenShell gateway Homebrew service returned an invalid process ID");
  }
  return {
    loaded: record.loaded,
    pid,
    running: record.running,
    serviceIdentity: expectedServiceIdentity,
  };
}

function requireTrustedIdentityReceipt(
  identity: TrustedActiveOpenShellGatewayUserServiceIdentity,
): void {
  if (
    identity === null ||
    typeof identity !== "object" ||
    identity[TRUSTED_GATEWAY_SERVICE_IDENTITY] !== true ||
    !Object.isFrozen(identity)
  ) {
    throw new Error("OpenShell gateway service lifecycle requires a captured trusted identity");
  }
}

function sameArgv(expected: readonly string[], actual: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function sameProcessIdentity(
  expected: Pick<
    TrustedActiveOpenShellGatewayUserServiceIdentity,
    "processArgv" | "processStartIdentity"
  >,
  actual: OpenShellGatewayProcessIdentity | null,
): boolean {
  return (
    actual !== null &&
    actual.startIdentity === expected.processStartIdentity &&
    sameArgv(expected.processArgv, actual.argv)
  );
}

function requireActiveProcessIdentity(
  context: TrustedServiceContext,
  pid: number,
): OpenShellGatewayProcessIdentity {
  const identity = freezeProcessIdentity(context.readProcessIdentity(pid));
  if (!identity) {
    throw new Error("Trusted OpenShell gateway process identity is unavailable or incomplete");
  }
  return identity;
}

function assertCapturedProcessInactive(
  identity: TrustedActiveOpenShellGatewayUserServiceIdentity,
  context: TrustedServiceContext,
): void {
  const current = freezeProcessIdentity(context.readProcessIdentity(identity.pid));
  if (sameProcessIdentity(identity, current)) {
    throw new Error("Trusted OpenShell gateway captured process is still active");
  }
}

function assertMatchingServiceTarget(
  identity: TrustedActiveOpenShellGatewayUserServiceIdentity,
  context: TrustedServiceContext,
): void {
  if (
    context.service.manager !== identity.manager ||
    context.service.serviceName !== identity.serviceName
  ) {
    throw new Error("Trusted OpenShell gateway service authority drifted");
  }
}

function requireMatchingSystemdState(
  identity: TrustedSystemdOpenShellGatewayUserServiceIdentity,
  context: TrustedServiceContext,
): SystemdServiceState {
  const state = queryTrustedSystemdServiceState(context);
  if (
    state.unitPath !== identity.unitPath ||
    state.execStart !== identity.execStart ||
    state.execStartPath !== identity.execStartPath
  ) {
    throw new Error("Trusted OpenShell gateway systemd unit identity drifted");
  }
  return state;
}

function requireMatchingHomebrewState(
  identity: TrustedHomebrewOpenShellGatewayUserServiceIdentity,
  context: TrustedServiceContext,
): HomebrewServiceState {
  if (
    identity.formulaName !== OPENSHELL_GATEWAY_HOMEBREW_SERVICE ||
    identity.formulaTap !== OPENSHELL_GATEWAY_HOMEBREW_TAP
  ) {
    throw new Error("Trusted OpenShell gateway Homebrew formula identity drifted");
  }
  const state = queryTrustedHomebrewServiceState(context);
  if (state.serviceIdentity !== identity.serviceIdentity) {
    throw new Error("Trusted OpenShell gateway Homebrew service identity drifted");
  }
  return state;
}

function trustedActiveIdentity(
  context: TrustedServiceContext,
): TrustedActiveOpenShellGatewayUserServiceIdentity {
  if (context.service.manager === "systemd") {
    const state = queryTrustedSystemdServiceState(context);
    if (
      state.activeState !== "active" ||
      state.mainPid <= 0 ||
      !isSystemdInvocationId(state.invocationId)
    ) {
      throw new Error("Trusted OpenShell gateway systemd service is not active");
    }
    const process = requireActiveProcessIdentity(context, state.mainPid);
    return Object.freeze({
      [TRUSTED_GATEWAY_SERVICE_IDENTITY]: true as const,
      execStart: state.execStart,
      execStartPath: state.execStartPath,
      invocationId: state.invocationId,
      manager: "systemd",
      pid: state.mainPid,
      processArgv: process.argv,
      processStartIdentity: process.startIdentity,
      serviceName: context.service.serviceName,
      unitPath: state.unitPath,
    });
  }
  const state = queryTrustedHomebrewServiceState(context);
  if (state.loaded !== true || state.running !== true || state.pid === null || state.pid <= 0) {
    throw new Error("Trusted OpenShell gateway Homebrew service is not active");
  }
  const process = requireActiveProcessIdentity(context, state.pid);
  return Object.freeze({
    [TRUSTED_GATEWAY_SERVICE_IDENTITY]: true as const,
    formulaName: OPENSHELL_GATEWAY_HOMEBREW_SERVICE,
    formulaTap: OPENSHELL_GATEWAY_HOMEBREW_TAP,
    manager: "homebrew",
    pid: state.pid,
    processArgv: process.argv,
    processStartIdentity: process.startIdentity,
    serviceIdentity: state.serviceIdentity,
    serviceName: context.service.serviceName,
  });
}

/**
 * Capture the exact active package-managed gateway authority and process.
 *
 * This is intentionally strict: unavailable managers, inactive services,
 * foreign units/formulae, malformed state, and ambiguous identities all throw.
 */
export function captureTrustedActiveOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): TrustedActiveOpenShellGatewayUserServiceIdentity {
  return trustedActiveIdentity(trustedServiceContext(opts));
}

/**
 * Distinguish an exactly inactive installed service from the active lifecycle
 * owner. Transitional, malformed, foreign, or unavailable manager state still
 * fails closed; only a fully proven inactive service returns null.
 */
export function captureTrustedOpenShellGatewayUserServiceIfActive(
  opts: OpenShellGatewayUserServiceOptions = {},
): TrustedActiveOpenShellGatewayUserServiceIdentity | null {
  const context = trustedServiceContext(opts);
  if (context.service.manager === "systemd") {
    const state = queryTrustedSystemdServiceState(context);
    if (state.activeState === "inactive" && state.mainPid === 0) return null;
    if (
      state.activeState !== "active" ||
      state.mainPid <= 0 ||
      !isSystemdInvocationId(state.invocationId)
    ) {
      throw new Error("Trusted OpenShell gateway systemd service state is transitional");
    }
  } else {
    const state = queryTrustedHomebrewServiceState(context);
    if (!state.loaded && !state.running && (state.pid === null || state.pid === 0)) return null;
    if (!state.loaded || !state.running || state.pid === null || state.pid <= 0) {
      throw new Error("Trusted OpenShell gateway Homebrew service state is transitional");
    }
  }
  return trustedActiveIdentity(context);
}

function requireInactiveServiceContext(
  identity: TrustedActiveOpenShellGatewayUserServiceIdentity,
  opts: OpenShellGatewayUserServiceOptions,
): TrustedServiceContext {
  requireTrustedIdentityReceipt(identity);
  const context = trustedServiceContext(opts);
  assertMatchingServiceTarget(identity, context);
  if (identity.manager === "systemd") {
    const state = requireMatchingSystemdState(identity, context);
    if (state.activeState !== "inactive" || state.mainPid !== 0) {
      throw new Error("Trusted OpenShell gateway systemd service is not proven inactive");
    }
  } else {
    const state = requireMatchingHomebrewState(identity, context);
    if (state.loaded || state.running || (state.pid !== null && state.pid !== 0)) {
      throw new Error("Trusted OpenShell gateway Homebrew service is not proven inactive");
    }
  }
  assertCapturedProcessInactive(identity, context);
  return context;
}

/**
 * Revalidate that the exact captured service authority remains inactive.
 */
export function assertTrustedOpenShellGatewayUserServiceInactive(
  identity: TrustedActiveOpenShellGatewayUserServiceIdentity,
  opts: OpenShellGatewayUserServiceOptions = {},
): void {
  requireInactiveServiceContext(identity, opts);
}

function requireExactActiveServiceContext(
  identity: TrustedActiveOpenShellGatewayUserServiceIdentity,
  opts: OpenShellGatewayUserServiceOptions,
): TrustedServiceContext {
  requireTrustedIdentityReceipt(identity);
  const context = trustedServiceContext(opts);
  assertMatchingServiceTarget(identity, context);
  if (identity.manager === "systemd") {
    const state = requireMatchingSystemdState(identity, context);
    const process =
      state.mainPid > 0 ? freezeProcessIdentity(context.readProcessIdentity(state.mainPid)) : null;
    if (
      state.activeState !== "active" ||
      state.mainPid !== identity.pid ||
      state.invocationId !== identity.invocationId ||
      !sameProcessIdentity(identity, process)
    ) {
      throw new Error("Trusted OpenShell gateway systemd process identity drifted");
    }
  } else {
    const state = requireMatchingHomebrewState(identity, context);
    const process =
      state.pid !== null && state.pid > 0
        ? freezeProcessIdentity(context.readProcessIdentity(state.pid))
        : null;
    if (
      !state.loaded ||
      !state.running ||
      state.pid === null ||
      state.pid !== identity.pid ||
      !sameProcessIdentity(identity, process)
    ) {
      throw new Error("Trusted OpenShell gateway Homebrew process identity drifted");
    }
  }
  return context;
}

/**
 * Stop only the exact captured manager/service identity, then independently
 * prove that the same trusted authority is inactive and did not respawn.
 */
export function stopTrustedOpenShellGatewayUserServiceAndProveInactive(
  identity: TrustedActiveOpenShellGatewayUserServiceIdentity,
  opts: OpenShellGatewayUserServiceOptions = {},
): void {
  const context = requireExactActiveServiceContext(identity, opts);
  const result =
    identity.manager === "homebrew"
      ? runBrew(["services", "stop", identity.serviceName], context)
      : runSystemctlUser(["stop", identity.serviceName], context);
  if (!result.ok) {
    throw new Error(
      `Failed to stop trusted OpenShell gateway ${identity.manager} service: ${
        result.reason ?? "unknown error"
      }`,
    );
  }
  requireInactiveServiceContext(identity, opts);
}

/**
 * Start the same captured manager/service identity from a proven stopped state,
 * then independently prove the exact unit/formula identity and a new PID.
 */
export function resumeTrustedOpenShellGatewayUserServiceAndProveActive(
  identity: TrustedActiveOpenShellGatewayUserServiceIdentity,
  opts: OpenShellGatewayUserServiceOptions = {},
): TrustedActiveOpenShellGatewayUserServiceIdentity {
  const context = requireInactiveServiceContext(identity, opts);
  const result =
    identity.manager === "homebrew"
      ? runBrew(["services", "start", identity.serviceName], context)
      : runSystemctlUser(["start", identity.serviceName], context);
  if (!result.ok) {
    throw new Error(
      `Failed to resume trusted OpenShell gateway ${identity.manager} service: ${
        result.reason ?? "unknown error"
      }`,
    );
  }
  const resumed = trustedActiveIdentity(trustedServiceContext(opts));
  if (
    resumed.manager !== identity.manager ||
    resumed.serviceName !== identity.serviceName ||
    resumed.pid === identity.pid ||
    (identity.manager === "systemd" &&
      (resumed.manager !== "systemd" ||
        resumed.unitPath !== identity.unitPath ||
        resumed.execStart !== identity.execStart ||
        resumed.execStartPath !== identity.execStartPath ||
        resumed.invocationId === identity.invocationId ||
        !sameArgv(identity.processArgv, resumed.processArgv) ||
        resumed.processStartIdentity === identity.processStartIdentity)) ||
    (identity.manager === "homebrew" &&
      (resumed.manager !== "homebrew" ||
        resumed.formulaName !== identity.formulaName ||
        resumed.formulaTap !== identity.formulaTap ||
        resumed.serviceIdentity !== identity.serviceIdentity ||
        !sameArgv(identity.processArgv, resumed.processArgv) ||
        resumed.processStartIdentity === identity.processStartIdentity))
  ) {
    throw new Error("Resumed OpenShell gateway service identity drifted or reused its prior PID");
  }
  return resumed;
}

export function getTrustedActiveOpenShellGatewayUserServicePid(
  opts: OpenShellGatewayUserServiceOptions = {},
): number | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return null;
  const env = opts.env ?? process.env;
  const home = effectiveHome(opts.home, opts.env);
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  let service: OpenShellGatewayUserServiceTarget | null;
  try {
    service = resolveOpenShellGatewayUserService({ ...opts, env, home });
  } catch {
    return null;
  }
  if (!service) return null;
  if (service.manager === "homebrew") {
    if (!commandExists("brew")) return null;
    const result = runBrew(["services", "info", service.serviceName, "--json"], {
      env,
      spawnSyncImpl,
    });
    if (!result.ok) return null;
    try {
      const records = JSON.parse(result.stdout ?? "") as Array<{
        loaded?: boolean;
        name?: string;
        pid?: number;
        running?: boolean;
        service_name?: string;
      }>;
      const record = records.find(
        (candidate) =>
          candidate.name === service.serviceName &&
          candidate.service_name === `homebrew.mxcl.${service.serviceName}`,
      );
      return record?.running === true &&
        record.loaded === true &&
        Number.isSafeInteger(record.pid) &&
        Number(record.pid) > 0
        ? Number(record.pid)
        : null;
    } catch {
      return null;
    }
  }
  if (!commandExists("systemctl")) return null;
  const result = runSystemctlUser(
    [
      "show",
      service.serviceName,
      "--property=FragmentPath",
      "--property=ExecStart",
      "--property=ActiveState",
      "--property=MainPID",
    ],
    { env, spawnSyncImpl },
  );
  if (!result.ok) return null;
  const properties = parseSystemctlShow(result.stdout ?? "");
  if (
    properties.ActiveState !== "active" ||
    !validateSystemdServiceIdentityFromProperties(service, properties).ok
  ) {
    return null;
  }
  const mainPid = Number(properties.MainPID);
  return Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : null;
}

function removeCompetingNemoclawUnit(
  service: OpenShellGatewayUserServiceTarget,
  opts: Required<
    Pick<OpenShellGatewayUserServiceOptions, "env" | "existsSync" | "home" | "spawnSyncImpl">
  > &
    Pick<OpenShellGatewayUserServiceOptions, "lstatSync" | "readFileSync" | "rmSync">,
): { ok: boolean; reason?: string } {
  if (service.serviceName !== OPENSHELL_GATEWAY_USER_SERVICE) return { ok: true };
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(opts.home, opts.env);
  if (!opts.existsSync(servicePath)) return { ok: true };
  if (isSymbolicLink(servicePath, opts) || !isNemoclawManagedUnit(servicePath, opts)) {
    return { ok: false, reason: `refusing to reconcile foreign unit ${servicePath}` };
  }
  const disabled = runSystemctlUser(
    ["disable", "--now", NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE],
    opts,
  );
  if (!disabled.ok) return { ok: false, reason: disabled.reason };
  try {
    (opts.rmSync ?? fs.rmSync)(servicePath, { force: true });
  } catch (error) {
    return { ok: false, reason: formatError(error) };
  }
  return runSystemctlUser(["daemon-reload"], opts);
}

function serviceFailure(
  service: OpenShellGatewayUserServiceTarget,
  reason: string,
  fallbackAllowed = false,
): OpenShellGatewayUserServiceStartResult {
  return {
    attempted: true,
    fallbackAllowed,
    manager: service.manager,
    reason,
    serviceName: service.serviceName,
    started: false,
    statusCommand: service.statusCommand,
  };
}

function runHook(
  hook: (() => void) | undefined,
  service: OpenShellGatewayUserServiceTarget,
  description: string,
): OpenShellGatewayUserServiceStartResult | null {
  try {
    hook?.();
    return null;
  } catch (error) {
    return serviceFailure(service, `${description}: ${formatError(error)}`);
  }
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
      reason: "unsupported platform",
    };
  }
  const env = opts.env ?? process.env;
  const home = effectiveHome(opts.home, opts.env);
  const existsSync = opts.existsSync ?? fs.existsSync;
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const service = resolveOpenShellGatewayUserService({ ...opts, env, home });
  if (!service) {
    return {
      attempted: false,
      fallbackAllowed: true,
      started: false,
      reason: "service not installed",
    };
  }
  const command = service.manager === "homebrew" ? "brew" : "systemctl";
  if (!commandExists(command)) {
    return serviceFailure(service, `${command} is not available`, true);
  }

  if (service.manager === "systemd") {
    const reloaded = runSystemctlUser(["daemon-reload"], { env, spawnSyncImpl });
    if (!reloaded.ok) {
      return serviceFailure(
        service,
        `systemctl --user daemon-reload failed: ${reloaded.reason}`,
        userManagerLooksUnavailable(reloaded.reason ?? ""),
      );
    }
    const identity = validateSystemdServiceIdentity(service, { env, spawnSyncImpl });
    if (!identity.ok)
      return serviceFailure(service, identity.reason ?? "service identity is invalid");
  }

  const ownershipFailure = runHook(
    opts.validatePortOwnerForServiceStart,
    service,
    "OpenShell gateway port ownership validation failed",
  );
  if (ownershipFailure) return ownershipFailure;

  if (service.manager === "systemd") {
    const reconciled = removeCompetingNemoclawUnit(service, {
      env,
      existsSync,
      home,
      lstatSync: opts.lstatSync,
      readFileSync: opts.readFileSync,
      rmSync: opts.rmSync,
      spawnSyncImpl,
    });
    if (!reconciled.ok) {
      return serviceFailure(
        service,
        `failed to reconcile gateway user services: ${reconciled.reason}`,
      );
    }
  }

  const envFailure = runHook(
    opts.prepareServiceEnv,
    service,
    "failed to prepare OpenShell gateway service environment",
  );
  if (envFailure) return envFailure;

  const stop =
    service.manager === "homebrew"
      ? runBrew(["services", "stop", service.serviceName], { env, spawnSyncImpl })
      : runSystemctlUser(["stop", service.serviceName], { env, spawnSyncImpl });
  if (!stop.ok) {
    const prefix = service.manager === "homebrew" ? "brew services stop" : "systemctl --user stop";
    return serviceFailure(
      service,
      `${prefix} ${service.serviceName} failed: ${stop.reason}`,
      service.manager === "systemd" && userManagerLooksUnavailable(stop.reason ?? ""),
    );
  }

  const portFailure = runHook(
    opts.preparePortForServiceStart,
    service,
    "failed to prepare the OpenShell gateway port",
  );
  if (portFailure) return portFailure;

  const commands =
    service.manager === "homebrew"
      ? [["services", "restart", service.serviceName]]
      : [
          ["enable", service.serviceName],
          ["restart", service.serviceName],
          ["is-active", "--quiet", service.serviceName],
        ];
  for (const args of commands) {
    const result =
      service.manager === "homebrew"
        ? runBrew(args, { env, spawnSyncImpl })
        : runSystemctlUser(args, { env, spawnSyncImpl });
    if (!result.ok) {
      const prefix = service.manager === "homebrew" ? "brew" : "systemctl --user";
      return serviceFailure(
        service,
        `${prefix} ${args.join(" ")} failed: ${result.reason}`,
        service.manager === "systemd" && userManagerLooksUnavailable(result.reason ?? ""),
      );
    }
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

export async function startPackageManagedDriverGateway({
  clearDockerDriverGatewayRuntimeFiles,
  driverLabel = "Docker",
  exitOnFailure,
  gatewayName,
  hasOpenShellGatewayUserService: hasService = hasOpenShellGatewayUserService,
  healthPollCount,
  healthPollInterval,
  isDockerDriverGatewayReady = isDockerDriverGatewayHttpReady,
  now = Date.now,
  prepareOpenShellGatewayUserServiceEnv,
  preparePortForOpenShellGatewayUserServiceStart,
  registerDockerDriverGatewayEndpoint,
  runCaptureOpenshell,
  skipSandboxBridgeReachability,
  sleepSeconds: sleepSecondsImpl = sleepSeconds,
  startOpenShellGatewayUserService: startService = startOpenShellGatewayUserService,
  validatePortOwnerForOpenShellGatewayUserServiceStart,
  verifySandboxBridgeGatewayReachableOrExit,
}: PackageManagedDriverGatewayOptions): Promise<boolean> {
  if (!hasService()) return false;

  console.log(`  Starting OpenShell ${driverLabel}-driver gateway via managed service...`);
  const serviceStart = startService({
    preparePortForServiceStart: preparePortForOpenShellGatewayUserServiceStart,
    prepareServiceEnv: prepareOpenShellGatewayUserServiceEnv,
    validatePortOwnerForServiceStart: validatePortOwnerForOpenShellGatewayUserServiceStart,
  });
  if (!serviceStart.started) {
    const detail = serviceStart.reason ? ` (${serviceStart.reason})` : "";
    if (serviceStart.fallbackAllowed) {
      console.warn(
        `  OpenShell gateway service is unavailable${detail}; using standalone fallback.`,
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
  let lastReadiness = { cliHealthy: false, grpcHealthy: false, registered: false };
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
    clearDockerDriverGatewayRuntimeFiles();
    await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, {
      skip: skipSandboxBridgeReachability,
    });
    console.log("  ✓ OpenShell gateway managed service is healthy");
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
  console.error(`  Check: ${serviceStart.statusCommand}`);
  if (exitOnFailure) process.exit(1);
  throw new Error(message);
}

export function startPackageManagedDockerDriverGateway(
  options: PackageManagedDockerDriverGatewayOptions,
): Promise<boolean> {
  return startPackageManagedDriverGateway({ ...options, driverLabel: "Docker" });
}
