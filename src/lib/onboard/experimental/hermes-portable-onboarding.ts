// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import type { AgentDefinition } from "../../agent/defs";
import { normalizeInferenceSelection, type InferenceSelection } from "../../inference/selection";
import {
  fingerprintOpenShellSandboxLiveIdentity,
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
  parseOpenShellSandboxId,
} from "../../adapters/openshell/sandbox-identity";
import {
  assertHermesPortableOpenShellExecutableAuthority,
  buildOpenShellSubprocessEnv,
  captureHermesPortableOpenShellExecutableAuthority,
  type HermesPortableOpenShellExecutableAuthority,
} from "../../adapters/openshell/resolve-shared";
import {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  type PodmanSocketAuthority,
} from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { registryEntryGatewayPort } from "../../state/gateway-registry";
import { enforceRemovedImmutabilityMigrationBoundary } from "../../state/migrations/removed-immutability";
import type { SandboxEntry } from "../../state/registry/types";
import { assertHermesPortableUninstallCompleteForOnboarding } from "../../state/hermes-portable-uninstall/journal";
import type { PortableOnboardRuntimeContext } from "../session-bootstrap";
import {
  classifySandboxInferenceRouteReservation,
  isCurrentSandboxInferenceRouteReservation,
  normalizeSandboxInferenceRouteSelection,
  type QualifiedSandboxInferenceRouteReservation,
  type SandboxInferenceRouteReservationAuthority,
} from "../../state/registry/route-reservation";
import {
  assertNoExplicitOpenShellGatewayEndpoint,
  assertNoOpenShellGatewayEndpointOverride,
} from "../../openshell-gateway-endpoint-guard";
import { isPortableExperimentalProfile } from "./portable-profile";
import { defaultPortableDemoStateDir } from "./portable-runtime-receipt-readiness";
export { defaultPortableDemoStateDir as defaultHermesPortableStateDir };
import {
  assertCurrentHermesPortableContainer,
  configureHermesPortableRestartPolicy,
  enrollHermesPortableContainer,
  probeHermesPortableAuthenticatedHealth,
  type HermesPortableAuthenticatedHealthCapture,
  type HermesPortableContainerDeps,
  type HermesPortableContainerInspection,
} from "./hermes-portable-container";
import {
  captureHermesPortablePodmanExecutableAuthority,
  createHermesPortablePodmanCommandAuthority,
  type HermesPortablePodmanExecutableAuthority,
} from "./hermes-portable-podman-authority";
import {
  assertCurrentHermesPortableStartupContract,
  resolveHermesPortableStartupContract,
  type ResolveHermesPortableStartupContractInput,
} from "./hermes-portable-contract";
import {
  proveHermesPortableLivePolicy,
  type HermesPortablePolicyCapture,
} from "./hermes-portable-policy-state";
import {
  assertHermesPortablePolicySource,
  captureHermesPortablePolicySource,
  createHermesPortableTransactionId,
  inspectPortableAgentReceiptAuthorityForPublicationRecovery,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  publishHermesPortableSuccessorReceipt,
  readHermesPortableLifecycleReceipt,
  reconcileHermesPortableCurrentPhasePublication,
  recoverableHermesPortablePolicyTransactionId,
  retireHermesPortableCreatePolicyState,
  type HermesPortableConfiguredReceipt,
  type HermesPortableLifecycleReceipt,
  type HermesPortablePendingReceipt,
  type HermesPortableReceiptSnapshot,
} from "./hermes-portable-receipt";
import {
  createHermesPortableBuildContextPlan,
  type HermesPortableBuildContextSettings,
  type HermesPortableBuildContextPlan,
  type HermesPortableStagedBuildContext,
} from "./hermes-portable-build-context";

export type HermesPortableSandboxObservation =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly sandboxId: string;
      readonly liveIdentityFingerprint: string;
    }
  | { readonly kind: "ambiguous"; readonly detail: string };

export type HermesPortableRegistryDisposition =
  | { readonly kind: "missing" }
  | { readonly kind: "matching"; readonly entry: SandboxEntry }
  | { readonly kind: "matching-without-gateway-port"; readonly entry: SandboxEntry }
  | { readonly kind: "conflict"; readonly detail: string };

export interface HermesPortableOnboardingInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly runtimeAuthority: CheckpointPortableRuntimeAuthority;
  readonly openshellExecutableAuthority: HermesPortableOpenShellExecutableAuthority;
  readonly stateDir: string;
  readonly createArgv: readonly string[];
  readonly createPolicyPath: string;
  readonly createPolicySourceBytes?: Buffer;
  readonly buildContext: HermesPortableBuildContextPlan;
  readonly startup: ResolveHermesPortableStartupContractInput;
  readonly inferenceRouteReservation: HermesPortableInferenceRouteReservationAuthority;
}

export interface HermesPortableInferenceRouteReservationAuthority {
  readonly sessionId: string;
  readonly selection: InferenceSelection;
}

export interface HermesPortableOnboardingDeps<T> {
  readonly withLifecycleLock: <R>(sandboxName: string, operation: () => Promise<R>) => Promise<R>;
  readonly captureSocketAuthority?: typeof capturePodmanSocketAuthority;
  readonly capturePodmanExecutableAuthority?: (
    socketAuthority: PodmanSocketAuthority,
    runtimeAuthority: CheckpointPortableRuntimeAuthority,
  ) => HermesPortablePodmanExecutableAuthority;
  readonly container:
    | HermesPortableContainerDeps
    | ((
        socketAuthority: PodmanSocketAuthority,
        podmanAuthority: HermesPortablePodmanExecutableAuthority,
      ) => HermesPortableContainerDeps);
  readonly capturePolicy: HermesPortablePolicyCapture;
  readonly assertOpenShellExecutableAuthority: (
    authority: HermesPortableOpenShellExecutableAuthority,
  ) => void;
  readonly observeSandbox: (timeoutBudgetMs?: number) => HermesPortableSandboxObservation;
  readonly delaySandboxReadyPublicationPoll?: (milliseconds: number) => Promise<void>;
  readonly readSandboxReadyPublicationClockMs?: () => number;
  readonly createSandbox: (
    createArgv: readonly string[],
    buildContextPath: string,
    effectivePolicySourcePath: string,
  ) => Promise<T>;
  readonly readRegistry: () => SandboxEntry | null;
  readonly revalidatePendingCreateRegistry?: () => SandboxEntry;
  readonly compareAndSetRegistryGatewayPort: (
    name: string,
    expected: SandboxEntry,
    gatewayPort: number,
  ) => boolean;
  readonly registerSandbox: (
    result: T | null,
    receipt: HermesPortableConfiguredReceipt,
    liveIdentityFingerprint: string,
    revalidate: () => string,
    routeReservation: QualifiedSandboxInferenceRouteReservation,
  ) => SandboxEntry | Promise<SandboxEntry>;
  readonly afterRegistryCommit?: () => void | Promise<void>;
  readonly cleanupTemporaryPolicy?: () => boolean;
}

export interface HermesPortableOnboardingResult<T> {
  readonly active: HermesPortableReceiptSnapshot;
  readonly createResult: T | null;
  readonly created: boolean;
}

export interface HermesPortableOpenShellResult {
  readonly status: number | null;
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
  readonly error?: Error;
}

/** Build the capability-minimal environment for one receipt-owned OpenShell child. */
export function createHermesPortableChildEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  runtimeAuthority?: CheckpointPortableRuntimeAuthority,
): NodeJS.ProcessEnv {
  assertNoOpenShellGatewayEndpointOverride(sourceEnv);
  const environment = buildOpenShellSubprocessEnv(sourceEnv, runtimeAuthority);
  if (!runtimeAuthority) return environment;
  const dockerHost = `unix://${runtimeAuthority.socketPath}`;
  return { ...environment, DOCKER_HOST: dockerHost };
}

