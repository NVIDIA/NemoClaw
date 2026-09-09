// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { normalizeProcessExitCode } from "../core/process-exit";
import type { ServingProfileProvenance } from "../inference/serving/types";
import { NEMOCLAW_VLLM_GPU_DEVICE_ENV, parseVllmGpuDevice } from "../inference/vllm-models";
import { PERSONAL_POLICY_TIER_NAME } from "../policy/tiers";
import { redact, redactFull, redactSensitiveText } from "../security/redact";
import { isDecisionSelected } from "../state/onboard-checkpoint-decision";
import {
  deriveCheckpointFromSession,
  loadResumeCheckpoint,
  ONBOARD_CHECKPOINT_SESSION_FILE,
} from "../state/onboard-checkpoint-migrate";
import type {
  CheckpointLoadResult,
  CheckpointOnboardProfile,
  CheckpointPortableRuntimeAuthority,
} from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";
import {
  DEFAULT_TOOL_DISCLOSURE,
  TOOL_DISCLOSURE_ENV,
  type ToolDisclosure,
} from "../tool-disclosure";
import { recordCheckpointSandboxIdentity } from "./checkpoint-record";
import { checkpointProvesSandboxStepComplete } from "./checkpoint-replay";
import { EXPERIMENTAL_PROFILE_ENV } from "./docker-driver-platform";
import type { PortableInferenceActivation } from "./experimental/portable-inference-descriptor";
import { requireReadOnlyHostMountRuntimeSupport } from "./host-mount";
import type { ResumeConfigConflict } from "./resume-config";
import type { StationExpressResumeIntent } from "./station-express-resume";
import { ensureRequiredTierPolicyPresets } from "./policy-tier-suppression";
import {
  assertLockedResumeIntentSnapshot as assertLockedResumeIntentSnapshotAtPath,
  isOnboardResumeIntentRaceError,
  OnboardResumeIntentError,
  OnboardResumeIntentRaceError,
  resolveOnboardResumeIntent as resolveOnboardResumeIntentAtPath,
  type OnboardResumeIntentSnapshot,
  type ResolvedOnboardResumeIntent,
} from "./resume/portable-resume-intent";

export { preparePortableExperimentalHost } from "./experimental/portable-host-preparation";

export {
  beginHostMountScope,
  isDockerBindMountsEnabled,
  reportReadOnlyHostMounts,
  verifyReadOnlyHostMountSources,
} from "./host-mount";
export { requireReadOnlyHostMountRuntimeSupport };
export {
  isOnboardResumeIntentRaceError,
  OnboardResumeIntentError,
  OnboardResumeIntentRaceError,
  type OnboardResumeIntentSnapshot,
  type ResolvedOnboardResumeIntent,
};

/** Expected onboarding refusal when selected restore authority changes. */
export class OnboardRestoreSnapshotDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardRestoreSnapshotDriftError";
  }
}

export function resolveOnboardResumeIntent(options: {
  readonly explicitResume: boolean;
  readonly fresh: boolean;
  readonly explicitProfile: CheckpointOnboardProfile | null;
  readonly sessionFile?: string;
}): ResolvedOnboardResumeIntent {
  return resolveOnboardResumeIntentAtPath({
    ...options,
    sessionFile: options.sessionFile ?? ONBOARD_CHECKPOINT_SESSION_FILE,
  });
}

export function assertLockedResumeIntentSnapshot(
  expected: OnboardResumeIntentSnapshot,
  sessionFile: string = ONBOARD_CHECKPOINT_SESSION_FILE,
): void {
  assertLockedResumeIntentSnapshotAtPath(expected, sessionFile);
}

export const PORTABLE_RUNTIME_ENV_KEYS = [
  EXPERIMENTAL_PROFILE_ENV,
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "XDG_CONFIG_HOME",
  "CONTAINERS_CONF",
  "NETAVARK_FW",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
] as const;

