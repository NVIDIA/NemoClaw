// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepSeconds, waitUntilAsync } from "../core/wait";
import { isGatewayHealthy } from "../state/gateway";
import { envInt } from "./env";
import {
  createGatewayHealthWaitOptions,
  formatGatewayHealthWaitLimit,
} from "./gateway-health-wait";
import { isDockerDriverGatewayHttpReady } from "./gateway-http-readiness";
import {
  getBlueprintMaxOpenshellVersion,
  getBlueprintMinOpenshellVersion,
  shouldAllowOpenshellAboveBlueprintMax,
  versionGte,
} from "./openshell-version";

export const OPENSHELL_GATEWAY_USER_SERVICE = "openshell-gateway";
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE = "nemoclaw-openshell-gateway";
export const OPENSHELL_GATEWAY_HOMEBREW_SERVICE = "openshell";
export const OPENSHELL_GATEWAY_HOMEBREW_TAP = "nvidia/openshell";
export const OPENSHELL_GATEWAY_HOMEBREW_FORMULA_SHA256 =
  "f0f86519e227b3b326431410058ba690b1a7b83e5af7384014e4b96283d3a642";
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER =
  "NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1";
export const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE = `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`;

/** Shared blocking wait used while observing native gateway readiness. */
export const waitForOpenShellGatewayRetry = sleepSeconds;

export interface OpenShellGatewayUserServiceOptions {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  /** Test seam for the checksum-verified, temporary formula trust boundary. */
  homebrewFormulaOperation?: (args: string[]) => SpawnSyncLikeResult;
  /** Test seam: read the version output of the package-managed gateway binary. */
  getUpstreamGatewayVersion?: (binaryPath: string) => string | null;
  /** Test seam: the blueprint version window the gateway binary must satisfy. */
  getUpstreamGatewayVersionBounds?: () => UpstreamGatewayVersionBounds;
  home?: string;
  lstatSync?: typeof fs.lstatSync;
  readdirSync?: typeof fs.readdirSync;
  platform?: NodeJS.Platform;
  /** Sink for the one-shot notice emitted when a package unit version is rejected. */
  warn?: (message: string) => void;
  /** Keep observation-only callers from emitting or consuming the version-error warning latch. */
  suppressUnsupportedVersionWarning?: boolean;
  preparePortForServiceStart?: () => void;
  prepareServiceEnv?: () => void;
  readFileSync?: (filePath: string, encoding: BufferEncoding) => string;
  rmSync?: typeof fs.rmSync;
  spawnSyncImpl?: SpawnSyncLike;
  validatePortOwnerForServiceStart?: () => void;
}

export interface OpenShellGatewayUserServiceStartResult {
  attempted: boolean;
  logCommand?: string;
  manager?: "homebrew" | "systemd";
  reason?: string;
  serviceName?: string;
  standaloneFallbackBlocked?: boolean;
  statusCommand?: string;
  started: boolean;
}

export interface OpenShellGatewayUserServiceStopResult {
  attempted: boolean;
  standaloneFallbackAllowed: boolean;
  manager?: "homebrew" | "systemd";
  reason?: string;
  serviceName?: string;
  standaloneFallbackBlocked?: boolean;
  statusCommand?: string;
  stopped: boolean;
}

export class OpenShellGatewayServiceEnvironmentError extends Error {
  constructor(error: unknown) {
    super(formatError(error), { cause: error });
    this.name = "OpenShellGatewayServiceEnvironmentError";
  }
}

export class OpenShellGatewayServiceTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenShellGatewayServiceTrustError";
  }
}

export interface SpawnSyncLikeResult {
  error?: Error;
  status: number | null;
  stderr?: Buffer | string | null;
  stdout?: Buffer | string | null;
}

interface CommandResult {
  diagnostic?: string;
  ok: boolean;
  rawStderr: string;
  rawStdout: string;
  reason?: string;
  spawnError?: Error;
  status: number | null;
  stdout?: string;
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
  hasOpenShellGatewayUserService?: () => boolean;
  healthPollCount?: number;
  healthPollInterval?: number;
  isDockerDriverGatewayReady?: () => Promise<boolean>;
  managedServiceLogCommand?: string;
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
  stopOpenShellGatewayUserService?: () => OpenShellGatewayUserServiceStopResult;
  validatePortOwnerForOpenShellGatewayUserServiceStart?: () => void;
  verifySandboxBridgeGatewayReachableOrExit: (
    exitOnFailure: boolean,
    options?: { skip?: boolean },
  ) => Promise<void>;
}

interface OpenShellGatewayUserServiceTarget {
  logCommand: string;
  manager: "homebrew" | "systemd";
  serviceName: string;
  statusCommand: string;
  trustedBinaryPaths: string[];
  trustedUnitPaths: string[];
}

function getSystemdGatewayLogCommand(serviceName: string): string {
  return `journalctl --user --unit ${serviceName} --no-pager --lines=200`;
}

function getHomebrewGatewayLogCommand(): string {
  return 'tail -n 200 "$(brew --prefix)/var/log/openshell/openshell-gateway.out.log" "$(brew --prefix)/var/log/openshell/openshell-gateway.err.log"';
}