/** Adapt the existing synchronous runner to bounded, byte-preserving OpenShell captures. */
export function createHermesPortableOpenShellCapture(
  openshellArgv: (args: string[]) => string[],
  sourceEnv: NodeJS.ProcessEnv = process.env,
  runtimeAuthority?: CheckpointPortableRuntimeAuthority,
  executableAuthority?: HermesPortableOpenShellExecutableAuthority,
  spawn: typeof spawnSync = spawnSync,
): (
  args: readonly string[],
  timeoutMs?: number,
) => HermesPortableOpenShellResult & {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
} {
  return (args, timeoutMs) => {
    assertNoExplicitOpenShellGatewayEndpoint(args);
    const [resolvedExecutable, ...argv] = openshellArgv([...args]);
    const executable = executableAuthority
      ? assertHermesPortableOpenShellExecutableAuthority(
          executableAuthority,
          createHermesPortableChildEnvironment(sourceEnv, runtimeAuthority),
          sourceEnv,
        )
      : resolvedExecutable;
    if (!executable) fail("OpenShell capture has no executable authority");
    if (resolvedExecutable !== executable) {
      fail("OpenShell capture resolution disagrees with executable authority");
    }
    const boundedTimeoutMs = timeoutMs === undefined ? 5_000 : Math.floor(timeoutMs);
    if (!Number.isFinite(boundedTimeoutMs) || boundedTimeoutMs < 1) {
      fail("OpenShell capture timeout must be a positive finite integer");
    }
    const result: SpawnSyncReturns<string | Buffer> = spawn(executable, argv, {
      env: createHermesPortableChildEnvironment(sourceEnv, runtimeAuthority),
      timeout: Math.min(5_000, boundedTimeoutMs),
      maxBuffer: 512 * 1024,
      encoding: null,
    });
    return {
      status: result.status,
      stdout: Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout ?? "", "utf8"),
      stderr: Buffer.isBuffer(result.stderr)
        ? result.stderr
        : Buffer.from(result.stderr ?? "", "utf8"),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

/** Scope create-flow Ready and identity captures to the receipt-owned gateway. */
export function createHermesPortableReadyCapture(
  sandboxName: string,
  gatewayName: string,
  capture: ReturnType<typeof createHermesPortableOpenShellCapture>,
): (args: string[], options?: Record<string, unknown>) => string {
  const run = createHermesPortableReadyRunner(sandboxName, gatewayName, capture);
  return (args) => {
    const result = run(args);
    if (result.error || result.status !== 0) return "";
    return strictOpenShellText(result.stdout);
  };
}

const CREATE_ATTEMPT_SELECTOR_PREFIX = `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=`;

function scopeHermesPortableCreatedIdentityArgs(
  args: string[],
  gatewayName: string,
): string[] | null {
  if (
    args.length !== 10 ||
    args[0] !== "sandbox" ||
    args[1] !== "list" ||
    args[2] !== "-g" ||
    args[3] !== gatewayName ||
    args[4] !== "--selector" ||
    args[6] !== "--output" ||
    args[7] !== "json" ||
    args[8] !== "--limit" ||
    args[9] !== "2"
  ) {
    return null;
  }
  const selector = args[5]!;
  if (!selector.startsWith(CREATE_ATTEMPT_SELECTOR_PREFIX)) return null;
  const nonce = selector.slice(CREATE_ATTEMPT_SELECTOR_PREFIX.length);
  if (nonce.length !== NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH || !/^[0-9a-f]+$/u.test(nonce)) {
    return null;
  }
  return [
    "sandbox",
    "list",
    "-g",
    gatewayName,
    "--selector",
    `${CREATE_ATTEMPT_SELECTOR_PREFIX}${nonce}`,
    "--output",
    "json",
    "--limit",
    "2",
  ];
}

function scopeHermesPortableReadyGetArgs(
  args: string[],
  sandboxName: string,
  gatewayName: string,
): string[] | null {
  if (args[0] !== "sandbox" || args[1] !== "get" || (args.length !== 3 && args.length !== 5)) {
    return null;
  }
  if (args.length === 3 && args[2] === sandboxName) {
    return ["sandbox", "get", "-g", gatewayName, sandboxName];
  }
  if (args.length === 5 && args[2] === "-g" && args[3] === gatewayName && args[4] === sandboxName) {
    return ["sandbox", "get", "-g", gatewayName, sandboxName];
  }
  return null;
}

function scopeHermesPortableReadyListArgs(args: string[], gatewayName: string): string[] | null {
  if (args.length === 2 && args[0] === "sandbox" && args[1] === "list") {
    return ["sandbox", "list", "-g", gatewayName];
  }
  if (
    args.length === 4 &&
    args[0] === "sandbox" &&
    args[1] === "list" &&
    args[2] === "-g" &&
    args[3] === gatewayName
  ) {
    return ["sandbox", "list", "-g", gatewayName];
  }
  return null;
}

function scopeHermesPortableReadyExecArgs(
  args: string[],
  sandboxName: string,
  gatewayName: string,
): string[] | null {
  const scoped = ["sandbox", "exec", "-g", gatewayName, "--name", sandboxName, "--", "true"];
  if (
    args.length === 6 &&
    args[0] === "sandbox" &&
    args[1] === "exec" &&
    args[2] === "--name" &&
    args[3] === sandboxName &&
    args[4] === "--" &&
    args[5] === "true"
  ) {
    return scoped;
  }
  if (args.length === scoped.length && args.every((value, index) => value === scoped[index])) {
    return scoped;
  }
  return null;
}

/** Route create readiness and failed-create cleanup through exact schema-7 authority. */
export function createHermesPortableReadyRunner(
  sandboxName: string,
  gatewayName: string,
  capture: ReturnType<typeof createHermesPortableOpenShellCapture>,
): (args: string[], options?: Record<string, unknown>) => HermesPortableOpenShellResult {
  return (args) => {
    const scoped =
      scopeHermesPortableCreatedIdentityArgs(args, gatewayName) ??
      scopeHermesPortableReadyGetArgs(args, sandboxName, gatewayName) ??
      scopeHermesPortableReadyListArgs(args, gatewayName) ??
      scopeHermesPortableReadyExecArgs(args, sandboxName, gatewayName) ??
      (args[0] === "sandbox" && args[1] === "delete" && args.length === 3 && args[2] === sandboxName
        ? ["sandbox", "delete", "-g", gatewayName, args[2]!]
        : null);
    if (!scoped) fail("create lifecycle attempted an unsupported OpenShell command");
    return capture(scoped);
  };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CREATE_INTENT_VALUE_OPTIONS = new Set([
  "-g",
  "--cpu",
  "--driver-config-json",
  "--from",
  "--gpu-device",
  "--memory",
  "--name",
  "--policy",
  "--provider",
]);
const CREATE_INTENT_DRIVER_KEYS = new Set([
  "cdi_devices",
  "docker",
  "mode",
  "mounts",
  "options",
  "podman",
  "read_only",
  "size_bytes",
  "source",
  "target",
  "type",
]);
const CREATE_INTENT_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function fail(message: string): never {
  throw new Error(`Hermes portable onboarding ${message}`);
}

export function isHermesPortableLifecycleMode(
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isPortableExperimentalProfile(env) && agent?.name === "hermes";
}

/** Keep unowned dashboard/TUI forwards out of schema-7 enrollment. */
export function shouldManageHermesPortableDashboard(
  ordinaryDecision: boolean,
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ordinaryDecision && !isHermesPortableLifecycleMode(agent, env);
}

export function createHermesPortableContainerDeps(
  socketAuthority: PodmanSocketAuthority,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  podmanAuthority: HermesPortablePodmanExecutableAuthority,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): HermesPortableContainerDeps {
  const authority = createHermesPortablePodmanCommandAuthority(
    podmanAuthority,
    socketAuthority,
    runtimeAuthority,
    sourceEnv,
  );
  return {
    podman: (args, timeoutMs) => {
      authority.assertCurrent();
      return authority.engine.capture(args, timeoutMs);
    },
    assertSocketAuthority: () => authority.engine.assertAuthority(),
  };
}

export function rewriteHermesPortableCreatePolicyArgv(
  createArgv: readonly string[],
  sourcePath: string,
  durablePath: string,
): string[] {
  const rewritten = [...createArgv];
  let matches = 0;
  for (let index = 0; index < rewritten.length; index += 1) {
    const argument = rewritten[index]!;
    if (argument === "--policy") {
      matches += 1;
      if (rewritten[index + 1] !== sourcePath) {
        fail("create argv policy option does not name the captured source");
      }
      rewritten[index + 1] = durablePath;
      index += 1;
    } else if (argument.startsWith("--policy=")) {
      fail("create argv must use one canonical '--policy <path>' option");
    }
  }
  if (matches !== 1) fail("create argv must contain exactly one canonical policy option");
  return rewritten;
}

/** Bind one Hermes portable create to its receipt-owned OpenShell gateway. */
export function scopeHermesPortableCreateGatewayArgv(
  createArgv: readonly string[],
  gatewayName: string,
): string[] {
  if (createArgv[1] !== "sandbox" || createArgv[2] !== "create") {
    fail("create argv does not use the expected OpenShell create command");
  }
  const separator = createArgv.indexOf("--", 3);
  const optionEnd = separator < 0 ? createArgv.length : separator;
  if (
    createArgv.slice(3, optionEnd).some((value) => value === "-g" || value.startsWith("--gateway"))
  ) {
    fail("create argv already contains gateway selection authority");
  }
  return [...createArgv.slice(0, 3), "-g", gatewayName, ...createArgv.slice(3)];
}

function canonicalCreateIntentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCreateIntentValue);
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      fail("create driver config number must be a safe integer");
    }
    return value;
  }
  if (typeof value === "string") {
    if (!value || value.length > 4096 || CREATE_INTENT_CONTROL.test(value)) {
      fail(
        "create driver config string must contain 1 to 4096 characters and no control characters",
      );
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    fail("create driver config contains an unsupported value");
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (!CREATE_INTENT_DRIVER_KEYS.has(key)) {
      fail("create driver config contains an unsupported field");
    }
    result[key] = canonicalCreateIntentValue(source[key]);
  }
  return result;
}

