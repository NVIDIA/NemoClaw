// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepSeconds, waitUntilAsync } from "../core/wait";
import { isGatewayHealthy } from "../state/gateway";
import {
  classifyOpenShellGatewayServiceMetadata,
  COMPETING_OPENSHELL_GATEWAY_SERVICE_PROPERTIES,
  type OpenShellGatewayServiceMetadataVerdict,
} from "./gateway/openshell-service-coexistence";
import {
  inspectLaunchdPlistFileIdentity,
  type LaunchdPlistFileIdentity,
  sameLaunchdPlistLifecycleIdentity,
} from "./gateway/launchd-plist-identity";
import {
  inspectServiceFileIdentity,
  type ServiceFileIdentity,
  type ServiceFileIdentityOptions,
  sameServiceFileIdentity,
} from "./gateway/service-file-identity";
import { matchesNemoclawGatewaySystemdUnit } from "./gateway/nemoclaw-systemd-unit-identity";
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

export interface OpenShellGatewayUserServiceOptions {
  /** Test seam for closing a descriptor opened during service identity validation. */
  closeSync?: (fileDescriptor: number) => void;
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  /** Test seam for reading metadata from an opened service file descriptor. */
  fstatSync?: (fileDescriptor: number) => Pick<fs.Stats, "dev" | "ino" | "isFile" | "uid">;
  /** Test seam for the checksum-verified, temporary formula trust boundary. */
  homebrewFormulaOperation?: (args: string[]) => SpawnSyncLikeResult;
  /** Test seam: read the version output of the package-managed gateway binary. */
  getUpstreamGatewayVersion?: (binaryPath: string) => string | null;
  /** Test seam: the blueprint version window the gateway binary must satisfy. */
  getUpstreamGatewayVersionBounds?: () => UpstreamGatewayVersionBounds;
  getuid?: () => number;
  home?: string;
  lstatSync?: typeof fs.lstatSync;
  /** Test seam for opening a service descriptor or executable without following a symlink. */
  openSync?: (filePath: string, flags: number) => number;
  /** Test seam for binding a service descriptor or executable to stable file identity. */
  inspectServiceFileIdentity?: typeof inspectServiceFileIdentity;
  readdirSync?: typeof fs.readdirSync;
  platform?: NodeJS.Platform;
  /** Sink for the one-shot notice emitted when a package unit version is rejected. */
  warn?: (message: string) => void;
  /** Keep observation-only callers from emitting or consuming the version-error warning latch. */
  suppressUnsupportedVersionWarning?: boolean;
  preparePortForServiceStart?: () => void;
  prepareServiceEnv?: () => void;
  /** Test seam for bounded reads from an opened launchd service descriptor. */
  readSync?: (
    fileDescriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ) => number;
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
  signal?: NodeJS.Signals | null;
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
      env: buildGatewayServiceCommandEnv(opts.env ?? process.env),
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
  const configured = env?.XDG_CONFIG_HOME;
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
  const configured = env?.XDG_BIN_HOME;
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

const GATEWAY_SERVICE_COMMAND_ENV_NAMES = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "HOME",
  "HOSTNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_BIN_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);

function buildGatewayServiceCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && GATEWAY_SERVICE_COMMAND_ENV_NAMES.has(entry[0]),
    ),
  );
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  return (
    spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      encoding: "utf-8",
      env: buildGatewayServiceCommandEnv(env),
    }).status === 0
  );
}

