// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PEM_CERTIFICATE_RE_GLOBAL } from "../corporate-ca-policy";
import {
  type ManagedStartupAgentEnvironment,
  type ManagedStartupAgentMaterial,
  type ManagedStartupApplicationRuntimePlan,
  mapManagedStartupProfileToAgentEnvironment,
} from "./agent-environment";
import {
  coordinateManagedStartupApplication,
  type ManagedStartupAdapterContext,
  type ManagedStartupAgentAdapter,
} from "./coordinator";
import {
  decodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  MANAGED_STARTUP_MESSAGING_AGENTS,
  type ManagedStartupAgent,
  type ManagedStartupDashboard,
  type ManagedStartupMessagingAgent,
  type ManagedStartupProfile,
} from "./profile";
import {
  MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES,
  type ManagedStartupRootApplyRequest,
  parseManagedStartupRootApplyRequest,
  selectManagedStartupApplicationRuntimeEnvironment,
} from "./root-apply";
import {
  beginManagedStartupSharedStateTransaction,
  clearManagedStartupSharedStateCommitReceipt,
  commitManagedStartupSharedStateTransaction,
  getManagedStartupSharedStateTransactionStatus,
  MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
  rollbackManagedStartupSharedStateTransaction,
} from "./shared-state-transaction";
import { MANAGED_STARTUP_CA_ENV, MANAGED_STARTUP_PROFILE_ENV } from "./transport";

export { MANAGED_STARTUP_CA_ENV, MANAGED_STARTUP_PROFILE_ENV } from "./transport";
export const MANAGED_STARTUP_RUNTIME_ENV_FILE = "/run/nemoclaw/managed-startup-runtime.env";
export const MANAGED_STARTUP_RUNTIME_EXECUTABLE =
  "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs";
export const MANAGED_STARTUP_MERGED_CA_FILE = "/run/nemoclaw/managed-startup-ca-bundle.pem";
export const MANAGED_STARTUP_COMPLETION_FILE = "/run/nemoclaw/managed-startup-complete.json";

const MANAGED_STARTUP_CORPORATE_CA_FILE = "/usr/local/share/nemoclaw/corporate-ca.pem";
const MANAGED_STARTUP_SYSTEM_CA_ANCHOR_DIRECTORY = "/usr/local/share/ca-certificates";
const MANAGED_STARTUP_SYSTEM_CA_ANCHOR_RE = /^nemoclaw-corporate-ca-[0-9]{2}\.crt$/u;
const SYSTEM_CA_BUNDLE_FILE = "/etc/ssl/certs/ca-certificates.crt";
const UPDATE_CA_CERTIFICATES_EXECUTABLE = "/usr/sbin/update-ca-certificates";
const MANAGED_STARTUP_TLS_ENV_NAMES = new Set([
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
]);
const MESSAGING_RUNTIME_PLAN_FILE = "/usr/local/share/nemoclaw/messaging-runtime-plan.json";
const ROOT_STATE_PARENT = "/var/lib/nemoclaw";
const ROOT_RUNTIME_DIRECTORY = "/run/nemoclaw";
const ROOT_OWNED_DIRECTORY_MODE = 0o755;
const MAX_TRUST_BUNDLE_BYTES = 4 * 1024 * 1024;
const HERMES_MANAGED_CONFIG_FILES = [
  "/sandbox/.hermes/config.yaml",
  "/sandbox/.hermes/.env",
] as const;
const HERMES_GENERATED_MANAGED_POLICY_FILE = "/sandbox/.hermes/managed-policy.json";
const HERMES_INSTALLED_MANAGED_POLICY_FILE = "/usr/local/share/nemoclaw/hermes-managed-policy.json";
const MAX_HERMES_MANAGED_POLICY_BYTES = 4 * 1024 * 1024;
const FIXED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SHA256_RE = /^[a-f0-9]{64}$/u;
export const MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION = 1;
const MAX_MANAGED_STARTUP_COMPLETION_BYTES = 4096;
const MAX_MANAGED_STARTUP_RUNTIME_ENVIRONMENT_BYTES = 512 * 1024;

export type ManagedStartupImageIdentity = "root" | "sandbox";

export interface ManagedStartupGenerateConfigConstructionAction {
  readonly kind: "generate-agent-config";
  readonly agent: ManagedStartupAgent;
  readonly runAs: "sandbox";
}

interface ManagedStartupApplyMessagingConstructionActionBase {
  readonly kind: "apply-messaging-plan";
  readonly agent: ManagedStartupMessagingAgent;
  readonly mode: "apply" | "clear";
}

export interface ManagedStartupApplyMessagingRuntimeConstructionAction
  extends ManagedStartupApplyMessagingConstructionActionBase {
  readonly phase: "runtime-setup";
  readonly runAs: "root";
}

export interface ManagedStartupApplyMessagingConfigConstructionAction
  extends ManagedStartupApplyMessagingConstructionActionBase {
  readonly phase: "post-agent-install";
  readonly runAs: "sandbox";
}

export type ManagedStartupApplyMessagingConstructionAction =
  | ManagedStartupApplyMessagingRuntimeConstructionAction
  | ManagedStartupApplyMessagingConfigConstructionAction;

export interface ManagedStartupConfigureDashboardConstructionAction {
  readonly kind: "configure-dashboard";
  readonly dashboard: ManagedStartupDashboard;
}

export type ManagedStartupImageConstructionAction =
  | ManagedStartupGenerateConfigConstructionAction
  | ManagedStartupApplyMessagingConstructionAction
  | ManagedStartupConfigureDashboardConstructionAction;

/**
 * The application mapper must produce this structural handoff only after it
 * decodes and revalidates the profile and its nested messaging plan.
 */
export interface ManagedStartupImageActionPlanInput {
  readonly agent: ManagedStartupAgent;
  readonly actions: readonly ManagedStartupImageConstructionAction[];
}

export interface ManagedStartupImageActionCommand {
  readonly action:
    | "generate-agent-config"
    | "messaging-runtime-setup"
    | "messaging-post-agent-install";
  readonly runAs: ManagedStartupImageIdentity;
  readonly argv: readonly string[];
}

export interface ManagedStartupImageApplyResult {
  readonly agent: ManagedStartupAgent;
  readonly adapterApplied: boolean;
  readonly fingerprint: string;
  readonly runtimeEnvironmentFile: string;
}

export interface ManagedStartupRootApplyResult extends ManagedStartupImageApplyResult {
  readonly transactionPending: boolean;
}

export interface ManagedStartupRootApplyOptions {
  /** One-attempt identity for managed bootstrap; null keeps the direct root-apply contract. */
  readonly bootstrapIdentity?: string | null;
}

export interface ManagedStartupCompletionMarker {
  readonly schemaVersion: typeof MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION;
  readonly agent: ManagedStartupAgent;
  readonly profileFingerprint: string;
  readonly runtimeEnvironmentSha256: string;
  readonly corporateCaMerged: boolean;
}

export class ManagedStartupImageActionPlanError extends Error {
  constructor(message: string) {
    super(`Cannot build managed startup image action plan: ${message}`);
    this.name = "ManagedStartupImageActionPlanError";
  }
}

export class ManagedStartupImageRuntimeError extends Error {
  constructor(message: string) {
    super(`Managed startup image application failed: ${message}`);
    this.name = "ManagedStartupImageRuntimeError";
  }
}

type Environment = Record<string, string | undefined>;

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function failActionPlan(message: string): never {
  throw new ManagedStartupImageActionPlanError(message);
}

function exactActionPlanAgent(value: string): ManagedStartupAgent {
  if ((MANAGED_STARTUP_AGENTS as readonly string[]).includes(value)) {
    return value as ManagedStartupAgent;
  }
  return failActionPlan(`unsupported agent ${JSON.stringify(value)}`);
}