const PORTABLE_DEFAULT_ENV_KEYS = [
  TOOL_DISCLOSURE_ENV,
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_PROVIDER_MODEL",
  "NEMOCLAW_ENDPOINT_URL",
  "NEMOCLAW_PREFERRED_API",
  "NEMOCLAW_OLLAMA_NO_AUTOSTART",
  "NEMOCLAW_POLICY_MODE",
  "NEMOCLAW_POLICY_PRESETS",
  "NEMOCLAW_POLICY_TIER",
] as const;

const PORTABLE_OWNED_ENV_KEYS = [
  ...PORTABLE_RUNTIME_ENV_KEYS,
  ...PORTABLE_DEFAULT_ENV_KEYS,
] as const;

interface PreviousEnvironmentValue {
  readonly present: boolean;
  readonly value: string | undefined;
}

export interface PortableOnboardEnvironmentScope {
  readonly env: NodeJS.ProcessEnv;
  createHermesPortablePodmanSourceEnvironment(
    runtimeAuthority: CheckpointPortableRuntimeAuthority,
  ): NodeJS.ProcessEnv;
  installRuntime(input: { containersConf: string; socketPath: string }): void;
  restore(): void;
}

/** Keep one prepared portable runtime authority with the environment scope that installed it. */
export interface PortableOnboardRuntimeContext {
  readonly authority: CheckpointPortableRuntimeAuthority;
  readonly environmentScope: PortableOnboardEnvironmentScope | null;
}

export function createDefaultResumeProfileEnvironmentScope(
  env: NodeJS.ProcessEnv,
): PortableOnboardEnvironmentScope {
  const present = Object.prototype.hasOwnProperty.call(env, EXPERIMENTAL_PROFILE_ENV);
  const value = env[EXPERIMENTAL_PROFILE_ENV];
  delete env[EXPERIMENTAL_PROFILE_ENV];
  let restored = false;
  return {
    env,
    createHermesPortablePodmanSourceEnvironment() {
      throw new Error("Default onboarding has no portable Podman environment authority.");
    },
    installRuntime() {
      throw new Error("Default onboarding resume cannot install portable runtime authority.");
    },
    restore() {
      if (restored) return;
      restored = true;
      if (present) env[EXPERIMENTAL_PROFILE_ENV] = value ?? "";
      else delete env[EXPERIMENTAL_PROFILE_ENV];
    },
  };
}

const ONBOARD_DEFERRED_EXIT_ERROR = Symbol.for("nemoclaw.onboard.deferred-exit-error");

export class OnboardDeferredExitError extends Error {
  readonly [ONBOARD_DEFERRED_EXIT_ERROR] = true;
  readonly code: number;
  readonly preserveIncompleteSession: boolean;

  constructor(code: number, options: { preserveIncompleteSession?: boolean } = {}) {
    super(`Onboarding requested exit ${String(code)}.`);
    this.name = "OnboardDeferredExitError";
    this.code = code;
    this.preserveIncompleteSession = options.preserveIncompleteSession === true;
  }
}

export function isOnboardDeferredExitError(error: unknown): error is OnboardDeferredExitError {
  const candidate = error as
    (Error & { code?: unknown; [ONBOARD_DEFERRED_EXIT_ERROR]?: unknown }) | null;
  return (
    candidate instanceof Error &&
    candidate[ONBOARD_DEFERRED_EXIT_ERROR] === true &&
    candidate.name === "OnboardDeferredExitError" &&
    typeof candidate.code === "number" &&
    Number.isInteger(candidate.code)
  );
}

export function shouldPreserveIncompleteOnboardSession(error: unknown): boolean {
  return isOnboardDeferredExitError(error) && error.preserveIncompleteSession;
}

interface DeferredExitOptions {
  readonly deferProcessExit?: boolean;
}