function parseCreateIntentDriverConfig(value: string): unknown {
  if (!value || value.length > 32 * 1024 || CREATE_INTENT_CONTROL.test(value)) {
    fail("create driver config is invalid");
  }
  try {
    return canonicalCreateIntentValue(JSON.parse(value));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Hermes portable onboarding ")) {
      throw error;
    }
    fail("create driver config is not valid JSON");
  }
}

function createHermesPortableCreateIntentSha256(
  input: HermesPortableOnboardingInput,
  startup: ReturnType<typeof resolveHermesPortableStartupContract>,
  podmanExecutableAuthority: HermesPortablePodmanExecutableAuthority,
): string {
  const argv = [...input.createArgv];
  if (argv.length < 9 || argv.length > 256) fail("create argv has an invalid bounded shape");
  if (!argv[0] || argv[0].length > 4096 || CREATE_INTENT_CONTROL.test(argv[0])) {
    fail("create argv has an invalid OpenShell executable identity");
  }
  if (argv[1] !== "sandbox" || argv[2] !== "create") {
    fail("create argv does not use the expected OpenShell create command");
  }
  const separator = argv.indexOf("--", 3);
  if (separator < 0 || !isDeepStrictEqual(argv.slice(separator + 1), startup.argv)) {
    fail("create argv startup does not match the accepted Hermes startup contract");
  }
  const canonicalArgs: unknown[] = [];
  let foundFrom = false;
  let foundGateway = false;
  let foundName = false;
  let foundPolicy = false;
  let createSourceAuthority: HermesPortableBuildContextPlan["authority"] | null = null;
  for (let index = 3; index < separator; index += 1) {
    const option = argv[index]!;
    if (option === "--gpu") {
      canonicalArgs.push(option);
      continue;
    }
    if (!CREATE_INTENT_VALUE_OPTIONS.has(option)) {
      fail("create argv contains an unsupported effect-bearing option");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || value.length > 32 * 1024) {
      fail("create argv contains an invalid option value");
    }
    index += 1;
    if (option === "--policy") {
      if (foundPolicy || value !== input.createPolicyPath) {
        fail("create argv policy option does not name the captured source");
      }
      foundPolicy = true;
      canonicalArgs.push(option, "<policy-source>");
      continue;
    }
    if (option === "--name") {
      if (foundName || value !== input.sandboxName) {
        fail("create argv sandbox identity changed");
      }
      foundName = true;
    }
    if (option === "-g") {
      if (foundGateway || value !== input.gatewayName) {
        fail("create argv gateway identity changed");
      }
      foundGateway = true;
    }
    if (option === "--from") {
      if (foundFrom) fail("create argv contains duplicate image authority");
      foundFrom = true;
      if (value !== input.buildContext.sourceDockerfilePath) {
        fail("create source does not name the captured build context source");
      }
      createSourceAuthority = input.buildContext.authority;
    }
    canonicalArgs.push(
      option,
      option === "--driver-config-json" ? parseCreateIntentDriverConfig(value) : value,
    );
  }
  if (!foundFrom || !foundName || !foundPolicy || !foundGateway) {
    fail("create argv is missing required image, sandbox, gateway, or policy state");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        command: "openshell sandbox create",
        executable: argv[0],
        podmanExecutableAuthority,
        args: canonicalArgs,
        createSourceAuthority,
        inferenceRouteReservation: {
          sessionId: input.inferenceRouteReservation.sessionId,
          selection: normalizeSandboxInferenceRouteSelection(
            input.inferenceRouteReservation.selection,
          ),
        },
        startupDescriptorSha256: startup.startupDescriptorSha256,
      }),
    )
    .digest("hex");
}

