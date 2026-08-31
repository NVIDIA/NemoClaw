// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import {
  mergeIsolatedDockerClientEnv,
  prepareDockerBuildEnvironment,
  warnIfDockerBuildEnvironmentCleanupFailed,
} from "../adapters/docker/client-isolation";
import {
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
  parseOpenShellSandboxId,
  observeCreatedOpenShellSandboxId,
  resolveCreatedOpenShellSandboxId,
  resolveOpenShellSandboxId,
  settleCreatedOpenShellSandboxId,
} from "../adapters/openshell/sandbox-identity";
import { printSandboxCreateRecoveryHints } from "../build-context";
import { streamSandboxCreate, type StreamSandboxCreateResult } from "../sandbox/create-stream";
import { getReadyCheckOutputPatternsForAgent } from "../sandbox/create-stream-ready-gate";
import { isSandboxReady } from "../state/gateway";
import type { SandboxGpuProofResult } from "../state/registry";
import { classifySandboxCreateFailure } from "../validation";
import { reportSandboxCreateFailure } from "./created-sandbox-failure";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { createDockerGpuSandboxCreatePatch } from "./docker-gpu-sandbox-create";
import { installPortableDemoSandboxLifecycle } from "./experimental/portable-demo-lifecycle";
import { enforceManagedBootstrapRecoveryForSandbox } from "./managed-bootstrap/adapter";
import type {
  ManagedBootstrapNativeGpuFallbackOwnerCleanupHandoff,
  ManagedBootstrapRuntimeCreateLifecycle,
  ManagedBootstrapRuntimePatch,
  ManagedBootstrapRuntimeSnapshot,
} from "./managed-bootstrap/runtime-create";
import {
  queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot,
} from "./openshell-docker-sandbox-containers";
import { printSandboxCreateFailureDiagnostics } from "./sandbox-create-failure";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import type {
  SandboxGpuCreateFlowDeps,
  SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";
import { fingerprintSandboxRecreateValue } from "./sandbox-recreate-transaction";
import * as sandboxGpuPreflight from "./sandbox-gpu-preflight";
import { SANDBOX_RECREATE_PROBE_TIMEOUT_MS } from "./sandbox-recreate-probe";
import type { CreatedSandboxReadyIdentityCheck } from "./sandbox-readiness-tracing";
import * as sandboxReadinessTracing from "./sandbox-readiness-tracing";
import { addTraceEvent } from "./tracing";

type NativeRuntimeSnapshot = ManagedBootstrapRuntimeSnapshot;

export type SandboxGpuCreateAttemptState = {
  firstCreateOutput: string;
  compatibilityArgv: string[] | null;
  compatibilityBootstrapIdentity: string | null;
  compatibilityHeldWorkloadArgv: string[] | null;
  allowUnbuiltCompatibilitySource: boolean;
  nativeRuntimeSnapshot: NativeRuntimeSnapshot | null;
  portableLifecycleGeneration: string | null;
};

// A runtime-managed container replacement can briefly observe the original
// container's stale Ready row. Require one confirmation poll before advancing
// to live validation or the GPU proof.
const REPLACEMENT_STABLE_READY_POLLS = 2;
const SANDBOX_READY_PROBE_TIMEOUT_MS = 5_000;
const CREATED_SANDBOX_PUBLICATION_POLL_INTERVAL_MS = 1_000;

async function streamSandboxCreateWithPublicImageCredentialIsolation(
  isolate: boolean,
  sandboxName: string,
  sandboxEnv: NodeJS.ProcessEnv,
  run: (env: NodeJS.ProcessEnv) => Promise<StreamSandboxCreateResult>,
): Promise<StreamSandboxCreateResult> {
  if (!isolate) return run(sandboxEnv);
  // Detect against the same environment the create command runs with. The
  // sandbox env drops DOCKER_CONFIG and DOCKER_CONTEXT, so process.env can
  // report a credential store or a context the create never uses.
  const prepared = prepareDockerBuildEnvironment({
    env: sandboxEnv,
    allowCredentialIsolation: true,
  });
  try {
    if (prepared.isolatedCredentialConfig) {
      console.log(
        "  Docker Desktop credential helper is unavailable in this WSL session; using an isolated credential-free config for the managed sandbox image pull.",
      );
    }
    return await run(mergeIsolatedDockerClientEnv(sandboxEnv, prepared));
  } finally {
    warnIfDockerBuildEnvironmentCleanupFailed(
      prepared.cleanup(),
      `managed sandbox create '${sandboxName}'`,
    );
  }
}

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/gu;
const OPENSHELL_SANDBOX_NOT_READY =
  /^Error: code: 'The system is not in a state required for the operation's execution', message: "sandbox is not ready"$/iu;

/** Reject caller policy flags while leaving workload arguments after `--` untouched. */
export function assertPolicylessSandboxCreateArgv(argv: readonly string[]): void {
  const createArgs = argv.slice(0, argv.indexOf("--") < 0 ? argv.length : argv.indexOf("--"));
  if (createArgs.some((arg) => arg === "--policy" || arg.startsWith("--policy="))) {
    throw new Error("APF interceptor sandbox creation must not supply a caller policy.");
  }
}

type OpenShellCommandResult = ReturnType<SandboxGpuCreateFlowDeps["runOpenshell"]>;

function createPortableRuntimePatch(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
  recordLifecycleGeneration: (generation: string) => void,
): ManagedBootstrapRuntimePatch {
  let applied = false;
  return {
    maybeApplyDuringCreate() {},
    createFailureMessage: () => null,
    exitOnPatchError() {},
    rollbackManagedStartupAfterCreateFailure() {},
    ensureApplied() {
      if (applied) return;
      const generation = (deps.installPortableDemoLifecycle ?? installPortableDemoSandboxLifecycle)(
        input.sandboxName,
        input.sandboxStartupCommand,
        input.hostEnv ?? process.env,
        {
          ...(input.lifecycleGeneration ? { registryGeneration: input.lifecycleGeneration } : {}),
          runtimeAuthority: input.portableRuntimeAuthority ?? null,
        },
      );
      if (!generation) {
        throw new Error(`Portable lifecycle setup did not record sandbox '${input.sandboxName}'.`);
      }
      recordLifecycleGeneration(generation);
      applied = true;
    },
    waitForSupervisorReconnectIfNeeded() {},
    commitAfterReady() {},
    selectedMode: () => null,
    printReadinessFailureIfEnabled() {},
    async verifyGpuOrExit(verifyDirectSandboxGpu) {
      return verifyDirectSandboxGpu(input.sandboxName);
    },
  };
}

type NativeFallbackCleanupEvidence = Readonly<{
  nativeCleanupHandoff?: ManagedBootstrapNativeGpuFallbackOwnerCleanupHandoff;
}>;

function warnForAuthorizedCompatibilityRetry(
  route: SelectedDockerGpuRoute,
  initialGpuRoute: SelectedDockerGpuRoute,
): void {
  if (route !== "compatibility" || initialGpuRoute !== "native") return;
  console.warn(
    "  Native OpenShell GPU onboarding did not complete; retrying once by recreating the OpenShell-managed Docker container with the legacy GPU compatibility envelope.",
  );
  console.warn(
    "  This compatibility container swap may relax container confinement compared with native injection. The retry is running only because NEMOCLAW_DOCKER_GPU_PATCH=fallback explicitly authorized it.",
  );
}

async function rollbackNativeGpuFailureForFallback(
  managedLifecycle: ManagedBootstrapRuntimeCreateLifecycle | null,
  runtimePatch: ManagedBootstrapRuntimePatch,
): Promise<NativeFallbackCleanupEvidence> {
  if (!managedLifecycle) {
    await runtimePatch.rollbackManagedStartupAfterCreateFailure();
    return {};
  }
  const rollback = await runtimePatch.rollbackManagedStartupAfterCreateFailure({
    ownerCleanupHandoff: "native-gpu-fallback",
  });
  if (rollback?.kind !== "openshell-owner-cleanup-required") return {};
  return { nativeCleanupHandoff: rollback };
}

function normalizedOpenShellCommandOutput(result: OpenShellCommandResult): string {
  return `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`
    .replace(ANSI_RE, "")
    .replace(/[×│]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

type OpenShellSandboxIdentityProbe =
  | { state: "identified"; sandboxId: string }
  | { state: "not_ready" }
  | { state: "failed" };

function addCreateAttemptIdentityLabel(argv: readonly string[], nonce: string): string[] {
  const optionEnd = argv.indexOf("--");
  const insertAt = optionEnd === -1 ? argv.length : optionEnd;
  const labelPrefix = `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=`;
  for (let index = 0; index < insertAt; index += 1) {
    const argument = argv[index] ?? "";
    if (
      (argument === "--label" && (argv[index + 1] ?? "").startsWith(labelPrefix)) ||
      argument.startsWith(`--label=${labelPrefix}`)
    ) {
      throw new Error("OpenShell create arguments override NemoClaw's reserved identity label.");
    }
  }
  return [
    ...argv.slice(0, insertAt),
    "--label",
    `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`,
    ...argv.slice(insertAt),
  ];
}

function remainingReadinessProbeTimeout(getRemainingMs: () => number): number | null {
  const remainingMs = Math.floor(getRemainingMs());
  return remainingMs > 0 ? Math.min(SANDBOX_RECREATE_PROBE_TIMEOUT_MS, remainingMs) : null;
}

function probeExactOpenShellSandboxId(
  sandboxName: string,
  gatewayName: string,
  deps: SandboxGpuCreateFlowDeps,
  getRemainingMs: () => number = () => SANDBOX_RECREATE_PROBE_TIMEOUT_MS,
): OpenShellSandboxIdentityProbe {
  const timeout = remainingReadinessProbeTimeout(getRemainingMs);
  if (timeout === null) return { state: "not_ready" };
  const result = deps.runOpenshell(["sandbox", "get", "-g", gatewayName, sandboxName], {
    ignoreError: true,
    suppressOutput: true,
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.status === 0 && !result.error) {
    const sandboxId = parseOpenShellSandboxId(String(result.stdout ?? ""));
    return sandboxId ? { state: "identified", sandboxId } : { state: "failed" };
  }
  if (result.error || result.status === null || ("signal" in result && result.signal)) {
    return { state: "failed" };
  }
  return OPENSHELL_SANDBOX_NOT_READY.test(normalizedOpenShellCommandOutput(result))
    ? { state: "not_ready" }
    : { state: "failed" };
}

async function verifyCreatedSandboxBeforeEffects(
  sandboxId: string,
  createAttemptNonce: string,
  route: SelectedDockerGpuRoute,
  input: SandboxGpuCreateFlowInput,
): Promise<void> {
  if (!input.verifyCreatedSandboxBeforeEffects) return;
  await input.verifyCreatedSandboxBeforeEffects({
    sandboxId,
    liveIdentityFingerprint: fingerprintSandboxRecreateValue(sandboxId),
    createAttemptNonce,
    route,
  });
}

function persistCreateAttemptRecovery(options: {
  readonly input: SandboxGpuCreateFlowInput;
  readonly createAttemptNonce: string | null;
  readonly detail: string;
  readonly sandboxIdentityFingerprint?: string;
}): void {
  const { input, createAttemptNonce, detail, sandboxIdentityFingerprint } = options;
  if (!createAttemptNonce) {
    throw new Error("Sandbox create-attempt identity was not generated.");
  }
  const persist = input.persistRetainedSandboxRecovery;
  if (!persist) {
    throw new Error("Verified sandbox creation has no durable recovery evidence owner.");
  }
  const message =
    `Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${createAttemptNonce}. ` +
    (sandboxIdentityFingerprint
      ? `Durable sandbox identity fingerprint: ${sandboxIdentityFingerprint}. `
      : "") +
    detail;
  let persistenceFailure: unknown = null;
  try {
    if (!persist(message, sandboxIdentityFingerprint, createAttemptNonce)) {
      persistenceFailure = new Error(
        "The retained sandbox recovery writer did not confirm durable persistence.",
      );
    }
  } catch (error) {
    persistenceFailure = error;
  }
  console.error(`  ${message}`);
  if (persistenceFailure) {
    console.error(
      "  NemoClaw could not save this create-attempt evidence. The recovery-only session remains blocked until its durable recovery record can be saved.",
    );
    throw new Error(
      "NemoClaw could not save the retained sandbox recovery record; the recovery-only session remains blocked.",
      { cause: persistenceFailure },
    );
  }
}

function persistIdentitySettlementRecoveryEvidence(options: {
  readonly input: SandboxGpuCreateFlowInput;
  readonly createAttemptNonce: string | null;
  readonly sandboxIdentityFingerprint: string | null;
}): void {
  const { input, createAttemptNonce, sandboxIdentityFingerprint } = options;
  const identityEvidence = sandboxIdentityFingerprint
    ? `Sandbox '${input.sandboxName}' did not remain visible through owning gateway '${input.gatewayName}' before identity verification completed. `
    : `Sandbox '${input.sandboxName}' reached Ready before OpenShell returned one exact durable create identity. Gateway '${input.gatewayName}'. OpenShell did not return one exact durable sandbox identity for this create attempt. `;
  persistCreateAttemptRecovery({
    input,
    createAttemptNonce,
    detail:
      identityEvidence +
      "Do not delete a sandbox by mutable name; preserve it until an OpenShell administrator resolves the create-attempt label to one sandbox.",
    sandboxIdentityFingerprint: sandboxIdentityFingerprint ?? undefined,
  });
}

async function confirmManagedRuntimeCommitReadiness(options: {
  readonly input: SandboxGpuCreateFlowInput;
  readonly deps: SandboxGpuCreateFlowDeps;
  readonly sandboxId: string | null;
  readonly createAttemptNonce: string | null;
}): Promise<void> {
  const { input, deps, sandboxId } = options;
  if (!sandboxId) return;
  input.revalidateVerifiedSandboxBeforeEffect?.(
    `confirm committed runtime readiness for sandbox '${input.sandboxName}'`,
  );
  const committedReadiness = await sandboxReadinessTracing.waitForCreatedSandboxReadyWithTrace({
    sandboxName: input.sandboxName,
    timeoutSecs: input.sandboxReadyTimeoutSecs,
    observer: deps.sandboxObserver,
    target: { kind: "named", gatewayName: input.gatewayName },
    stableReadyPolls: REPLACEMENT_STABLE_READY_POLLS,
    checkReadyIdentity: (getRemainingMs = () => SANDBOX_RECREATE_PROBE_TIMEOUT_MS) =>
      checkRecreatedSandboxReadyIdentity(
        input.sandboxName,
        input.gatewayName,
        sandboxId,
        deps,
        getRemainingMs,
      ),
    sleep: deps.sleep,
  });
  if (committedReadiness.ready) return;
  console.error("");
  sandboxReadinessTracing.printReadinessFailure(
    committedReadiness,
    input.sandboxName,
    input.sandboxReadyTimeoutSecs,
  );
  const sandboxIdentityFingerprint = fingerprintSandboxRecreateValue(sandboxId);
  persistCreateAttemptRecovery({
    input,
    createAttemptNonce: options.createAttemptNonce,
    sandboxIdentityFingerprint,
    detail:
      `Managed runtime commit completed for sandbox '${input.sandboxName}', but the same sandbox did not return to executable Ready state through owning gateway '${input.gatewayName}'. ` +
      "Do not delete a sandbox by mutable name; preserve it for identity-bound recovery.",
  });
  (deps.printCreateFailureDiagnostics ?? printSandboxCreateFailureDiagnostics)(input.sandboxName, {
    backupPath: input.restoreBackupPath,
  });
  console.error(
    "  NemoClaw did not start dashboard forwarding. NemoClaw left the sandbox in place for identity-bound recovery.",
  );
  console.error(
    `  Do not delete sandbox '${input.sandboxName}' by name. Give the create-attempt label above to an OpenShell administrator and ask them to remove that exact sandbox and reconcile its retained recovery state through an identity-bound procedure.`,
  );
  throw new Error(
    `Sandbox '${input.sandboxName}' did not return to Ready after its managed runtime commit.`,
  );
}

async function requireManagedBootstrapCreatedSandboxReady(options: {
  readonly input: SandboxGpuCreateFlowInput;
  readonly deps: SandboxGpuCreateFlowDeps;
  readonly createAttemptNonce: string | null;
  readonly persistIdentitySettlementRecovery: () => void;
}): Promise<void> {
  const observation = await sandboxReadinessTracing.observeOpenShellSandbox(
    options.deps.sandboxObserver,
    { kind: "named", gatewayName: options.input.gatewayName },
    options.input.sandboxName,
    SANDBOX_READY_PROBE_TIMEOUT_MS,
  );
  if (!observation.ok) {
    if (options.createAttemptNonce) options.persistIdentitySettlementRecovery();
    throw new Error(
      `Managed bootstrap create completed, but NemoClaw could not observe the sandbox. ${observation.error.message}`,
    );
  }
  if (observation.value.state !== "present" || observation.value.sandbox.readiness !== "ready") {
    if (options.createAttemptNonce) options.persistIdentitySettlementRecovery();
    throw new Error("Managed bootstrap create completed without an authoritative Ready sandbox.");
  }
}

function resolveCreateAttemptNonce(
  input: SandboxGpuCreateFlowInput,
  deferPostCreateEffects: boolean,
): string | null {
  const resumedCreateAttemptNonce = input.resumeVerifiedCreate?.createAttemptNonce;
  if (!input.resumeVerifiedCreate) {
    return deferPostCreateEffects
      ? randomBytes(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH / 2).toString("hex")
      : null;
  }
  if (
    !resumedCreateAttemptNonce ||
    resumedCreateAttemptNonce.length !== NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH ||
    !/^[0-9a-f]+$/u.test(resumedCreateAttemptNonce)
  ) {
    throw new Error(
      "Verified sandbox recovery has no durable create-attempt authority; refusing continuation.",
    );
  }
  return resumedCreateAttemptNonce;
}

function waitForCreatedOpenShellSandboxPublication(
  sandboxId: string,
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
): void {
  const timeoutMs = Math.max(1, Math.round(input.sandboxReadyTimeoutSecs * 1_000));
  const published = sandboxReadinessTracing.waitForCreatedSandboxPublication({
    budgetMs: timeoutMs,
    pollIntervalMs: CREATED_SANDBOX_PUBLICATION_POLL_INTERVAL_MS,
    now: deps.publicationNow,
    sleep: deps.sleep,
    probe: (getRemainingMs) => {
      const result = deps.runOpenshell(
        ["sandbox", "get", "-g", input.gatewayName, input.sandboxName],
        {
          ignoreError: true,
          suppressOutput: true,
          timeout: Math.min(SANDBOX_READY_PROBE_TIMEOUT_MS, getRemainingMs()),
          killSignal: "SIGKILL",
        },
      );
      if (result.status === 0 && !result.error) {
        const publishedSandboxId = parseOpenShellSandboxId(String(result.stdout ?? ""));
        if (!publishedSandboxId) {
          throw new Error(
            `OpenShell returned no exact durable ID for created sandbox '${input.sandboxName}'.`,
          );
        }
        if (publishedSandboxId !== sandboxId) {
          throw new Error(
            `Created sandbox '${input.sandboxName}' changed identity before identity verification completed.`,
          );
        }
        return true;
      }
      return false;
    },
  });
  if (!published) {
    throw new Error(
      `Created sandbox '${input.sandboxName}' did not become visible through its owning gateway before identity verification completed.`,
    );
  }
}

function waitForCreatedSandboxPublicationOrPersist(
  sandboxId: string,
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
  persistIdentitySettlementRecovery: (sandboxIdentityFingerprint: string) => void,
): void {
  try {
    waitForCreatedOpenShellSandboxPublication(sandboxId, input, deps);
  } catch (error) {
    persistIdentitySettlementRecovery(fingerprintSandboxRecreateValue(sandboxId));
    throw error;
  }
}

function checkRecreatedSandboxReadyIdentity(
  sandboxName: string,
  gatewayName: string,
  expectedSandboxId: string,
  deps: SandboxGpuCreateFlowDeps,
  getRemainingMs: () => number,
): ReturnType<CreatedSandboxReadyIdentityCheck> {
  const identity = probeExactOpenShellSandboxId(sandboxName, gatewayName, deps, getRemainingMs);
  if (identity.state === "not_ready") return "not_ready";
  if (identity.state === "failed") return "probe_failed";
  if (identity.sandboxId !== expectedSandboxId) return "identity_changed";
  return checkSandboxExecutableReadiness(sandboxName, gatewayName, deps, getRemainingMs);
}

function checkCreatedSandboxReadyIdentity(
  sandboxName: string,
  gatewayName: string,
  deps: SandboxGpuCreateFlowDeps,
  getRemainingMs: () => number,
): ReturnType<CreatedSandboxReadyIdentityCheck> {
  const identity = probeExactOpenShellSandboxId(sandboxName, gatewayName, deps, getRemainingMs);
  if (identity.state === "not_ready") return "not_ready";
  if (identity.state === "failed") return "probe_failed";
  return checkSandboxExecutableReadiness(sandboxName, gatewayName, deps, getRemainingMs);
}

function checkSandboxExecutableReadiness(
  sandboxName: string,
  gatewayName: string,
  deps: SandboxGpuCreateFlowDeps,
  getRemainingMs: () => number,
): ReturnType<CreatedSandboxReadyIdentityCheck> {
  const timeout = remainingReadinessProbeTimeout(getRemainingMs);
  if (timeout === null) return "not_ready";
  const result = deps.runOpenshell(
    ["sandbox", "exec", "-g", gatewayName, "--name", sandboxName, "--", "true"],
    {
      ignoreError: true,
      suppressOutput: true,
      timeout,
      killSignal: "SIGKILL",
    },
  );
  if (result.status === 0 && !result.error) return "ready";
  if (result.error || result.status === null || ("signal" in result && result.signal)) {
    return "probe_failed";
  }
  return OPENSHELL_SANDBOX_NOT_READY.test(normalizedOpenShellCommandOutput(result))
    ? "not_ready"
    : "probe_failed";
}

class ManagedBootstrapCreateStreamFailure extends Error {
  constructor(readonly result: Awaited<ReturnType<typeof streamSandboxCreate>>) {
    super("Managed bootstrap held workload did not complete its create stream.");
  }
}

export function createSandboxGpuCreateAttemptRunner(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
) {
  const portableLifecycle = input.portableLifecycle === true;
  const printCreateFailureDiagnostics =
    deps.printCreateFailureDiagnostics ??
    (input.hermesPortableLifecycle
      ? (sandboxName: string) =>
          console.error(
            `  Hermes portable sandbox '${sandboxName}' did not complete receipt-owned creation. Preserve its lifecycle receipt and resume onboarding after correcting the reported failure.`,
          )
      : printSandboxCreateFailureDiagnostics);
  if (
    portableLifecycle &&
    (input.gpuRoutePlan === "compatibility-only" ||
      input.gpuRoutePlan === "native-with-fallback" ||
      input.initialGpuRoute === "compatibility")
  ) {
    throw new Error(
      "Portable sandbox creation requires native OpenShell GPU injection; Docker GPU compatibility is unavailable.",
    );
  }
  const state: SandboxGpuCreateAttemptState = {
    firstCreateOutput: "",
    compatibilityArgv: null,
    compatibilityBootstrapIdentity: null,
    compatibilityHeldWorkloadArgv: null,
    allowUnbuiltCompatibilitySource: false,
    nativeRuntimeSnapshot: null,
    portableLifecycleGeneration: null,
  };
  const revalidatePostCreateEffect = (operation: string): void => {
    if (!input.verifyCreatedSandboxBeforeEffects) return;
    const revalidate = input.revalidateVerifiedSandboxBeforeEffect;
    if (!revalidate) {
      throw new Error("Verified sandbox creation has no post-create effect revalidation.");
    }
    revalidate(operation);
  };
  const managedRouting = input.managedBootstrap?.runtimeProvider.bootstrap.createOnboardRouting({
    sandboxName: input.sandboxName,
    openshellArgv: deps.openshellArgv,
    nativeFallbackEnabled:
      input.initialGpuRoute === "native" && input.gpuRoutePlan === "native-with-fallback",
  });
  const nativeFallbackBaseline =
    !managedRouting &&
    !portableLifecycle &&
    input.initialGpuRoute === "native" &&
    input.gpuRoutePlan === "native-with-fallback"
      ? queryOpenShellDockerSandboxContainers(input.sandboxName)
      : null;
  const nativeFallbackHasCleanBaseline =
    managedRouting?.nativeFallbackHasCleanBaseline ??
    (nativeFallbackBaseline?.ok === true && nativeFallbackBaseline.ids.length === 0);
  const runAttempt = async (route: SelectedDockerGpuRoute) => {
    const deferPostCreateEffects = input.verifyCreatedSandboxBeforeEffects !== undefined;
    const compatibility = route === "compatibility";
    warnForAuthorizedCompatibilityRetry(route, input.initialGpuRoute);
    const hasRequiredUlimits = (input.requiredUlimits?.length ?? 0) > 0;
    const managedBootstrap = input.managedBootstrap ?? null;
    const unboundAttemptArgv = state.compatibilityArgv ?? input.createArgv;
    if (input.requirePolicylessCreate) assertPolicylessSandboxCreateArgv(unboundAttemptArgv);
    const createAttemptNonce = resolveCreateAttemptNonce(input, deferPostCreateEffects);
    const persistIdentitySettlementRecovery = (
      sandboxIdentityFingerprint: string | null = null,
    ): void => {
      persistIdentitySettlementRecoveryEvidence({
        input,
        createAttemptNonce,
        sandboxIdentityFingerprint,
      });
    };
    const waitForCreatedSandboxPublication = (sandboxId: string): void =>
      waitForCreatedSandboxPublicationOrPersist(
        sandboxId,
        input,
        deps,
        persistIdentitySettlementRecovery,
      );
    const captureRetainedSandboxRecovery = () => {
      if (!input.requirePolicylessCreate || !createAttemptNonce) return {};
      let liveIdentityFingerprint: string | null = null;
      try {
        const sandboxId = resolveCreatedOpenShellSandboxId({
          sandboxName: input.sandboxName,
          gatewayName: input.gatewayName,
          createAttemptNonce,
          runCaptureOpenshell: deps.runCaptureOpenshell,
        });
        liveIdentityFingerprint = fingerprintSandboxRecreateValue(sandboxId);
      } catch {
        // The nonce remains durable recovery evidence when identity lookup is unavailable.
      }
      return {
        retainedSandboxRecovery: {
          createAttemptNonce,
          liveIdentityFingerprint,
        },
      } as const;
    };
    const attemptArgv = createAttemptNonce
      ? addCreateAttemptIdentityLabel(unboundAttemptArgv, createAttemptNonce)
      : unboundAttemptArgv;
    const attemptBootstrapIdentity =
      state.compatibilityBootstrapIdentity ?? managedBootstrap?.bootstrapIdentity ?? null;
    const attemptHeldWorkloadArgv =
      state.compatibilityHeldWorkloadArgv ?? input.sandboxStartupCommand;
    const managedLifecycle = managedBootstrap
      ? managedBootstrap.runtimeProvider.bootstrap.createLifecycle({
          providerId: managedBootstrap.runtimeProvider.identity.id,
          stateRoot: managedBootstrap.stateRoot,
          bootstrapIdentity: attemptBootstrapIdentity ?? managedBootstrap.bootstrapIdentity,
          request: managedBootstrap.request,
          image: managedBootstrap.image,
          agentIdentity: managedBootstrap.agentIdentity,
          intendedWorkloadArgv: managedBootstrap.intendedWorkloadArgv,
          expectedSupervisorArgv: managedBootstrap.expectedSupervisorArgv,
          launchArgv: attemptArgv,
          heldWorkloadArgv: attemptHeldWorkloadArgv,
          authorityStore: managedBootstrap.authorityStore,
          ...(deps.createManagedBootstrapAdapter
            ? { adapterOverride: deps.createManagedBootstrapAdapter(managedBootstrap.stateRoot) }
            : {}),
          route,
          persistStartupCommand: input.persistStartupCommand === true,
          sandboxName: input.sandboxName,
          sandboxGpuConfig: input.sandboxGpuConfig,
          requiredLimits: input.requiredUlimits ?? [],
          timeoutSecs: input.sandboxReadyTimeoutSecs,
          dockerClientEnv: input.sandboxEnv,
          network: {
            inferenceProvider: input.provider,
            gatewayUsesContainerBridge: input.dockerDriverGateway,
            gatewayPort: input.gatewayPort,
          },
          dependencies: {
            runCaptureOpenshell: deps.runCaptureOpenshell,
            runOpenshell: deps.runOpenshell,
            sleep: deps.sleep,
          },
        })
      : null;
    const persistRestartSafeStartup =
      input.persistStartupCommand === true &&
      (route !== "native" || !input.terminalAgent || hasRequiredUlimits);
    const deferRestartSafeCutover =
      !managedLifecycle && !portableLifecycle && !compatibility && persistRestartSafeStartup;
    const portableRuntimePatch = portableLifecycle
      ? createPortableRuntimePatch(input, deps, (generation) => {
          state.portableLifecycleGeneration = generation;
        })
      : null;
    const runtimePatch =
      managedLifecycle?.patch ??
      (portableRuntimePatch
        ? portableRuntimePatch
        : createDockerGpuSandboxCreatePatch({
            route,
            // The startup clone preserves native CDI devices, so non-terminal agents
            // keep their selected command and DCode can apply its exact required limits
            // without replacing the native GPU envelope. Native terminal agents without
            // required limits retain their create-time command.
            persistStartupCommand: persistRestartSafeStartup,
            externalRecreation: false,
            sandboxName: input.sandboxName,
            gpuDevice: input.sandboxGpuConfig.sandboxGpuDevice,
            openshellSandboxCommand: input.sandboxStartupCommand,
            requiredUlimits: input.requiredUlimits,
            timeoutSecs: input.sandboxReadyTimeoutSecs,
            backend: input.sandboxGpuConfig.hostGpuPlatform === "jetson" ? "jetson" : "generic",
            deps,
          }));
    const inspectNativeRuntime = (): NativeRuntimeSnapshot | null => {
      const lifecycleSnapshot = managedLifecycle?.inspectNativeRuntime?.();
      if (lifecycleSnapshot !== undefined) return lifecycleSnapshot;
      if (managedRouting) return managedRouting.inspectNativeRuntime();
      const expectedContainerId = runtimePatch.replacementRuntimeId?.() ?? null;
      const snapshot = expectedContainerId
        ? queryOpenShellDockerSandboxRuntimeSnapshot(input.sandboxName, {}, { expectedContainerId })
        : queryOpenShellDockerSandboxRuntimeSnapshot(input.sandboxName);
      return snapshot.ok ? snapshot : null;
    };
    const recovery = await managedLifecycle?.recoverUnfinished();
    if (recovery) {
      enforceManagedBootstrapRecoveryForSandbox(recovery, input.sandboxName, (message) =>
        console.warn(`  ⚠ ${message}`),
      );
    }
    if (!deferPostCreateEffects) await managedLifecycle?.prepareNetwork();
    const [createExecutable, ...createExecutableArgs] = managedLifecycle?.launchArgv ?? attemptArgv;
    if (!createExecutable) throw new Error("Sandbox create executable is missing.");
    let readyCheckCreatedSandboxId: string | null = null;
    let readyCheckCreatedIdentityFailure: unknown = null;
    const failReadyCheckCreatedIdentity = (diagnostic: string): true => {
      readyCheckCreatedIdentityFailure = new Error(
        `OpenShell did not return the exact created identity for sandbox '${input.sandboxName}'. Diagnostic class: ${diagnostic}.`,
      );
      return true;
    };
    const settleCreatedIdentity = (): string => {
      if (readyCheckCreatedIdentityFailure !== null) throw readyCheckCreatedIdentityFailure;
      const sandboxId = settleCreatedOpenShellSandboxId({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
        createAttemptNonce: createAttemptNonce!,
        runCaptureOpenshell: deps.runCaptureOpenshell,
        priorSandboxId: readyCheckCreatedSandboxId,
        sleep: (milliseconds) => deps.sleep(milliseconds / 1000),
      });
      if (readyCheckCreatedSandboxId && sandboxId !== readyCheckCreatedSandboxId) {
        throw new Error("OpenShell create-attempt identity changed after the Ready handoff.");
      }
      return sandboxId;
    };
    const streamCreate = () =>
      streamSandboxCreateWithPublicImageCredentialIsolation(
        managedBootstrap != null,
        input.sandboxName,
        input.sandboxEnv,
        (createEnv) =>
          streamSandboxCreate(createExecutable, createExecutableArgs, createEnv, {
            ...(input.createWorkingDirectory ? { cwd: input.createWorkingDirectory } : {}),
            readyCheck: () => {
              const list = deps.runCaptureOpenshell(["sandbox", "list", "-g", input.gatewayName], {
                ignoreError: true,
                timeout: SANDBOX_READY_PROBE_TIMEOUT_MS,
              });
              const ready = isSandboxReady(list, input.sandboxName);
              if (!ready || !createAttemptNonce) return ready;
              const observation = observeCreatedOpenShellSandboxId(
                {
                  sandboxName: input.sandboxName,
                  gatewayName: input.gatewayName,
                  createAttemptNonce,
                  runCaptureOpenshell: deps.runCaptureOpenshell,
                },
                SANDBOX_READY_PROBE_TIMEOUT_MS,
              );
              if (observation.state === "invalid") {
                return failReadyCheckCreatedIdentity(observation.diagnostic);
              }
              if (observation.sandboxId === null) {
                return readyCheckCreatedSandboxId
                  ? failReadyCheckCreatedIdentity("selector-identity-disappeared")
                  : false;
              }
              if (
                readyCheckCreatedSandboxId &&
                observation.sandboxId !== readyCheckCreatedSandboxId
              ) {
                return failReadyCheckCreatedIdentity("selector-identity-changed");
              }
              readyCheckCreatedSandboxId = observation.sandboxId;
              return observation.state === "matched";
            },
            ...(deferPostCreateEffects
              ? {}
              : {
                  onPoll: () => {
                    if (!deferRestartSafeCutover) void runtimePatch.maybeApplyDuringCreate();
                  },
                }),
            readyCheckOutputPatterns: getReadyCheckOutputPatternsForAgent({
              isTerminalAgent: input.terminalAgent,
              startupRunsDuringCreate: managedLifecycle === null,
              env: createEnv,
            }),
            failureCheck: runtimePatch.createFailureMessage,
            traceEvent: addTraceEvent,
            waitForReadyTermination: deferRestartSafeCutover || deferPostCreateEffects,
            initialPhase:
              compatibility && (input.prebuild.imageRef || state.compatibilityArgv)
                ? "create"
                : undefined,
          }),
      );
    let createResult: Awaited<ReturnType<typeof streamSandboxCreate>> | null = null;
    let resumedSandboxId: string | null = null;
    let verifiedCreatedSandboxId: string | null = null;
    let managedIncompleteCreateRecovered = false;
    let createdSandboxVerified = false;
    const failAfterCreatedSandboxVerification = (message: string, status: number): never => {
      if (createdSandboxVerified) throw new Error(message);
      return process.exit(status);
    };
    if (input.resumeVerifiedCreate) {
      if (route !== input.resumeVerifiedCreate.route) {
        throw new Error("Verified sandbox recovery route changed before continuation.");
      }
      const identity = probeExactOpenShellSandboxId(input.sandboxName, input.gatewayName, deps);
      if (identity.state !== "identified") {
        throw new Error(
          `Cannot resume sandbox '${input.sandboxName}': its exact live identity is unavailable.`,
        );
      }
      const liveIdentityFingerprint = fingerprintSandboxRecreateValue(identity.sandboxId);
      if (liveIdentityFingerprint !== input.resumeVerifiedCreate.liveIdentityFingerprint) {
        throw new Error(
          `Cannot resume sandbox '${input.sandboxName}': its live identity changed after the verified checkpoint.`,
        );
      }
      resumedSandboxId = identity.sandboxId;
      verifiedCreatedSandboxId = identity.sandboxId;
      await verifyCreatedSandboxBeforeEffects(
        identity.sandboxId,
        createAttemptNonce!,
        route,
        input,
      );
      createdSandboxVerified = true;
      if (deferPostCreateEffects) {
        revalidatePostCreateEffect(`activate managed sandbox network for '${input.sandboxName}'`);
        await managedLifecycle?.prepareNetwork();
      }
    } else if (managedBootstrap && managedLifecycle) {
      try {
        createResult = await managedLifecycle.runCreate(
          async ({ heldWorkloadArgv, bootstrapIdentity }) => {
            if (
              bootstrapIdentity !== attemptBootstrapIdentity ||
              heldWorkloadArgv.length !== attemptHeldWorkloadArgv.length ||
              heldWorkloadArgv.some((value, index) => value !== attemptHeldWorkloadArgv[index])
            ) {
              throw new Error(
                "Managed bootstrap launch does not match the rendered identity-bound hold.",
              );
            }
            const result = await streamCreate();
            const createFailure =
              result.status === 0 ? null : classifySandboxCreateFailure(result.output);
            if (result.status !== 0 && createFailure?.kind !== "sandbox_create_incomplete") {
              throw new ManagedBootstrapCreateStreamFailure(result);
            }
            if (createFailure?.kind === "sandbox_create_incomplete") {
              const readiness = await sandboxReadinessTracing.waitForCreatedSandboxReadyWithTrace({
                sandboxName: input.sandboxName,
                timeoutSecs: input.sandboxReadyTimeoutSecs,
                observer: deps.sandboxObserver,
                target: { kind: "named", gatewayName: input.gatewayName },
                stableReadyPolls: REPLACEMENT_STABLE_READY_POLLS,
                sleep: deps.sleep,
              });
              if (!readiness.ready) {
                if (createAttemptNonce) persistIdentitySettlementRecovery();
                throw new Error(
                  sandboxReadinessTracing
                    .formatCreatedSandboxReadinessFailureMessage(
                      input.sandboxName,
                      readiness,
                      input.sandboxReadyTimeoutSecs,
                    )
                    .trimStart(),
                );
              }
            } else {
              await requireManagedBootstrapCreatedSandboxReady({
                input,
                deps,
                createAttemptNonce,
                persistIdentitySettlementRecovery,
              });
            }
            let sandboxId: string;
            try {
              sandboxId = createAttemptNonce
                ? settleCreatedIdentity()
                : resolveOpenShellSandboxId(
                    input.sandboxName,
                    deps.runCaptureOpenshell,
                    input.gatewayName,
                  );
            } catch (error) {
              if (createAttemptNonce) persistIdentitySettlementRecovery();
              const diagnostic =
                error instanceof Error ? ` ${error.message}` : " Identity settlement failed.";
              throw new Error(
                createFailure?.kind === "sandbox_create_incomplete"
                  ? `Managed bootstrap incomplete create did not return one exact durable sandbox identity after Ready.${diagnostic}`
                  : `Managed bootstrap create did not return one exact durable sandbox identity after Ready.${diagnostic}`,
                { cause: error },
              );
            }
            waitForCreatedSandboxPublication(sandboxId);
            verifiedCreatedSandboxId = sandboxId;
            await verifyCreatedSandboxBeforeEffects(sandboxId, createAttemptNonce!, route, input);
            createdSandboxVerified = true;
            if (deferPostCreateEffects) {
              revalidatePostCreateEffect(
                `activate managed sandbox network for '${input.sandboxName}'`,
              );
              await managedLifecycle.prepareNetwork();
            }
            managedIncompleteCreateRecovered = createFailure?.kind === "sandbox_create_incomplete";
            return {
              value: result,
              receipt: {
                sandbox: {
                  sandboxName: input.sandboxName,
                  sandboxId,
                  driverId: managedBootstrap.runtimeProvider.identity.id,
                },
                ready: true,
                readyAt: new Date().toISOString(),
              },
            };
          },
        );
      } catch (error) {
        if (!(error instanceof ManagedBootstrapCreateStreamFailure)) throw error;
        createResult = error.result;
      }
    } else {
      createResult = await streamCreate();
    }
    if (createResult && !state.firstCreateOutput) state.firstCreateOutput = createResult.output;
    if (!deferPostCreateEffects) await runtimePatch.exitOnPatchError();
    if (createResult && createResult.status !== 0) {
      const failure = classifySandboxCreateFailure(createResult.output);
      let nativeCreateRejectedBeforeProgress = false;
      if (failure.kind === "sandbox_create_incomplete") {
        console.warn("");
        if (managedIncompleteCreateRecovered) {
          console.warn(
            `  Create stream exited with code ${createResult.status}; the exact durable sandbox reached Ready, and onboarding is continuing with final checks.`,
          );
        } else {
          console.warn(
            `  Create stream exited with code ${createResult.status} after sandbox was created.`,
          );
          console.warn("  Checking whether the sandbox reaches Ready state...");
        }
      } else if (
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline &&
        (() => {
          if (
            managedRouting
              ? managedRouting.isNativeCreateRoutingFailure(
                  createResult.output,
                  createResult.sawProgress,
                )
              : sandboxGpuCreateAttempt.isNativeGpuCreateRoutingFailure(createResult.output, {
                  sawProgress: createResult.sawProgress,
                })
          ) {
            nativeCreateRejectedBeforeProgress = true;
            state.allowUnbuiltCompatibilitySource = input.prebuild.imageRef === null;
            return true;
          }
          const snapshot = inspectNativeRuntime();
          if (
            snapshot &&
            (managedRouting
              ? managedRouting.isTrustedNativeRuntimeError(snapshot.stateError)
              : sandboxGpuCreateAttempt.isTrustedNativeGpuRuntimeError(snapshot.stateError))
          ) {
            state.nativeRuntimeSnapshot = snapshot;
            return true;
          }
          return false;
        })()
      ) {
        let nativeCleanup: NativeFallbackCleanupEvidence = {};
        if (nativeCreateRejectedBeforeProgress) {
          await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        } else {
          nativeCleanup = await rollbackNativeGpuFailureForFallback(managedLifecycle, runtimePatch);
        }
        return {
          ok: false,
          route,
          stage: "create",
          error: new Error("Native OpenShell GPU sandbox creation was rejected."),
          fallbackEligible: true,
          ...captureRetainedSandboxRecovery(),
          ...(nativeCreateRejectedBeforeProgress
            ? { nativeCreateRejectedBeforeProgress: true as const }
            : {}),
          ...nativeCleanup,
        } as const;
      } else {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        reportSandboxCreateFailure(
          {
            sandboxName: input.sandboxName,
            createStatus: createResult.status,
            createOutput: createResult.output,
            restoreBackupPath: input.restoreBackupPath,
            createArgs: input.prebuild.createArgs,
          },
          {
            classifyCreateFailure: classifySandboxCreateFailure,
            printCreateFailureDiagnostics,
            printRecoveryHints: printSandboxCreateRecoveryHints,
            warn: (message) => console.warn(message),
            error: (message) => console.error(message),
            exitProcess: (code) => process.exit(code),
          },
        );
      }
    }
    if (!createdSandboxVerified && deferPostCreateEffects) {
      if (!createAttemptNonce) {
        throw new Error("Sandbox create-attempt identity was not generated.");
      }
      let sandboxId: string;
      try {
        sandboxId = settleCreatedIdentity();
      } catch (error) {
        persistIdentitySettlementRecovery();
        throw new Error(
          `Sandbox '${input.sandboxName}' was created, but OpenShell did not return one exact durable sandbox identity before post-create effects.`,
          { cause: error },
        );
      }
      waitForCreatedSandboxPublication(sandboxId);
      verifiedCreatedSandboxId = sandboxId;
      await verifyCreatedSandboxBeforeEffects(sandboxId, createAttemptNonce!, route, input);
      createdSandboxVerified = true;
    }
    if (deferPostCreateEffects) {
      revalidatePostCreateEffect(`validate runtime patch for sandbox '${input.sandboxName}'`);
      await runtimePatch.exitOnPatchError();
    }
    const preRecreateIdentity =
      deferRestartSafeCutover && !resumedSandboxId
        ? probeExactOpenShellSandboxId(input.sandboxName, input.gatewayName, deps)
        : null;
    const expectedRecreatedSandboxId =
      resumedSandboxId ??
      (preRecreateIdentity?.state === "identified" ? preRecreateIdentity.sandboxId : null);
    if (deferRestartSafeCutover && !expectedRecreatedSandboxId) {
      console.error("");
      console.error(
        `  Sandbox '${input.sandboxName}' reached Ready, but OpenShell did not return one exact durable sandbox ID before runtime recreation.`,
      );
      printCreateFailureDiagnostics(input.sandboxName, {
        backupPath: input.restoreBackupPath,
      });
      failAfterCreatedSandboxVerification(
        `Sandbox '${input.sandboxName}' did not return one exact durable sandbox ID before runtime recreation after verified creation.`,
        createResult?.status === 0 ? 1 : (createResult?.status ?? 1),
      );
    }
    if (!portableLifecycle || managedLifecycle) {
      revalidatePostCreateEffect(`apply runtime patch for sandbox '${input.sandboxName}'`);
      await runtimePatch.ensureApplied();
    }
    await runtimePatch.waitForSupervisorReconnectIfNeeded();
    revalidatePostCreateEffect(`reconnect sandbox supervisor for '${input.sandboxName}'`);
    console.log("  Waiting for sandbox to become ready...");
    const readiness = await sandboxReadinessTracing.waitForCreatedSandboxReadyWithTrace({
      sandboxName: input.sandboxName,
      timeoutSecs: input.sandboxReadyTimeoutSecs,
      observer: deps.sandboxObserver,
      target: { kind: "named", gatewayName: input.gatewayName },
      stableReadyPolls:
        compatibility || managedBootstrap || expectedRecreatedSandboxId
          ? REPLACEMENT_STABLE_READY_POLLS
          : 1,
      checkReadyIdentity: expectedRecreatedSandboxId
        ? (getRemainingMs = () => SANDBOX_RECREATE_PROBE_TIMEOUT_MS) =>
            checkRecreatedSandboxReadyIdentity(
              input.sandboxName,
              input.gatewayName,
              expectedRecreatedSandboxId,
              deps,
              getRemainingMs,
            )
        : input.terminalAgent
          ? undefined
          : (getRemainingMs = () => SANDBOX_RECREATE_PROBE_TIMEOUT_MS) =>
              checkCreatedSandboxReadyIdentity(
                input.sandboxName,
                input.gatewayName,
                deps,
                getRemainingMs,
              ),
      sleep: deps.sleep,
    });
    if (!readiness.ready) {
      console.error("");
      sandboxReadinessTracing.printReadinessFailure(
        readiness,
        input.sandboxName,
        input.sandboxReadyTimeoutSecs,
      );
      const canClassifyNativeReadiness =
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline;
      const runtimeSnapshot = canClassifyNativeReadiness ? inspectNativeRuntime() : null;
      if (
        canClassifyNativeReadiness &&
        runtimeSnapshot &&
        (managedRouting
          ? managedRouting.isNativeReadinessRoutingFailure({
              failurePhase: readiness.failurePhase,
              runtimeError: runtimeSnapshot.stateError,
            })
          : sandboxGpuCreateAttempt.isNativeGpuReadinessRoutingFailure({
              failurePhase: readiness.failurePhase,
              runtimeError: runtimeSnapshot.stateError,
            }))
      ) {
        state.nativeRuntimeSnapshot = runtimeSnapshot;
        const nativeCleanup = await rollbackNativeGpuFailureForFallback(
          managedLifecycle,
          runtimePatch,
        );
        return {
          ok: false,
          route,
          stage: "readiness",
          error: new Error(
            `Native OpenShell GPU sandbox did not become ready${readiness.failurePhase ? ` (${readiness.failurePhase})` : ""}.`,
          ),
          fallbackEligible: true,
          ...captureRetainedSandboxRecovery(),
          ...nativeCleanup,
        } as const;
      }
      await runtimePatch.rollbackManagedStartupAfterCreateFailure();
      printCreateFailureDiagnostics(input.sandboxName, {
        backupPath: input.restoreBackupPath,
      });
      if (compatibility) runtimePatch.printReadinessFailureIfEnabled();
      else if (expectedRecreatedSandboxId) {
        console.error(
          "  NemoClaw did not start dashboard forwarding. NemoClaw left the sandbox in place for inspection and recovery.",
        );
      } else if (portableLifecycle) {
        console.error(
          "  NemoClaw left the portable sandbox in place because it could not verify the exact runtime identity.",
        );
      } else {
        console.error(
          `  NemoClaw left sandbox '${input.sandboxName}' in place because OpenShell can delete it only by mutable name.`,
        );
        console.error("  Verify the sandbox identity before manual cleanup.");
      }
      failAfterCreatedSandboxVerification(
        `Sandbox '${input.sandboxName}' did not become ready after verified creation.`,
        createResult?.status === 0 ? 1 : (createResult?.status ?? 1),
      );
    }
    if (input.sandboxGpuConfig.sandboxGpuEnabled) {
      revalidatePostCreateEffect(`verify GPU access for sandbox '${input.sandboxName}'`);
      const deferNativeProofFailure =
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline;
      let proof: SandboxGpuProofResult;
      try {
        proof = await dockerGpuLocalInference.verifyGpuSandboxAccessAfterReady(
          input.sandboxGpuConfig,
          {
            sandboxName: input.sandboxName,
            dockerDriverGateway: input.dockerDriverGateway,
            selectedRoute: route,
            verifyDirectSandboxGpu: deps.verifyDirectSandboxGpu,
            verifyGpuOrExit: deferNativeProofFailure ? undefined : runtimePatch.verifyGpuOrExit,
            reportGpuProofFailure: !deferNativeProofFailure,
            selectedMode: runtimePatch.selectedMode,
            runCaptureOpenshell: deps.runCaptureOpenshell,
            log: console.log,
          },
        );
      } catch (error) {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        throw error;
      }
      if (deferNativeProofFailure && proof.status === "failed") {
        if (sandboxGpuPreflight.isExplicitNvidiaSmiDriverProofFailure(proof)) {
          const snapshot = inspectNativeRuntime();
          if (snapshot?.nativeGpuAttachmentState === "absent") {
            state.nativeRuntimeSnapshot = snapshot;
            const nativeCleanup = await rollbackNativeGpuFailureForFallback(
              managedLifecycle,
              runtimePatch,
            );
            return {
              ok: false,
              route,
              stage: "gpu-proof",
              error: new Error(
                "Native OpenShell GPU proof failed and the host confirms no GPU attachment.",
              ),
              fallbackEligible: true,
              ...captureRetainedSandboxRecovery(),
              ...nativeCleanup,
            } as const;
          }
        }
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        console.error("");
        console.error("  Native sandbox GPU proof failed.");
        console.error(
          "  Sandbox-reported GPU output without corroborating host evidence cannot authorize a less-confined compatibility retry.",
        );
        console.error(
          "  To explicitly select the compatibility route, clean up the sandbox and retry with NEMOCLAW_DOCKER_GPU_PATCH=1.",
        );
        failAfterCreatedSandboxVerification(
          `Sandbox '${input.sandboxName}' failed GPU proof after verified creation.`,
          1,
        );
      }
      if (proof.status === "failed") {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        throw new Error("Sandbox GPU proof returned failed status.");
      }
    }
    if (portableRuntimePatch) {
      revalidatePostCreateEffect(`install portable lifecycle for sandbox '${input.sandboxName}'`);
      await portableRuntimePatch.ensureApplied();
    }
    // GPU-enabled cutover stays reversible until the caller also proves the
    // configured host-local inference path. Non-GPU workloads have completed
    // their final authoritative Ready gate here.
    if (!input.sandboxGpuConfig.sandboxGpuEnabled) {
      revalidatePostCreateEffect(`commit runtime readiness for sandbox '${input.sandboxName}'`);
      await runtimePatch.commitAfterReady();
    }
    const confirmCommittedRuntimeReadiness = () =>
      confirmManagedRuntimeCommitReadiness({
        input,
        deps,
        sandboxId: managedBootstrap ? verifiedCreatedSandboxId : null,
        createAttemptNonce,
      });
    if (!input.sandboxGpuConfig.sandboxGpuEnabled) {
      await confirmCommittedRuntimeReadiness();
    }
    return {
      ok: true,
      route,
      value: createResult
        ? {
            createResult,
            runtimePatch,
            confirmManagedRuntimeCommitReadiness: confirmCommittedRuntimeReadiness,
          }
        : {
            runtimePatch,
            confirmManagedRuntimeCommitReadiness: confirmCommittedRuntimeReadiness,
          },
    } as const;
  };

  return { state, managedRouting, runAttempt };
}