export function wrapOnboardDeferredExit<TOptions extends DeferredExitOptions>(
  run: (options?: TOptions) => Promise<void>,
): (options?: TOptions) => Promise<void> {
  return async (options?: TOptions): Promise<void> => {
    const resolvedOptions = options ?? ({} as TOptions);
    const originalProcessExit = process.exit;
    let deferredExit: OnboardDeferredExitError | null = null;
    process.exit = ((code?: number | string | null): never => {
      throw new OnboardDeferredExitError(normalizeProcessExitCode(code));
    }) as typeof process.exit;
    try {
      await run(resolvedOptions);
    } catch (error) {
      if (!isOnboardDeferredExitError(error)) throw error;
      deferredExit = error;
    } finally {
      process.exit = originalProcessExit;
    }
    if (!deferredExit) return;
    if (resolvedOptions.deferProcessExit === true) throw deferredExit;
    originalProcessExit(deferredExit.code);
  };
}

export function redactOnboardDiagnosticText(message: string): string {
  return redactSensitiveText(message) ?? "";
}

export function redactOnboardCommandDiagnosticText(message: string): string {
  return redactSensitiveText(redact(redactFull(message))) ?? "";
}

export function createPortableOnboardEnvironmentScope(
  env: NodeJS.ProcessEnv,
  activation: PortableInferenceActivation | null,
  options: { readonly resume?: boolean } = {},
): PortableOnboardEnvironmentScope {
  const previous = new Map<string, PreviousEnvironmentValue>();
  for (const key of PORTABLE_OWNED_ENV_KEYS) {
    previous.set(key, {
      present: Object.prototype.hasOwnProperty.call(env, key),
      value: env[key],
    });
  }
  for (const key of PORTABLE_OWNED_ENV_KEYS) delete env[key];
  env[EXPERIMENTAL_PROFILE_ENV] = "portable";
  env.NEMOCLAW_OLLAMA_NO_AUTOSTART = "1";
  if (activation) {
    env.NEMOCLAW_PROVIDER = "custom";
    env.NEMOCLAW_MODEL = activation.model;
    env.NEMOCLAW_ENDPOINT_URL = activation.baseUrl;
    env.NEMOCLAW_PREFERRED_API = "openai-completions";
  }
  if (!options.resume) {
    const requestedModel = previous.get("NEMOCLAW_MODEL")?.value?.trim();
    const requestedPolicyPresets = previous.get("NEMOCLAW_POLICY_PRESETS")?.value;
    env[TOOL_DISCLOSURE_ENV] = "direct";
    env.NEMOCLAW_PROVIDER = activation ? "custom" : "ollama";
    env.NEMOCLAW_MODEL = activation?.model ?? (requestedModel || "qwen3-vl:4b");
    env.NEMOCLAW_POLICY_TIER = PERSONAL_POLICY_TIER_NAME;
    if (requestedPolicyPresets?.trim()) {
      env.NEMOCLAW_POLICY_MODE = "custom";
      env.NEMOCLAW_POLICY_PRESETS = ensureRequiredTierPolicyPresets(
        PERSONAL_POLICY_TIER_NAME,
        requestedPolicyPresets
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      ).join(",");
    } else {
      env.NEMOCLAW_POLICY_MODE = "suggested";
    }
  } else {
    const requestedPolicyPresets = previous.get("NEMOCLAW_POLICY_PRESETS")?.value?.trim();
    if (requestedPolicyPresets) {
      env.NEMOCLAW_POLICY_MODE = "custom";
      env.NEMOCLAW_POLICY_PRESETS = requestedPolicyPresets;
    }
  }

  let installedRuntime: { readonly containersConf: string; readonly dockerHost: string } | null =
    null;
  let restored = false;
  return {
    env,
    createHermesPortablePodmanSourceEnvironment(runtimeAuthority) {
      if (restored || !installedRuntime) {
        throw new Error("Hermes portable Podman environment authority is not active.");
      }
      const expectedContainersConf = path.join(
        runtimeAuthority.configHome,
        "nemoclaw",
        "portable",
        "containers.conf",
      );
      const expectedDockerHost = `unix://${runtimeAuthority.socketPath}`;
      if (
        installedRuntime.containersConf !== expectedContainersConf ||
        installedRuntime.dockerHost !== expectedDockerHost
      ) {
        throw new Error("Hermes portable Podman environment disagrees with runtime authority.");
      }
      const source = { ...env };
      if (source.CONTAINERS_CONF === installedRuntime.containersConf) {
        delete source.CONTAINERS_CONF;
      }
      if (source.DOCKER_HOST === installedRuntime.dockerHost) delete source.DOCKER_HOST;
      return source;
    },
    installRuntime({ containersConf, socketPath }) {
      env.NETAVARK_FW = "iptables";
      env.CONTAINERS_CONF = containersConf;
      env.DOCKER_HOST = `unix://${socketPath}`;
      installedRuntime = { containersConf, dockerHost: env.DOCKER_HOST };
    },
    restore() {
      if (restored) return;
      restored = true;
      for (const [key, value] of previous) {
        if (value.present) env[key] = value.value ?? "";
        else delete env[key];
      }
    },
  };
}