function fail(message: string): never {
  throw new ManagedStartupImageRuntimeError(message);
}

export function validateManagedStartupApplicationRuntimePlan(
  plan: ManagedStartupApplicationRuntimePlan,
): ManagedStartupApplicationRuntimePlan {
  if (typeof plan !== "object" || plan === null) {
    return fail("application runtime plan must be an object");
  }
  const exportEnvironment = plan.exportEnvironment;
  const unsetEnvironment = plan.unsetEnvironment;
  if (
    typeof exportEnvironment !== "object" ||
    exportEnvironment === null ||
    Array.isArray(exportEnvironment) ||
    !Array.isArray(unsetEnvironment)
  ) {
    return fail("application runtime plan must contain exports and unsets");
  }
  const exports: Record<string, string> = {};
  for (const [name, value] of Object.entries(exportEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      return fail(`invalid application runtime environment key ${JSON.stringify(name)}`);
    }
    if (typeof value !== "string" || value.includes("\0") || /[\r\n]/u.test(value)) {
      return fail(`application runtime environment value for ${name} must be single-line text`);
    }
    exports[name] = value;
  }
  const unsets = new Set<string>();
  for (const name of unsetEnvironment) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      return fail(`invalid application runtime unset ${JSON.stringify(name)}`);
    }
    if (unsets.has(name)) {
      return fail(`duplicate application runtime unset ${name}`);
    }
    if (Object.hasOwn(exports, name)) {
      return fail(`application runtime cannot both export and unset ${name}`);
    }
    unsets.add(name);
  }
  return Object.freeze({
    exportEnvironment: Object.freeze(
      Object.fromEntries(
        Object.entries(exports).sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
    unsetEnvironment: Object.freeze([...unsets].sort()),
  });
}

export function applyManagedStartupCommandEnvironmentPlan(
  environment: Readonly<NodeJS.ProcessEnv>,
  plan: ManagedStartupApplicationRuntimePlan,
): NodeJS.ProcessEnv {
  const validated = validateManagedStartupApplicationRuntimePlan(plan);
  const applied: NodeJS.ProcessEnv = { ...environment };
  for (const name of [...Object.keys(validated.exportEnvironment), ...validated.unsetEnvironment]) {
    delete applied[name];
  }
  return applied;
}

function exactAgent(value: string): ManagedStartupAgent {
  if ((MANAGED_STARTUP_AGENTS as readonly string[]).includes(value)) {
    return value as ManagedStartupAgent;
  }
  return fail(`unsupported agent ${JSON.stringify(value)}`);
}

function managedTransactionProfile(
  expectedAgentInput: string,
  env: Environment = process.env,
): ManagedStartupProfile {
  requireRoot();
  const expectedAgent = exactAgent(expectedAgentInput);
  if (env.NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION !== "1") {
    fail("shared-state transactions require a complete managed image");
  }
  const encodedProfile = env[MANAGED_STARTUP_PROFILE_ENV];
  if (!encodedProfile) fail(`${MANAGED_STARTUP_PROFILE_ENV} is required`);
  const profile = decodeManagedStartupProfile(encodedProfile);
  if (profile.agent !== expectedAgent) {
    fail(`shared-state transaction profile targets ${profile.agent}, expected ${expectedAgent}`);
  }
  return profile;
}

function requireRoot(): void {
  if (process.geteuid?.() !== 0) {
    fail("managed startup requires container effective uid 0");
  }
}

function modeOf(stat: fs.Stats): number {
  return stat.mode & 0o777;
}

function requireRootOwnedDirectory(target: string, mode: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    fail(`required root-owned directory is missing: ${target}`);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    modeOf(stat) !== mode
  ) {
    fail(`${target} must be a root:root directory with mode ${mode.toString(8)}`);
  }
}

function ensureRootOwnedDirectory(target: string, mode = ROOT_OWNED_DIRECTORY_MODE): void {
  const parent = path.dirname(target);
  const parentStat = fs.lstatSync(parent);
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentStat.uid !== 0 ||
    parentStat.gid !== 0 ||
    (modeOf(parentStat) & 0o022) !== 0
  ) {
    fail(`refusing unsafe parent directory for ${target}`);
  }
  try {
    fs.mkdirSync(target, { mode });
    fs.chownSync(target, 0, 0);
    fs.chmodSync(target, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      fail(`could not create ${target}`);
    }
  }
  requireRootOwnedDirectory(target, mode);
}

function requireSafeExistingRootTarget(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    fail(`could not inspect ${target}`);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== 0 ||
    stat.gid !== 0
  ) {
    fail(`refusing to replace unsafe root-owned file ${target}`);
  }
}

export function atomicWriteRootFile(target: string, contents: string | Buffer, mode: number): void {
  const parent = path.dirname(target);
  const parentStat = fs.lstatSync(parent);
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentStat.uid !== 0 ||
    parentStat.gid !== 0 ||
    (modeOf(parentStat) & 0o022) !== 0
  ) {
    fail(`refusing unsafe root-owned file parent ${parent}`);
  }
  requireSafeExistingRootTarget(target);
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${randomBytes(12).toString("hex")}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchownSync(descriptor, 0, 0);
    fs.writeFileSync(descriptor, contents);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the primary write failure.
    }
    fail(`could not atomically write ${target}: ${(error as Error).message}`);
  }
  const stat = fs.lstatSync(target);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    modeOf(stat) !== mode
  ) {
    fail(`root-owned output failed metadata verification: ${target}`);
  }
}

function removeSafeRootFile(target: string): void {
  requireSafeExistingRootTarget(target);
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail(`could not remove ${target}`);
    }
  }
}

function trustedExecutable(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return (
      !stat.isSymbolicLink() &&
      stat.isFile() &&
      stat.uid === 0 &&
      stat.gid === 0 &&
      (modeOf(stat) & 0o022) === 0 &&
      (modeOf(stat) & 0o111) !== 0
    );
  } catch {
    return false;
  }
}

function readSandboxIdentity(): { readonly uid: string; readonly gid: string } {
  const readId = (flag: "-u" | "-g"): string => {
    const result = spawnSync("/usr/bin/id", [flag, "sandbox"], {
      encoding: "utf8",
      env: { PATH: FIXED_PATH },
    });
    const value = result.stdout.trim();
    if (result.status !== 0 || !/^[1-9][0-9]*$/u.test(value)) {
      fail("could not resolve the sandbox account");
    }
    return value;
  };
  return { uid: readId("-u"), gid: readId("-g") };
}

export function managedStartupSandboxPrefix(): readonly string[] {
  if (trustedExecutable("/usr/bin/setpriv")) {
    const identity = readSandboxIdentity();
    return [
      "/usr/bin/setpriv",
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--init-groups",
      "--",
    ];
  }
  return fail("a trusted setpriv executable is required");
}

function commandEnvironment(
  configurationEnvironment: Readonly<Record<string, string>>,
  applicationRuntime: ManagedStartupApplicationRuntimePlan,
): NodeJS.ProcessEnv {
  const env = applyManagedStartupCommandEnvironmentPlan(
    {
      ...process.env,
      ...configurationEnvironment,
      HOME: "/sandbox",
      PATH: FIXED_PATH,
      NPM_CONFIG_OFFLINE: "true",
      npm_config_offline: "true",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INDEX: "1",
      UV_OFFLINE: "1",
    },
    applicationRuntime,
  );
  delete env[MANAGED_STARTUP_PROFILE_ENV];
  delete env[MANAGED_STARTUP_CA_ENV];
  return env;
}