export function getOpenShellGatewayManagedServiceLogCommand(
  opts: Pick<OpenShellGatewayUserServiceOptions, "existsSync" | "platform"> = {},
): string | undefined {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") return getHomebrewGatewayLogCommand();
  if (platform !== "linux") return undefined;
  return getSystemdGatewayLogCommand(
    hasUpstreamOpenShellGatewayUserService(opts)
      ? OPENSHELL_GATEWAY_USER_SERVICE
      : NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  );
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

/**
 * SOURCE_OF_TRUTH_REVIEW
 * invalidState: a package-managed OpenShell gateway unit runs a gateway binary
 *   outside the blueprint version window NemoClaw just enforced on the CLI. The
 *   package unit hard-codes an absolute `ExecStart` under `/usr/bin`, so
 *   reinstalling a supported CLI into the user-local bin directory does not
 *   change which gateway actually starts — NemoClaw ends up driving a gateway
 *   it has already classified as unsupported (#8094).
 * sourceBoundary: the OpenShell package owns its unit and binaries; NemoClaw
 *   cannot rewrite either. What NemoClaw does own is the choice of whether to
 *   adopt that unit, so the version window is enforced at adoption time.
 * whyNotSourceFix: editing or masking a distro-owned unit would fight the
 *   package manager and break on the next package upgrade. NemoClaw stops so
 *   another lifecycle cannot compete with the package unit for port 8080.
 * regressionTest: docker-driver-gateway-service-version-gate.test.ts
 * removalCondition: remove once the upstream unit resolves its gateway binary
 *   through PATH (or a NemoClaw-supplied override) so a supported user-local
 *   build is honoured without replacing the unit.
 */
export type UpstreamGatewayVersionBounds = { min: string | null; max: string | null };

export type UpstreamGatewayVersionVerdict =
  | { supported: true }
  | { supported: false; binaryPath: string; version: string | null; message: string };

function defaultUpstreamGatewayVersionBounds(): UpstreamGatewayVersionBounds {
  return { min: getBlueprintMinOpenshellVersion(), max: getBlueprintMaxOpenshellVersion() };
}

function readUpstreamGatewayVersion(
  binaryPath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">,
): string | null {
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  try {
    const result = spawnSyncImpl(binaryPath, ["-V"], {
      encoding: "utf-8",
      env: opts.env ?? process.env,
      timeout: 10_000,
    });
    if (result.status !== 0) return null;
    const output = text(result.stdout).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** Decide whether the package-managed gateway binary may be adopted. */
export function checkUpstreamGatewayVersion(
  binaryPath: string | null,
  opts: Pick<
    OpenShellGatewayUserServiceOptions,
    | "env"
    | "getUpstreamGatewayVersion"
    | "getUpstreamGatewayVersionBounds"
    | "platform"
    | "spawnSyncImpl"
  > = {},
): UpstreamGatewayVersionVerdict {
  if (!binaryPath) {
    return {
      supported: false,
      binaryPath: "<unresolved>",
      version: null,
      message:
        "  NemoClaw could not resolve the effective package-managed OpenShell gateway executable. " +
        "Restore the OpenShell package, then retry.",
    };
  }
  const readVersion =
    opts.getUpstreamGatewayVersion ?? ((p: string) => readUpstreamGatewayVersion(p, opts));
  const versionOutput = readVersion(binaryPath);
  const version = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(versionOutput ?? "")?.[1];
  if (!version) {
    return {
      supported: false,
      binaryPath,
      version: null,
      message:
        `  NemoClaw could not determine the package-managed OpenShell gateway version at ${binaryPath}. ` +
        "Restore the OpenShell package, then retry.",
    };
  }
  const bounds = (opts.getUpstreamGatewayVersionBounds ?? defaultUpstreamGatewayVersionBounds)();
  const belowMin = Boolean(bounds.min) && !versionGte(version, bounds.min as string);
  const aboveMax =
    Boolean(bounds.max) &&
    !versionGte(bounds.max as string, version) &&
    !shouldAllowOpenshellAboveBlueprintMax(
      versionOutput,
      opts.platform ?? process.platform,
      opts.env ?? process.env,
    );
  if (!belowMin && !aboveMax) return { supported: true };
  const bound = belowMin ? `minimum ${bounds.min}` : `maximum ${bounds.max}`;
  return {
    supported: false,
    binaryPath,
    version,
    message:
      `  Refusing the system OpenShell gateway service: ${binaryPath} is ${version}, ` +
      `outside the ${bound} supported by this NemoClaw release.\n` +
      "  Install a supported OpenShell package or remove the existing package before retrying NemoClaw.",
  };
}

let warnedUnsupportedUpstreamGateway = false;

function warnUnsupportedUpstreamGateway(
  verdict: Extract<UpstreamGatewayVersionVerdict, { supported: false }>,
  opts: Pick<OpenShellGatewayUserServiceOptions, "warn">,
): void {
  if (warnedUnsupportedUpstreamGateway) return;
  warnedUnsupportedUpstreamGateway = true;
  (opts.warn ?? ((message: string) => console.error(message)))(verdict.message);
}

/** Test seam: forget the warn-once latch between cases. */
export function resetUpstreamGatewayVersionWarning(): void {
  warnedUnsupportedUpstreamGateway = false;
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
): CommandResult {
  try {
    return commandResult(
      opts.spawnSyncImpl(command, args, {
        encoding: "utf-8",
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
      } satisfies SpawnSyncOptions),
      command,
    );
  } catch (error) {
    const spawnError = error instanceof Error ? error : new Error(formatError(error));
    return {
      ok: false,
      rawStderr: "",
      rawStdout: "",
      reason: `${command} invocation error: ${spawnError.message}`,
      spawnError,
      status: null,
    };
  }
}

function commandResult(result: SpawnSyncLikeResult, command = "command"): CommandResult {
  const rawStderr = text(result.stderr);
  const rawStdout = text(result.stdout);
  const rawResult = { rawStderr, rawStdout, status: result.status };
  if (result.error) {
    return {
      ...rawResult,
      ok: false,
      reason: `${command} execution error: ${result.error.message}`,
      spawnError: result.error,
    };
  }
  if (result.status === null) {
    return {
      ...rawResult,
      ok: false,
      reason: `${command} ended without an exit status${rawStderr.trim() || rawStdout.trim() ? `: ${[rawStderr.trim(), rawStdout.trim()].filter(Boolean).join("\n")}` : ""}`,
    };
  }
  if (result.status !== 0) {
    const diagnostics = [rawStderr.trim(), rawStdout.trim()].filter(Boolean);
    const diagnostic = diagnostics.join("\n") || `exit ${String(result.status)}`;
    return {
      ...rawResult,
      ok: false,
      diagnostic,
      reason: diagnostic,
    };
  }
  return { ...rawResult, ok: true, stdout: rawStdout };
}

function runSystemctlUser(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
) {
  return runCommand("systemctl", ["--user", ...args], {
    ...opts,
    env: { ...opts.env, LC_ALL: "C" },
  });
}

const OPENSHELL_HOMEBREW_FORMULA_ABSENT = 65;
const OPENSHELL_HOMEBREW_FORMULA_REPAIR = 66;
const OPENSHELL_HOMEBREW_TRUST_FAILED = 67;
const OPENSHELL_HOMEBREW_UNTRUST_FAILED = 68;
const OPENSHELL_HOMEBREW_OPERATION_FAILED = 69;

function homebrewFormulaOperationScript(): string {
  return path.resolve(__dirname, "../../../scripts/install-openshell.sh");
}

function runTrustedHomebrewFormulaOperation(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">> &
    Pick<OpenShellGatewayUserServiceOptions, "homebrewFormulaOperation">,
): CommandResult {
  if (opts.homebrewFormulaOperation) {
    return commandResult(opts.homebrewFormulaOperation(args));
  }
  return runCommand(
    "bash",
    [
      homebrewFormulaOperationScript(),
      "--homebrew-formula-operation",
      OPENSHELL_GATEWAY_HOMEBREW_FORMULA_SHA256,
      "--",
      "brew",
      ...args,
    ],
    opts,
  );
}

const HOMEBREW_FORMULA_REPAIR_GUIDANCE =
  "OpenShell's Homebrew formula is installed but cannot satisfy NemoClaw's pinned checksum and temporary trust contract. " +
  "Run curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash, then rerun onboarding.";

function throwHomebrewFormulaOperationFailure(operation: string, result: CommandResult): never {
  if (result.status === OPENSHELL_HOMEBREW_FORMULA_REPAIR) {
    throw new OpenShellGatewayServiceTrustError(HOMEBREW_FORMULA_REPAIR_GUIDANCE);
  }
  if (result.status === OPENSHELL_HOMEBREW_TRUST_FAILED) {
    throw new OpenShellGatewayServiceTrustError(
      `Homebrew could not grant temporary trust for the checksum-verified OpenShell formula during ${operation}. ` +
        "No service operation was performed.",
    );
  }
  if (result.status === OPENSHELL_HOMEBREW_UNTRUST_FAILED) {
    throw new OpenShellGatewayServiceTrustError(
      `Homebrew could not remove temporary trust for the OpenShell formula after ${operation}. ` +
        "Stop and repair Homebrew trust before continuing.",
    );
  }
  throw new OpenShellGatewayServiceTrustError(
    `OpenShell Homebrew ${operation} failed inside the checksum-verified temporary trust boundary.`,
  );
}

function runStopService(
  service: OpenShellGatewayUserServiceTarget,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">> &
    Pick<OpenShellGatewayUserServiceOptions, "homebrewFormulaOperation">,
) {
  return service.manager === "homebrew"
    ? runTrustedHomebrewFormulaOperation(["services", "stop", service.serviceName], opts)
    : runSystemctlUser(["stop", service.serviceName], opts);
}

function stopServiceCommandName(service: OpenShellGatewayUserServiceTarget): string {
  return service.manager === "homebrew" ? "brew" : "systemctl";
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
    "commandExists" | "env" | "homebrewFormulaOperation" | "platform" | "spawnSyncImpl"
  >,
): boolean {
  if ((opts.platform ?? process.platform) !== "darwin") return false;
  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  if (!commandExists("brew")) return false;
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const operationOptions = {
    env,
    homebrewFormulaOperation: opts.homebrewFormulaOperation,
    spawnSyncImpl,
  };
  const listed = runTrustedHomebrewFormulaOperation(
    ["list", "--formula", OPENSHELL_GATEWAY_HOMEBREW_SERVICE],
    operationOptions,
  );
  if (!listed.ok) {
    if (listed.status === OPENSHELL_HOMEBREW_FORMULA_ABSENT) return false;
    if (listed.status === OPENSHELL_HOMEBREW_OPERATION_FAILED) {
      throw new OpenShellGatewayServiceTrustError(HOMEBREW_FORMULA_REPAIR_GUIDANCE);
    }
    throwHomebrewFormulaOperationFailure("installation inspection", listed);
  }
  const info = runTrustedHomebrewFormulaOperation(
    ["info", "--json=v2", OPENSHELL_GATEWAY_HOMEBREW_SERVICE],
    operationOptions,
  );
  if (!info.ok) {
    throwHomebrewFormulaOperationFailure("formula identity inspection", info);
  }
  try {
    const parsed = JSON.parse(info.stdout ?? "") as {
      formulae?: Array<{ name?: string; tap?: string }>;
    };
    const formula = parsed.formulae?.find(
      (candidate) => candidate.name === OPENSHELL_GATEWAY_HOMEBREW_SERVICE,
    );
    if (formula?.tap !== OPENSHELL_GATEWAY_HOMEBREW_TAP) {
      throw new OpenShellGatewayServiceTrustError(
        `OpenShell Homebrew formula must come from ${OPENSHELL_GATEWAY_HOMEBREW_TAP}`,
      );
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new OpenShellGatewayServiceTrustError(
        "OpenShell Homebrew formula identity check returned invalid JSON",
      );
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
          logCommand: getHomebrewGatewayLogCommand(),
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
    // The package unit hard-codes an absolute ExecStart, so a supported
    // user-local build cannot override it. A version or identity failure must
    // block fallback because an enabled package service can later claim 8080.
    const upstreamService: OpenShellGatewayUserServiceTarget = {
      logCommand: getSystemdGatewayLogCommand(OPENSHELL_GATEWAY_USER_SERVICE),
      manager: "systemd",
      serviceName: OPENSHELL_GATEWAY_USER_SERVICE,
      statusCommand: `systemctl --user status ${OPENSHELL_GATEWAY_USER_SERVICE}`,
      trustedBinaryPaths: getOpenShellGatewayUserServiceBinaryPaths(),
      trustedUnitPaths: getOpenShellGatewayUserServicePaths(),
    };
    const env = opts.env ?? process.env;
    const identity = validateSystemdServiceIdentity(upstreamService, {
      env,
      spawnSyncImpl: opts.spawnSyncImpl ?? spawnSync,
    });
    if (!identity.ok) {
      if (!identity.trustFailure && userManagerLooksUnavailable(identity.reason ?? "")) {
        return upstreamService;
      }
      throw new OpenShellGatewayServiceTrustError(
        `Could not verify the effective OpenShell gateway user service: ${identity.reason ?? "systemctl query failed"}`,
      );
    }
    if (identity.ok) {
      const verdict = checkUpstreamGatewayVersion(identity.execStartPath, opts);
      if (verdict.supported) {
        return upstreamService;
      }
      if (!opts.suppressUnsupportedVersionWarning) {
        warnUnsupportedUpstreamGateway(verdict, opts);
      }
      throw new OpenShellGatewayServiceTrustError(verdict.message.trim());
    }
  }

  const env = opts.env ?? process.env;
  const home = effectiveHome(opts.home, opts.env);
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
  if (!(opts.existsSync ?? fs.existsSync)(servicePath)) return null;
  if (isSymbolicLink(servicePath, opts)) {
    throw new OpenShellGatewayServiceTrustError(
      `Refusing symlinked NemoClaw gateway user service: ${servicePath}`,
    );
  }
  if (!isNemoclawManagedUnit(servicePath, opts)) {
    throw new OpenShellGatewayServiceTrustError(
      `Refusing foreign NemoClaw gateway user service: ${servicePath}`,
    );
  }
  return {
    logCommand: getSystemdGatewayLogCommand(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE),
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

/**
 * Stop command for whichever service manager owns the gateway on this host, or
 * null when no managed service owns it and NemoClaw runs the gateway standalone.
 *
 * The resolver picks the upstream package unit, the NemoClaw unit, or the
 * Homebrew formula, so a caller that prints a stop command must ask for the
 * resolved name instead of deriving one from the platform (#8797).
 */
export function getOpenShellGatewayServiceStopCommand(
  opts: OpenShellGatewayUserServiceOptions = {},
): string | null {
  const service = resolveOpenShellGatewayUserService(opts);
  if (!service) return null;
  const prefix = service.manager === "homebrew" ? "brew services stop" : "systemctl --user stop";
  return `${prefix} ${service.serviceName}`;
}

function userManagerLooksUnavailable(reason: string): boolean {
  const diagnostics = reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    diagnostics.length > 0 &&
    diagnostics.every(
      (diagnostic) =>
        diagnostic === "Failed to connect to bus: No medium found" ||
        diagnostic === "Failed to connect to bus: Host is down" ||
        diagnostic === "Failed to connect to bus: No such file or directory" ||
        diagnostic ===
          "System has not been booted with systemd as init system (PID 1). Can't operate." ||
        diagnostic === "XDG_RUNTIME_DIR is not set in the environment." ||
        diagnostic ===
          "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)",
    )
  );
}

function findSystemdUserServiceActivationPath(
  service: OpenShellGatewayUserServiceTarget,
  home: string,
  env: NodeJS.ProcessEnv,
  existsSync: (filePath: string) => boolean,
  lstatSync: typeof fs.lstatSync,
  readdirSync: typeof fs.readdirSync,
): string | null {
  if (service.manager !== "systemd") return null;
  if (env.SYSTEMD_UNIT_PATH?.trim()) {
    throw new OpenShellGatewayServiceTrustError(
      "SYSTEMD_UNIT_PATH overrides the systemd user unit search path, so NemoClaw cannot prove that no gateway service can activate.",
    );
  }
  const configDirectories = (env.XDG_CONFIG_DIRS?.trim() || "/etc/xdg").split(":").filter(Boolean);
  const dataHome = env.XDG_DATA_HOME?.trim();
  const effectiveDataHome =
    dataHome && path.isAbsolute(dataHome)
      ? path.normalize(dataHome)
      : path.join(home, ".local", "share");
  const configuredDataDirectories = (env.XDG_DATA_DIRS?.trim() || "/usr/local/share:/usr/share")
    .split(":")
    .filter(Boolean);
  if (
    configDirectories.some((directory) => !path.isAbsolute(directory)) ||
    configuredDataDirectories.some((directory) => !path.isAbsolute(directory))
  ) {
    throw new OpenShellGatewayServiceTrustError(
      "XDG_CONFIG_DIRS or XDG_DATA_DIRS contains a relative path, so NemoClaw cannot inspect user service activation paths.",
    );
  }
  const roots = [
    path.join(getOpenShellUserConfigHome(home, env), "systemd", "user"),
    path.join(getOpenShellUserConfigHome(home, env), "systemd", "user.control"),
    path.join(effectiveDataHome, "systemd", "user"),
    "/etc/systemd/user",
    "/run/systemd/user",
    "/usr/local/lib/systemd/user",
    "/usr/lib/systemd/user",
    "/lib/systemd/user",
    ...configDirectories.map((directory) =>
      path.join(path.normalize(directory), "systemd", "user"),
    ),
    ...configuredDataDirectories.map((directory) =>
      path.join(path.normalize(directory), "systemd", "user"),
    ),
  ];
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  const effectiveRuntimeDir =
    runtimeDir && path.isAbsolute(runtimeDir)
      ? path.normalize(runtimeDir)
      : typeof process.getuid === "function"
        ? path.join("/run/user", String(process.getuid()))
        : null;
  if (effectiveRuntimeDir) {
    roots.push(
      path.join(effectiveRuntimeDir, "systemd", "user.control"),
      path.join(effectiveRuntimeDir, "systemd", "transient"),
      path.join(effectiveRuntimeDir, "systemd", "generator.early"),
      path.join(effectiveRuntimeDir, "systemd", "user"),
      path.join(effectiveRuntimeDir, "systemd", "generator"),
      path.join(effectiveRuntimeDir, "systemd", "generator.late"),
    );
  }
  const serviceNames = [OPENSHELL_GATEWAY_USER_SERVICE, NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE];
  for (const root of new Set(roots)) {
    let targetDirectories: string[];
    try {
      targetDirectories = readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            (entry.name.endsWith(".wants") ||
              entry.name.endsWith(".requires") ||
              entry.name.endsWith(".upholds")),
        )
        .map((entry) => entry.name);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : null;
      if (code === "ENOENT" || code === "ENOTDIR") {
        try {
          lstatSync(root);
        } catch (statError) {
          const statCode =
            statError && typeof statError === "object" && "code" in statError
              ? String(statError.code)
              : null;
          if (statCode === "ENOENT" || statCode === "ENOTDIR") continue;
          throw new OpenShellGatewayServiceTrustError(
            `Could not inspect OpenShell gateway user service root ${root}: ${formatError(statError)}`,
          );
        }
      }
      throw new OpenShellGatewayServiceTrustError(
        `Could not inspect OpenShell gateway user service root ${root}: ${formatError(error)}`,
      );
    }
    for (const targetDirectory of targetDirectories) {
      const targetPath = path.join(root, targetDirectory);
      let targetEntries: string[];
      try {
        targetEntries = readdirSync(targetPath).map(String);
      } catch (error) {
        throw new OpenShellGatewayServiceTrustError(
          `Could not inspect OpenShell gateway user service dependency directory ${targetPath}: ${formatError(error)}`,
        );
      }
      for (const serviceName of serviceNames) {
        const candidate = path.join(root, targetDirectory, `${serviceName}.service`);
        if (targetEntries.includes(`${serviceName}.service`)) return candidate;
        if (existsSync(candidate)) return candidate;
        try {
          if (lstatSync(candidate).isSymbolicLink()) return candidate;
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? String(error.code) : null;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          throw new OpenShellGatewayServiceTrustError(
            `Could not inspect OpenShell gateway user service activation path ${candidate}: ${formatError(error)}`,
          );
        }
      }
    }
  }
  return null;
}

function parseSystemctlShow(
  output: string,
  expectedProperties: readonly string[],
): Record<string, string> | null {
  const expected = new Set(expectedProperties);
  const properties: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    const property = separator > 0 ? line.slice(0, separator) : "";
    if (!expected.has(property) || Object.hasOwn(properties, property)) return null;
    properties[property] = line.slice(separator + 1).trim();
  }
  return expectedProperties.every((property) => Object.hasOwn(properties, property))
    ? properties
    : null;
}

function extractSystemdExecStartPath(execStart: string): string | null {
  const candidates = Array.from(
    execStart.matchAll(/(?:^|[\s;])path=([^\s;]+)/g),
    (match) => match[1]?.trim() ?? "",
  );
  if (candidates.length !== 1 || !path.isAbsolute(candidates[0])) return null;
  return path.normalize(candidates[0]);
}

function validateSystemdServiceIdentity(
  service: OpenShellGatewayUserServiceTarget,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
):
  | { ok: true; execStartPath: string }
  | { diagnostic?: string; ok: false; reason?: string; trustFailure?: boolean } {
  const result = runSystemctlUser(
    ["show", service.serviceName, "--property=FragmentPath", "--property=ExecStart"],
    opts,
  );
  if (!result.ok) return { diagnostic: result.diagnostic, ok: false, reason: result.reason };
  const properties = parseSystemctlShow(result.stdout ?? "", ["FragmentPath", "ExecStart"]);
  if (!properties) {
    return {
      ok: false,
      reason: "service identity query returned invalid metadata",
      trustFailure: true,
    };
  }
  return validateSystemdServiceIdentityFromProperties(service, properties);
}

function validateSystemdServiceIdentityFromProperties(
  service: OpenShellGatewayUserServiceTarget,
  properties: Record<string, string>,
): { ok: true; execStartPath: string } | { ok: false; reason?: string; trustFailure?: boolean } {
  const fragmentPath = path.normalize(properties.FragmentPath ?? "");
  const execStartPath = extractSystemdExecStartPath(properties.ExecStart ?? "");
  const trustedUnit = service.trustedUnitPaths.some(
    (candidate) => path.normalize(candidate) === fragmentPath,
  );
  const trustedBinary =
    execStartPath !== null &&
    service.trustedBinaryPaths.some((candidate) => path.normalize(candidate) === execStartPath);
  if (trustedUnit && trustedBinary && execStartPath !== null) {
    return { ok: true, execStartPath };
  }
  return {
    ok: false,
    reason: `service identity is not a trusted OpenShell gateway (${fragmentPath})`,
    trustFailure: true,
  };
}

export interface TrustedActiveOpenShellGatewayUserServiceIdentity {
  pid: number;
  /** Exact validated systemd ExecStart or official Homebrew formula binary path. */
  executablePath: string | null;
}

function resolveOfficialHomebrewGatewayBinary(
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "existsSync" | "spawnSyncImpl">> &
    Pick<OpenShellGatewayUserServiceOptions, "homebrewFormulaOperation">,
): string | null {
  const prefix = runTrustedHomebrewFormulaOperation(
    ["--prefix", OPENSHELL_GATEWAY_HOMEBREW_SERVICE],
    opts,
  );
  if (!prefix.ok) return null;
  const value = prefix.stdout?.trim() ?? "";
  if (!path.isAbsolute(value)) return null;
  const gatewayBinary = path.normalize(path.join(value, "bin", "openshell-gateway"));
  return opts.existsSync(gatewayBinary) ? gatewayBinary : null;
}

export function getTrustedActiveOpenShellGatewayUserServiceIdentity(
  opts: OpenShellGatewayUserServiceOptions = {},
): TrustedActiveOpenShellGatewayUserServiceIdentity | null {
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
    const result = runTrustedHomebrewFormulaOperation(
      ["services", "info", service.serviceName, "--json"],
      {
        env,
        homebrewFormulaOperation: opts.homebrewFormulaOperation,
        spawnSyncImpl,
      },
    );
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
      const pid =
        record?.running === true &&
        record.loaded === true &&
        Number.isSafeInteger(record.pid) &&
        Number(record.pid) > 0
          ? Number(record.pid)
          : null;
      if (pid === null) return null;
      return {
        pid,
        executablePath: resolveOfficialHomebrewGatewayBinary({
          env,
          existsSync: opts.existsSync ?? fs.existsSync,
          homebrewFormulaOperation: opts.homebrewFormulaOperation,
          spawnSyncImpl,
        }),
      };
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
  const properties = parseSystemctlShow(result.stdout ?? "", [
    "FragmentPath",
    "ExecStart",
    "ActiveState",
    "MainPID",
  ]);
  if (!properties) return null;
  const identity = validateSystemdServiceIdentityFromProperties(service, properties);
  if (properties.ActiveState !== "active" || !identity.ok) {
    return null;
  }
  const mainPid = Number(properties.MainPID);
  return Number.isSafeInteger(mainPid) && mainPid > 0
    ? { pid: mainPid, executablePath: identity.execStartPath }
    : null;
}

export function getTrustedActiveOpenShellGatewayUserServicePid(
  opts: OpenShellGatewayUserServiceOptions = {},
): number | null {
  return getTrustedActiveOpenShellGatewayUserServiceIdentity(opts)?.pid ?? null;
}

function removeCompetingNemoclawUnit(
  service: OpenShellGatewayUserServiceTarget,
  opts: Required<
    Pick<OpenShellGatewayUserServiceOptions, "env" | "existsSync" | "home" | "spawnSyncImpl">
  > &
    Pick<OpenShellGatewayUserServiceOptions, "lstatSync" | "readFileSync" | "rmSync">,
): { ok: boolean; reason?: string; trustFailure?: boolean } {
  if (service.serviceName !== OPENSHELL_GATEWAY_USER_SERVICE) return { ok: true };
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(opts.home, opts.env);
  if (!opts.existsSync(servicePath)) return { ok: true };
  if (isSymbolicLink(servicePath, opts) || !isNemoclawManagedUnit(servicePath, opts)) {
    return {
      ok: false,
      reason: `refusing to reconcile foreign unit ${servicePath}`,
      trustFailure: true,
    };
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
  standaloneFallbackBlocked = service.manager === "homebrew",
): OpenShellGatewayUserServiceStartResult {
  return {
    attempted: true,
    logCommand: service.logCommand,
    manager: service.manager,
    reason,
    serviceName: service.serviceName,
    standaloneFallbackBlocked,
    started: false,
    statusCommand: service.statusCommand,
  };
}

function runHook(
  hook: (() => void) | undefined,
  service: OpenShellGatewayUserServiceTarget,
  description: string,
  standaloneFallbackBlocked = false,
): OpenShellGatewayUserServiceStartResult | null {
  try {
    hook?.();
    return null;
  } catch (error) {
    return serviceFailure(
      service,
      `${description}: ${formatError(error)}`,
      standaloneFallbackBlocked,
    );
  }
}

export function startOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): OpenShellGatewayUserServiceStartResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    return {
      attempted: false,
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
      started: false,
      reason: "service not installed",
    };
  }
  const command = stopServiceCommandName(service);
  if (!commandExists(command)) {
    return serviceFailure(service, `${command} is not available`);
  }

  if (service.manager === "systemd") {
    const reloaded = runSystemctlUser(["daemon-reload"], { env, spawnSyncImpl });
    if (!reloaded.ok) {
      return serviceFailure(service, `systemctl --user daemon-reload failed: ${reloaded.reason}`);
    }
    const identity = validateSystemdServiceIdentity(service, { env, spawnSyncImpl });
    if (!identity.ok)
      return serviceFailure(
        service,
        identity.reason ?? "service identity is invalid",
        identity.trustFailure,
      );
    if (service.serviceName === OPENSHELL_GATEWAY_USER_SERVICE) {
      const verdict = checkUpstreamGatewayVersion(identity.execStartPath, opts);
      if (!verdict.supported) {
        warnUnsupportedUpstreamGateway(verdict, opts);
        const version = verdict.version ?? "unknown";
        return serviceFailure(
          service,
          `package-managed gateway changed before startup: ${verdict.binaryPath} is ${version}`,
          true,
        );
      }
    }
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
        reconciled.trustFailure,
      );
    }
  }

  const envFailure = runHook(
    opts.prepareServiceEnv,
    service,
    "failed to prepare OpenShell gateway service environment",
    true,
  );
  if (envFailure) return envFailure;

  const stop = runStopService(service, {
    env,
    homebrewFormulaOperation: opts.homebrewFormulaOperation,
    spawnSyncImpl,
  });
  if (!stop.ok) {
    const prefix = service.manager === "homebrew" ? "brew services stop" : "systemctl --user stop";
    return serviceFailure(service, `${prefix} ${service.serviceName} failed: ${stop.reason}`);
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
        ? runTrustedHomebrewFormulaOperation(args, {
            env,
            homebrewFormulaOperation: opts.homebrewFormulaOperation,
            spawnSyncImpl,
          })
        : runSystemctlUser(args, { env, spawnSyncImpl });
    if (!result.ok) {
      const prefix = service.manager === "homebrew" ? "brew" : "systemctl --user";
      return serviceFailure(service, `${prefix} ${args.join(" ")} failed: ${result.reason}`);
    }
  }
  return {
    attempted: true,
    logCommand: service.logCommand,
    manager: service.manager,
    serviceName: service.serviceName,
    started: true,
    statusCommand: service.statusCommand,
  };
}