export interface OnboardSessionBootstrapInput {
  resume: boolean;
  fresh: boolean;
  recreateSandboxRequested?: boolean;
  requestedFromDockerfile: string | null;
  requestedSandboxName: string | null;
  cannotPrompt: boolean;
  nonInteractive: boolean;
  authoritativeResumeConfig?: boolean;
  agentFlag?: string | null;
  envAgent?: string | null;
  requestedToolDisclosure?: ToolDisclosure | null;
  requestedObservabilityEnabled?: boolean | null;
  apfInterceptorRequested?: boolean | null;
  stationExpressIntent?: StationExpressResumeIntent | null;
  requestedHostMounts?: readonly import("../state/registry/types").SandboxHostMount[];
  servingProfileProvenance?: ServingProfileProvenance | null;
  checkpointProfile?: CheckpointOnboardProfile;
  portableRuntimeAuthority?: CheckpointPortableRuntimeAuthority | null;
}

export interface OnboardSessionBootstrapDeps {
  loadSession(): Session | null;
  clearSession(): void;
  createSession(overrides?: Partial<Session>): Session;
  saveSession(session: Session): Session;
  updateSession(mutator: (session: Session) => Session | void): Session | Promise<Session>;
  applySessionRecovery(session: Session): void;
  setOnboardBrandingAgent(agentName: string | null): void;
  getResumeConfigConflicts(
    session: Session | null,
    opts: {
      nonInteractive?: boolean;
      fromDockerfile?: string | null;
      sandboxName?: string | null;
      agent?: string | null;
      toolDisclosure?: ToolDisclosure | null;
      observabilityEnabled?: boolean | null;
      hostMounts?: readonly import("../state/registry/types").SandboxHostMount[];
      authoritativeResumeConfig?: boolean;
    },
  ): ResumeConfigConflict[];
  recordResumeConflict(conflict: ResumeConfigConflict): Promise<unknown>;
  resolvePath(value: string): string;
  cliName(): string;
  error(message: string): void;
  exitProcess(code: number): never;
  requireHostMountRuntimeSupport(
    mounts: readonly import("../state/registry/types").SandboxHostMount[] | undefined,
    checkpointProfile?: CheckpointOnboardProfile,
  ): void;
  resolveResumeCheckpoint(): CheckpointLoadResult;
}

export interface OnboardSessionBootstrapResult {
  session: Session | null;
  fromDockerfile: string | null;
}

export const defaultResolveResumeCheckpoint: () => CheckpointLoadResult = loadResumeCheckpoint;

export async function checkpointSandboxName(
  sandboxName: string,
  agent: { name?: string } | null,
  updateSession: OnboardSessionBootstrapDeps["updateSession"],
): Promise<void> {
  await updateSession((current) => {
    const checkpointAgent = agent?.name ?? current.agent ?? "openclaw";
    current.sandboxName = sandboxName;
    current.sandboxPromptProgress.sandboxName = true;
    recordCheckpointSandboxIdentity(current, sandboxName, checkpointAgent);
    return current;
  });
}