function execute(
  argv: readonly string[],
  runAs: ManagedStartupImageIdentity,
  configurationEnvironment: Readonly<Record<string, string>>,
  applicationRuntime: ManagedStartupApplicationRuntimePlan,
  capture = false,
): CommandResult {
  if (argv.length === 0) fail("refusing an empty managed startup command");
  const command = runAs === "sandbox" ? [...managedStartupSandboxPrefix(), ...argv] : [...argv];
  const result = spawnSync(command[0] as string, command.slice(1), {
    encoding: "utf8",
    env: commandEnvironment(configurationEnvironment, applicationRuntime),
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) {
    fail(`could not execute ${argv[0]}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = capture ? `: ${(result.stderr || result.stdout).trim()}` : "";
    fail(`${argv[0]} exited with status ${String(result.status ?? "unknown")}${detail}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function generatorCommand(agent: ManagedStartupAgent): readonly string[] {
  switch (agent) {
    case "openclaw":
      return [
        "/usr/local/bin/node",
        "--experimental-strip-types",
        "/scripts/generate-openclaw-config.mts",
      ];
    case "hermes":
      return [
        "/usr/local/bin/node",
        "--experimental-strip-types",
        "/opt/nemoclaw-hermes-config/generate-config.ts",
      ];
    case "langchain-deepagents-code":
      return [
        "/usr/local/bin/node",
        "--experimental-strip-types",
        "/opt/nemoclaw-deepagents-code/generate-config.ts",
      ];
    case "pi":
      return [
        "/usr/local/bin/node",
        "--experimental-strip-types",
        "/opt/nemoclaw-pi/generate-config.ts",
      ];
  }
}

function messagingCommand(
  agent: ManagedStartupMessagingAgent,
  phase: "runtime-setup" | "post-agent-install",
  mode: "apply" | "clear",
): readonly string[] {
  return [
    "/usr/local/bin/node",
    "--experimental-strip-types",
    "/src/lib/messaging/applier/build/messaging-build-applier.mts",
    "--agent",
    agent,
    "--phase",
    phase,
    "--mode",
    mode,
    ...(phase === "post-agent-install" ? ["--managed-startup-runtime"] : []),
  ];
}

function assertActionAgent(
  inputAgent: ManagedStartupAgent,
  actionAgent: ManagedStartupAgent,
): void {
  if (inputAgent !== actionAgent) {
    failActionPlan(`action for ${actionAgent} cannot be used by ${inputAgent}`);
  }
}

/**
 * Convert the closed application-action vocabulary into immutable image
 * commands. The vocabulary cannot express agent installation, package-manager
 * access, arbitrary command execution, or runtime activation.
 */
export function buildManagedStartupImageActionPlan(
  input: ManagedStartupImageActionPlanInput,
): readonly ManagedStartupImageActionCommand[] {
  const inputAgent = exactActionPlanAgent(input.agent);
  const commands: ManagedStartupImageActionCommand[] = [];
  let dashboardActions = 0;
  let generateActions = 0;
  let runtimeMessagingActions = 0;
  let postMessagingActions = 0;

  for (const action of input.actions) {
    switch (action.kind) {
      case "configure-dashboard": {
        if (action.dashboard.agent !== input.agent) {
          failActionPlan(
            `dashboard for ${action.dashboard.agent} cannot be used by ${input.agent}`,
          );
        }
        dashboardActions += 1;
        break;
      }
      case "generate-agent-config": {
        assertActionAgent(inputAgent, exactActionPlanAgent(action.agent));
        if (action.runAs !== "sandbox") {
          failActionPlan("agent configuration generation must run as sandbox");
        }
        generateActions += 1;
        commands.push({
          action: "generate-agent-config",
          runAs: action.runAs,
          argv: generatorCommand(action.agent),
        });
        break;
      }
      case "apply-messaging-plan": {
        assertActionAgent(inputAgent, exactActionPlanAgent(action.agent));
        if (action.mode !== "apply" && action.mode !== "clear") {
          failActionPlan("messaging intent must be apply or clear");
        }
        if (action.phase === "runtime-setup") {
          if (action.runAs !== "root") {
            failActionPlan("messaging runtime setup must run as root");
          }
          runtimeMessagingActions += 1;
          commands.push({
            action: "messaging-runtime-setup",
            runAs: action.runAs,
            argv: messagingCommand(action.agent, action.phase, action.mode),
          });
        } else if (action.phase === "post-agent-install") {
          if (action.runAs !== "sandbox") {
            failActionPlan("messaging post-agent configuration must run as sandbox");
          }
          postMessagingActions += 1;
          commands.push({
            action: "messaging-post-agent-install",
            runAs: action.runAs,
            argv: messagingCommand(action.agent, action.phase, action.mode),
          });
        } else {
          failActionPlan("unsupported messaging construction phase");
        }
        break;
      }
      default:
        failActionPlan("unsupported managed startup construction action");
    }
  }

  if (dashboardActions !== 1) {
    failActionPlan("exactly one dashboard construction action is required");
  }
  if (generateActions !== 1) {
    failActionPlan("exactly one agent config construction action is required");
  }
  const supportsMessaging = (MANAGED_STARTUP_MESSAGING_AGENTS as readonly string[]).includes(
    inputAgent,
  );
  const expectedMessagingActions = supportsMessaging ? 1 : 0;
  if (
    runtimeMessagingActions !== expectedMessagingActions ||
    postMessagingActions !== expectedMessagingActions
  ) {
    failActionPlan(
      `${inputAgent} requires ${String(expectedMessagingActions)} action for each messaging phase`,
    );
  }
  const expectedOrder = supportsMessaging
    ? ["messaging-runtime-setup", "generate-agent-config", "messaging-post-agent-install"]
    : ["generate-agent-config"];
  if (commands.some((command, index) => command.action !== expectedOrder[index])) {
    failActionPlan(`${inputAgent} image actions are not in the required construction order`);
  }

  return Object.freeze(
    commands.map((command) =>
      Object.freeze({
        ...command,
        argv: Object.freeze([...command.argv]),
      }),
    ),
  );
}

function prepareMessagingRuntimeTarget(mode: "apply" | "clear"): void {
  if (mode === "clear") {
    removeSafeRootFile(MESSAGING_RUNTIME_PLAN_FILE);
    return;
  }
  requireSafeExistingRootTarget(MESSAGING_RUNTIME_PLAN_FILE);
  try {
    fs.unlinkSync(MESSAGING_RUNTIME_PLAN_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("could not prepare the messaging runtime-plan target");
    }
  }
}

function verifyMessagingRuntimeTarget(mode: "apply" | "clear"): void {
  if (mode === "clear") {
    if (fs.existsSync(MESSAGING_RUNTIME_PLAN_FILE)) {
      fail("clear messaging profile left a runtime-plan artifact");
    }
    return;
  }
  const stat = fs.lstatSync(MESSAGING_RUNTIME_PLAN_FILE);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    modeOf(stat) !== 0o644
  ) {
    fail("messaging runtime-plan artifact failed root ownership validation");
  }
}

function runInternalSandboxAction(
  action: "write-openclaw-hash" | "write-hermes-compat-hash",
  configurationEnvironment: Readonly<Record<string, string>>,
  applicationRuntime: ManagedStartupApplicationRuntimePlan,
  extraEnvironment: Readonly<Record<string, string>> = {},
): void {
  execute(
    ["/usr/local/bin/node", MANAGED_STARTUP_RUNTIME_EXECUTABLE, `--internal-${action}`],
    "sandbox",
    { ...configurationEnvironment, ...extraEnvironment },
    applicationRuntime,
  );
}

function sealOpenClawConfiguration(
  configurationEnvironment: Readonly<Record<string, string>>,
  applicationRuntime: ManagedStartupApplicationRuntimePlan,
): void {
  const validation = execute(
    ["/usr/local/bin/openclaw", "config", "validate", "--json"],
    "sandbox",
    {
      ...configurationEnvironment,
      OPENCLAW_CONFIG_PATH: "/sandbox/.openclaw/openclaw.json",
    },
    applicationRuntime,
    true,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(validation.stdout);
  } catch {
    fail("OpenClaw config validation did not emit JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).valid !== true
  ) {
    fail("OpenClaw rejected the generated managed startup config");
  }
  runInternalSandboxAction("write-openclaw-hash", configurationEnvironment, applicationRuntime);
}

export interface StableRegularFile {
  readonly bytes: Buffer;
  readonly stat: fs.BigIntStats;
}

interface NumericIdentity {
  readonly uid: number;
  readonly gid: number;
}

function sameStableFileMetadata(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function readStableRegularFileSnapshot(target: string, maxBytes: number): StableRegularFile {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    fail("O_NOFOLLOW is unavailable for managed startup file reads");
  }
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonblock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    fail(`refusing unsafe or unreadable file ${target}`);
  }

  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maxBytes)
    ) {
      fail(`refusing unsafe or oversized file ${target}`);
    }

    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const overflowBytes = fs.readSync(descriptor, overflow, 0, 1, offset);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.length || overflowBytes !== 0 || !sameStableFileMetadata(before, after)) {
      fail(`${target} changed while it was read`);
    }
    return { bytes, stat: before };
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      fail(`could not close safely opened file ${target}`);
    }
  }
}