export function stopOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): OpenShellGatewayUserServiceStopResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    return {
      attempted: false,
      standaloneFallbackAllowed: false,
      stopped: false,
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
      standaloneFallbackAllowed: false,
      stopped: false,
      reason: "service not installed",
    };
  }

  const describe = (
    stopped: boolean,
    reason?: string,
    standaloneFallbackBlocked = false,
    managerDiagnostic?: string,
  ): OpenShellGatewayUserServiceStopResult => {
    const userManagerUnavailable =
      service.manager === "systemd" && userManagerLooksUnavailable(managerDiagnostic ?? "");
    const activationPath = userManagerUnavailable
      ? findSystemdUserServiceActivationPath(
          service,
          home,
          env,
          existsSync,
          opts.lstatSync ?? fs.lstatSync,
          opts.readdirSync ?? fs.readdirSync,
        )
      : null;
    const fallbackBlocked =
      standaloneFallbackBlocked ||
      (!stopped && service.manager === "homebrew") ||
      activationPath !== null;
    const reportedReason = activationPath
      ? `${reason ?? "The systemd user manager is unavailable"}; ${activationPath} can activate a gateway user service that can later claim port 8080`
      : reason;
    return {
      attempted: true,
      standaloneFallbackAllowed: !stopped && !fallbackBlocked && userManagerUnavailable,
      manager: service.manager,
      serviceName: service.serviceName,
      ...(fallbackBlocked ? { standaloneFallbackBlocked: true } : {}),
      statusCommand: service.statusCommand,
      stopped,
      ...(reportedReason === undefined ? {} : { reason: reportedReason }),
    };
  };
  const command = stopServiceCommandName(service);
  if (!commandExists(command)) return describe(false, `${command} is not available`);
  if (service.manager === "systemd") {
    const identity = validateSystemdServiceIdentity(service, { env, spawnSyncImpl });
    if (!identity.ok) {
      const userManagerUnavailable = userManagerLooksUnavailable(identity.reason ?? "");
      return describe(
        false,
        identity.reason ?? "service identity is invalid",
        identity.trustFailure || !userManagerUnavailable,
        identity.diagnostic,
      );
    }
  }
  const stop = runStopService(service, {
    env,
    homebrewFormulaOperation: opts.homebrewFormulaOperation,
    spawnSyncImpl,
  });
  if (stop.ok) return describe(true);
  const prefix = service.manager === "homebrew" ? "brew services stop" : "systemctl --user stop";
  return describe(
    false,
    `${prefix} ${service.serviceName} failed: ${stop.reason}`,
    false,
    stop.diagnostic,
  );
}