export function getCheckpointedSandboxName(
  resume: boolean,
  agent: { name?: string } | null,
  session: Session | null,
): string | null {
  if (!resume) return null;
  if (session?.checkpoint) {
    return isDecisionSelected(session.checkpoint.sandboxIdentity)
      ? session.checkpoint.sandboxIdentity.value.name
      : null;
  }
  return session?.sandboxPromptProgress?.sandboxName === true ? session.sandboxName : null;
}

function mode(nonInteractive: boolean): "non-interactive" | "interactive" {
  return nonInteractive ? "non-interactive" : "interactive";
}

function reportMissingResumeSession(deps: OnboardSessionBootstrapDeps): never {
  deps.error("  No resumable onboarding session was found.");
  deps.error("  --resume only continues an interrupted onboarding run.");
  deps.error("  To change configuration on an existing sandbox, rebuild it:");
  deps.error(`    ${deps.cliName()} onboard`);
  deps.exitProcess(1);
}

function reportUnsupportedResumeCheckpoint(
  foundVersion: number,
  deps: OnboardSessionBootstrapDeps,
): never {
  deps.error(
    `  This onboarding session was written by a newer NemoClaw (checkpoint schema v${foundVersion}).`,
  );
  deps.error(
    "  Resuming it with this version could create a second sandbox or drop recorded decisions.",
  );
  deps.error(`  Upgrade NemoClaw to resume it, or start fresh: ${deps.cliName()} onboard`);
  deps.exitProcess(1);
}

function reportCorruptResumeCheckpoint(deps: OnboardSessionBootstrapDeps): never {
  deps.error("  The onboarding resume checkpoint is unreadable and cannot be safely continued.");
  deps.error(`  Start fresh: ${deps.cliName()} onboard`);
  deps.exitProcess(1);
}

function reportLegacyResumeCheckpoint(deps: OnboardSessionBootstrapDeps): never {
  deps.error(
    "  This onboarding checkpoint predates recorded runtime authority and cannot be resumed safely.",
  );
  deps.error(`  Start a new attempt: ${deps.cliName()} onboard --fresh`);
  deps.exitProcess(1);
}

function reportUnsupportedApfLifecycle(
  reason: "resume" | "recreate" | "portable",
  deps: OnboardSessionBootstrapDeps,
): never {
  deps.error(
    reason === "resume"
      ? "  APF interceptor selection cannot resume an onboarding session."
      : reason === "recreate"
        ? "  APF interceptor selection cannot recreate a sandbox."
        : "  APF interceptor selection cannot use the Portable experimental profile.",
  );
  deps.error(
    `  Start a new sandbox with a new name: ${deps.cliName()} onboard --fresh --apf-interceptor --name <sandbox>`,
  );
  deps.exitProcess(1);
}

function guardResumeCheckpoint(deps: OnboardSessionBootstrapDeps): void {
  const result = deps.resolveResumeCheckpoint();
  if (result?.status === "unsupported_future") {
    reportUnsupportedResumeCheckpoint(result.foundVersion, deps);
  }
  if (result?.status === "corrupt") {
    reportCorruptResumeCheckpoint(deps);
  }
  if (result?.status === "legacy") {
    reportLegacyResumeCheckpoint(deps);
  }
}

function reportResumeConflict(
  conflict: ResumeConfigConflict,
  deps: OnboardSessionBootstrapDeps,
): void {
  if (conflict.field === "sandbox") {
    deps.error(
      `  Resumable state belongs to sandbox '${conflict.recorded}', not '${conflict.requested}'.`,
    );
    return;
  }
  if (conflict.field === "agent") {
    deps.error(
      `  Session was started with agent '${conflict.recorded}', not '${conflict.requested}'.`,
    );
    return;
  }
  if (conflict.field === "fromDockerfile") {
    if (!conflict.recorded) {
      deps.error(
        `  Session was started without --from; add --from '${conflict.requested}' to resume it.`,
      );
    } else if (!conflict.requested) {
      deps.error(
        `  Session was started with --from '${conflict.recorded}'; rerun with that path to resume it.`,
      );
    } else {
      deps.error(
        `  Session was started with --from '${conflict.recorded}', not '${conflict.requested}'.`,
      );
    }
    return;
  }
  deps.error(
    `  Resumable state recorded ${conflict.field} '${conflict.recorded}', not '${conflict.requested}'.`,
  );
}