export function readStableRegularFile(target: string, maxBytes: number): Buffer {
  return readStableRegularFileSnapshot(target, maxBytes).bytes;
}

/** Promote the generator output to the one root-owned policy artifact used at runtime. */
export function installHermesManagedPolicy(
  source = HERMES_GENERATED_MANAGED_POLICY_FILE,
  target = HERMES_INSTALLED_MANAGED_POLICY_FILE,
): void {
  const generated = readStableRegularFileSnapshot(source, MAX_HERMES_MANAGED_POLICY_BYTES);
  atomicWriteRootFile(target, generated.bytes, 0o444);
  const current = fs.lstatSync(source, { bigint: true });
  if (!sameStableFileMetadata(generated.stat, current)) {
    fail(`Hermes managed policy changed before source cleanup: ${source}`);
  }
  fs.unlinkSync(source);
}

/**
 * Restore the mutable Hermes image contract after its sandbox-side generator
 * atomically replaces config.yaml or .env with mode 0600. The mode transition
 * is performed through the already-authenticated descriptor, never by path.
 */
export function normalizeHermesManagedConfigDescriptor(
  target: string,
  sandboxIdentity: NumericIdentity,
): void {
  if (
    !Number.isSafeInteger(sandboxIdentity.uid) ||
    sandboxIdentity.uid <= 0 ||
    !Number.isSafeInteger(sandboxIdentity.gid) ||
    sandboxIdentity.gid <= 0
  ) {
    fail("invalid sandbox identity for Hermes descriptor normalization");
  }
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    fail("O_NOFOLLOW is unavailable for Hermes descriptor normalization");
  }
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonblock);
  } catch {
    fail(`refusing unsafe Hermes managed config descriptor ${target}`);
  }

  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const beforeMode = Number(before.mode & 0o777n);
    const mutable =
      before.uid === BigInt(sandboxIdentity.uid) &&
      before.gid === BigInt(sandboxIdentity.gid) &&
      (beforeMode === 0o600 || beforeMode === 0o640);
    if (!before.isFile() || before.nlink !== 1n || !mutable) {
      fail(`refusing unexpected Hermes managed config descriptor ${target}`);
    }

    const expectedMode = 0o640;
    if (beforeMode === 0o600) {
      try {
        fs.fchmodSync(descriptor, expectedMode);
      } catch {
        fail(`could not normalize Hermes managed config descriptor ${target}`);
      }
    }

    const after = fs.fstatSync(descriptor, { bigint: true });
    let pathAfter: fs.BigIntStats;
    try {
      pathAfter = fs.lstatSync(target, { bigint: true });
    } catch {
      fail(`Hermes managed config descriptor disappeared during normalization: ${target}`);
    }
    const expectedUid = BigInt(sandboxIdentity.uid);
    const expectedGid = BigInt(sandboxIdentity.gid);
    if (
      !after.isFile() ||
      after.nlink !== 1n ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.uid !== expectedUid ||
      after.gid !== expectedGid ||
      Number(after.mode & 0o777n) !== expectedMode ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameStableFileMetadata(after, pathAfter)
    ) {
      fail(`Hermes managed config descriptor changed during normalization: ${target}`);
    }
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      fail(`could not close Hermes managed config descriptor ${target}`);
    }
  }
}

function normalizeHermesManagedConfiguration(): void {
  const identity = readSandboxIdentity();
  const sandboxIdentity = {
    uid: Number(identity.uid),
    gid: Number(identity.gid),
  };
  for (const target of HERMES_MANAGED_CONFIG_FILES) {
    normalizeHermesManagedConfigDescriptor(target, sandboxIdentity);
  }
}

function sealHermesConfiguration(
  configurationEnvironment: Readonly<Record<string, string>>,
  applicationRuntime: ManagedStartupApplicationRuntimePlan,
): void {
  const configPath = "/sandbox/.hermes/config.yaml";
  const envPath = "/sandbox/.hermes/.env";
  const config = readStableRegularFile(configPath, 4 * 1024 * 1024);
  const env = readStableRegularFile(envPath, 512 * 1024);
  const digest = execute(
    [
      "/opt/hermes/.venv/bin/python3",
      "-I",
      "/usr/local/lib/nemoclaw/build-hermes-mcp-digest.py",
      "--guard",
      "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
      "--config",
      configPath,
    ],
    "root",
    configurationEnvironment,
    applicationRuntime,
    true,
  ).stdout.trim();
  if (!SHA256_RE.test(digest)) {
    fail("Hermes MCP digest helper returned an invalid digest");
  }
  const hashText = [
    `${createHash("sha256").update(config).digest("hex")}  ${configPath}`,
    `${createHash("sha256").update(env).digest("hex")}  ${envPath}`,
    `# nemoclaw-hermes-mcp-state-v1 intended=${digest} applied=${digest}`,
    "",
  ].join("\n");
  atomicWriteRootFile("/etc/nemoclaw/hermes.config-hash", hashText, 0o444);
  runInternalSandboxAction(
    "write-hermes-compat-hash",
    configurationEnvironment,
    applicationRuntime,
    {
      NEMOCLAW_MANAGED_HERMES_HASH_B64: Buffer.from(hashText, "utf8").toString("base64"),
    },
  );
}

function installRootOwnedMaterials(materials: readonly ManagedStartupAgentMaterial[]): void {
  for (const material of materials) {
    if (material.kind !== "root-owned-file") continue;
    if (material.owner !== "root" || material.group !== "root" || material.mode !== 0o444) {
      fail(`unsupported root-owned material contract for ${material.path}`);
    }
    atomicWriteRootFile(material.path, material.contents, material.mode);
  }
}

function verifyRootOwnedMaterials(materials: readonly ManagedStartupAgentMaterial[]): void {
  for (const material of materials) {
    if (material.kind !== "root-owned-file") continue;
    const expected = Buffer.from(material.contents, "utf8");
    const { bytes, stat } = readStableRegularFileSnapshot(material.path, expected.length);
    if (
      stat.nlink !== 1n ||
      stat.uid !== 0n ||
      stat.gid !== 0n ||
      Number(stat.mode & 0o777n) !== material.mode ||
      !bytes.equals(expected)
    ) {
      fail(`committed root-owned material drifted: ${material.path}`);
    }
  }
}