export async function startPackageManagedDockerDriverGateway({
  clearDockerDriverGatewayRuntimeFiles,
  exitOnFailure,
  gatewayName,
  hasOpenShellGatewayUserService: hasService = hasOpenShellGatewayUserService,
  healthPollCount,
  healthPollInterval,
  isDockerDriverGatewayReady = isDockerDriverGatewayHttpReady,
  managedServiceLogCommand,
  now = Date.now,
  prepareOpenShellGatewayUserServiceEnv,
  preparePortForOpenShellGatewayUserServiceStart,
  registerDockerDriverGatewayEndpoint,
  runCaptureOpenshell,
  skipSandboxBridgeReachability,
  sleepSeconds: sleepSecondsImpl = sleepSeconds,
  startOpenShellGatewayUserService: startService = startOpenShellGatewayUserService,
  stopOpenShellGatewayUserService: stopService = stopOpenShellGatewayUserService,
  validatePortOwnerForOpenShellGatewayUserServiceStart,
  verifySandboxBridgeGatewayReachableOrExit,
}: PackageManagedDockerDriverGatewayOptions): Promise<boolean> {
  const stopBeforeStandaloneFallback = () => {
    try {
      const stopped = stopService();
      if (stopped.standaloneFallbackBlocked) {
        throw new OpenShellGatewayServiceTrustError(
          stopped.reason ?? "managed service identity is not trusted",
        );
      }
      if (stopped.attempted && !stopped.stopped && !stopped.standaloneFallbackAllowed) {
        throw new OpenShellGatewayServiceTrustError(
          stopped.reason ?? "managed service cleanup did not explicitly allow standalone fallback",
        );
      }
      if (stopped.attempted && !stopped.stopped) {
        const detail = stopped.reason ? ` (${stopped.reason})` : "";
        console.warn(
          `  OpenShell gateway managed service could not be stopped${detail}; standalone startup will verify gateway port ownership.`,
        );
      }
    } catch (error) {
      const failure =
        error instanceof OpenShellGatewayServiceTrustError
          ? error
          : new OpenShellGatewayServiceTrustError(
              `OpenShell gateway managed service cleanup failed: ${formatError(error)}`,
            );
      if (exitOnFailure) process.exit(1);
      throw failure;
    }
  };
  try {
    if (!hasService()) return false;
  } catch (error) {
    if (error instanceof OpenShellGatewayServiceTrustError) throw error;
    console.warn(
      `  OpenShell gateway managed service could not be inspected (${formatError(error)}); using standalone fallback.`,
    );
    if (managedServiceLogCommand) console.warn(`  Logs: ${managedServiceLogCommand}`);
    stopBeforeStandaloneFallback();
    return false;
  }

  console.log("  Starting OpenShell Docker-driver gateway via managed service...");
  let serviceStart: OpenShellGatewayUserServiceStartResult;
  try {
    serviceStart = startService({
      preparePortForServiceStart: preparePortForOpenShellGatewayUserServiceStart,
      prepareServiceEnv: prepareOpenShellGatewayUserServiceEnv,
      validatePortOwnerForServiceStart: validatePortOwnerForOpenShellGatewayUserServiceStart,
    });
  } catch (error) {
    if (
      error instanceof OpenShellGatewayServiceEnvironmentError ||
      error instanceof OpenShellGatewayServiceTrustError
    ) {
      throw error;
    }
    console.warn(
      `  OpenShell gateway managed service startup failed (${formatError(error)}); using standalone fallback.`,
    );
    if (managedServiceLogCommand) console.warn(`  Logs: ${managedServiceLogCommand}`);
    stopBeforeStandaloneFallback();
    return false;
  }
  const reportLogs = () => {
    const logCommand = serviceStart.logCommand ?? managedServiceLogCommand;
    if (logCommand) console.warn(`  Logs: ${logCommand}`);
  };
  if (!serviceStart.started) {
    const detail = serviceStart.reason ? ` (${serviceStart.reason})` : "";
    if (serviceStart.standaloneFallbackBlocked || serviceStart.manager === "homebrew") {
      const message = `OpenShell gateway managed service failed to start${detail}.`;
      console.error(`  ${message}`);
      if (exitOnFailure) process.exit(1);
      throw new Error(message);
    }
    console.warn(
      `  OpenShell gateway managed service failed to start${detail}; using standalone fallback.`,
    );
    reportLogs();
    if (serviceStart.attempted) stopBeforeStandaloneFallback();
    return false;
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

  const message = `OpenShell gateway managed service did not become healthy within the configured ${formatGatewayHealthWaitLimit(
    pollCount,
    pollInterval,
  )}; using standalone fallback.`;
  console.warn(`  ${message}`);
  console.warn(
    `  Last readiness check: endpoint registered=${lastReadiness.registered ? "yes" : "no"}, OpenShell CLI health=${lastReadiness.cliHealthy ? "yes" : "no"}, direct gRPC health=${lastReadiness.grpcHealthy ? "yes" : "no"}.`,
  );
  reportLogs();
  if (serviceStart.manager === "homebrew") {
    stopBeforeStandaloneFallback();
    const authorityMessage =
      "The installed OpenShell Homebrew formula remains lifecycle authority; " +
      "run curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash before retrying onboarding.";
    if (exitOnFailure) process.exit(1);
    throw new OpenShellGatewayServiceTrustError(authorityMessage);
  }
  if (serviceStart.attempted) stopBeforeStandaloneFallback();
  return false;
}