async function exitForResumeConflicts(
  conflicts: ResumeConfigConflict[],
  deps: OnboardSessionBootstrapDeps,
): Promise<never> {
  for (const conflict of conflicts) {
    try {
      await deps.recordResumeConflict(conflict);
    } catch {
      // Conflict reporting is the enforcing source of truth here; the runtime
      // diagnostic write is best-effort and must not hide the user-facing exit.
      // Remove this suppression if recordResumeConflict becomes authoritative.
    }
    reportResumeConflict(conflict, deps);
  }
  deps.error(`  Run: ${deps.cliName()} onboard              # start a fresh onboarding session`);
  deps.error("  Or rerun with the original settings to continue that session.");
  deps.exitProcess(1);
}

function assertRecoverableResumeSandboxName(
  session: Session | null,
  input: OnboardSessionBootstrapInput,
  deps: OnboardSessionBootstrapDeps,
): void {
  const checkpoint = session?.checkpoint ?? null;
  const nameRecoverable = checkpoint
    ? checkpointProvesSandboxStepComplete(session) || isDecisionSelected(checkpoint.sandboxIdentity)
    : session?.steps?.sandbox?.status === "complete" ||
      session?.sandboxPromptProgress?.sandboxName === true;
  const checkpointedSandboxName =
    checkpoint && isDecisionSelected(checkpoint.sandboxIdentity)
      ? checkpoint.sandboxIdentity.value.name
      : null;
  const recoveredSandboxName =
    input.requestedSandboxName ||
    (nameRecoverable ? checkpointedSandboxName || session?.sandboxName || null : null);
  if (input.cannotPrompt && !recoveredSandboxName) {
    deps.error(
      "  Cannot resume non-interactive onboard: the previous run was interrupted before sandbox creation completed,",
    );
    deps.error(
      "  so no sandbox name was recorded. Re-run with --name <sandbox> (or set NEMOCLAW_SANDBOX_NAME).",
    );
    deps.exitProcess(1);
  }
}

async function prepareResumeSession(
  input: OnboardSessionBootstrapInput,
  deps: OnboardSessionBootstrapDeps,
): Promise<OnboardSessionBootstrapResult> {
  let session = deps.loadSession();
  if (input.apfInterceptorRequested === true || session?.apfInterceptorRequested === true) {
    reportUnsupportedApfLifecycle("resume", deps);
  }
  deps.requireHostMountRuntimeSupport(
    input.requestedHostMounts?.length ? input.requestedHostMounts : session?.metadata?.hostMounts,
    input.checkpointProfile,
  );
  deps.setOnboardBrandingAgent(input.agentFlag || session?.agent || input.envAgent || null);
  if (!session || session.resumable === false) {
    reportMissingResumeSession(deps);
  }
  guardResumeCheckpoint(deps);

  const sessionFrom = session.metadata?.fromDockerfile || null;
  const fromDockerfile = input.requestedFromDockerfile
    ? deps.resolvePath(input.requestedFromDockerfile)
    : sessionFrom
      ? deps.resolvePath(sessionFrom)
      : null;
  const resumeConflicts = deps.getResumeConfigConflicts(session, {
    nonInteractive: input.nonInteractive,
    fromDockerfile: input.requestedFromDockerfile,
    sandboxName: input.requestedSandboxName,
    agent: input.agentFlag || null,
    toolDisclosure: input.requestedToolDisclosure ?? null,
    observabilityEnabled: input.requestedObservabilityEnabled ?? null,
    hostMounts: input.requestedHostMounts,
    authoritativeResumeConfig: input.authoritativeResumeConfig,
  });
  if (resumeConflicts.length > 0) {
    await exitForResumeConflicts(resumeConflicts, deps);
  }

  deps.updateSession((current: Session) => {
    deps.applySessionRecovery(current);
    if (typeof input.requestedObservabilityEnabled === "boolean") {
      current.observabilityEnabled = input.requestedObservabilityEnabled;
      current.observabilityRequestedExplicitly = true;
    }
    current.mode = mode(input.nonInteractive);
    current.failure = null;
    current.status = "in_progress";
    return current;
  });
  session = deps.loadSession();
  assertRecoverableResumeSandboxName(session, input, deps);
  return { session, fromDockerfile };
}