function installCorporateCa(corporateCaPath: string | null): void {
  if (corporateCaPath === null) {
    removeSafeRootFile(MANAGED_STARTUP_CORPORATE_CA_FILE);
    return;
  }
  const bytes = readStableRegularFile(corporateCaPath, 128 * 1024);
  atomicWriteRootFile(MANAGED_STARTUP_CORPORATE_CA_FILE, bytes, 0o444);
}

function corporateCaCertificateBlocks(corporateCaPath: string): readonly string[] {
  const corporate = readStableRegularFile(corporateCaPath, 128 * 1024).toString("utf8");
  const blocks = corporate.match(PEM_CERTIFICATE_RE_GLOBAL);
  if (!blocks || blocks.length === 0) {
    fail("corporate CA material contains no certificate");
  }
  for (const block of blocks) {
    try {
      if (!new X509Certificate(block).ca) {
        fail("corporate CA material contains a certificate that is not a CA");
      }
    } catch (error) {
      if (error instanceof ManagedStartupImageRuntimeError) throw error;
      fail("corporate CA material contains an invalid certificate");
    }
  }
  return blocks.map((block) => `${block.trim()}\n`);
}

function managedSystemCaAnchorNames(): readonly string[] {
  try {
    fs.lstatSync(MANAGED_STARTUP_SYSTEM_CA_ANCHOR_DIRECTORY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    fail("could not inspect the managed system CA anchor directory");
  }
  requireRootOwnedDirectory(
    MANAGED_STARTUP_SYSTEM_CA_ANCHOR_DIRECTORY,
    ROOT_OWNED_DIRECTORY_MODE,
  );
  try {
    return (fs.readdirSync(MANAGED_STARTUP_SYSTEM_CA_ANCHOR_DIRECTORY) as string[])
      .filter((name) => MANAGED_STARTUP_SYSTEM_CA_ANCHOR_RE.test(name))
      .sort();
  } catch (error) {
    fail("could not inspect the managed system CA anchors");
  }
}

function refreshSystemCaBundle(): void {
  if (!trustedExecutable(UPDATE_CA_CERTIFICATES_EXECUTABLE)) {
    fail(`a trusted ${UPDATE_CA_CERTIFICATES_EXECUTABLE} executable is required`);
  }
  const result = spawnSync(UPDATE_CA_CERTIFICATES_EXECUTABLE, [], {
    encoding: "utf8",
    env: { PATH: FIXED_PATH },
    stdio: "inherit",
  });
  if (result.error) {
    fail(`could not execute ${UPDATE_CA_CERTIFICATES_EXECUTABLE}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${UPDATE_CA_CERTIFICATES_EXECUTABLE} exited with status ${String(result.status ?? "unknown")}`,
    );
  }
}

function requireSystemCaBundleContains(blocks: readonly string[]): void {
  const systemBundle = safeTrustBundle(SYSTEM_CA_BUNDLE_FILE);
  if (systemBundle === null) fail("the refreshed system CA bundle is missing");
  const systemBlocks = systemBundle.toString("utf8").match(PEM_CERTIFICATE_RE_GLOBAL) ?? [];
  const systemFingerprints = new Set<string>();
  for (const block of systemBlocks) {
    try {
      systemFingerprints.add(new X509Certificate(block).fingerprint256);
    } catch {
      fail("the refreshed system CA bundle contains an invalid certificate");
    }
  }
  for (const block of blocks) {
    if (!systemFingerprints.has(new X509Certificate(block).fingerprint256)) {
      fail("the refreshed system CA bundle does not contain the corporate CA");
    }
  }
}

export function installCorporateCaSystemAnchors(corporateCaPath: string | null): void {
  const existingNames = managedSystemCaAnchorNames();
  if (corporateCaPath === null) {
    for (const name of existingNames) {
      removeSafeRootFile(path.join(MANAGED_STARTUP_SYSTEM_CA_ANCHOR_DIRECTORY, name));
    }
    refreshSystemCaBundle();
    return;
  }

  ensureRootOwnedDirectory(MANAGED_STARTUP_SYSTEM_CA_ANCHOR_DIRECTORY);
  const blocks = corporateCaCertificateBlocks(corporateCaPath);
  const expectedNames = blocks.map(
    (_block, index) => `nemoclaw-corporate-ca-${String(index + 1).padStart(2, "0")}.crt`,
  );
  for (const name of existingNames) {
    if (!expectedNames.includes(name)) {
      removeSafeRootFile(path.join(MANAGED_STARTUP_SYSTEM_CA_ANCHOR_DIRECTORY, name));
    }
  }
  for (const [index, name] of expectedNames.entries()) {
    atomicWriteRootFile(
      path.join(MANAGED_STARTUP_SYSTEM_CA_ANCHOR_DIRECTORY, name),
      blocks[index] as string,
      0o444,
    );
  }
  refreshSystemCaBundle();
  requireSystemCaBundleContains(blocks);
}

function safeTrustBundle(target: string): Buffer | null {
  try {
    const { bytes, stat } = readStableRegularFileSnapshot(target, MAX_TRUST_BUNDLE_BYTES);
    if (Number(stat.mode & 0o022n) !== 0) {
      fail(`refusing unsafe trust bundle ${target}`);
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function mergeCorporateCa(corporateCaPath: string | null): boolean {
  if (corporateCaPath === null) {
    removeSafeRootFile(MANAGED_STARTUP_MERGED_CA_FILE);
    return false;
  }
  const corporate = readStableRegularFile(corporateCaPath, 128 * 1024);
  const candidates = [
    "/etc/openshell-tls/ca-bundle.pem",
    process.env.SSL_CERT_FILE ?? "",
    "/etc/ssl/certs/ca-certificates.crt",
  ].filter(
    (candidate, index, values) =>
      candidate &&
      candidate !== MANAGED_STARTUP_MERGED_CA_FILE &&
      values.indexOf(candidate) === index,
  );
  let base: Buffer | null = null;
  for (const candidate of candidates) {
    base = safeTrustBundle(candidate);
    if (base) break;
  }
  const merged = Buffer.concat([
    ...(base ? [base, Buffer.from("\n", "utf8")] : []),
    corporate,
    ...(corporate.at(-1) === 0x0a ? [] : [Buffer.from("\n", "utf8")]),
  ]);
  atomicWriteRootFile(MANAGED_STARTUP_MERGED_CA_FILE, merged, 0o444);
  return true;
}

function shellSingleQuote(value: string): string {
  if (value.includes("\0") || /[\r\n]/u.test(value)) {
    fail("runtime environment values must be single-line text");
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function serializeManagedStartupRuntimeEnvironment(
  environment: Readonly<Record<string, string>>,
  corporateCaMerged: boolean,
  configurationEnvironment: Readonly<Record<string, string>> = {},
  applicationRuntime: ManagedStartupApplicationRuntimePlan = {
    exportEnvironment: {},
    unsetEnvironment: [],
  },
): string {
  const { output, unsetNames } = materializeManagedStartupRuntimeEnvironment(
    environment,
    corporateCaMerged,
    configurationEnvironment,
    applicationRuntime,
  );
  const unsetLines = unsetNames.map((name) => `unset ${name}`);
  const exportLines = Object.entries(output)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `export ${name}=${shellSingleQuote(value)}`);
  return `${[...unsetLines, ...exportLines].join("\n")}\n`;
}

function materializeManagedStartupRuntimeEnvironment(
  environment: Readonly<Record<string, string>>,
  corporateCaMerged: boolean,
  configurationEnvironment: Readonly<Record<string, string>> = {},
  applicationRuntime: ManagedStartupApplicationRuntimePlan = {
    exportEnvironment: {},
    unsetEnvironment: [],
  },
): { output: Record<string, string>; unsetNames: string[] } {
  const validatedApplicationRuntime =
    validateManagedStartupApplicationRuntimePlan(applicationRuntime);
  const output: Record<string, string> = {
    ...environment,
    ...validatedApplicationRuntime.exportEnvironment,
    NEMOCLAW_MANAGED_STARTUP_APPLIED: "1",
  };
  if (corporateCaMerged) {
    for (const name of MANAGED_STARTUP_TLS_ENV_NAMES) {
      delete output[name];
    }
    output._NEMOCLAW_CORPORATE_CA_MERGED = "1";
  }
  for (const name of [...Object.keys(configurationEnvironment), ...Object.keys(output)]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      fail(`invalid runtime environment key ${JSON.stringify(name)}`);
    }
  }
  const unsetNames = new Set([
    ...Object.keys(configurationEnvironment).filter(
      (name) =>
        !Object.hasOwn(output, name) &&
        (!corporateCaMerged || !MANAGED_STARTUP_TLS_ENV_NAMES.has(name)),
    ),
    ...validatedApplicationRuntime.unsetEnvironment.filter(
      (name) => !corporateCaMerged || !MANAGED_STARTUP_TLS_ENV_NAMES.has(name),
    ),
  ]);
  for (const name of validatedApplicationRuntime.unsetEnvironment) {
    if (Object.hasOwn(output, name)) {
      fail(`runtime environment cannot both export and unset ${name}`);
    }
  }
  for (const name of unsetNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      fail(`invalid runtime environment key ${JSON.stringify(name)}`);
    }
  }
  return { output, unsetNames: [...unsetNames].sort() };
}

export function serializeManagedStartupCompletionMarker(
  marker: ManagedStartupCompletionMarker,
): string {
  if (
    marker.schemaVersion !== MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION ||
    !(MANAGED_STARTUP_AGENTS as readonly string[]).includes(marker.agent) ||
    !SHA256_RE.test(marker.profileFingerprint) ||
    !SHA256_RE.test(marker.runtimeEnvironmentSha256) ||
    typeof marker.corporateCaMerged !== "boolean"
  ) {
    fail("managed startup completion marker is invalid");
  }
  return `${JSON.stringify({
    agent: marker.agent,
    corporateCaMerged: marker.corporateCaMerged,
    profileFingerprint: marker.profileFingerprint,
    runtimeEnvironmentSha256: marker.runtimeEnvironmentSha256,
    schemaVersion: marker.schemaVersion,
  })}\n`;
}

function parseManagedStartupCompletionMarker(text: string): ManagedStartupCompletionMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("managed startup completion marker is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("managed startup completion marker must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    "agent",
    "corporateCaMerged",
    "profileFingerprint",
    "runtimeEnvironmentSha256",
    "schemaVersion",
  ];
  if (
    Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",") ||
    record.schemaVersion !== MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION ||
    typeof record.agent !== "string" ||
    !(MANAGED_STARTUP_AGENTS as readonly string[]).includes(record.agent) ||
    typeof record.profileFingerprint !== "string" ||
    !SHA256_RE.test(record.profileFingerprint) ||
    typeof record.runtimeEnvironmentSha256 !== "string" ||
    !SHA256_RE.test(record.runtimeEnvironmentSha256) ||
    typeof record.corporateCaMerged !== "boolean"
  ) {
    fail("managed startup completion marker has an invalid schema");
  }
  const marker = {
    schemaVersion: MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION,
    agent: record.agent as ManagedStartupAgent,
    profileFingerprint: record.profileFingerprint,
    runtimeEnvironmentSha256: record.runtimeEnvironmentSha256,
    corporateCaMerged: record.corporateCaMerged,
  } as const;
  if (serializeManagedStartupCompletionMarker(marker) !== text) {
    fail("managed startup completion marker is not canonical");
  }
  return marker;
}

export function verifyManagedStartupImageCompletion(
  expectedAgentInput: string,
  expectedFingerprint: string,
  completionFile: string = MANAGED_STARTUP_COMPLETION_FILE,
  runtimeEnvironmentFile: string = MANAGED_STARTUP_RUNTIME_ENV_FILE,
): { readonly agent: ManagedStartupAgent; readonly fingerprint: string } {
  const expectedAgent = exactAgent(expectedAgentInput);
  if (!SHA256_RE.test(expectedFingerprint)) {
    fail("startup completion expected profile fingerprint is invalid");
  }
  const { bytes, stat } = readStableRegularFileSnapshot(
    completionFile,
    MAX_MANAGED_STARTUP_COMPLETION_BYTES,
  );
  if (
    stat.nlink !== 1n ||
    stat.uid !== 0n ||
    stat.gid !== 0n ||
    Number(stat.mode & 0o777n) !== 0o444
  ) {
    fail("managed startup completion marker must be root:root mode 0444");
  }
  const marker = parseManagedStartupCompletionMarker(bytes.toString("utf8"));
  if (marker.agent !== expectedAgent || marker.profileFingerprint !== expectedFingerprint) {
    fail("managed startup completion marker does not match the requested profile");
  }
  const runtimeEnvironment = readStableRegularFileSnapshot(
    runtimeEnvironmentFile,
    MAX_MANAGED_STARTUP_RUNTIME_ENVIRONMENT_BYTES,
  );
  if (
    runtimeEnvironment.stat.nlink !== 1n ||
    runtimeEnvironment.stat.uid !== 0n ||
    runtimeEnvironment.stat.gid !== 0n ||
    Number(runtimeEnvironment.stat.mode & 0o777n) !== 0o444
  ) {
    fail("managed startup runtime environment must be root:root mode 0444");
  }
  const runtimeEnvironmentSha256 = createHash("sha256")
    .update(runtimeEnvironment.bytes)
    .digest("hex");
  if (runtimeEnvironmentSha256 !== marker.runtimeEnvironmentSha256) {
    fail("managed startup completion marker runtime environment digest mismatch");
  }
  return { agent: expectedAgent, fingerprint: expectedFingerprint };
}

export function waitForManagedStartupImageCompletion(
  expectedAgentInput: string,
  expectedFingerprint: string,
  timeoutSeconds = 600,
): { readonly agent: ManagedStartupAgent; readonly fingerprint: string } {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    fail("startup completion wait timeout must be an integer from 1 to 3600 seconds");
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    try {
      return verifyManagedStartupImageCompletion(expectedAgentInput, expectedFingerprint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) {
        fail(`startup completion was not published within ${String(timeoutSeconds)} seconds`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function applyAdapter(
  context: ManagedStartupAdapterContext,
  mapped: ManagedStartupAgentEnvironment,
): void {
  if (mapped.agent !== context.agent) {
    fail(`mapped ${mapped.agent} environment for ${context.agent}`);
  }
  const commandPlan = buildManagedStartupImageActionPlan({
    agent: mapped.agent,
    actions: mapped.actions,
  });
  let commandIndex = 0;
  for (const action of mapped.actions) {
    if (action.kind === "configure-dashboard") continue;
    const command = commandPlan[commandIndex];
    if (!command) fail(`missing image command for ${action.kind}`);
    commandIndex += 1;
    if (action.kind === "apply-messaging-plan") {
      if (action.phase === "runtime-setup") {
        prepareMessagingRuntimeTarget(action.mode);
      }
      execute(
        command.argv,
        command.runAs,
        mapped.configurationEnvironment,
        mapped.applicationRuntime,
      );
      if (action.phase === "runtime-setup") {
        verifyMessagingRuntimeTarget(action.mode);
      }
      continue;
    }
    execute(
      command.argv,
      command.runAs,
      mapped.configurationEnvironment,
      mapped.applicationRuntime,
    );
  }
  if (commandIndex !== commandPlan.length) {
    fail("image action plan contains an unmatched command");
  }

  switch (context.agent) {
    case "openclaw":
      sealOpenClawConfiguration(mapped.configurationEnvironment, mapped.applicationRuntime);
      break;
    case "hermes":
      installHermesManagedPolicy();
      sealHermesConfiguration(mapped.configurationEnvironment, mapped.applicationRuntime);
      // Normalize before the coordinator commits a newly applied profile so
      // the durable transaction never records generator-created 0600 files as
      // a completed mutable image contract.
      normalizeHermesManagedConfiguration();
      break;
    case "langchain-deepagents-code":
      break;
  }
  installRootOwnedMaterials(mapped.materials);
  installCorporateCa(context.corporateCaPath);
  installCorporateCaSystemAnchors(context.corporateCaPath);
  mergeCorporateCa(context.corporateCaPath);
}

function adapters(mapped: ManagedStartupAgentEnvironment): readonly ManagedStartupAgentAdapter[] {
  return MANAGED_STARTUP_AGENTS.map((agent) => ({
    agent,
    apply: (context: ManagedStartupAdapterContext) => applyAdapter(context, mapped),
  }));
}

export async function applyManagedStartupImageProfile(
  expectedAgentInput: string,
  env: Environment = process.env,
): Promise<ManagedStartupImageApplyResult> {
  requireRoot();
  const expectedAgent = exactAgent(expectedAgentInput);
  if (env.NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION !== "1") {
    fail("startup profiles require a complete managed image");
  }
  const encodedProfile = env[MANAGED_STARTUP_PROFILE_ENV];
  if (!encodedProfile) fail(`${MANAGED_STARTUP_PROFILE_ENV} is required`);
  let profile;
  try {
    profile = decodeManagedStartupProfile(encodedProfile);
  } catch (error) {
    fail((error as Error).message);
  }
  if (profile.agent !== expectedAgent) {
    fail(`managed startup profile targets ${profile.agent}, expected ${expectedAgent}`);
  }
  const mapped = mapManagedStartupProfileToAgentEnvironment(profile, env);
  validateManagedStartupApplicationRuntimePlan(mapped.applicationRuntime);

  ensureRootOwnedDirectory(ROOT_STATE_PARENT);
  ensureRootOwnedDirectory(ROOT_RUNTIME_DIRECTORY);
  const result = await coordinateManagedStartupApplication(
    {
      encodedProfile,
      expectedAgent,
      ...(env[MANAGED_STARTUP_CA_ENV] === undefined
        ? {}
        : { corporateCaB64: env[MANAGED_STARTUP_CA_ENV] }),
    },
    adapters(mapped),
  );
  if (mapped.agent !== result.application.profile.agent) {
    fail(`mapped ${mapped.agent} environment for ${result.application.profile.agent}`);
  }
  if (expectedAgent === "hermes" && !result.adapterApplied) {
    // Committed startup replays still repair generator-created 0600 files.
    normalizeHermesManagedConfiguration();
  }
  let corporateCaMerged: boolean;
  if (result.adapterApplied) {
    corporateCaMerged = result.application.corporateCaPath !== null;
  } else {
    verifyRootOwnedMaterials(mapped.materials);
    if (result.application.corporateCaPath === null) {
      if (fs.existsSync(MANAGED_STARTUP_CORPORATE_CA_FILE)) {
        fail("committed profile without a corporate CA has a stale CA material");
      }
    } else {
      const expected = readStableRegularFile(result.application.corporateCaPath, 128 * 1024);
      const installed = readStableRegularFile(MANAGED_STARTUP_CORPORATE_CA_FILE, 128 * 1024);
      if (!expected.equals(installed)) {
        fail("committed corporate CA material drifted");
      }
    }
    installCorporateCaSystemAnchors(result.application.corporateCaPath);
    corporateCaMerged = mergeCorporateCa(result.application.corporateCaPath);
  }
  const runtimeEnvironment = serializeManagedStartupRuntimeEnvironment(
    mapped.runtimeEnvironment,
    corporateCaMerged,
    mapped.configurationEnvironment,
    mapped.applicationRuntime,
  );
  // This handoff is intentionally readable by the sandbox account only after
  // the root-owned completion marker authenticates its exact digest. It
  // contains the secret-free mapped profile environment, never provider
  // credentials or the raw corporate-CA transport.
  atomicWriteRootFile(MANAGED_STARTUP_RUNTIME_ENV_FILE, runtimeEnvironment, 0o444);
  atomicWriteRootFile(
    MANAGED_STARTUP_COMPLETION_FILE,
    serializeManagedStartupCompletionMarker({
      schemaVersion: MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION,
      agent: expectedAgent,
      profileFingerprint: result.application.fingerprint,
      runtimeEnvironmentSha256: createHash("sha256")
        .update(runtimeEnvironment, "utf8")
        .digest("hex"),
      corporateCaMerged,
    }),
    0o444,
  );
  return {
    agent: expectedAgent,
    adapterApplied: result.adapterApplied,
    fingerprint: result.application.fingerprint,
    runtimeEnvironmentFile: MANAGED_STARTUP_RUNTIME_ENV_FILE,
  };
}

function completionAlreadyPublished(request: ManagedStartupRootApplyRequest): boolean {
  try {
    verifyManagedStartupImageCompletion(request.agent, request.profileFingerprint);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function applyManagedStartupRootRequest(
  request: ManagedStartupRootApplyRequest,
  env: Environment = process.env,
  options: ManagedStartupRootApplyOptions = {},
): Promise<ManagedStartupRootApplyResult> {
  requireRoot();
  const profile = decodeManagedStartupProfile(request.encodedProfile);
  if (
    profile.agent !== request.agent ||
    fingerprintManagedStartupProfile(profile) !== request.profileFingerprint
  ) {
    fail("root application request identity does not match its profile");
  }
  const imageEnvironment = {
    HOME: "/root",
    PATH: FIXED_PATH,
    NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
    ...selectManagedStartupApplicationRuntimeEnvironment(env),
    [MANAGED_STARTUP_PROFILE_ENV]: request.encodedProfile,
    ...(request.corporateCaB64 === null
      ? {}
      : { [MANAGED_STARTUP_CA_ENV]: request.corporateCaB64 }),
  };
  // Validate launch controls before completion inspection or transaction
  // mutation. A completed same-profile replay must still be allowed to refresh
  // these non-fingerprinted application-runtime values.
  mapManagedStartupProfileToAgentEnvironment(profile, imageEnvironment);
  const alreadyPublished = completionAlreadyPublished(request);
  const bootstrapIdentity = options.bootstrapIdentity ?? null;
  const transactionStatus =
    alreadyPublished && bootstrapIdentity !== null
      ? getManagedStartupSharedStateTransactionStatus({
          agent: request.agent,
          profileFingerprint: request.profileFingerprint,
          bootstrapIdentity,
        })
      : null;
  if (transactionStatus === "none") {
    fail("completed startup profile has no shared-state authority for this bootstrap attempt");
  }
  if (!alreadyPublished) {
    ensureRootOwnedDirectory(ROOT_STATE_PARENT);
    beginManagedStartupSharedStateTransaction(profile, { bootstrapIdentity });
  }
  const result = await applyManagedStartupImageProfile(request.agent, imageEnvironment);
  return {
    ...result,
    transactionPending: !alreadyPublished || transactionStatus === "pending",
  };
}

function readBoundedRootApplyStdin(): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(16 * 1024);
    const read = fs.readSync(0, chunk, 0, chunk.length, null);
    if (read === 0) break;
    total += read;
    if (total > MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES) {
      fail("root application stdin exceeds its bounded transport");
    }
    chunks.push(chunk.subarray(0, read));
  }
  const bytes = Buffer.concat(chunks, total);
  const text = bytes.toString("utf8");
  if (text.includes("\0") || !Buffer.from(text, "utf8").equals(bytes)) {
    fail("root application stdin must be valid UTF-8 without NUL bytes");
  }
  return text;
}

function writeSandboxFileAtomically(target: string, contents: string, mode: number): void {
  const parent = path.dirname(target);
  const parentStat = fs.lstatSync(parent);
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentStat.uid !== process.geteuid?.() ||
    parentStat.gid !== process.getegid?.()
  ) {
    fail(`refusing unsafe sandbox-owned directory ${parent}`);
  }
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${randomBytes(12).toString("hex")}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, contents);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the primary write failure.
    }
    fail(`could not write sandbox-owned file ${target}: ${(error as Error).message}`);
  }
}

function internalWriteOpenClawHash(): void {
  if (process.geteuid?.() === 0) fail("sandbox hash writer must not run as root");
  const configPath = "/sandbox/.openclaw/openclaw.json";
  const config = readStableRegularFile(configPath, 16 * 1024 * 1024);
  const text = `${createHash("sha256").update(config).digest("hex")}  openclaw.json\n`;
  writeSandboxFileAtomically("/sandbox/.openclaw/.config-hash", text, 0o660);
}

function internalWriteHermesCompatHash(): void {
  if (process.geteuid?.() === 0) fail("sandbox hash writer must not run as root");
  const encoded = process.env.NEMOCLAW_MANAGED_HERMES_HASH_B64 ?? "";
  if (
    encoded.length === 0 ||
    encoded.length > 4096 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    fail("Hermes compatibility hash transport is invalid");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    fail("Hermes compatibility hash transport is non-canonical");
  }
  writeSandboxFileAtomically("/sandbox/.hermes/.config-hash", decoded.toString("utf8"), 0o640);
}

function readCliAgent(argv: readonly string[], expectedLength = 2): string {
  const index = argv.indexOf("--agent");
  if (index < 0 || index + 1 >= argv.length || argv.length !== expectedLength) {
    fail(
      "usage: managed-startup-image-runtime [--apply-root-stdin|--wait-for-completion|--verify-completion|--begin-shared-state-transaction|--commit-shared-state-transaction|--clear-shared-state-commit-receipt|--shared-state-transaction-status] --agent <agent>",
    );
  }
  return argv[index + 1] as string;
}

function readCliFingerprint(argv: readonly string[]): string {
  const index = argv.indexOf("--profile-fingerprint");
  if (index < 0 || index + 1 >= argv.length) {
    fail("managed startup profile fingerprint argument is missing");
  }
  return argv[index + 1] as string;
}

function readCliBootstrapIdentity(argv: readonly string[]): string {
  const index = argv.indexOf("--bootstrap-identity");
  if (index < 0 || index + 1 >= argv.length || !SHA256_RE.test(String(argv[index + 1] ?? ""))) {
    fail("managed bootstrap identity argument is missing or invalid");
  }
  return argv[index + 1] as string;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === "--internal-write-openclaw-hash") {
    internalWriteOpenClawHash();
    return;
  }
  if (argv.length === 1 && argv[0] === "--internal-write-hermes-compat-hash") {
    internalWriteHermesCompatHash();
    return;
  }
  if (argv.length === 3 && argv[0] === "--apply-root-stdin") {
    const expectedAgent = exactAgent(readCliAgent(argv, 3));
    const request = parseManagedStartupRootApplyRequest(readBoundedRootApplyStdin());
    if (request.agent !== expectedAgent) {
      fail(`root application request targets ${request.agent}, expected ${expectedAgent}`);
    }
    const result = await applyManagedStartupRootRequest(request);
    console.log(
      result.transactionPending
        ? `[managed-startup] applied ${result.agent} profile ${result.fingerprint}; transaction pending`
        : `[managed-startup] ${result.agent} profile ${result.fingerprint} was already complete`,
    );
    return;
  }
  if (
    argv.length === 5 &&
    (argv[0] === "--verify-completion" || argv[0] === "--wait-for-completion")
  ) {
    const agent = readCliAgent(argv, 5);
    const fingerprint = readCliFingerprint(argv);
    const result =
      argv[0] === "--wait-for-completion"
        ? waitForManagedStartupImageCompletion(agent, fingerprint)
        : verifyManagedStartupImageCompletion(agent, fingerprint);
    console.log(
      `[managed-startup] verified ${result.agent} profile ${result.fingerprint} completion`,
    );
    return;
  }
  if (argv.length === 3 && argv[0] === "--begin-shared-state-transaction") {
    const profile = managedTransactionProfile(readCliAgent(argv, 3));
    ensureRootOwnedDirectory(ROOT_STATE_PARENT);
    const created = beginManagedStartupSharedStateTransaction(profile);
    process.stdout.write(created ? "created\n" : "pending\n");
    return;
  }
  if (
    (argv.length === 4 || argv.length === 6) &&
    argv[0] === "--rollback-shared-state-transaction" &&
    argv[argv.length - 1] === "--read-only-receipt"
  ) {
    requireRoot();
    const agent = exactAgent(readCliAgent(argv, argv.length));
    const rolledBack = rollbackManagedStartupSharedStateTransaction(agent, {
      transactionDirectory: MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
      readOnlyReceipt: true,
      bootstrapIdentity: argv.length === 6 ? readCliBootstrapIdentity(argv) : null,
    });
    if (!rolledBack) fail("read-only shared-state rollback receipt is missing");
    console.log(`[managed-startup] verified and restored ${agent} shared state`);
    return;
  }
  if ((argv.length === 3 || argv.length === 5) && argv[0] === "--commit-shared-state-transaction") {
    requireRoot();
    const agent = exactAgent(readCliAgent(argv, argv.length));
    if (
      !commitManagedStartupSharedStateTransaction(agent, {
        bootstrapIdentity: argv.length === 5 ? readCliBootstrapIdentity(argv) : null,
      })
    ) {
      fail("managed startup transaction is missing at commit");
    }
    console.log(`[managed-startup] committed ${agent} shared state`);
    return;
  }
  if (argv.length === 5 && argv[0] === "--clear-shared-state-commit-receipt") {
    requireRoot();
    const agent = exactAgent(readCliAgent(argv, 5));
    const bootstrapIdentity = readCliBootstrapIdentity(argv);
    if (!clearManagedStartupSharedStateCommitReceipt(agent, { bootstrapIdentity })) {
      fail("managed startup durable commit receipt is missing at cleanup");
    }
    console.log(`[managed-startup] cleared ${agent} durable shared-state commit receipt`);
    return;
  }
  if (
    argv.length === 8 &&
    argv[0] === "--shared-state-transaction-status" &&
    argv[7] === "--read-only-receipt"
  ) {
    requireRoot();
    const agent = exactAgent(readCliAgent(argv, 8));
    const profileFingerprint = readCliFingerprint(argv);
    const bootstrapIdentity = readCliBootstrapIdentity(argv);
    process.stdout.write(
      `${getManagedStartupSharedStateTransactionStatus(
        {
          agent,
          profileFingerprint,
          bootstrapIdentity,
        },
        { readOnlyReceipt: true },
      )}\n`,
    );
    return;
  }
  const result = await applyManagedStartupImageProfile(readCliAgent(argv));
  console.log(
    result.adapterApplied
      ? `[managed-startup] applied ${result.agent} profile ${result.fingerprint}`
      : `[managed-startup] ${result.agent} profile ${result.fingerprint} is already committed`,
  );
}

// This module is the startup-profile implementation library. The composed
// managed-bootstrap image runtime owns the one process entrypoint and delegates
// non-bootstrap actions to main(). Keeping a second require.main guard here
// makes an esbuild bundle execute every CLI action twice.