function rewriteHermesPortableCreateSourceArgv(
  argv: readonly string[],
  expectedSource: string,
  context: HermesPortableStagedBuildContext,
): readonly string[] {
  const rewritten = [...argv];
  const separator = rewritten.indexOf("--", 3);
  let found = false;
  for (let index = 3; index < separator; index += 1) {
    if (rewritten[index] !== "--from") continue;
    if (found || rewritten[index + 1] !== expectedSource) {
      fail("create source changed before staged-context dispatch");
    }
    found = true;
    rewritten[index + 1] = context.dockerfilePath;
    index += 1;
  }
  if (!found) fail("create argv is missing the staged-context source");
  return rewritten;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function strictOpenShellText(value: string | Buffer): string {
  if (typeof value === "string") return value;
  try {
    return UTF8.decode(value);
  } catch {
    fail("OpenShell returned output that is not strict UTF-8");
  }
}

/** Probe the gateway from the receipt-owned OpenShell workload namespace. */
export function createHermesPortableAuthenticatedHealthCapture(
  sandboxName: string,
  gatewayName: string,
  capture: ReturnType<typeof createHermesPortableOpenShellCapture>,
): HermesPortableAuthenticatedHealthCapture {
  return (script, timeoutMs) => {
    const result = capture(
      ["sandbox", "exec", "-g", gatewayName, "--name", sandboxName, "--", "python3", "-c", script],
      timeoutMs,
    );
    return {
      status: result.status,
      stdout: strictOpenShellText(result.stdout),
      stderr: strictOpenShellText(result.stderr),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

function parseHermesPortableSandboxJson(
  output: string,
  sandboxName: string,
): {
  readonly sandboxId: string;
  readonly liveIdentityFingerprint: string;
  readonly phase: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    record.name !== sandboxName ||
    typeof record.id !== "string" ||
    typeof record.phase !== "string"
  ) {
    return null;
  }
  const identityOutput = `ID: ${record.id}\n`;
  const sandboxId = parseOpenShellSandboxId(identityOutput);
  const liveIdentityFingerprint = fingerprintOpenShellSandboxLiveIdentity(identityOutput);
  return sandboxId && liveIdentityFingerprint
    ? { sandboxId, liveIdentityFingerprint, phase: record.phase }
    : null;
}

const HERMES_PORTABLE_READY_PUBLICATION_POLL_INTERVAL_MS = 1_000;
const HERMES_PORTABLE_READY_PUBLICATION_TIMEOUT_MS = 180_000;
const HERMES_PORTABLE_READY_PUBLICATION_MAX_POLLS = Math.ceil(
  HERMES_PORTABLE_READY_PUBLICATION_TIMEOUT_MS / HERMES_PORTABLE_READY_PUBLICATION_POLL_INTERVAL_MS,
);
const HERMES_PORTABLE_NOT_READY_DETAIL = "exact OpenShell sandbox is not Ready";
const HERMES_PORTABLE_READY_PUBLICATION_TIMEOUT_DETAIL =
  "exact OpenShell sandbox Ready publication exceeded its total deadline";
function delayHermesPortableReadyPublicationPoll(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Prove gateway reachability before interpreting one exact not-found response as absence. */
export function observeHermesPortableSandbox(
  sandboxName: string,
  gatewayName: string,
  capture: (args: readonly string[], timeoutMs?: number) => HermesPortableOpenShellResult,
  timeoutBudgetMs?: number,
  readClockMs: () => number = performance.now.bind(performance),
): HermesPortableSandboxObservation {
  if (timeoutBudgetMs !== undefined && (!Number.isFinite(timeoutBudgetMs) || timeoutBudgetMs < 1)) {
    return { kind: "ambiguous", detail: HERMES_PORTABLE_READY_PUBLICATION_TIMEOUT_DETAIL };
  }
  const deadlineMs = timeoutBudgetMs === undefined ? null : readClockMs() + timeoutBudgetMs;
  const captureWithinDeadline = (args: readonly string[]): HermesPortableOpenShellResult | null => {
    if (deadlineMs === null) return capture(args);
    const remainingMs = Math.floor(deadlineMs - readClockMs());
    return remainingMs < 1 ? null : capture(args, remainingMs);
  };
  const list = captureWithinDeadline(["sandbox", "list", "-g", gatewayName]);
  if (!list) {
    return { kind: "ambiguous", detail: HERMES_PORTABLE_READY_PUBLICATION_TIMEOUT_DETAIL };
  }
  if (list.status !== 0 || list.error) {
    return { kind: "ambiguous", detail: "the selected OpenShell gateway is not proven reachable" };
  }
  const current = captureWithinDeadline([
    "sandbox",
    "get",
    "-g",
    gatewayName,
    "-o",
    "json",
    sandboxName,
  ]);
  if (!current) {
    return { kind: "ambiguous", detail: HERMES_PORTABLE_READY_PUBLICATION_TIMEOUT_DETAIL };
  }
  if (current.status === 0 && !current.error) {
    const output = strictOpenShellText(current.stdout);
    const identity = parseHermesPortableSandboxJson(output, sandboxName);
    if (!identity) {
      return { kind: "ambiguous", detail: "sandbox get returned no exact durable sandbox ID" };
    }
    if (identity.phase !== "Ready") {
      return { kind: "ambiguous", detail: HERMES_PORTABLE_NOT_READY_DETAIL };
    }
    return {
      kind: "present",
      sandboxId: identity.sandboxId,
      liveIdentityFingerprint: identity.liveIdentityFingerprint,
    };
  }
  if (current.error || current.status === null) {
    return { kind: "ambiguous", detail: "sandbox get ended without a status-bearing response" };
  }
  const output =
    `${strictOpenShellText(current.stderr)}\n${strictOpenShellText(current.stdout)}`.trim();
  const named = new RegExp(
    `^(?:Error:\\s*)?sandbox ['\"]?${escapedRegExp(sandboxName)}['\"]? not found\\.?$`,
    "u",
  );
  const coded =
    output === `Error: code: 'NotFound', message: "sandbox not found"` ||
    output ===
      `Error:   × code: 'Some requested entity was not found', message: "sandbox not found"`;
  return named.test(output) || coded
    ? { kind: "absent" }
    : { kind: "ambiguous", detail: "sandbox get did not prove exact sandbox absence" };
}

async function settleCreatedHermesPortableSandboxReadyPublication(
  observeSandbox: (timeoutBudgetMs?: number) => HermesPortableSandboxObservation,
  delayPoll: (milliseconds: number) => Promise<void>,
  readClockMs: () => number,
): Promise<HermesPortableSandboxObservation> {
  const deadlineMs = readClockMs() + HERMES_PORTABLE_READY_PUBLICATION_TIMEOUT_MS;
  let observation: HermesPortableSandboxObservation = {
    kind: "ambiguous",
    detail: HERMES_PORTABLE_READY_PUBLICATION_TIMEOUT_DETAIL,
  };
  for (let poll = 0; poll <= HERMES_PORTABLE_READY_PUBLICATION_MAX_POLLS; poll += 1) {
    const observationBudgetMs = Math.floor(deadlineMs - readClockMs());
    if (observationBudgetMs < 1) return observation;
    observation = observeSandbox(observationBudgetMs);
    if (
      observation.kind !== "ambiguous" ||
      observation.detail !== HERMES_PORTABLE_NOT_READY_DETAIL
    ) {
      return observation;
    }
    if (poll === HERMES_PORTABLE_READY_PUBLICATION_MAX_POLLS) return observation;
    const delayBudgetMs = Math.floor(deadlineMs - readClockMs());
    if (delayBudgetMs < 1) return observation;
    await delayPoll(Math.min(HERMES_PORTABLE_READY_PUBLICATION_POLL_INTERVAL_MS, delayBudgetMs));
  }
  return observation;
}

export function classifyHermesPortableRegistry(
  receipt: HermesPortableLifecycleReceipt,
  entry: SandboxEntry | null,
  pendingReservationSessionId?: string,
): HermesPortableRegistryDisposition {
  if (!entry) return { kind: "missing" };
  if (
    entry.pendingRouteReservation === true &&
    (!pendingReservationSessionId || entry.reservationSessionId !== pendingReservationSessionId)
  ) {
    return {
      kind: "conflict",
      detail: "the saved row is an inference route reservation, not registered sandbox authority",
    };
  }
  let gatewayPort: number | null = null;
  try {
    gatewayPort = registryEntryGatewayPort({
      name: receipt.sandboxName,
      gatewayName: receipt.gatewayName,
    });
  } catch {
    // Invalid gateway identity remains an ordinary registry conflict.
  }
  if (
    gatewayPort === null ||
    entry.name !== receipt.sandboxName ||
    entry.agent !== "hermes" ||
    entry.gatewayName !== receipt.gatewayName ||
    entry.lifecycleGeneration !== receipt.lifecycleGeneration ||
    entry.openshellDriver !== "docker" ||
    entry.openshellVersion !== receipt.openshellExecutableAuthority.version
  ) {
    return { kind: "conflict", detail: "the saved row has another agent, gateway, or generation" };
  }
  if (entry.gatewayPort === undefined) {
    return { kind: "matching-without-gateway-port", entry };
  }
  if (entry.gatewayPort !== gatewayPort) {
    return { kind: "conflict", detail: "the saved row has another gateway port" };
  }
  return { kind: "matching", entry };
}

function classifyHermesPortableRegistryForCurrentRoute(
  receipt: HermesPortableLifecycleReceipt,
  authority: SandboxInferenceRouteReservationAuthority,
  entry: SandboxEntry | null,
  pendingReservationSessionId?: string,
): HermesPortableRegistryDisposition {
  const disposition = classifyHermesPortableRegistry(receipt, entry, pendingReservationSessionId);
  if (
    (disposition.kind === "matching" || disposition.kind === "matching-without-gateway-port") &&
    !isDeepStrictEqual(
      normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(disposition.entry)),
      normalizeSandboxInferenceRouteSelection(authority.selection),
    )
  ) {
    return { kind: "conflict", detail: "the saved row has another inference route" };
  }
  return disposition;
}

function commonReceipt(
  input: HermesPortableOnboardingInput,
  socketAuthority: PodmanSocketAuthority,
  podmanExecutableAuthority: HermesPortablePodmanExecutableAuthority,
  createIntentSha256: string,
  startup: ReturnType<typeof resolveHermesPortableStartupContract>,
) {
  return {
    schemaVersion: 7 as const,
    agent: "hermes" as const,
    createIntentSha256,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    lifecycleGeneration: input.lifecycleGeneration,
    runtimeAuthority: input.runtimeAuthority,
    openshellExecutableAuthority: input.openshellExecutableAuthority,
    podmanExecutableAuthority,
    socketAuthority,
    startup,
  };
}

function assertCurrentTransaction(
  receipt: HermesPortableLifecycleReceipt,
  input: HermesPortableOnboardingInput,
  socketAuthority: PodmanSocketAuthority,
  podmanExecutableAuthority: HermesPortablePodmanExecutableAuthority,
  createIntentSha256: string,
): void {
  if (
    receipt.sandboxName !== input.sandboxName ||
    receipt.gatewayName !== input.gatewayName ||
    receipt.lifecycleGeneration !== input.lifecycleGeneration ||
    !isDeepStrictEqual(receipt.runtimeAuthority, input.runtimeAuthority) ||
    !isDeepStrictEqual(receipt.openshellExecutableAuthority, input.openshellExecutableAuthority) ||
    !isDeepStrictEqual(receipt.podmanExecutableAuthority, podmanExecutableAuthority) ||
    !isDeepStrictEqual(receipt.socketAuthority, socketAuthority) ||
    (receipt.phase === "pending" && receipt.createIntentSha256 !== createIntentSha256)
  ) {
    fail("saved transaction disagrees with current sandbox, generation, or runtime authority");
  }
  assertCurrentHermesPortableStartupContract(receipt.startup, input.startup);
  // Pending authority still owns create effects, so its full create intent must
  // match. Configuring and active receipts instead prove the already-created
  // sandbox, container, policy, and registry; their retired build-context plan
  // may be regenerated without authorizing another create.
  if (receipt.phase === "pending") assertHermesPortablePolicySource(receipt.policy);
}

function proveLivePolicy(
  receipt: HermesPortableLifecycleReceipt,
  capture: HermesPortablePolicyCapture,
): void {
  if (receipt.phase === "pending") assertHermesPortablePolicySource(receipt.policy);
  proveHermesPortableLivePolicy({
    gatewayName: receipt.gatewayName,
    sandboxName: receipt.sandboxName,
    capture,
  });
}

function assertRegistryMissingBeforeConfiguration(
  receipt: HermesPortableLifecycleReceipt,
  disposition: HermesPortableRegistryDisposition,
): void {
  if (disposition.kind === "missing") return;
  fail(
    disposition.kind === "conflict"
      ? `registry conflicts with ${receipt.phase} authority: ${disposition.detail}`
      : `registry is already committed while receipt phase is '${receipt.phase}'`,
  );
}

function requireMatchingRegistry(
  receipt: HermesPortableLifecycleReceipt,
  disposition: HermesPortableRegistryDisposition,
  liveIdentityFingerprint: string,
): void {
  if (
    disposition.kind === "matching" &&
    disposition.entry.lifecycleLiveIdentityFingerprint === liveIdentityFingerprint
  ) {
    return;
  }
  fail(
    disposition.kind === "conflict"
      ? `registry conflicts with ${receipt.phase} authority: ${disposition.detail}`
      : disposition.kind === "missing"
        ? `registry is missing for receipt phase '${receipt.phase}'`
        : `registry live identity disagrees with receipt phase '${receipt.phase}'`,
  );
}

function requireRegistryBeforeConfigurationMutation(
  disposition: HermesPortableRegistryDisposition,
  liveIdentityFingerprint: string,
): void {
  if (disposition.kind === "missing") return;
  if (
    disposition.kind === "matching" &&
    disposition.entry.lifecycleLiveIdentityFingerprint === liveIdentityFingerprint
  ) {
    return;
  }
  fail(
    disposition.kind === "conflict"
      ? `registry conflicts with configuring authority: ${disposition.detail}`
      : "registry live identity disagrees with configuring authority",
  );
}

function requireCurrentOpenShellIdentity(
  receipt: HermesPortableConfiguredReceipt,
  observation: HermesPortableSandboxObservation,
): Extract<HermesPortableSandboxObservation, { readonly kind: "present" }> {
  if (observation.kind !== "present" || observation.sandboxId !== receipt.container.sandboxId) {
    fail("current OpenShell sandbox identity disagrees with the receipt container");
  }
  return observation;
}

function requireCurrentReceiptSnapshot<T extends HermesPortableLifecycleReceipt>(
  expected: HermesPortableReceiptSnapshot & { readonly receipt: T },
  stateDir: string,
  allowPublicationRecovery = false,
): HermesPortableReceiptSnapshot & { readonly receipt: T } {
  const recoveryAuthority = allowPublicationRecovery
    ? inspectPortableAgentReceiptAuthorityForPublicationRecovery(
        expected.receipt.sandboxName,
        stateDir,
      )
    : null;
  const current = allowPublicationRecovery
    ? recoveryAuthority?.kind === "hermes"
      ? recoveryAuthority.snapshot
      : null
    : readHermesPortableLifecycleReceipt(expected.receipt.sandboxName, stateDir);
  if (
    !current ||
    current.path !== expected.path ||
    current.identity.dev !== expected.identity.dev ||
    current.identity.ino !== expected.identity.ino ||
    current.sha256 !== expected.sha256 ||
    !current.bytes.equals(expected.bytes)
  ) {
    fail("receipt authority changed during lifecycle verification");
  }
  return current as HermesPortableReceiptSnapshot & { readonly receipt: T };
}

function requireConfiguredReceiptSnapshot(
  snapshot: HermesPortableReceiptSnapshot,
): HermesPortableReceiptSnapshot & { readonly receipt: HermesPortableConfiguredReceipt } {
  if (snapshot.receipt.phase === "pending") fail("configured receipt authority is required");
  return snapshot as HermesPortableReceiptSnapshot & {
    readonly receipt: HermesPortableConfiguredReceipt;
  };
}

function requireConfiguredContainerReady(container: HermesPortableContainerInspection): void {
  if (
    !container.authority.running ||
    container.paused ||
    container.authority.restartPolicy !== "unless-stopped"
  ) {
    fail("exact container is not running with the committed restart policy");
  }
}

function configuringReceipt(
  pending: HermesPortableReceiptSnapshot,
  container: HermesPortableContainerInspection,
): HermesPortableConfiguredReceipt {
  if (pending.receipt.phase !== "pending") fail("configuring requires pending authority");
  const { policy: _policy, ...transaction } = pending.receipt;
  return {
    ...transaction,
    phase: "configuring",
    previousPhaseSha256: pending.sha256,
    container: container.authority,
  };
}

function activeReceipt(
  configuring: HermesPortableReceiptSnapshot,
  container: HermesPortableContainerInspection,
): HermesPortableConfiguredReceipt {
  if (configuring.receipt.phase !== "configuring") fail("active requires configuring authority");
  return {
    ...configuring.receipt,
    phase: "active",
    previousPhaseSha256: configuring.sha256,
    container: container.authority,
  };
}

/**
 * Hold one sandbox lifecycle fence across reservation, create, registry commit,
 * and active publication. Every retry resumes the highest immutable phase.
 */
export async function runHermesPortableOnboardingTransaction<T>(
  input: HermesPortableOnboardingInput,
  deps: HermesPortableOnboardingDeps<T>,
): Promise<HermesPortableOnboardingResult<T>> {
  enforceRemovedImmutabilityMigrationBoundary(input.sandboxName, {
    stateDir: path.join(input.stateDir, "state"),
  });
  return await deps.withLifecycleLock(input.sandboxName, async () => {
    assertHermesPortableUninstallCompleteForOnboarding(input.stateDir);
    const assertOpenShellExecutableAuthority = (): void =>
      deps.assertOpenShellExecutableAuthority(input.openshellExecutableAuthority);
    const observeSandbox = (timeoutBudgetMs?: number): HermesPortableSandboxObservation => {
      assertOpenShellExecutableAuthority();
      return deps.observeSandbox(timeoutBudgetMs);
    };
    const capturePolicy: HermesPortablePolicyCapture = (args) => {
      assertOpenShellExecutableAuthority();
      return deps.capturePolicy(args);
    };
    const validatedCreateArgv = rewriteHermesPortableCreatePolicyArgv(
      input.createArgv,
      input.createPolicyPath,
      input.createPolicyPath,
    );
    input.buildContext.assertCurrentSource();
    const startup = resolveHermesPortableStartupContract(input.startup);
    const temporaryPolicy = input.createPolicySourceBytes
      ? {
          bytes: Buffer.from(input.createPolicySourceBytes),
          sha256: createHash("sha256").update(input.createPolicySourceBytes).digest("hex"),
        }
      : captureHermesPortablePolicySource(input.createPolicyPath);
    const socketAuthority = (deps.captureSocketAuthority ?? capturePodmanSocketAuthority)(
      input.runtimeAuthority.socketPath,
    );
    const podmanExecutableAuthority = (
      deps.capturePodmanExecutableAuthority ?? captureHermesPortablePodmanExecutableAuthority
    )(socketAuthority, input.runtimeAuthority);
    const createIntentSha256 = createHermesPortableCreateIntentSha256(
      input,
      startup,
      podmanExecutableAuthority,
    );
    const containerDeps =
      typeof deps.container === "function"
        ? deps.container(socketAuthority, podmanExecutableAuthority)
        : deps.container;
    const recoverableTransactionId = recoverableHermesPortablePolicyTransactionId(
      input.sandboxName,
      input.stateDir,
    );
    const authority = recoverableTransactionId
      ? { kind: "none" as const }
      : inspectPortableAgentReceiptAuthorityForPublicationRecovery(
          input.sandboxName,
          input.stateDir,
        );
    if (authority.kind === "openclaw") fail("will not reinterpret OpenClaw lifecycle authority");
    let snapshot = authority.kind === "hermes" ? authority.snapshot : null;
    const initialRegistryEntry = deps.readRegistry();
    const routeReservationAuthority: SandboxInferenceRouteReservationAuthority = {
      sandboxName: input.sandboxName,
      gatewayName: input.gatewayName,
      sessionId: input.inferenceRouteReservation.sessionId,
      selection: input.inferenceRouteReservation.selection,
    };
    const initialRouteReservation = classifySandboxInferenceRouteReservation(
      routeReservationAuthority,
      initialRegistryEntry,
    );
    const admittedRouteReservation =
      initialRouteReservation.kind === "owned" ? initialRouteReservation.reservation : null;
    const initialCommittedDisposition =
      snapshot && snapshot.receipt.phase !== "pending" && initialRegistryEntry
        ? classifyHermesPortableRegistryForCurrentRoute(
            snapshot.receipt,
            routeReservationAuthority,
            initialRegistryEntry,
            routeReservationAuthority.sessionId,
          )
        : null;
    let committedRegistryEntry =
      initialCommittedDisposition?.kind === "matching" ||
      initialCommittedDisposition?.kind === "matching-without-gateway-port"
        ? structuredClone(initialCommittedDisposition.entry)
        : null;
    const canClassifyCommittedRegistry = Boolean(
      snapshot &&
      snapshot.receipt.phase !== "pending" &&
      initialRouteReservation.kind === "not-reservation",
    );
    if (
      initialCommittedDisposition?.kind === "conflict" &&
      initialCommittedDisposition.detail === "the saved row has another inference route"
    ) {
      fail(initialCommittedDisposition.detail);
    }
    if (
      !committedRegistryEntry &&
      initialRouteReservation.kind !== "owned" &&
      !canClassifyCommittedRegistry
    ) {
      fail("inference route reservation is not owned by the current onboarding session");
    }
    const registryDisposition = (
      receipt: HermesPortableLifecycleReceipt,
    ): HermesPortableRegistryDisposition => {
      const entry = deps.readRegistry();
      const registered = classifyHermesPortableRegistryForCurrentRoute(
        receipt,
        routeReservationAuthority,
        entry,
        routeReservationAuthority.sessionId,
      );
      if (
        entry?.pendingRouteReservation === true &&
        (registered.kind === "matching" || registered.kind === "matching-without-gateway-port")
      ) {
        return !committedRegistryEntry || !isDeepStrictEqual(entry, committedRegistryEntry)
          ? {
              kind: "conflict",
              detail: "sandbox registry authority changed after pending registration",
            }
          : registered;
      }
      const reservation = classifySandboxInferenceRouteReservation(
        routeReservationAuthority,
        entry,
      );
      if (reservation.kind === "conflict") return reservation;
      if (reservation.kind === "owned") {
        if (
          !admittedRouteReservation ||
          !isCurrentSandboxInferenceRouteReservation(admittedRouteReservation, entry)
        ) {
          return {
            kind: "conflict",
            detail: "the inference route reservation changed after admission",
          };
        }
        if (entry?.pendingCreateIdentity !== undefined) {
          if (committedRegistryEntry || !deps.revalidatePendingCreateRegistry) {
            return {
              kind: "conflict",
              detail: "the verified create checkpoint lacks current transaction authority",
            };
          }
          try {
            const revalidated = deps.revalidatePendingCreateRegistry();
            if (!isDeepStrictEqual(revalidated, entry)) {
              return {
                kind: "conflict",
                detail: "the verified create checkpoint changed during revalidation",
              };
            }
          } catch {
            return {
              kind: "conflict",
              detail: "the verified create checkpoint lacks current transaction authority",
            };
          }
        }
        return { kind: "missing" };
      }
      if (reservation.kind === "missing") {
        return admittedRouteReservation
          ? {
              kind: "conflict",
              detail: "the inference route reservation disappeared after admission",
            }
          : { kind: "missing" };
      }
      const committed = classifyHermesPortableRegistryForCurrentRoute(
        receipt,
        routeReservationAuthority,
        entry,
      );
      if (
        (committed.kind === "matching" || committed.kind === "matching-without-gateway-port") &&
        (!committedRegistryEntry || !isDeepStrictEqual(entry, committedRegistryEntry))
      ) {
        return {
          kind: "conflict",
          detail: "sandbox registry authority replaced the route reservation before registration",
        };
      }
      return committed;
    };
    const repairRegistryGatewayPort = (
      receipt: HermesPortableConfiguredReceipt,
      liveIdentityFingerprint: string,
    ): HermesPortableRegistryDisposition => {
      const disposition = registryDisposition(receipt);
      if (disposition.kind !== "matching-without-gateway-port") {
        return disposition;
      }
      if (disposition.entry.lifecycleLiveIdentityFingerprint !== liveIdentityFingerprint) {
        fail("registry live identity disagrees before gateway port repair");
      }
      let gatewayPort: number | null = null;
      try {
        gatewayPort = registryEntryGatewayPort({
          name: receipt.sandboxName,
          gatewayName: receipt.gatewayName,
        });
      } catch {
        // Invalid gateway identity remains a failed repair below.
      }
      if (
        gatewayPort === null ||
        !deps.compareAndSetRegistryGatewayPort(receipt.sandboxName, disposition.entry, gatewayPort)
      ) {
        fail("registry gateway port repair did not complete");
      }
      const repairedEntry = deps.readRegistry();
      const repaired = classifyHermesPortableRegistry(
        receipt,
        repairedEntry,
        routeReservationAuthority.sessionId,
      );
      if (
        repaired.kind !== "matching" ||
        repaired.entry.lifecycleLiveIdentityFingerprint !== liveIdentityFingerprint
      ) {
        fail("registry gateway port repair did not publish exact lifecycle authority");
      }
      committedRegistryEntry = structuredClone(repaired.entry);
      return registryDisposition(receipt);
    };
    if (!snapshot) {
      const preexisting = observeSandbox();
      if (preexisting.kind === "present") {
        fail("live sandbox authority already exists before reservation");
      }
      if (preexisting.kind === "ambiguous") {
        fail(`cannot prove sandbox absence before reservation: ${preexisting.detail}`);
      }
    }
    let createArgv: readonly string[];
    if (snapshot) {
      snapshot = reconcileHermesPortableCurrentPhasePublication(snapshot, input.stateDir);
      assertCurrentTransaction(
        snapshot.receipt,
        input,
        socketAuthority,
        podmanExecutableAuthority,
        createIntentSha256,
      );
      createArgv =
        snapshot.receipt.phase === "pending"
          ? rewriteHermesPortableCreatePolicyArgv(
              validatedCreateArgv,
              input.createPolicyPath,
              snapshot.receipt.policy.sourcePath,
            )
          : validatedCreateArgv;
    } else {
      const transactionId = recoverableTransactionId ?? createHermesPortableTransactionId();
      const policy = publishHermesPortableDurablePolicySource({
        sandboxName: input.sandboxName,
        transactionId,
        stateDir: input.stateDir,
        source: temporaryPolicy,
      });
      createArgv = rewriteHermesPortableCreatePolicyArgv(
        validatedCreateArgv,
        input.createPolicyPath,
        policy.sourcePath,
      );
      const pending: HermesPortablePendingReceipt = {
        ...commonReceipt(
          input,
          socketAuthority,
          podmanExecutableAuthority,
          createIntentSha256,
          startup,
        ),
        transactionId,
        phase: "pending",
        policy,
      };
      snapshot = publishHermesPortableLifecycleReceipt(pending, input.stateDir);
    }
    if (deps.cleanupTemporaryPolicy && !deps.cleanupTemporaryPolicy()) {
      fail("temporary policy cleanup did not complete after durable reservation");
    }

    let createResult: T | null = null;
    let created = false;
    if (snapshot.receipt.phase === "active") {
      let activeSnapshot = requireConfiguredReceiptSnapshot(snapshot);
      const recoverSuccessorPublication = activeSnapshot.successorPublicationPending === true;
      const liveIdentity = requireCurrentOpenShellIdentity(
        activeSnapshot.receipt,
        observeSandbox(),
      );
      requireConfiguredContainerReady(
        assertCurrentHermesPortableContainer(activeSnapshot.receipt, containerDeps),
      );
      proveLivePolicy(activeSnapshot.receipt, capturePolicy);
      requireMatchingRegistry(
        activeSnapshot.receipt,
        repairRegistryGatewayPort(activeSnapshot.receipt, liveIdentity.liveIdentityFingerprint),
        liveIdentity.liveIdentityFingerprint,
      );
      probeHermesPortableAuthenticatedHealth(activeSnapshot.receipt, containerDeps);
      activeSnapshot = requireCurrentReceiptSnapshot(
        activeSnapshot,
        input.stateDir,
        recoverSuccessorPublication,
      );
      const finalIdentity = requireCurrentOpenShellIdentity(
        activeSnapshot.receipt,
        observeSandbox(),
      );
      requireConfiguredContainerReady(
        assertCurrentHermesPortableContainer(activeSnapshot.receipt, containerDeps),
      );
      proveLivePolicy(activeSnapshot.receipt, capturePolicy);
      requireMatchingRegistry(
        activeSnapshot.receipt,
        repairRegistryGatewayPort(activeSnapshot.receipt, finalIdentity.liveIdentityFingerprint),
        finalIdentity.liveIdentityFingerprint,
      );
      activeSnapshot = publishHermesPortableSuccessorReceipt(input.sandboxName, input.stateDir);
      activeSnapshot = retireHermesPortableCreatePolicyState(
        activeSnapshot.receipt.sandboxName,
        activeSnapshot.receipt.transactionId,
        input.stateDir,
      );
      return { active: activeSnapshot, createResult, created };
    }

    if (snapshot.receipt.phase === "pending") {
      const createPolicySourcePath = snapshot.receipt.policy.sourcePath;
      assertRegistryMissingBeforeConfiguration(
        snapshot.receipt,
        registryDisposition(snapshot.receipt),
      );
      const buildContext = input.buildContext.materialize({
        sandboxName: snapshot.receipt.sandboxName,
        transactionId: snapshot.receipt.transactionId,
        createIntentSha256: snapshot.receipt.createIntentSha256,
        stateDir: input.stateDir,
      });
      let observation = observeSandbox();
      if (
        observation.kind === "ambiguous" &&
        observation.detail === HERMES_PORTABLE_NOT_READY_DETAIL
      ) {
        observation = await settleCreatedHermesPortableSandboxReadyPublication(
          observeSandbox,
          deps.delaySandboxReadyPublicationPoll ?? delayHermesPortableReadyPublicationPoll,
          deps.readSandboxReadyPublicationClockMs ?? performance.now.bind(performance),
        );
      }
      if (observation.kind === "ambiguous")
        fail(`cannot classify create effects: ${observation.detail}`);
      if (observation.kind === "absent") {
        snapshot = requireCurrentReceiptSnapshot(snapshot, input.stateDir, true);
        const currentCreateIntentSha256 = createHermesPortableCreateIntentSha256(
          input,
          startup,
          podmanExecutableAuthority,
        );
        assertCurrentTransaction(
          snapshot.receipt,
          input,
          socketAuthority,
          podmanExecutableAuthority,
          currentCreateIntentSha256,
        );
        (containerDeps.assertSocketAuthority ?? assertPodmanSocketAuthority)(
          snapshot.receipt.socketAuthority,
          containerDeps.socketAuthority,
        );
        assertOpenShellExecutableAuthority();
        buildContext.assertCurrent();
        input.buildContext.assertCurrentSource();
        createResult = await deps.createSandbox(
          rewriteHermesPortableCreateSourceArgv(
            createArgv,
            input.buildContext.sourceDockerfilePath,
            buildContext,
          ),
          buildContext.buildContextPath,
          createPolicySourcePath,
        );
        buildContext.assertCurrent();
        input.buildContext.assertCurrentSource();
        created = true;
        observation = await settleCreatedHermesPortableSandboxReadyPublication(
          observeSandbox,
          deps.delaySandboxReadyPublicationPoll ?? delayHermesPortableReadyPublicationPoll,
          deps.readSandboxReadyPublicationClockMs ?? performance.now.bind(performance),
        );
        buildContext.assertCurrent();
        input.buildContext.assertCurrentSource();
      }
      if (observation.kind !== "present") {
        fail(
          observation.kind === "ambiguous"
            ? `cannot classify create result: ${observation.detail}`
            : "create returned without exact live sandbox authority",
        );
      }
      assertCurrentTransaction(
        snapshot.receipt,
        input,
        socketAuthority,
        podmanExecutableAuthority,
        createIntentSha256,
      );
      proveLivePolicy(snapshot.receipt, capturePolicy);
      const container = enrollHermesPortableContainer(
        snapshot.receipt,
        observation.sandboxId,
        containerDeps,
      );
      snapshot = publishHermesPortableLifecycleReceipt(
        configuringReceipt(snapshot, container),
        input.stateDir,
      );
    }

    if (snapshot.receipt.phase !== "configuring") fail("transaction has an unsupported phase");
    if (
      !input.buildContext.retire({
        sandboxName: snapshot.receipt.sandboxName,
        transactionId: snapshot.receipt.transactionId,
        createIntentSha256: snapshot.receipt.createIntentSha256,
        stateDir: input.stateDir,
      })
    ) {
      fail("staged build context cleanup did not complete after configuration");
    }
    let configuringSnapshot = requireConfiguredReceiptSnapshot(snapshot);
    assertCurrentTransaction(
      configuringSnapshot.receipt,
      input,
      socketAuthority,
      podmanExecutableAuthority,
      createIntentSha256,
    );
    let liveIdentity = requireCurrentOpenShellIdentity(
      configuringSnapshot.receipt,
      observeSandbox(),
    );
    proveLivePolicy(configuringSnapshot.receipt, capturePolicy);
    requireRegistryBeforeConfigurationMutation(
      repairRegistryGatewayPort(configuringSnapshot.receipt, liveIdentity.liveIdentityFingerprint),
      liveIdentity.liveIdentityFingerprint,
    );
    configureHermesPortableRestartPolicy(configuringSnapshot.receipt, containerDeps);
    const beforeRegistry = registryDisposition(configuringSnapshot.receipt);
    if (beforeRegistry.kind === "conflict") {
      fail(`registry conflicts with configuring authority: ${beforeRegistry.detail}`);
    }
    if (beforeRegistry.kind === "missing") {
      const revalidateRegistryBoundary = (): string => {
        assertCurrentTransaction(
          configuringSnapshot.receipt,
          input,
          socketAuthority,
          podmanExecutableAuthority,
          createIntentSha256,
        );
        const currentIdentity = requireCurrentOpenShellIdentity(
          configuringSnapshot.receipt,
          observeSandbox(),
        );
        proveLivePolicy(configuringSnapshot.receipt, capturePolicy);
        requireConfiguredContainerReady(
          assertCurrentHermesPortableContainer(configuringSnapshot.receipt, containerDeps),
        );
        assertRegistryMissingBeforeConfiguration(
          configuringSnapshot.receipt,
          registryDisposition(configuringSnapshot.receipt),
        );
        return currentIdentity.liveIdentityFingerprint;
      };
      if (!admittedRouteReservation) {
        fail("inference route reservation is missing before sandbox registration");
      }
      committedRegistryEntry = await deps.registerSandbox(
        createResult,
        configuringSnapshot.receipt,
        liveIdentity.liveIdentityFingerprint,
        revalidateRegistryBoundary,
        admittedRouteReservation,
      );
      await deps.afterRegistryCommit?.();
    }
    assertCurrentTransaction(
      configuringSnapshot.receipt,
      input,
      socketAuthority,
      podmanExecutableAuthority,
      createIntentSha256,
    );
    liveIdentity = requireCurrentOpenShellIdentity(configuringSnapshot.receipt, observeSandbox());
    proveLivePolicy(configuringSnapshot.receipt, capturePolicy);
    const currentContainer = assertCurrentHermesPortableContainer(
      configuringSnapshot.receipt,
      containerDeps,
    );
    requireConfiguredContainerReady(currentContainer);
    requireMatchingRegistry(
      configuringSnapshot.receipt,
      repairRegistryGatewayPort(configuringSnapshot.receipt, liveIdentity.liveIdentityFingerprint),
      liveIdentity.liveIdentityFingerprint,
    );
    probeHermesPortableAuthenticatedHealth(configuringSnapshot.receipt, containerDeps);
    configuringSnapshot = requireCurrentReceiptSnapshot(configuringSnapshot, input.stateDir, true);
    liveIdentity = requireCurrentOpenShellIdentity(configuringSnapshot.receipt, observeSandbox());
    proveLivePolicy(configuringSnapshot.receipt, capturePolicy);
    requireConfiguredContainerReady(
      assertCurrentHermesPortableContainer(configuringSnapshot.receipt, containerDeps),
    );
    requireMatchingRegistry(
      configuringSnapshot.receipt,
      repairRegistryGatewayPort(configuringSnapshot.receipt, liveIdentity.liveIdentityFingerprint),
      liveIdentity.liveIdentityFingerprint,
    );
    publishHermesPortableLifecycleReceipt(
      activeReceipt(configuringSnapshot, currentContainer),
      input.stateDir,
    );
    const published = publishHermesPortableSuccessorReceipt(input.sandboxName, input.stateDir);
    const active = retireHermesPortableCreatePolicyState(
      published.receipt.sandboxName,
      published.receipt.transactionId,
      input.stateDir,
    );
    return { active, createResult, created };
  });
}

export interface HermesPortableOnboardingFromOnboardInput<T> {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly portableRuntime: PortableOnboardRuntimeContext;
  readonly createArgv: readonly string[];
  readonly createPolicyPath: string;
  readonly startup: ResolveHermesPortableStartupContractInput;
  readonly inferenceRouteReservation: HermesPortableInferenceRouteReservationAuthority;
  readonly withLifecycleLock: HermesPortableOnboardingDeps<T>["withLifecycleLock"];
  readonly childEnv: NodeJS.ProcessEnv;
  readonly openshellArgv: (args: string[]) => string[];
  readonly createSandbox: (
    createArgv: readonly string[],
    readyCapture: ReturnType<typeof createHermesPortableReadyCapture>,
    readyRunner: ReturnType<typeof createHermesPortableReadyRunner>,
    buildContextPath: string,
    effectivePolicySourcePath: string,
  ) => Promise<T>;
  readonly readRegistry: () => SandboxEntry | null;
  readonly revalidatePendingCreateRegistry?: HermesPortableOnboardingDeps<T>["revalidatePendingCreateRegistry"];
  readonly compareAndSetRegistryGatewayPort: HermesPortableOnboardingDeps<T>["compareAndSetRegistryGatewayPort"];
  readonly registerSandbox: HermesPortableOnboardingDeps<T>["registerSandbox"];
  readonly sourceRoot: string;
  readonly buildContextSettings: HermesPortableBuildContextSettings;
  readonly cleanupTemporaryPolicy?: () => boolean;
  readonly createPolicySourceBytes?: Buffer;
}

interface RunHermesPortableOnboardCreateInput<T> {
  readonly argv: readonly string[];
  readonly buildContextPath: string;
  readonly effectivePolicySourcePath: string;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly captureOpenShell: ReturnType<typeof createHermesPortableOpenShellCapture>;
  readonly readyRunner: ReturnType<typeof createHermesPortableReadyRunner>;
  readonly createSandbox: HermesPortableOnboardingFromOnboardInput<T>["createSandbox"];
}

/** Carry one transaction-scoped create source through the outer generic create gate. */
export function runHermesPortableOnboardCreate<T>(
  input: RunHermesPortableOnboardCreateInput<T>,
): Promise<T> {
  const verifiedArgv = rewriteHermesPortableCreatePolicyArgv(
    input.argv,
    input.effectivePolicySourcePath,
    input.effectivePolicySourcePath,
  );
  return input.createSandbox(
    verifiedArgv,
    createHermesPortableReadyCapture(input.sandboxName, input.gatewayName, input.captureOpenShell),
    input.readyRunner,
    input.buildContextPath,
    input.effectivePolicySourcePath,
  );
}

/** Assemble the existing onboarding transaction without changing its lifecycle fence. */
export async function runHermesPortableOnboardingFromOnboard<T>(
  input: HermesPortableOnboardingFromOnboardInput<T>,
): Promise<HermesPortableOnboardingResult<T>> {
  const {
    sandboxName,
    gatewayName,
    lifecycleGeneration,
    portableRuntime,
    createArgv,
    createPolicyPath,
    startup,
    inferenceRouteReservation,
    withLifecycleLock,
    childEnv,
    openshellArgv,
    createSandbox,
    readRegistry,
    revalidatePendingCreateRegistry,
    compareAndSetRegistryGatewayPort,
    registerSandbox,
    sourceRoot,
    buildContextSettings,
    cleanupTemporaryPolicy,
    createPolicySourceBytes,
  } = input;
  const runtimeAuthority = portableRuntime.authority;
  const portableEnvironmentScope = portableRuntime.environmentScope;
  if (!portableEnvironmentScope) {
    throw new Error("Hermes portable onboarding is missing runtime environment authority.");
  }
  const podmanSourceEnv =
    portableEnvironmentScope.createHermesPortablePodmanSourceEnvironment(runtimeAuthority);
  const scopedCreateArgv = scopeHermesPortableCreateGatewayArgv(createArgv, gatewayName);
  const buildContext = createHermesPortableBuildContextPlan(sourceRoot, buildContextSettings);
  const executablePath = scopedCreateArgv[0];
  if (!executablePath) fail("create command has no OpenShell executable authority");
  const commandEnv = createHermesPortableChildEnvironment(childEnv, runtimeAuthority);
  const openshellExecutableAuthority = captureHermesPortableOpenShellExecutableAuthority(
    executablePath,
    commandEnv,
    childEnv,
  );
  const assertOpenShellExecutableAuthority = (): void => {
    assertHermesPortableOpenShellExecutableAuthority(
      openshellExecutableAuthority,
      commandEnv,
      childEnv,
    );
  };
  const captureOpenShell = createHermesPortableOpenShellCapture(
    openshellArgv,
    childEnv,
    runtimeAuthority,
    openshellExecutableAuthority,
  );
  const authenticatedHealth = createHermesPortableAuthenticatedHealthCapture(
    sandboxName,
    gatewayName,
    captureOpenShell,
  );
  const readyRunner = createHermesPortableReadyRunner(sandboxName, gatewayName, captureOpenShell);
  return runHermesPortableOnboardingTransaction(
    {
      sandboxName,
      gatewayName,
      lifecycleGeneration,
      runtimeAuthority,
      openshellExecutableAuthority,
      stateDir: defaultPortableDemoStateDir(process.env),
      createArgv: scopedCreateArgv,
      createPolicyPath,
      ...(createPolicySourceBytes ? { createPolicySourceBytes } : {}),
      buildContext,
      startup,
      inferenceRouteReservation,
    },
    {
      withLifecycleLock,
      capturePodmanExecutableAuthority: (socketAuthority) =>
        captureHermesPortablePodmanExecutableAuthority(
          socketAuthority,
          runtimeAuthority,
          podmanSourceEnv,
        ),
      container: (socketAuthority, podmanAuthority) => ({
        ...createHermesPortableContainerDeps(
          socketAuthority,
          runtimeAuthority,
          podmanAuthority,
          podmanSourceEnv,
        ),
        authenticatedHealth,
      }),
      assertOpenShellExecutableAuthority: () => assertOpenShellExecutableAuthority(),
      capturePolicy: captureOpenShell,
      observeSandbox: (timeoutBudgetMs) =>
        observeHermesPortableSandbox(sandboxName, gatewayName, captureOpenShell, timeoutBudgetMs),
      createSandbox: (argv, buildContextPath, effectivePolicySourcePath) =>
        runHermesPortableOnboardCreate({
          argv,
          buildContextPath,
          effectivePolicySourcePath,
          sandboxName,
          gatewayName,
          captureOpenShell,
          readyRunner,
          createSandbox,
        }),
      readRegistry,
      ...(revalidatePendingCreateRegistry ? { revalidatePendingCreateRegistry } : {}),
      compareAndSetRegistryGatewayPort,
      registerSandbox,
      ...(cleanupTemporaryPolicy ? { cleanupTemporaryPolicy } : {}),
    },
  );
}