function prepareFreshSession(
  input: OnboardSessionBootstrapInput,
  deps: OnboardSessionBootstrapDeps,
): OnboardSessionBootstrapResult {
  if (input.apfInterceptorRequested === true && input.recreateSandboxRequested === true) {
    reportUnsupportedApfLifecycle("recreate", deps);
  }
  if (input.apfInterceptorRequested === true && input.checkpointProfile === "portable") {
    reportUnsupportedApfLifecycle("portable", deps);
  }
  deps.requireHostMountRuntimeSupport(input.requestedHostMounts, input.checkpointProfile);
  if (input.fresh) {
    deps.clearSession();
  }
  const fromDockerfile = input.requestedFromDockerfile
    ? deps.resolvePath(input.requestedFromDockerfile)
    : null;
  const session = deps.createSession({
    mode: mode(input.nonInteractive),
    toolDisclosure: input.requestedToolDisclosure ?? DEFAULT_TOOL_DISCLOSURE,
    observabilityEnabled: input.requestedObservabilityEnabled === true,
    observabilityRequestedExplicitly: typeof input.requestedObservabilityEnabled === "boolean",
    apfInterceptorRequested: input.apfInterceptorRequested === true,
    stationExpressIntent: input.stationExpressIntent ?? null,
    servingProfileProvenance: input.servingProfileProvenance ?? null,
    vllmGpuDevice: parseVllmGpuDevice(process.env[NEMOCLAW_VLLM_GPU_DEVICE_ENV]),
    metadata: {
      gatewayName: "nemoclaw",
      fromDockerfile: fromDockerfile || null,
      ...(input.requestedHostMounts && input.requestedHostMounts.length > 0
        ? { hostMounts: input.requestedHostMounts.map((mount) => ({ ...mount })) }
        : {}),
    },
  });
  session.checkpoint = deriveCheckpointFromSession(session, {
    profile: input.checkpointProfile ?? "default",
    runtimeAuthority: input.portableRuntimeAuthority ?? null,
  });
  const savedSession = deps.saveSession(session);
  return { session: savedSession, fromDockerfile };
}

export async function prepareOnboardSession(
  input: OnboardSessionBootstrapInput,
  deps: OnboardSessionBootstrapDeps,
): Promise<OnboardSessionBootstrapResult> {
  return input.resume ? prepareResumeSession(input, deps) : prepareFreshSession(input, deps);
}

export function prepareOnboardSessionValidated(
  input: OnboardSessionBootstrapInput,
  deps: Omit<
    OnboardSessionBootstrapDeps,
    "requireHostMountRuntimeSupport" | "resolveResumeCheckpoint"
  >,
): Promise<OnboardSessionBootstrapResult> {
  return prepareOnboardSession(input, {
    ...deps,
    requireHostMountRuntimeSupport: (mounts, checkpointProfile) =>
      requireReadOnlyHostMountRuntimeSupport(mounts, {
        experimentalProfile: checkpointProfile === "portable" ? "portable" : null,
      }),
    resolveResumeCheckpoint: defaultResolveResumeCheckpoint,
  });
}
