// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import type { AgentDefinition } from "../../agent/defs";
import type { InferenceSelection } from "../../inference/selection";
import {
  fingerprintOpenShellSandboxLiveIdentity,
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
  hermesPortableCreatePolicySemanticDigest,
  proveHermesPortableLivePolicy,
  type HermesPortablePolicyCapture,
} from "./hermes-portable-policy-authority";
import {
  assertHermesPortableDurablePolicyAuthority,
  captureHermesPortablePolicySource,
  createHermesPortableTransactionId,
  inspectPortableAgentReceiptAuthorityForPublicationRecovery,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  readHermesPortableLifecycleReceipt,
  reconcileHermesPortableCurrentPhasePublication,
  recoverableHermesPortablePolicyTransactionId,
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
  readonly observeSandbox: () => HermesPortableSandboxObservation;
  readonly createSandbox: (createArgv: readonly string[], buildContextPath: string) => Promise<T>;
  readonly readRegistry: () => SandboxEntry | null;
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
  return buildOpenShellSubprocessEnv(sourceEnv, runtimeAuthority);
}

/** Adapt the existing synchronous runner to bounded, byte-preserving OpenShell captures. */
export function createHermesPortableOpenShellCapture(
  openshellArgv: (args: string[]) => string[],
  sourceEnv: NodeJS.ProcessEnv = process.env,
  runtimeAuthority?: CheckpointPortableRuntimeAuthority,
  executableAuthority?: HermesPortableOpenShellExecutableAuthority,
  spawn: typeof spawnSync = spawnSync,
): (args: readonly string[]) => HermesPortableOpenShellResult & {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
} {
  return (args) => {
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
    const result: SpawnSyncReturns<string | Buffer> = spawn(executable, argv, {
      env: createHermesPortableChildEnvironment(sourceEnv, runtimeAuthority),
      timeout: 5_000,
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

/** Route every generic create-readiness command through exact schema-5 authority. */
export function createHermesPortableReadyRunner(
  sandboxName: string,
  gatewayName: string,
  capture: ReturnType<typeof createHermesPortableOpenShellCapture>,
): (args: string[], options?: Record<string, unknown>) => HermesPortableOpenShellResult {
  return (args) => {
    const scoped =
      args[0] === "sandbox" && args[1] === "list" && args.length === 2
        ? ["sandbox", "list", "-g", gatewayName]
        : args[0] === "sandbox" && args[1] === "get" && args.length === 3 && args[2] === sandboxName
          ? ["sandbox", "get", "-g", gatewayName, args[2]!]
          : args.length === 6 &&
              args[0] === "sandbox" &&
              args[1] === "exec" &&
              args[2] === "--name" &&
              args[3] === sandboxName &&
              args[4] === "--" &&
              args[5] === "true"
            ? ["sandbox", "exec", "-g", gatewayName, "--name", args[3]!, "--", "true"]
            : null;
    if (!scoped) fail("create readiness attempted an unsupported OpenShell command");
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

/** Keep unowned dashboard/TUI forwards out of schema-5 enrollment. */
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
      canonicalArgs.push(option, "<policy-authority>");
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
    fail("create argv is missing required image, sandbox, gateway, or policy authority");
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

/** Prove gateway reachability before interpreting one exact not-found response as absence. */
export function observeHermesPortableSandbox(
  sandboxName: string,
  gatewayName: string,
  capture: (args: readonly string[]) => HermesPortableOpenShellResult,
): HermesPortableSandboxObservation {
  const list = capture(["sandbox", "list", "-g", gatewayName]);
  if (list.status !== 0 || list.error) {
    return { kind: "ambiguous", detail: "the selected OpenShell gateway is not proven reachable" };
  }
  const current = capture(["sandbox", "get", "-g", gatewayName, sandboxName]);
  if (current.status === 0 && !current.error) {
    const output = strictOpenShellText(current.stdout);
    const sandboxId = parseOpenShellSandboxId(output);
    const liveIdentityFingerprint = fingerprintOpenShellSandboxLiveIdentity(output);
    if (!/^Phase:\s*Ready\s*$/mu.test(output)) {
      return { kind: "ambiguous", detail: "exact OpenShell sandbox is not Ready" };
    }
    return sandboxId && liveIdentityFingerprint
      ? { kind: "present", sandboxId, liveIdentityFingerprint }
      : { kind: "ambiguous", detail: "sandbox get returned no exact durable sandbox ID" };
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

export function classifyHermesPortableRegistry(
  receipt: HermesPortableLifecycleReceipt,
  entry: SandboxEntry | null,
): HermesPortableRegistryDisposition {
  if (!entry) return { kind: "missing" };
  if (entry.pendingRouteReservation === true) {
    return {
      kind: "conflict",
      detail: "the saved row is an inference route reservation, not registered sandbox authority",
    };
  }
  if (
    entry.name !== receipt.sandboxName ||
    entry.agent !== "hermes" ||
    entry.gatewayName !== receipt.gatewayName ||
    entry.lifecycleGeneration !== receipt.lifecycleGeneration ||
    entry.openshellDriver !== "docker" ||
    entry.openshellVersion !== receipt.openshellExecutableAuthority.version
  ) {
    return { kind: "conflict", detail: "the saved row has another agent, gateway, or generation" };
  }
  return { kind: "matching", entry };
}

function commonReceipt(
  input: HermesPortableOnboardingInput,
  socketAuthority: PodmanSocketAuthority,
  podmanExecutableAuthority: HermesPortablePodmanExecutableAuthority,
  createIntentSha256: string,
  startup: ReturnType<typeof resolveHermesPortableStartupContract>,
) {
  return {
    schemaVersion: 5 as const,
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
  currentIntendedSemanticSha256: string,
): void {
  if (
    receipt.sandboxName !== input.sandboxName ||
    receipt.gatewayName !== input.gatewayName ||
    receipt.lifecycleGeneration !== input.lifecycleGeneration ||
    !isDeepStrictEqual(receipt.runtimeAuthority, input.runtimeAuthority) ||
    !isDeepStrictEqual(receipt.openshellExecutableAuthority, input.openshellExecutableAuthority) ||
    !isDeepStrictEqual(receipt.podmanExecutableAuthority, podmanExecutableAuthority) ||
    !isDeepStrictEqual(receipt.socketAuthority, socketAuthority) ||
    receipt.createIntentSha256 !== createIntentSha256
  ) {
    fail("saved transaction disagrees with current sandbox, generation, or runtime authority");
  }
  assertCurrentHermesPortableStartupContract(receipt.startup, input.startup);
  if (currentIntendedSemanticSha256 !== receipt.policy.intendedSemanticSha256) {
    fail("saved transaction disagrees with the current create policy intent");
  }
  assertHermesPortableDurablePolicyAuthority(receipt.policy);
}

function proveLivePolicy(
  receipt: HermesPortableLifecycleReceipt,
  capture: HermesPortablePolicyCapture,
): string {
  const durable = assertHermesPortableDurablePolicyAuthority(receipt.policy);
  const proof = proveHermesPortableLivePolicy({
    gatewayName: receipt.gatewayName,
    sandboxName: receipt.sandboxName,
    createPolicyBytes: durable,
    capture,
  });
  if (proof.intendedSemanticSha256 !== receipt.policy.intendedSemanticSha256) {
    fail("live policy proof disagrees with pending intent");
  }
  return proof.verifiedLivePolicySemanticSha256;
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
  livePolicyDigest: string,
  container: HermesPortableContainerInspection,
): HermesPortableConfiguredReceipt {
  if (pending.receipt.phase !== "pending") fail("configuring requires pending authority");
  return {
    ...pending.receipt,
    phase: "configuring",
    previousPhaseSha256: pending.sha256,
    verifiedLivePolicySemanticSha256: livePolicyDigest,
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
  return await deps.withLifecycleLock(input.sandboxName, async () => {
    assertHermesPortableUninstallCompleteForOnboarding(input.stateDir);
    const assertOpenShellExecutableAuthority = (): void =>
      deps.assertOpenShellExecutableAuthority(input.openshellExecutableAuthority);
    const observeSandbox = (): HermesPortableSandboxObservation => {
      assertOpenShellExecutableAuthority();
      return deps.observeSandbox();
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
    const currentIntendedSemanticSha256 = hermesPortableCreatePolicySemanticDigest(
      temporaryPolicy.bytes,
    );
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
    let committedRegistryEntry =
      snapshot &&
      snapshot.receipt.phase !== "pending" &&
      initialRegistryEntry &&
      classifyHermesPortableRegistry(snapshot.receipt, initialRegistryEntry).kind === "matching"
        ? structuredClone(initialRegistryEntry)
        : null;
    const canClassifyCommittedRegistry = Boolean(
      snapshot &&
      snapshot.receipt.phase !== "pending" &&
      initialRouteReservation.kind === "not-reservation",
    );
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
      const reservation = classifySandboxInferenceRouteReservation(
        routeReservationAuthority,
        entry,
      );
      if (reservation.kind === "conflict") return reservation;
      if (reservation.kind === "owned") {
        return admittedRouteReservation &&
          isCurrentSandboxInferenceRouteReservation(admittedRouteReservation, entry)
          ? { kind: "missing" }
          : {
              kind: "conflict",
              detail: "the inference route reservation changed after admission",
            };
      }
      if (reservation.kind === "missing") {
        return admittedRouteReservation
          ? {
              kind: "conflict",
              detail: "the inference route reservation disappeared after admission",
            }
          : { kind: "missing" };
      }
      const committed = classifyHermesPortableRegistry(receipt, entry);
      if (
        committed.kind === "matching" &&
        (!committedRegistryEntry || !isDeepStrictEqual(entry, committedRegistryEntry))
      ) {
        return {
          kind: "conflict",
          detail: "sandbox registry authority replaced the route reservation before registration",
        };
      }
      return committed;
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
        currentIntendedSemanticSha256,
      );
      createArgv = rewriteHermesPortableCreatePolicyArgv(
        validatedCreateArgv,
        input.createPolicyPath,
        snapshot.receipt.policy.sourcePath,
      );
    } else {
      const transactionId = recoverableTransactionId ?? createHermesPortableTransactionId();
      const policy = publishHermesPortableDurablePolicySource({
        sandboxName: input.sandboxName,
        transactionId,
        stateDir: input.stateDir,
        intendedSemanticSha256: currentIntendedSemanticSha256,
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
        registryDisposition(activeSnapshot.receipt),
        liveIdentity.liveIdentityFingerprint,
      );
      probeHermesPortableAuthenticatedHealth(activeSnapshot.receipt, containerDeps);
      activeSnapshot = requireCurrentReceiptSnapshot(activeSnapshot, input.stateDir);
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
        registryDisposition(activeSnapshot.receipt),
        finalIdentity.liveIdentityFingerprint,
      );
      return { active: activeSnapshot, createResult, created };
    }

    if (snapshot.receipt.phase === "pending") {
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
          currentIntendedSemanticSha256,
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
        );
        buildContext.assertCurrent();
        input.buildContext.assertCurrentSource();
        created = true;
        observation = observeSandbox();
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
        currentIntendedSemanticSha256,
      );
      const livePolicyDigest = proveLivePolicy(snapshot.receipt, capturePolicy);
      const container = enrollHermesPortableContainer(
        snapshot.receipt,
        observation.sandboxId,
        containerDeps,
      );
      snapshot = publishHermesPortableLifecycleReceipt(
        configuringReceipt(snapshot, livePolicyDigest, container),
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
      currentIntendedSemanticSha256,
    );
    let liveIdentity = requireCurrentOpenShellIdentity(
      configuringSnapshot.receipt,
      observeSandbox(),
    );
    proveLivePolicy(configuringSnapshot.receipt, capturePolicy);
    requireRegistryBeforeConfigurationMutation(
      registryDisposition(configuringSnapshot.receipt),
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
          currentIntendedSemanticSha256,
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
      currentIntendedSemanticSha256,
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
      registryDisposition(configuringSnapshot.receipt),
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
      registryDisposition(configuringSnapshot.receipt),
      liveIdentity.liveIdentityFingerprint,
    );
    const active = publishHermesPortableLifecycleReceipt(
      activeReceipt(configuringSnapshot, currentContainer),
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
  ) => Promise<T>;
  readonly readRegistry: () => SandboxEntry | null;
  readonly registerSandbox: HermesPortableOnboardingDeps<T>["registerSandbox"];
  readonly sourceRoot: string;
  readonly buildContextSettings: HermesPortableBuildContextSettings;
  readonly cleanupTemporaryPolicy?: () => boolean;
  readonly createPolicySourceBytes?: Buffer;
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
      container: (socketAuthority, podmanAuthority) =>
        createHermesPortableContainerDeps(
          socketAuthority,
          runtimeAuthority,
          podmanAuthority,
          podmanSourceEnv,
        ),
      assertOpenShellExecutableAuthority: () => assertOpenShellExecutableAuthority(),
      capturePolicy: captureOpenShell,
      observeSandbox: () =>
        observeHermesPortableSandbox(sandboxName, gatewayName, captureOpenShell),
      createSandbox: (argv, buildContextPath) =>
        createSandbox(
          argv,
          createHermesPortableReadyCapture(sandboxName, gatewayName, captureOpenShell),
          readyRunner,
          buildContextPath,
        ),
      readRegistry,
      registerSandbox,
      ...(cleanupTemporaryPolicy ? { cleanupTemporaryPolicy } : {}),
    },
  );
}