function runCommand(
  command: string,
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
  timeout?: number,
): CommandResult {
  try {
    return commandResult(
      opts.spawnSyncImpl(command, args, {
        encoding: "utf-8",
        env: buildGatewayServiceCommandEnv(opts.env),
        stdio: ["ignore", "pipe", "pipe"],
        ...(timeout === undefined ? {} : { timeout }),
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

function commandFailureSummary(command: string, result: CommandResult): string {
  if (result.spawnError) return `${command} could not be started`;
  if (result.status === null) return `${command} ended without an exit status`;
  return `${command} failed with status ${String(result.status)}`;
}

function runSystemctlUser(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
  timeout?: number,
) {
  return runCommand(
    "systemctl",
    ["--user", ...args],
    {
      ...opts,
      env: { ...opts.env, LC_ALL: "C" },
    },
    timeout,
  );
}

const SYSTEMCTL_USER_INSPECTION_TIMEOUT_MS = 10_000;
const LAUNCHCTL_INSPECTION_TIMEOUT_MS = 10_000;
const LAUNCHCTL_SERVICE_ABSENT_STATUS = 113;

const SYSTEMD_USER_MANAGER_UNIT_PATH_ARGS = [
  "--user",
  "--json=short",
  "get-property",
  "org.freedesktop.systemd1",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
  "UnitPath",
] as const;

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

function isHomebrewLaunchdJobAbsent(
  serviceName: string,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">> &
    Pick<OpenShellGatewayUserServiceOptions, "getuid">,
): boolean {
  const uid = currentUserId(opts);
  if (uid === null) return false;
  const label = `homebrew.mxcl.${serviceName}`;
  for (const domain of [`gui/${String(uid)}/${label}`, `user/${String(uid)}/${label}`]) {
    try {
      const result = opts.spawnSyncImpl("/bin/launchctl", ["print", domain], {
        env: { ...buildGatewayServiceCommandEnv(opts.env), LC_ALL: "C" },
        stdio: "ignore",
        timeout: LAUNCHCTL_INSPECTION_TIMEOUT_MS,
      });
      if (
        result.error !== undefined ||
        result.status !== LAUNCHCTL_SERVICE_ABSENT_STATUS ||
        result.signal !== null ||
        result.stdout !== null ||
        result.stderr !== null
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function isPathAbsentByLstat(
  filePath: string,
  lstatSync: NonNullable<OpenShellGatewayUserServiceOptions["lstatSync"]>,
): boolean {
  try {
    lstatSync(filePath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function getHomebrewLaunchdUserPlistPath(home: string, serviceName: string): string {
  return path.join(home, "Library", "LaunchAgents", `homebrew.mxcl.${serviceName}.plist`);
}

function isHomebrewLifecycleUnloaded(
  serviceName: string,
  home: string,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">> &
    Pick<OpenShellGatewayUserServiceOptions, "getuid" | "lstatSync">,
): boolean {
  return (
    isHomebrewLaunchdJobAbsent(serviceName, opts) &&
    isPathAbsentByLstat(
      getHomebrewLaunchdUserPlistPath(home, serviceName),
      opts.lstatSync ?? fs.lstatSync,
    )
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

function runSystemdStopService(
  serviceName: string,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
) {
  return runSystemctlUser(["stop", serviceName], opts);
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

function isCurrentUserOwnedRegularFile(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "getuid" | "lstatSync"> = {},
): boolean {
  try {
    const stat = (opts.lstatSync ?? fs.lstatSync)(filePath);
    const getuid = opts.getuid ?? process.getuid;
    return (
      typeof getuid === "function" &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === getuid()
    );
  } catch {
    return false;
  }
}

function currentUserId(opts: Pick<OpenShellGatewayUserServiceOptions, "getuid">): number | null {
  const getuid = opts.getuid ?? process.getuid;
  if (typeof getuid !== "function") return null;
  const uid = getuid();
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

function inspectTrustedRegularFile(
  filePath: string,
  expectedUid: number | null,
  inspectionOptions: Pick<
    ServiceFileIdentityOptions,
    "contentsLimit" | "hashContents" | "requiredModeBits"
  >,
  opts: SystemdFileInspectionOptions,
): { contents?: string; identity: TrustedRegularFileIdentity } | null {
  if (expectedUid === null) return null;
  const inspection = (opts.inspectServiceFileIdentity ?? inspectServiceFileIdentity)({
    expectedUid,
    filePath,
    ...inspectionOptions,
  });
  if (!inspection || (inspectionOptions.contentsLimit !== undefined && !inspection.contents)) {
    return null;
  }
  return {
    ...(inspection.contents ? { contents: inspection.contents.toString("utf8") } : {}),
    identity: inspection.identity,
  };
}

function sameTrustedRegularFileIdentity(
  first: TrustedRegularFileIdentity,
  second: TrustedRegularFileIdentity,
): boolean {
  return sameServiceFileIdentity(first, second);
}

function isNemoclawManagedUnit(
  filePath: string,
  opts: Pick<OpenShellGatewayUserServiceOptions, "readFileSync"> = {},
): boolean {
  return hasNemoclawManagedUnitMarker(readTextFileIfPresent(filePath, opts));
}

function hasNemoclawManagedUnitMarker(contents: string): boolean {
  return contents
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

function upstreamOpenShellGatewayUserServiceTarget(
  opts: Pick<OpenShellGatewayUserServiceOptions, "existsSync"> = {},
): OpenShellGatewayUserServiceTarget {
  const existsSync = opts.existsSync ?? fs.existsSync;
  return {
    logCommand: getSystemdGatewayLogCommand(OPENSHELL_GATEWAY_USER_SERVICE),
    manager: "systemd",
    serviceName: OPENSHELL_GATEWAY_USER_SERVICE,
    statusCommand: `systemctl --user status ${OPENSHELL_GATEWAY_USER_SERVICE}`,
    trustedBinaryPaths: getOpenShellGatewayUserServiceBinaryPaths(),
    trustedUnitPaths: getOpenShellGatewayUserServicePaths().filter(existsSync),
  };
}

function nemoclawOpenShellGatewayUserServiceTarget(
  opts: OpenShellGatewayUserServiceOptions,
  home: string,
  env: NodeJS.ProcessEnv,
): OpenShellGatewayUserServiceTarget | null {
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
  if (!(opts.existsSync ?? fs.existsSync)(servicePath)) return null;
  if (isSymbolicLink(servicePath, opts)) {
    throw new OpenShellGatewayServiceTrustError(
      `Refusing symlinked NemoClaw gateway user service: ${servicePath}`,
    );
  }
  if (!isCurrentUserOwnedRegularFile(servicePath, opts)) {
    throw new OpenShellGatewayServiceTrustError(
      `Refusing unowned NemoClaw gateway user service: ${servicePath}`,
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
    const upstreamService = upstreamOpenShellGatewayUserServiceTarget(opts);
    const env = opts.env ?? process.env;
    const identity = validateSystemdServiceIdentity(upstreamService, {
      env,
      getuid: opts.getuid,
      inspectServiceFileIdentity: opts.inspectServiceFileIdentity,
      spawnSyncImpl: opts.spawnSyncImpl ?? spawnSync,
    });
    if (!identity.ok) {
      if (!identity.trustFailure && userManagerLooksUnavailable(identity.reason ?? "")) {
        return upstreamService;
      }
      throw new OpenShellGatewayServiceTrustError(
        "Could not verify the effective OpenShell gateway user service.",
      );
    }
    if (identity.ok) {
      const verdict = checkUpstreamGatewayVersion(identity.executablePath, opts);
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
  return nemoclawOpenShellGatewayUserServiceTarget(opts, home, env);
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

interface SystemdUserServiceActivation {
  activationPath: string;
  serviceName: string;
}

function formatDiagnosticPath(filePath: string): string {
  return JSON.stringify(filePath).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function parseSystemdUserManagerUnitPaths(output: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "data" || keys[1] !== "type") return null;
  const result = value as Record<string, unknown>;
  if (
    result.type !== "as" ||
    !Array.isArray(result.data) ||
    result.data.length === 0 ||
    result.data.some(
      (unitRoot) =>
        typeof unitRoot !== "string" ||
        unitRoot.length === 0 ||
        unitRoot.includes("\0") ||
        !path.isAbsolute(unitRoot),
    )
  ) {
    return null;
  }
  return result.data as string[];
}

function systemdUserServiceFallbackUnitRoots(home: string, env: NodeJS.ProcessEnv): string[] {
  if (env.SYSTEMD_UNIT_PATH) {
    throw new OpenShellGatewayServiceTrustError(
      "SYSTEMD_UNIT_PATH overrides the systemd user unit search path, so NemoClaw cannot prove that no gateway service can activate.",
    );
  }
  const configDirectories = (env.XDG_CONFIG_DIRS || "/etc/xdg").split(":").filter(Boolean);
  const configHome = env.XDG_CONFIG_HOME;
  const effectiveConfigHome =
    configHome && path.isAbsolute(configHome)
      ? path.normalize(configHome)
      : path.join(home, ".config");
  const dataHome = env.XDG_DATA_HOME;
  const effectiveDataHome =
    dataHome && path.isAbsolute(dataHome)
      ? path.normalize(dataHome)
      : path.join(home, ".local", "share");
  const configuredDataDirectories = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
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
    path.join(effectiveConfigHome, "systemd", "user"),
    path.join(effectiveConfigHome, "systemd", "user.control"),
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
  const runtimeDir = env.XDG_RUNTIME_DIR;
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
  return roots;
}

function assertMissingActivationRootIsSafe(
  root: string,
  lstatSync: typeof fs.lstatSync,
  readdirSync: typeof fs.readdirSync,
): void {
  let candidate = root;
  while (true) {
    try {
      const candidateStat = lstatSync(candidate);
      if (candidate === root) {
        throw new OpenShellGatewayServiceTrustError(
          `Could not inspect OpenShell gateway user service root ${root}.`,
        );
      }
      try {
        readdirSync(candidate, { withFileTypes: true });
        return;
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error ? String(error.code) : null;
        if (!candidateStat.isSymbolicLink() && code === "ENOTDIR") return;
        throw new OpenShellGatewayServiceTrustError(
          `Could not inspect OpenShell gateway user service root ${root}: ${formatError(error)}`,
        );
      }
    } catch (error) {
      if (error instanceof OpenShellGatewayServiceTrustError) throw error;
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : null;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new OpenShellGatewayServiceTrustError(
          `Could not inspect OpenShell gateway user service root ${root}: ${formatError(error)}`,
        );
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

function discoverSystemdUserServiceActivations(
  home: string,
  env: NodeJS.ProcessEnv,
  lstatSync: typeof fs.lstatSync,
  readdirSync: typeof fs.readdirSync,
  managerUnitRoots?: readonly string[],
): SystemdUserServiceActivation[] {
  const roots = managerUnitRoots ?? systemdUserServiceFallbackUnitRoots(home, env);
  const activations = new Map<string, string>();
  for (const root of new Set(roots)) {
    if (!path.isAbsolute(root)) {
      throw new OpenShellGatewayServiceTrustError(
        "Could not inspect a relative systemd user service activation root.",
      );
    }
    let targetDirectories: string[];
    try {
      targetDirectories = readdirSync(root, { withFileTypes: true })
        .filter((entry) => {
          if (
            !entry.name.endsWith(".wants") &&
            !entry.name.endsWith(".requires") &&
            !entry.name.endsWith(".upholds")
          ) {
            return false;
          }
          if (entry.isDirectory() || entry.isSymbolicLink()) return true;
          try {
            const entryStat = lstatSync(path.join(root, entry.name));
            return entryStat.isDirectory() || entryStat.isSymbolicLink();
          } catch (error) {
            throw new OpenShellGatewayServiceTrustError(
              `Could not inspect OpenShell gateway user service dependency entry ${path.join(root, entry.name)}: ${formatError(error)}`,
            );
          }
        })
        .map((entry) => entry.name);
    } catch (error) {
      if (error instanceof OpenShellGatewayServiceTrustError) throw error;
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : null;
      if (code === "ENOENT" || code === "ENOTDIR") {
        assertMissingActivationRootIsSafe(root, lstatSync, readdirSync);
        continue;
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
      for (const serviceName of targetEntries) {
        if (!serviceName.endsWith(".service")) continue;
        if (!isSafeSystemdServiceName(serviceName)) {
          throw new OpenShellGatewayServiceTrustError(
            "Could not inspect a systemd user service activation path because the service name is invalid.",
          );
        }
        if (!activations.has(serviceName)) {
          activations.set(serviceName, path.join(targetPath, serviceName));
        }
      }
    }
  }
  return [...activations].map(([serviceName, activationPath]) => ({
    activationPath,
    serviceName,
  }));
}

function findSystemdUserServiceActivation(
  service: Pick<OpenShellGatewayUserServiceTarget, "manager">,
  home: string,
  env: NodeJS.ProcessEnv,
  lstatSync: typeof fs.lstatSync,
  readdirSync: typeof fs.readdirSync,
): SystemdUserServiceActivation | null {
  if (service.manager !== "systemd") return null;
  const activations = discoverSystemdUserServiceActivations(home, env, lstatSync, readdirSync);
  return (
    activations.find(
      ({ serviceName }) =>
        serviceName === `${OPENSHELL_GATEWAY_USER_SERVICE}.service` ||
        serviceName === `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`,
    ) ??
    activations[0] ??
    null
  );
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

interface ParsedSystemdExecStartIdentity {
  argumentsValue: string;
  executablePath: string;
}

type TrustedRegularFileIdentity = ServiceFileIdentity;

interface ValidatedSystemdServiceIdentity extends ParsedSystemdExecStartIdentity {
  descriptorIdentity: TrustedRegularFileIdentity;
  executableIdentity: TrustedRegularFileIdentity;
  fragmentPath: string;
}

type SystemdFileInspectionOptions = Pick<
  OpenShellGatewayUserServiceOptions,
  "getuid" | "inspectServiceFileIdentity"
>;

const SYSTEMD_SERVICE_IDENTITY_PROPERTIES = [
  "FragmentPath",
  "ExecStart",
  "DropInPaths",
  "ExecCondition",
  "ExecStartPre",
  "ExecStartPost",
  "ExecReload",
  "ExecStop",
  "ExecStopPost",
] as const;

const SYSTEMD_EXECUTABLE_HOOK_PROPERTIES = [
  "ExecCondition",
  "ExecStartPost",
  "ExecReload",
  "ExecStop",
  "ExecStopPost",
] as const;

const NEMOCLAW_SYSTEMD_PRE_START_ARGUMENTS = [
  "generate-certs",
  "--output-dir",
  "${OPENSHELL_LOCAL_TLS_DIR}",
  "--server-san",
  "host.openshell.internal",
].join(" ");

function stripMatchingQuotes(value: string): string {
  const first = value.at(0);
  return value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}

function parseSystemdExecCommand(execCommand: string): ParsedSystemdExecStartIdentity | null {
  const executablePaths = Array.from(
    execCommand.matchAll(/(?:^|[\s;])path=([^\s;]+)/g),
    (match) => match[1]?.trim() ?? "",
  );
  const argumentsValues = Array.from(
    execCommand.matchAll(/(?:^|[\s;{])argv\[\]=([^;]*)(?=;)/gu),
    (match) => match[1]?.trim() ?? "",
  );
  const ignoreErrorsValues = Array.from(
    execCommand.matchAll(/(?:^|[\s;])ignore_errors=([^\s;]+)/gu),
    (match) => match[1]?.trim() ?? "",
  );
  if (
    executablePaths.length !== 1 ||
    argumentsValues.length !== 1 ||
    ignoreErrorsValues.length !== 1 ||
    ignoreErrorsValues[0] !== "no" ||
    !path.isAbsolute(executablePaths[0])
  ) {
    return null;
  }
  const executablePath = path.normalize(executablePaths[0]);
  const argumentsValue = stripMatchingQuotes(argumentsValues[0]);
  return { argumentsValue, executablePath };
}

function parseSystemdExecStartIdentity(execStart: string): ParsedSystemdExecStartIdentity | null {
  const identity = parseSystemdExecCommand(execStart);
  return identity && identity.argumentsValue === identity.executablePath ? identity : null;
}

function hasExpectedSystemdExecutableHooks(
  service: OpenShellGatewayUserServiceTarget,
  properties: Record<string, string>,
  executablePath: string | null,
): boolean {
  if (!SYSTEMD_EXECUTABLE_HOOK_PROPERTIES.every((property) => properties[property] === "")) {
    return false;
  }
  if (service.serviceName !== NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE) {
    return properties.ExecStartPre === "";
  }
  const preStart = parseSystemdExecCommand(properties.ExecStartPre ?? "");
  return (
    executablePath !== null &&
    preStart?.executablePath === executablePath &&
    preStart.argumentsValue === `${executablePath} ${NEMOCLAW_SYSTEMD_PRE_START_ARGUMENTS}`
  );
}

function isSafeSystemdServiceName(serviceName: string): boolean {
  return /^(?:[A-Za-z0-9_]|\\x[0-9A-Fa-f]{2})(?:[A-Za-z0-9_.@:-]|\\x[0-9A-Fa-f]{2})*\.service$/.test(
    serviceName,
  );
}

function parseActiveSystemdServiceNames(output: string): string[] | null {
  const names: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split(/\s+/);
    if (
      columns.length < 4 ||
      !isSafeSystemdServiceName(columns[0]) ||
      !["active", "activating", "reloading", "deactivating"].includes(columns[2])
    ) {
      return null;
    }
    names.push(columns[0]);
  }
  return names;
}

function assertNoOfflineGatewayActivationPath(
  gatewayPort: number,
  opts: OpenShellGatewayUserServiceOptions,
): void {
  const env = opts.env ?? process.env;
  const home = effectiveHome(opts.home, opts.env);
  let activations: SystemdUserServiceActivation[];
  try {
    activations = discoverSystemdUserServiceActivations(
      home,
      env,
      opts.lstatSync ?? fs.lstatSync,
      opts.readdirSync ?? fs.readdirSync,
    );
  } catch {
    throw new OpenShellGatewayServiceTrustError(
      "Could not inspect systemd user service activation paths while the user manager is unavailable.",
    );
  }
  const canonicalNames = new Set([
    `${OPENSHELL_GATEWAY_USER_SERVICE}.service`,
    `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`,
  ]);
  const canonicalActivation = activations.find(({ serviceName }) =>
    canonicalNames.has(serviceName),
  );
  const noncanonicalActivation = activations.find(
    ({ serviceName }) => !canonicalNames.has(serviceName),
  );
  const activation = gatewayPort === 8080 ? canonicalActivation : null;
  if (activation) {
    throw new OpenShellGatewayServiceTrustError(
      `OpenShell gateway user service activation path ${formatDiagnosticPath(activation.activationPath)} can later claim port ${String(gatewayPort)}.`,
    );
  }
  if (!noncanonicalActivation) return;
  throw new OpenShellGatewayServiceTrustError(
    `The systemd user manager is unavailable, and a noncanonical enabled user service cannot be qualified for selected port ${String(gatewayPort)}.`,
  );
}

function assertCompetingServiceVerdictAllowed(
  serviceName: string,
  gatewayPort: number,
  verdict: OpenShellGatewayServiceMetadataVerdict,
): void {
  if (verdict === "unrelated" || verdict === "different-port") return;
  if (verdict === "block-invalid-selected-port") {
    throw new OpenShellGatewayServiceTrustError("The selected OpenShell gateway port is invalid.");
  }
  if (verdict === "block-malformed-metadata") {
    throw new OpenShellGatewayServiceTrustError(
      `Could not inspect same-user service ${serviceName} because systemd returned malformed metadata.`,
    );
  }
  if (verdict === "block-ambiguous-executable") {
    throw new OpenShellGatewayServiceTrustError(
      `OpenShell gateway user service ${serviceName} has ambiguous executable metadata.`,
    );
  }
  if (verdict === "block-untrusted-executable") {
    throw new OpenShellGatewayServiceTrustError(
      `OpenShell gateway user service ${serviceName} uses an untrusted executable.`,
    );
  }
  if (verdict === "block-ambiguous-port") {
    throw new OpenShellGatewayServiceTrustError(
      `OpenShell gateway user service ${serviceName} has ambiguous port configuration and could claim selected port ${String(gatewayPort)}.`,
    );
  }
  throw new OpenShellGatewayServiceTrustError(
    `OpenShell gateway user service ${serviceName} can claim selected port ${String(gatewayPort)}. Stop or disable that independently managed service before continuing.`,
  );
}

const CANONICAL_OPENSHELL_GATEWAY_SERVICE_PROPERTIES = [
  ...SYSTEMD_SERVICE_IDENTITY_PROPERTIES,
  "ActiveState",
  "UnitFileState",
] as const;

function competingServiceMetadataFromCanonicalProperties(
  properties: Record<string, string>,
): string {
  return COMPETING_OPENSHELL_GATEWAY_SERVICE_PROPERTIES.map(
    (property) => `${property}=${properties[property] ?? ""}`,
  ).join("\n");
}

function isQualifiedCanonicalSystemdService(
  serviceName: string,
  properties: Record<string, string>,
  home: string,
  env: NodeJS.ProcessEnv,
  opts: OpenShellGatewayUserServiceOptions,
): boolean {
  let service: OpenShellGatewayUserServiceTarget | null = null;
  try {
    if (
      serviceName === `${OPENSHELL_GATEWAY_USER_SERVICE}.service` &&
      hasUpstreamOpenShellGatewayUserService(opts)
    ) {
      service = upstreamOpenShellGatewayUserServiceTarget(opts);
    } else if (serviceName === `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`) {
      service = nemoclawOpenShellGatewayUserServiceTarget(opts, home, env);
    }
  } catch {
    return false;
  }
  if (!service) return false;
  const identity = validateSystemdServiceIdentityFromProperties(service, properties, opts);
  if (!identity.ok) return false;
  if (service.serviceName !== OPENSHELL_GATEWAY_USER_SERVICE) return true;
  return checkUpstreamGatewayVersion(identity.executablePath, opts).supported;
}

/** Refuse a same-user service that can compete for the selected gateway port. */
export function assertNoCompetingOpenShellGatewayUserService(
  gatewayPort: number,
  opts: OpenShellGatewayUserServiceOptions = {},
): void {
  if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
    throw new OpenShellGatewayServiceTrustError("The selected OpenShell gateway port is invalid.");
  }
  if ((opts.platform ?? process.platform) !== "linux") return;
  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  if (!commandExists("systemctl")) {
    assertNoOfflineGatewayActivationPath(gatewayPort, opts);
    return;
  }
  const commandOptions = { env, spawnSyncImpl: opts.spawnSyncImpl ?? spawnSync };
  const active = runSystemctlUser(
    [
      "list-units",
      "--type=service",
      "--state=active,activating,reloading,deactivating",
      "--no-legend",
      "--plain",
      "--no-pager",
    ],
    commandOptions,
    SYSTEMCTL_USER_INSPECTION_TIMEOUT_MS,
  );
  if (!active.ok) {
    if (userManagerLooksUnavailable(active.reason ?? "")) {
      assertNoOfflineGatewayActivationPath(gatewayPort, opts);
      return;
    }
    throw new OpenShellGatewayServiceTrustError(
      "Could not inspect same-user OpenShell gateway services during active enumeration.",
    );
  }
  const activeNames = parseActiveSystemdServiceNames(active.stdout ?? "");
  if (!activeNames) {
    throw new OpenShellGatewayServiceTrustError(
      "Could not inspect same-user OpenShell gateway services because systemd returned malformed service enumeration metadata.",
    );
  }
  if (!commandExists("busctl")) {
    throw new OpenShellGatewayServiceTrustError(
      "Could not inspect same-user OpenShell gateway services during manager unit-path enumeration.",
    );
  }
  const managerUnitPath = runCommand(
    "busctl",
    [...SYSTEMD_USER_MANAGER_UNIT_PATH_ARGS],
    { ...commandOptions, env: { ...env, LC_ALL: "C" } },
    SYSTEMCTL_USER_INSPECTION_TIMEOUT_MS,
  );
  const managerUnitRoots = managerUnitPath.ok
    ? parseSystemdUserManagerUnitPaths(managerUnitPath.stdout ?? "")
    : null;
  if (!managerUnitRoots) {
    throw new OpenShellGatewayServiceTrustError(
      "Could not inspect same-user OpenShell gateway services during manager unit-path enumeration.",
    );
  }
  const home = effectiveHome(opts.home, opts.env);
  let activations: SystemdUserServiceActivation[];
  try {
    activations = discoverSystemdUserServiceActivations(
      home,
      env,
      opts.lstatSync ?? fs.lstatSync,
      opts.readdirSync ?? fs.readdirSync,
      managerUnitRoots,
    );
  } catch {
    throw new OpenShellGatewayServiceTrustError(
      "Could not inspect same-user OpenShell gateway services during activation-path enumeration.",
    );
  }
  const activationNames = new Set(activations.map(({ serviceName }) => serviceName));
  const canonicalNames = new Set([
    `${OPENSHELL_GATEWAY_USER_SERVICE}.service`,
    `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`,
  ]);
  const serviceNames = [...new Set([...activeNames, ...activationNames])];
  for (const serviceName of serviceNames) {
    const canonicalDefaultPortService = gatewayPort === 8080 && canonicalNames.has(serviceName);
    const queriedProperties = canonicalDefaultPortService
      ? CANONICAL_OPENSHELL_GATEWAY_SERVICE_PROPERTIES
      : COMPETING_OPENSHELL_GATEWAY_SERVICE_PROPERTIES;
    const metadata = runSystemctlUser(
      ["show", serviceName, ...queriedProperties.map((property) => `--property=${property}`)],
      commandOptions,
      SYSTEMCTL_USER_INSPECTION_TIMEOUT_MS,
    );
    if (!metadata.ok) {
      throw new OpenShellGatewayServiceTrustError(
        "Could not inspect same-user OpenShell gateway services during service metadata query.",
      );
    }
    let classifiedMetadata = metadata.stdout ?? "";
    if (canonicalDefaultPortService) {
      const properties = parseSystemctlShow(classifiedMetadata, queriedProperties);
      if (!properties) {
        throw new OpenShellGatewayServiceTrustError(
          `Could not inspect same-user service ${serviceName} because systemd returned malformed metadata.`,
        );
      }
      classifiedMetadata = competingServiceMetadataFromCanonicalProperties(properties);
      const verdict = classifyOpenShellGatewayServiceMetadata({
        enabledByActivationPath: activationNames.has(serviceName),
        gatewayPort,
        metadata: classifiedMetadata,
        trustedExecutablePaths: getNemoclawOpenShellGatewayUserServiceBinaryPaths(home, env),
      });
      if (
        isQualifiedCanonicalSystemdService(serviceName, properties, home, env, opts) &&
        properties.UnitFileState !== "not-found" &&
        verdict === "block-ambiguous-port"
      ) {
        continue;
      }
      if (verdict === "different-port") continue;
      if (verdict === "unrelated") {
        throw new OpenShellGatewayServiceTrustError(
          `Canonical OpenShell gateway user service ${serviceName} is not bound to a trusted service definition.`,
        );
      }
      assertCompetingServiceVerdictAllowed(serviceName, gatewayPort, verdict);
      continue;
    }
    assertCompetingServiceVerdictAllowed(
      serviceName,
      gatewayPort,
      classifyOpenShellGatewayServiceMetadata({
        enabledByActivationPath: activationNames.has(serviceName),
        gatewayPort,
        metadata: classifiedMetadata,
        trustedExecutablePaths: getNemoclawOpenShellGatewayUserServiceBinaryPaths(home, env),
      }),
    );
  }
}

function validateSystemdServiceIdentity(
  service: OpenShellGatewayUserServiceTarget,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">> &
    SystemdFileInspectionOptions,
):
  | ({ ok: true } & ValidatedSystemdServiceIdentity)
  | { diagnostic?: string; ok: false; reason?: string; trustFailure?: boolean } {
  const result = runSystemctlUser(
    [
      "show",
      service.serviceName,
      ...SYSTEMD_SERVICE_IDENTITY_PROPERTIES.map((property) => `--property=${property}`),
    ],
    opts,
    SYSTEMCTL_USER_INSPECTION_TIMEOUT_MS,
  );
  if (!result.ok) return { diagnostic: result.diagnostic, ok: false, reason: result.reason };
  const properties = parseSystemctlShow(result.stdout ?? "", SYSTEMD_SERVICE_IDENTITY_PROPERTIES);
  if (!properties) {
    return {
      ok: false,
      reason: "service identity query returned invalid metadata",
      trustFailure: true,
    };
  }
  return validateSystemdServiceIdentityFromProperties(service, properties, opts);
}

function expectedSystemdFileOwners(
  service: OpenShellGatewayUserServiceTarget,
  filePath: string,
  fileKind: "descriptor" | "executable",
  opts: Pick<OpenShellGatewayUserServiceOptions, "getuid">,
): number[] {
  if (service.serviceName === OPENSHELL_GATEWAY_USER_SERVICE) return [0];
  const uid = currentUserId(opts);
  if (uid === null) return [];
  if (fileKind === "descriptor") return [uid];
  const normalizedFilePath = path.normalize(filePath);
  if (normalizedFilePath === path.normalize("/usr/bin/openshell-gateway")) return [0];
  if (normalizedFilePath === path.normalize("/usr/local/bin/openshell-gateway")) {
    return uid === 0 ? [0] : [0, uid];
  }
  return [uid];
}

function inspectTrustedSystemdFile(
  service: OpenShellGatewayUserServiceTarget,
  filePath: string,
  fileKind: "descriptor" | "executable",
  inspectionOptions: Pick<
    ServiceFileIdentityOptions,
    "contentsLimit" | "hashContents" | "requiredModeBits"
  >,
  opts: SystemdFileInspectionOptions,
): { contents?: string; identity: TrustedRegularFileIdentity } | null {
  for (const expectedUid of expectedSystemdFileOwners(service, filePath, fileKind, opts)) {
    const inspected = inspectTrustedRegularFile(filePath, expectedUid, inspectionOptions, opts);
    if (inspected) return inspected;
  }
  return null;
}

function trustedSystemdDescriptorIdentity(
  service: OpenShellGatewayUserServiceTarget,
  fragmentPath: string,
  executablePath: string,
  opts: SystemdFileInspectionOptions,
): TrustedRegularFileIdentity | null {
  const descriptor = inspectTrustedSystemdFile(
    service,
    fragmentPath,
    "descriptor",
    service.serviceName === NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE
      ? { contentsLimit: 128 * 1024 }
      : { hashContents: true },
    opts,
  );
  if (!descriptor) return null;
  return service.serviceName !== NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE ||
    matchesNemoclawGatewaySystemdUnit(descriptor.contents ?? "", executablePath)
    ? descriptor.identity
    : null;
}

function validateSystemdServiceIdentityFromProperties(
  service: OpenShellGatewayUserServiceTarget,
  properties: Record<string, string>,
  opts: SystemdFileInspectionOptions,
):
  | ({ ok: true } & ValidatedSystemdServiceIdentity)
  | { ok: false; reason?: string; trustFailure?: boolean } {
  const rawFragmentPath = properties.FragmentPath ?? "";
  const fragmentPath = path.isAbsolute(rawFragmentPath) ? path.normalize(rawFragmentPath) : "";
  const execStart = parseSystemdExecStartIdentity(properties.ExecStart ?? "");
  const completeSnapshot = SYSTEMD_SERVICE_IDENTITY_PROPERTIES.every((property) =>
    Object.hasOwn(properties, property),
  );
  const hasNoDropIns = properties.DropInPaths === "";
  const hasExpectedExecutableHooks = hasExpectedSystemdExecutableHooks(
    service,
    properties,
    execStart?.executablePath ?? null,
  );
  const trustedUnit = service.trustedUnitPaths.some(
    (candidate) => path.normalize(candidate) === fragmentPath,
  );
  const trustedBinary =
    execStart !== null &&
    service.trustedBinaryPaths.some(
      (candidate) => path.normalize(candidate) === execStart.executablePath,
    );
  if (
    completeSnapshot &&
    hasNoDropIns &&
    hasExpectedExecutableHooks &&
    trustedUnit &&
    trustedBinary &&
    execStart !== null
  ) {
    const descriptorIdentity = trustedSystemdDescriptorIdentity(
      service,
      fragmentPath,
      execStart.executablePath,
      opts,
    );
    const executableIdentity = inspectTrustedSystemdFile(
      service,
      execStart.executablePath,
      "executable",
      { hashContents: true, requiredModeBits: 0o100 },
      opts,
    )?.identity;
    if (descriptorIdentity && executableIdentity) {
      return {
        ...execStart,
        descriptorIdentity,
        executableIdentity,
        fragmentPath,
        ok: true,
      };
    }
  }
  return {
    ok: false,
    reason: "service identity is not a trusted OpenShell gateway",
    trustFailure: true,
  };
}

type OpenShellGatewayLifecycleIdentity =
  | {
      gatewayExecutableIdentity: TrustedRegularFileIdentity;
      gatewayExecutablePath: string;
      manager: "homebrew";
      plistIdentity: LaunchdPlistFileIdentity;
      serviceCommand: string;
      serviceCommandIdentity: TrustedRegularFileIdentity;
    }
  | ({ manager: "systemd" } & ValidatedSystemdServiceIdentity);

function sameValidatedSystemdServiceIdentity(
  first: ValidatedSystemdServiceIdentity,
  second: ValidatedSystemdServiceIdentity,
): boolean {
  return (
    first.fragmentPath === second.fragmentPath &&
    first.executablePath === second.executablePath &&
    first.argumentsValue === second.argumentsValue &&
    sameTrustedRegularFileIdentity(first.descriptorIdentity, second.descriptorIdentity) &&
    sameTrustedRegularFileIdentity(first.executableIdentity, second.executableIdentity)
  );
}

function inspectOpenShellGatewayLifecycleIdentity(
  service: OpenShellGatewayUserServiceTarget,
  home: string,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "existsSync" | "spawnSyncImpl">> &
    Pick<
      OpenShellGatewayUserServiceOptions,
      | "closeSync"
      | "fstatSync"
      | "getuid"
      | "homebrewFormulaOperation"
      | "inspectServiceFileIdentity"
      | "lstatSync"
      | "openSync"
      | "readSync"
    >,
):
  | { identity: OpenShellGatewayLifecycleIdentity; ok: true }
  | { diagnostic?: string; ok: false; reason: string; trustFailure: boolean } {
  if (service.manager === "homebrew") {
    const identity = validateHomebrewServiceIdentity(service, home, opts);
    return identity
      ? {
          identity: {
            gatewayExecutableIdentity: identity.gatewayExecutableIdentity,
            gatewayExecutablePath: identity.gatewayExecutablePath,
            manager: "homebrew",
            plistIdentity: identity.plistIdentity,
            serviceCommand: identity.command,
            serviceCommandIdentity: identity.commandIdentity,
          },
          ok: true,
        }
      : {
          ok: false,
          reason: "Homebrew service definition is not trusted",
          trustFailure: true,
        };
  }
  const identity = validateSystemdServiceIdentity(service, opts);
  return identity.ok
    ? { identity: { ...identity, manager: "systemd" }, ok: true }
    : {
        diagnostic: identity.diagnostic,
        ok: false,
        reason: identity.trustFailure
          ? "systemd service definition is not trusted"
          : "systemd service identity query failed",
        trustFailure: identity.trustFailure === true,
      };
}

function sameOpenShellGatewayLifecycleIdentity(
  first: OpenShellGatewayLifecycleIdentity,
  second: OpenShellGatewayLifecycleIdentity,
): boolean {
  if (first.manager !== second.manager) return false;
  return first.manager === "homebrew" && second.manager === "homebrew"
    ? first.serviceCommand === second.serviceCommand &&
        first.gatewayExecutablePath === second.gatewayExecutablePath &&
        sameTrustedRegularFileIdentity(
          first.serviceCommandIdentity,
          second.serviceCommandIdentity,
        ) &&
        sameTrustedRegularFileIdentity(
          first.gatewayExecutableIdentity,
          second.gatewayExecutableIdentity,
        ) &&
        sameLaunchdPlistLifecycleIdentity(first.plistIdentity, second.plistIdentity)
    : first.manager === "systemd" &&
        second.manager === "systemd" &&
        sameValidatedSystemdServiceIdentity(first, second);
}

export interface TrustedActiveOpenShellGatewayUserServiceIdentity {
  pid: number;
  /** Exact validated systemd ExecStart or official Homebrew formula binary path. */
  executablePath: string | null;
}

function resolveOfficialHomebrewFormulaPrefix(
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "existsSync" | "spawnSyncImpl">> &
    Pick<OpenShellGatewayUserServiceOptions, "homebrewFormulaOperation">,
): string | null {
  const prefix = runTrustedHomebrewFormulaOperation(
    ["--prefix", OPENSHELL_GATEWAY_HOMEBREW_SERVICE],
    opts,
  );
  if (!prefix.ok) return null;
  const value = prefix.stdout?.trim() ?? "";
  return path.isAbsolute(value) ? path.normalize(value) : null;
}

interface HomebrewServiceInfoRecord {
  command?: unknown;
  file?: unknown;
  loaded?: unknown;
  loaded_file?: unknown;
  name?: unknown;
  pid?: unknown;
  registered?: unknown;
  running?: unknown;
  service_name?: unknown;
}

interface ValidatedHomebrewServiceIdentity {
  command: string;
  commandIdentity: TrustedRegularFileIdentity;
  gatewayExecutableIdentity: TrustedRegularFileIdentity;
  gatewayExecutablePath: string;
  pid: number | null;
  plistIdentity: LaunchdPlistFileIdentity;
  running: boolean;
}

function validateHomebrewServiceIdentity(
  service: OpenShellGatewayUserServiceTarget,
  home: string,
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "existsSync" | "spawnSyncImpl">> &
    Pick<
      OpenShellGatewayUserServiceOptions,
      | "closeSync"
      | "fstatSync"
      | "getuid"
      | "homebrewFormulaOperation"
      | "inspectServiceFileIdentity"
      | "lstatSync"
      | "openSync"
      | "readSync"
    >,
): ValidatedHomebrewServiceIdentity | null {
  const formulaPrefix = resolveOfficialHomebrewFormulaPrefix(opts);
  if (!formulaPrefix) return null;
  const result = runTrustedHomebrewFormulaOperation(
    ["services", "info", service.serviceName, "--json"],
    opts,
  );
  if (!result.ok) return null;
  try {
    const records = JSON.parse(result.stdout ?? "") as unknown;
    if (!Array.isArray(records) || records.length !== 1) return null;
    const record = records[0] as HomebrewServiceInfoRecord;
    const serviceLabel = `homebrew.mxcl.${service.serviceName}`;
    const command = path.join(formulaPrefix, "libexec", "openshell-gateway-homebrew-service");
    const gatewayExecutablePath = path.join(formulaPrefix, "bin", "openshell-gateway");
    const formulaPlist = path.join(formulaPrefix, `${serviceLabel}.plist`);
    const userPlist = path.join(home, "Library", "LaunchAgents", `${serviceLabel}.plist`);
    const running = record.running === true;
    const pid =
      Number.isSafeInteger(record.pid) && Number(record.pid) > 0 ? Number(record.pid) : null;
    const coherentLoadedState =
      record.registered === true &&
      record.loaded === true &&
      record.file === userPlist &&
      record.loaded_file === userPlist &&
      (record.running === true ? pid !== null : record.running === false && record.pid === null);
    const coherentUnloadedState =
      record.registered === false &&
      record.loaded === false &&
      record.running === false &&
      record.pid === null &&
      record.file === formulaPlist &&
      record.loaded_file === null;
    if (
      record.name !== service.serviceName ||
      record.service_name !== serviceLabel ||
      record.command !== command ||
      (!coherentLoadedState && !coherentUnloadedState) ||
      !opts.existsSync(record.file as string) ||
      (typeof record.loaded_file === "string" && !opts.existsSync(record.loaded_file))
    ) {
      return null;
    }
    const plistIdentity = inspectLaunchdPlistFileIdentity({
      closeSync: opts.closeSync,
      effectivePath: record.file as string,
      fstatSync: opts.fstatSync as
        | NonNullable<Parameters<typeof inspectLaunchdPlistFileIdentity>[0]["fstatSync"]>
        | undefined,
      formulaPath: formulaPlist,
      getuid: opts.getuid,
      lstatSync: opts.lstatSync as
        | NonNullable<Parameters<typeof inspectLaunchdPlistFileIdentity>[0]["lstatSync"]>
        | undefined,
      openSync: opts.openSync,
      readSync: opts.readSync,
    });
    const currentUid = currentUserId(opts);
    const commandIdentity = inspectTrustedRegularFile(
      command,
      currentUid,
      { hashContents: true, requiredModeBits: 0o100 },
      opts,
    )?.identity;
    const gatewayExecutableIdentity = inspectTrustedRegularFile(
      gatewayExecutablePath,
      currentUid,
      { hashContents: true, requiredModeBits: 0o100 },
      opts,
    )?.identity;
    return plistIdentity && commandIdentity && gatewayExecutableIdentity
      ? {
          command,
          commandIdentity,
          gatewayExecutableIdentity,
          gatewayExecutablePath,
          pid,
          plistIdentity,
          running,
        }
      : null;
  } catch {
    return null;
  }
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
    // launchctl has no structured, secret-free live-definition query.
    // Observation-only callers must not trust a loaded Homebrew job.
    return null;
  }
  if (!commandExists("systemctl")) return null;
  const result = runSystemctlUser(
    [
      "show",
      service.serviceName,
      ...SYSTEMD_SERVICE_IDENTITY_PROPERTIES.map((property) => `--property=${property}`),
      "--property=ActiveState",
      "--property=MainPID",
    ],
    { env, spawnSyncImpl },
    SYSTEMCTL_USER_INSPECTION_TIMEOUT_MS,
  );
  if (!result.ok) return null;
  const properties = parseSystemctlShow(result.stdout ?? "", [
    ...SYSTEMD_SERVICE_IDENTITY_PROPERTIES,
    "ActiveState",
    "MainPID",
  ]);
  if (!properties) return null;
  const identity = validateSystemdServiceIdentityFromProperties(service, properties, opts);
  if (properties.ActiveState !== "active" || !identity.ok) {
    return null;
  }
  const mainPid = Number(properties.MainPID);
  return Number.isSafeInteger(mainPid) && mainPid > 0
    ? { pid: mainPid, executablePath: identity.executablePath }
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
    Pick<
      OpenShellGatewayUserServiceOptions,
      | "closeSync"
      | "fstatSync"
      | "getuid"
      | "inspectServiceFileIdentity"
      | "lstatSync"
      | "openSync"
      | "readSync"
      | "readFileSync"
      | "rmSync"
    > & {
      selectedIdentityIsCurrent: () => boolean;
    },
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
  const competingService = nemoclawOpenShellGatewayUserServiceTarget(opts, opts.home, opts.env);
  if (!competingService) {
    return {
      ok: false,
      reason: "competing NemoClaw service definition disappeared before reconciliation",
      trustFailure: true,
    };
  }
  const baselineIdentity = validateSystemdServiceIdentity(competingService, opts);
  if (!baselineIdentity.ok) {
    return {
      ok: false,
      reason: "competing NemoClaw service definition is not trusted",
      trustFailure: true,
    };
  }
  const competingIdentityIsCurrent = (): boolean => {
    const currentIdentity = validateSystemdServiceIdentity(competingService, opts);
    return (
      currentIdentity.ok && sameValidatedSystemdServiceIdentity(baselineIdentity, currentIdentity)
    );
  };
  if (!opts.selectedIdentityIsCurrent() || !competingIdentityIsCurrent()) {
    return {
      ok: false,
      reason: "gateway service identity changed before competing service disable",
      trustFailure: true,
    };
  }
  const disabled = runSystemctlUser(
    ["disable", "--now", NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE],
    opts,
  );
  if (!disabled.ok) {
    return {
      ok: false,
      reason: commandFailureSummary("systemctl --user disable", disabled),
    };
  }
  if (!opts.selectedIdentityIsCurrent() || !competingIdentityIsCurrent()) {
    return {
      ok: false,
      reason: "gateway service identity changed before competing descriptor removal",
      trustFailure: true,
    };
  }
  try {
    (opts.rmSync ?? fs.rmSync)(servicePath, { force: true });
  } catch {
    return { ok: false, reason: "could not remove the competing NemoClaw service descriptor" };
  }
  if (!opts.selectedIdentityIsCurrent()) {
    return {
      ok: false,
      reason: "gateway service identity changed before manager reload",
      trustFailure: true,
    };
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

function unverifiedHomebrewLaunchdJobGuidance(serviceName: string): string {
  return `NemoClaw cannot verify the loaded Homebrew launchd job definition. Run \`brew services stop ${serviceName}\`, then rerun onboarding.`;
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

  const identityOptions = {
    closeSync: opts.closeSync,
    env,
    existsSync,
    fstatSync: opts.fstatSync,
    getuid: opts.getuid,
    homebrewFormulaOperation: opts.homebrewFormulaOperation,
    inspectServiceFileIdentity: opts.inspectServiceFileIdentity,
    lstatSync: opts.lstatSync,
    openSync: opts.openSync,
    readSync: opts.readSync,
    spawnSyncImpl,
  };
  const baselineIdentityResult = inspectOpenShellGatewayLifecycleIdentity(
    service,
    home,
    identityOptions,
  );
  if (!baselineIdentityResult.ok) {
    return serviceFailure(
      service,
      baselineIdentityResult.reason,
      baselineIdentityResult.trustFailure,
    );
  }
  const baselineIdentity = baselineIdentityResult.identity;
  if (
    baselineIdentity.manager === "homebrew" &&
    (baselineIdentity.plistIdentity.effective.source !== "formula" ||
      !isHomebrewLifecycleUnloaded(service.serviceName, home, identityOptions))
  ) {
    return serviceFailure(service, unverifiedHomebrewLaunchdJobGuidance(service.serviceName), true);
  }
  const validateIdentityBeforeMutation = (): OpenShellGatewayUserServiceStartResult | null => {
    const current = inspectOpenShellGatewayLifecycleIdentity(service, home, identityOptions);
    if (!current.ok || !sameOpenShellGatewayLifecycleIdentity(baselineIdentity, current.identity)) {
      return serviceFailure(service, "service identity changed before lifecycle mutation", true);
    }
    if (
      current.identity.manager === "homebrew" &&
      (current.identity.plistIdentity.effective.source !== "formula" ||
        !isHomebrewLifecycleUnloaded(service.serviceName, home, identityOptions))
    ) {
      return serviceFailure(
        service,
        unverifiedHomebrewLaunchdJobGuidance(service.serviceName),
        true,
      );
    }
    if (
      current.identity.manager === "systemd" &&
      service.serviceName === OPENSHELL_GATEWAY_USER_SERVICE
    ) {
      const verdict = checkUpstreamGatewayVersion(current.identity.executablePath, opts);
      if (!verdict.supported) {
        warnUnsupportedUpstreamGateway(verdict, opts);
        return serviceFailure(service, "package-managed gateway changed before startup", true);
      }
    }
    return null;
  };
  if (
    baselineIdentity.manager === "systemd" &&
    service.serviceName === OPENSHELL_GATEWAY_USER_SERVICE
  ) {
    const verdict = checkUpstreamGatewayVersion(baselineIdentity.executablePath, opts);
    if (!verdict.supported) {
      warnUnsupportedUpstreamGateway(verdict, opts);
      return serviceFailure(service, "package-managed gateway changed before startup", true);
    }
  }

  if (service.manager === "systemd") {
    const beforeReloadIdentityFailure = validateIdentityBeforeMutation();
    if (beforeReloadIdentityFailure) return beforeReloadIdentityFailure;
    const reloaded = runSystemctlUser(["daemon-reload"], { env, spawnSyncImpl });
    if (!reloaded.ok) {
      return serviceFailure(
        service,
        commandFailureSummary("systemctl --user daemon-reload", reloaded),
      );
    }
  }

  const beforeOwnershipIdentityFailure =
    service.manager === "homebrew" ? validateIdentityBeforeMutation() : null;
  if (beforeOwnershipIdentityFailure) return beforeOwnershipIdentityFailure;
  const ownershipFailure = runHook(
    opts.validatePortOwnerForServiceStart,
    service,
    "OpenShell gateway port ownership validation failed",
  );
  if (ownershipFailure) return ownershipFailure;

  if (service.manager === "systemd") {
    const mayReconcileCompetingUnit =
      service.serviceName === OPENSHELL_GATEWAY_USER_SERVICE &&
      existsSync(getNemoclawOpenShellGatewayUserServicePath(home, env));
    const beforeReconciliationIdentityFailure = mayReconcileCompetingUnit
      ? validateIdentityBeforeMutation()
      : null;
    if (beforeReconciliationIdentityFailure) return beforeReconciliationIdentityFailure;
    const reconciled = removeCompetingNemoclawUnit(service, {
      closeSync: opts.closeSync,
      env,
      existsSync,
      fstatSync: opts.fstatSync,
      getuid: opts.getuid,
      home,
      inspectServiceFileIdentity: opts.inspectServiceFileIdentity,
      lstatSync: opts.lstatSync,
      openSync: opts.openSync,
      readSync: opts.readSync,
      readFileSync: opts.readFileSync,
      rmSync: opts.rmSync,
      selectedIdentityIsCurrent: () => validateIdentityBeforeMutation() === null,
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

  const beforeEnvironmentIdentityFailure = validateIdentityBeforeMutation();
  if (beforeEnvironmentIdentityFailure) return beforeEnvironmentIdentityFailure;
  const envFailure = runHook(
    opts.prepareServiceEnv,
    service,
    "failed to prepare OpenShell gateway service environment",
    true,
  );
  if (envFailure) return envFailure;

  if (service.manager === "systemd") {
    const beforeStopIdentityFailure = validateIdentityBeforeMutation();
    if (beforeStopIdentityFailure) return beforeStopIdentityFailure;

    const stop = runSystemdStopService(service.serviceName, {
      env,
      spawnSyncImpl,
    });
    if (!stop.ok) {
      return serviceFailure(
        service,
        commandFailureSummary(`systemctl --user stop ${service.serviceName}`, stop),
      );
    }
  }

  const beforePortIdentityFailure = validateIdentityBeforeMutation();
  if (beforePortIdentityFailure) return beforePortIdentityFailure;
  const portFailure = runHook(
    opts.preparePortForServiceStart,
    service,
    "failed to prepare the OpenShell gateway port",
  );
  if (portFailure) return portFailure;

  const commands =
    service.manager === "homebrew"
      ? [["services", "start", service.serviceName]]
      : [
          ["enable", service.serviceName],
          ["restart", service.serviceName],
          ["is-active", "--quiet", service.serviceName],
        ];
  for (const args of commands) {
    const mutatesService = args[0] === "enable" || args[0] === "restart" || args[0] === "services";
    const identityFailure = mutatesService ? validateIdentityBeforeMutation() : null;
    if (identityFailure) return identityFailure;
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
      return serviceFailure(service, commandFailureSummary(`${prefix} ${args.join(" ")}`, result));
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
    let activation: SystemdUserServiceActivation | null = null;
    let activationScanFailed = false;
    if (userManagerUnavailable) {
      try {
        activation = findSystemdUserServiceActivation(
          service,
          home,
          env,
          opts.lstatSync ?? fs.lstatSync,
          opts.readdirSync ?? fs.readdirSync,
        );
      } catch {
        activationScanFailed = true;
      }
    }
    const fallbackBlocked =
      standaloneFallbackBlocked ||
      (!stopped && service.manager === "homebrew") ||
      activation !== null ||
      activationScanFailed;
    const reportedReason = activationScanFailed
      ? `${reason ?? "The systemd user manager is unavailable"}; could not inspect systemd user service activation paths`
      : activation &&
          (activation.serviceName === `${OPENSHELL_GATEWAY_USER_SERVICE}.service` ||
            activation.serviceName === `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`)
        ? `${reason ?? "The systemd user manager is unavailable"}; ${formatDiagnosticPath(activation.activationPath)} can activate a gateway user service that can later claim port 8080`
        : activation
          ? `${reason ?? "The systemd user manager is unavailable"}; a noncanonical enabled user service cannot be qualified for selected port 8080`
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
  const identityOptions = {
    closeSync: opts.closeSync,
    env,
    existsSync,
    fstatSync: opts.fstatSync,
    getuid: opts.getuid,
    homebrewFormulaOperation: opts.homebrewFormulaOperation,
    inspectServiceFileIdentity: opts.inspectServiceFileIdentity,
    lstatSync: opts.lstatSync,
    openSync: opts.openSync,
    readSync: opts.readSync,
    spawnSyncImpl,
  };
  const baselineIdentityResult = inspectOpenShellGatewayLifecycleIdentity(
    service,
    home,
    identityOptions,
  );
  if (!baselineIdentityResult.ok) {
    const userManagerUnavailable =
      service.manager === "systemd" &&
      userManagerLooksUnavailable(baselineIdentityResult.diagnostic ?? "");
    return describe(
      false,
      baselineIdentityResult.reason,
      baselineIdentityResult.trustFailure || !userManagerUnavailable,
      baselineIdentityResult.diagnostic,
    );
  }
  const baselineIdentity = baselineIdentityResult.identity;
  if (
    baselineIdentity.manager === "homebrew" &&
    (baselineIdentity.plistIdentity.effective.source !== "formula" ||
      !isHomebrewLifecycleUnloaded(service.serviceName, home, identityOptions))
  ) {
    return describe(false, unverifiedHomebrewLaunchdJobGuidance(service.serviceName), true);
  }
  if (
    baselineIdentity.manager === "systemd" &&
    service.serviceName === OPENSHELL_GATEWAY_USER_SERVICE
  ) {
    const verdict = checkUpstreamGatewayVersion(baselineIdentity.executablePath, opts);
    if (!verdict.supported) {
      return describe(false, "package-managed gateway changed before stop", true);
    }
  }
  const currentIdentityResult = inspectOpenShellGatewayLifecycleIdentity(
    service,
    home,
    identityOptions,
  );
  if (
    !currentIdentityResult.ok ||
    !sameOpenShellGatewayLifecycleIdentity(baselineIdentity, currentIdentityResult.identity)
  ) {
    return describe(
      false,
      "service identity changed before stop",
      true,
      currentIdentityResult.ok ? undefined : currentIdentityResult.diagnostic,
    );
  }
  if (
    currentIdentityResult.identity.manager === "homebrew" &&
    (currentIdentityResult.identity.plistIdentity.effective.source !== "formula" ||
      !isHomebrewLifecycleUnloaded(service.serviceName, home, identityOptions))
  ) {
    return describe(false, unverifiedHomebrewLaunchdJobGuidance(service.serviceName), true);
  }
  if (baselineIdentity.manager === "homebrew") {
    return describe(true, "Homebrew service is already stopped.");
  }
  const stop = runSystemdStopService(service.serviceName, {
    env,
    spawnSyncImpl,
  });
  if (stop.ok) return describe(true);
  return describe(
    false,
    commandFailureSummary(`systemctl --user stop ${service.serviceName}`, stop),
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
