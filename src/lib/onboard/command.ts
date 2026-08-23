// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { formatAgentAliasSuffix, resolveAgentNameAlias } from "../agent/aliases";
import { withCredentialOverrides } from "../credentials/scoped-overrides";
import { loadServingCatalog } from "../inference/serving/catalog-loader";
import { NEMOCLAW_SERVING_PRESET_ENV } from "../inference/serving/managed-cluster-discovery";
import {
  resolveServingProfileSelection,
  type ServingProfileListEntry,
  ServingProfileSelectionError,
} from "../inference/serving/profile-list";
import {
  assertServingProfileProvenanceCurrent,
  servingProfileProvenance,
} from "../inference/serving/profile-provenance";
import type { CompiledServingCatalog, ServingProfileProvenance } from "../inference/serving/types";
import {
  NEMOCLAW_VLLM_GPU_DEVICE_ENV,
  normalizeVllmGpuDevice,
  VLLM_EXTRA_ARGS_ENV,
} from "../inference/vllm-models";
import {
  resolveToolDisclosureRequest,
  TOOL_DISCLOSURE_ENV,
  type ToolDisclosure,
} from "../tool-disclosure";
import { applyAgentsManifestEnv } from "./agents-manifest";
import type { OnboardFlags } from "./command-support";
import {
  type ExperimentalOnboardProfile,
  PORTABLE_EXPERIMENTAL_PROFILE,
} from "./docker-driver-platform";
import {
  loadPortableInferenceDescriptor,
  PORTABLE_INFERENCE_CREDENTIAL_ENV,
  type PortableInferenceActivation,
  PortableInferenceDescriptorError,
} from "./experimental/portable-inference-descriptor";
import { GatewayManagementDeclarationError } from "./gateway-management";
import { GatewayAuthorityError, gatewayAuthorityFailureLines } from "./gateway-teardown-authority";
import {
  LOCAL_MODEL_PROFILE_ENABLED_ENV,
  LOCAL_MODEL_PROFILE_RUNTIME_ENV,
  resolveLocalModelProfilePlan,
} from "./local-model-profile/plan";
import { managedSandboxFeatureIssue } from "./managed-sandbox-feature";
import { parseReadOnlyHostMounts, requireReadOnlyHostMountRuntimeSupport } from "./host-mount";
import { DCODE_OBSERVABILITY_FEATURE } from "./observability-policy-presets";
import { isOpenclawAgent } from "./openclaw-otel-policy-presets";
import { NOTICE_ACCEPT_ENV, NOTICE_ACCEPT_FLAG_NAME } from "./usage-notice";
import {
  OnboardResumeIntentError,
  isOnboardResumeIntentRaceError,
  resolveOnboardResumeIntent,
  type OnboardResumeIntentSnapshot,
  type ResolvedOnboardResumeIntent,
  isOnboardDeferredExitError,
  redactOnboardDiagnosticText,
} from "./session-bootstrap";

export interface OnboardCommandOptions {
  tempManagedRuntime: boolean;
  tempManagedRuntimeCatalog: string | null;
  nonInteractive: boolean;
  resume: boolean;
  fresh: boolean;
  recreateSandbox: boolean;
  fromDockerfile: string | null;
  sandboxName: string | null;
  hostMounts?: import("../state/registry/types").SandboxHostMount[];
  sandboxGpu: "enable" | "disable" | null;
  sandboxGpuDevice: string | null;
  vllmGpuDevice: string | null;
  acceptThirdPartySoftware: boolean;
  agent: string | null;
  agentsManifest: string | null;
  toolDisclosure: ToolDisclosure | null;
  observabilityEnabled: boolean | null;
  controlUiPort: number | null;
  gpu: boolean;
  noGpu: boolean;
  autoYes: boolean;
  noOllamaAutostart: boolean;
  experimentalProfile: ExperimentalOnboardProfile | null;
  portableInferenceActivation: PortableInferenceActivation | null;
  deferProcessExit: true;
  resumeIntentSnapshot: OnboardResumeIntentSnapshot | null;
  servingProfile: string | null;
  servingProfileProvenance: ServingProfileProvenance | null;
}

export interface ResolveOnboardOptionsDeps {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  runtimeProviders?: import("./runtime-provider/access").RuntimeProviderBundleRegistry;
  listAgents?: () => string[];
  listServingProfiles?: () => ServingProfileListEntry[];
  loadServingCatalog?: () => CompiledServingCatalog;
  loadSession?: () => {
    servingProfileProvenance?: ServingProfileProvenance | null;
    vllmGpuDevice?: string | null;
  } | null;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
  resumeIntent?: ResolvedOnboardResumeIntent;
  resolveResumeIntent?: typeof resolveOnboardResumeIntent;
}

export interface RunOnboardCommandDeps extends ResolveOnboardOptionsDeps {
  flags: OnboardFlags;
  runOnboard: (options: OnboardCommandOptions) => Promise<void>;
  loadPortableInferenceDescriptor?: typeof loadPortableInferenceDescriptor;
}

function fail(deps: ResolveOnboardOptionsDeps, message: string): never {
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  error(redactOnboardDiagnosticText(message));
  return exit(1);
}

function resolveFileOption(
  flag: "--from" | "--agents" | "--temp-managed-runtime-catalog",
  value: string | undefined,
  deps: ResolveOnboardOptionsDeps,
  preserveInput: boolean,
): string | null {
  if (value === undefined) return null;
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) fail(deps, `  ${flag} path not found: ${resolved}`);
  if (!fs.statSync(resolved).isFile()) {
    const expected = flag === "--from" ? "a Dockerfile" : "a file";
    fail(deps, `  ${flag} must point to ${expected}: ${resolved}`);
  }
  return preserveInput ? value : resolved;
}

// Validate the effective agent from the --agent flag, else the NEMOCLAW_AGENT
// env var. Both feed the same downstream resolver, so validating the env var
// here makes an unknown value fail with the clean flag-style message instead of
// throwing uncaught deep inside runOnboard (a raw Node `throw new Error(...)`
// source frame on stderr) (#5972). For a valid env value we return null and let
// downstream resolution canonicalize it, leaving existing behavior unchanged.
function failUnknownAgent(
  deps: ResolveOnboardOptionsDeps,
  value: string,
  fromEnv: boolean,
  knownAgents: readonly string[],
): never {
  const source = fromEnv ? " (from NEMOCLAW_AGENT)" : "";
  return fail(
    deps,
    `  Unknown agent '${value}'${source}. Available: ${knownAgents.join(", ")}${formatAgentAliasSuffix(knownAgents)}`,
  );
}

function resolveAgent(
  requestedAgent: string | undefined,
  deps: ResolveOnboardOptionsDeps,
): string | null {
  const fromEnv = requestedAgent === undefined;
  const candidate = ((fromEnv ? deps.env.NEMOCLAW_AGENT : requestedAgent) ?? "").trim();
  if (candidate === "") return null;

  const knownAgents = deps.listAgents?.() ?? [];
  const resolved =
    knownAgents.length === 0 ? candidate : resolveAgentNameAlias(candidate, knownAgents);
  if (!resolved) failUnknownAgent(deps, candidate, fromEnv, knownAgents);

  // The env path leaves canonicalization to downstream resolution (returns
  // null); the flag path returns the canonical name as before.
  return fromEnv ? null : resolved;
}

function resolveAgentsManifest(
  requestedManifest: string | undefined,
  agent: string | null,
  deps: ResolveOnboardOptionsDeps,
): string | null {
  if (requestedManifest === undefined) return null;
  if (!isOpenclawAgent(agent)) {
    fail(
      deps,
      `  --agents is OpenClaw-specific and cannot be used with --agent ${agent}; the declarative manifest only drives OpenClaw secondary agents.`,
    );
  }
  return resolveFileOption("--agents", requestedManifest, deps, false);
}

function resolveSandboxGpu(flags: OnboardFlags): "enable" | "disable" | null {
  if (flags["sandbox-gpu"]) return "enable";
  if (flags["no-sandbox-gpu"]) return "disable";
  return null;
}

function resolveVllmGpuDevice(
  requested: string | undefined,
  resume: boolean,
  deps: ResolveOnboardOptionsDeps,
): string | null {
  let normalized: string | null = null;
  if (requested !== undefined) {
    try {
      normalized = normalizeVllmGpuDevice(requested);
    } catch (error) {
      fail(deps, `  Invalid --vllm-gpu-device: ${(error as Error).message}.`);
    }
  }
  if (!resume) return normalized;

  const recorded = deps.loadSession?.()?.vllmGpuDevice ?? null;
  if (!recorded) {
    if (normalized) {
      fail(
        deps,
        "  --vllm-gpu-device cannot be added while resuming a legacy onboarding session; start fresh instead.",
      );
    }
    return null;
  }
  if (normalized && normalized !== recorded) {
    fail(deps, `  --vllm-gpu-device ${normalized} does not match resumed GPU device ${recorded}.`);
  }
  return recorded;
}

function resolveHostMounts(
  values: readonly string[] | undefined,
  experimentalProfile: ExperimentalOnboardProfile | null,
  deps: ResolveOnboardOptionsDeps,
): import("../state/registry/types").SandboxHostMount[] {
  let mounts: import("../state/registry/types").SandboxHostMount[];
  try {
    mounts = parseReadOnlyHostMounts(values ?? []);
  } catch (error) {
    return fail(deps, `  ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    requireReadOnlyHostMountRuntimeSupport(mounts, { ...deps, experimentalProfile });
  } catch (error) {
    fail(deps, `  ${error instanceof Error ? error.message : String(error)}`);
  }
  return mounts;
}

function validateObservabilityAgent(
  requested: boolean | undefined,
  agent: string | null,
  deps: ResolveOnboardOptionsDeps,
): void {
  if (
    agent &&
    managedSandboxFeatureIssue(DCODE_OBSERVABILITY_FEATURE, { agent, requested }) ===
      "unsupported-request"
  ) {
    fail(deps, "  --observability is supported only with --agent langchain-deepagents-code.");
  }
}

function resolveExperimentalProfile(
  flags: OnboardFlags,
  resumeIntent: ResolvedOnboardResumeIntent | undefined,
): ExperimentalOnboardProfile | null {
  return flags["experimental-profile"] === PORTABLE_EXPERIMENTAL_PROFILE ||
    resumeIntent?.snapshot?.profile === PORTABLE_EXPERIMENTAL_PROFILE
    ? PORTABLE_EXPERIMENTAL_PROFILE
    : null;
}

const PROFILE_CONFLICT_ENV = [
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_VLLM_MODEL",
  VLLM_EXTRA_ARGS_ENV,
  "NEMOCLAW_MANAGED_CLUSTER_PEERS",
] as const;

function validateServingProfileConflicts(
  selectedProfileId: string,
  deps: ResolveOnboardOptionsDeps,
): void {
  const existingPreset = String(deps.env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
  if (existingPreset && existingPreset !== selectedProfileId) {
    fail(
      deps,
      `  --profile ${selectedProfileId} conflicts with ${NEMOCLAW_SERVING_PRESET_ENV}=${existingPreset}.`,
    );
  }
  const conflicts = PROFILE_CONFLICT_ENV.filter((name) => String(deps.env[name] ?? "").trim());
  if (conflicts.length > 0) {
    fail(deps, `  --profile cannot be combined with inference overrides: ${conflicts.join(", ")}.`);
  }
}

function resolveServingProfile(
  requested: string | undefined,
  deps: ResolveOnboardOptionsDeps,
): ServingProfileProvenance | null {
  if (requested === undefined) return null;
  const catalog = (deps.loadServingCatalog ?? loadServingCatalog)();
  let selectedProfileId: string;
  try {
    selectedProfileId = resolveServingProfileSelection(requested.trim(), {
      catalog,
      listProfiles: deps.listServingProfiles ? () => deps.listServingProfiles!() : undefined,
    });
  } catch (error) {
    if (error instanceof ServingProfileSelectionError) fail(deps, `  ${error.message}`);
    throw error;
  }
  validateServingProfileConflicts(selectedProfileId, deps);
  return servingProfileProvenance(catalog, selectedProfileId);
}

function resolveInstallerServingProfile(
  deps: ResolveOnboardOptionsDeps,
): ServingProfileProvenance | null {
  const hasInstallerProfileIntent =
    String(deps.env[LOCAL_MODEL_PROFILE_ENABLED_ENV] ?? "").trim() !== "" ||
    String(deps.env[LOCAL_MODEL_PROFILE_RUNTIME_ENV] ?? "").trim() !== "";
  if (!hasInstallerProfileIntent) return null;
  try {
    const catalog = (deps.loadServingCatalog ?? loadServingCatalog)();
    const plan = resolveLocalModelProfilePlan(catalog, deps.env);
    if (!plan) return null;
    validateServingProfileConflicts(plan.preset.metadata.id, deps);
    return servingProfileProvenance(catalog, plan.preset.metadata.id);
  } catch (error) {
    fail(deps, `  ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveServingProfileLifecycle(
  flags: OnboardFlags,
  deps: ResolveOnboardOptionsDeps,
  resume: boolean,
): ServingProfileProvenance | null {
  const explicit = resolveServingProfile(flags.profile, deps);
  const installerProfile = resolveInstallerServingProfile(deps);
  if (
    explicit &&
    installerProfile &&
    JSON.stringify(explicit) !== JSON.stringify(installerProfile)
  ) {
    fail(
      deps,
      `  --profile ${explicit.preset.id} conflicts with installer local model profile ${installerProfile.preset.id}.`,
    );
  }
  const requested = explicit ?? installerProfile;
  const settled = resume ? resolveResumedServingProfile(requested, deps) : requested;
  // Check the profile the run will actually apply, not just an explicit
  // --profile: the installer and resume paths reach the same environment
  // application, and an unmapped backend there would set the preset while
  // leaving the provider unresolved — the silent fall-through to the provider
  // menu this fixes (#9313).
  return assertServingProfileProviderSupported(settled, deps);
}

function assertServingProfileProviderSupported(
  provenance: ServingProfileProvenance | null,
  deps: ResolveOnboardOptionsDeps,
): ServingProfileProvenance | null {
  const unsupported = provenance !== null && servingProfileProviderKey(provenance) === null;
  return unsupported
    ? fail(
        deps,
        `  Serving profile '${provenance.preset.id}' uses backend '${provenance.recipe.backend}', which onboarding cannot configure.`,
      )
    : provenance;
}

function activeServingProfileId(provenance: ServingProfileProvenance | null): string | null {
  if (!provenance || provenance.preset.supportState === "disabled") return null;
  return provenance.preset.id;
}

/**
 * Provider the requested serving profile has to run through.
 *
 * The preset alone only tells provider selection *which* profile to serve once
 * a local-inference provider has been chosen; it never chooses the provider.
 * Because `--profile` also rejects an explicit `NEMOCLAW_PROVIDER`, leaving
 * this unset dropped onboarding into the interactive provider menu with the
 * requested profile unusable (#9313). Returns null for a backend that has no
 * provider wired up, which the caller reports rather than silently ignoring.
 */
export function servingProfileProviderKey(provenance: ServingProfileProvenance): string | null {
  switch (provenance.recipe.backend) {
    // Kept as literals so this module does not take a dependency on the
    // provider menu; `command.test.ts` asserts they match its exported keys.
    case "vllm":
      return "install-vllm";
    case "install-llama-cpp":
      return "install-llama-cpp";
    default:
      return null;
  }
}

function resolveResumedServingProfile(
  requested: ServingProfileProvenance | null,
  deps: ResolveOnboardOptionsDeps,
): ServingProfileProvenance | null {
  const recorded = deps.loadSession?.()?.servingProfileProvenance ?? null;
  if (!recorded) {
    if (requested) {
      fail(
        deps,
        "  --profile cannot be added while resuming a legacy onboarding session; start fresh instead.",
      );
    }
    return null;
  }
  let current: ServingProfileProvenance;
  try {
    current = assertServingProfileProvenanceCurrent(
      recorded,
      (deps.loadServingCatalog ?? loadServingCatalog)(),
    );
  } catch (error) {
    fail(deps, `  ${error instanceof Error ? error.message : String(error)}`);
  }
  if (requested && JSON.stringify(requested) !== JSON.stringify(current)) {
    fail(
      deps,
      `  --profile ${requested.preset.id} does not match resumed profile ${current.preset.id}.`,
    );
  }
  validateServingProfileConflicts(current.preset.id, deps);
  return current;
}

function withPortableDefault(
  requested: boolean | undefined,
  profile: ExperimentalOnboardProfile | null,
): boolean {
  return requested === true || profile !== null;
}

export function resolveOnboardOptions(
  flags: OnboardFlags,
  deps: ResolveOnboardOptionsDeps,
): OnboardCommandOptions {
  const experimentalProfile = resolveExperimentalProfile(flags, deps.resumeIntent);
  const resume = deps.resumeIntent?.effectiveResume ?? flags.resume === true;
  const agent = resolveAgent(flags.agent, deps);
  const servingProfileProvenance = resolveServingProfileLifecycle(flags, deps, resume);
  const vllmGpuDevice = resolveVllmGpuDevice(flags["vllm-gpu-device"], resume, deps);
  validateObservabilityAgent(flags.observability, agent, deps);
  let toolDisclosure: ToolDisclosure | null;
  try {
    toolDisclosure = resolveToolDisclosureRequest(flags["tool-disclosure"], deps.env);
  } catch (error) {
    fail(deps, `  ${error instanceof Error ? error.message : String(error)}`);
  }
  const hostMounts = resolveHostMounts(flags["host-mount"], experimentalProfile, deps);
  return {
    tempManagedRuntime: flags["temp-managed-runtime"] === true,
    tempManagedRuntimeCatalog: resolveFileOption(
      "--temp-managed-runtime-catalog",
      flags["temp-managed-runtime-catalog"],
      deps,
      false,
    ),
    nonInteractive: withPortableDefault(flags["non-interactive"], experimentalProfile),
    resume,
    fresh: resume ? false : withPortableDefault(flags.fresh, experimentalProfile),
    recreateSandbox: flags["recreate-sandbox"] === true,
    fromDockerfile: resolveFileOption("--from", flags.from, deps, true),
    sandboxName: flags.name ?? null,
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
    sandboxGpu: resolveSandboxGpu(flags),
    sandboxGpuDevice: flags["sandbox-gpu-device"] ?? null,
    vllmGpuDevice,
    acceptThirdPartySoftware:
      flags[NOTICE_ACCEPT_FLAG_NAME] === true || String(deps.env[NOTICE_ACCEPT_ENV] || "") === "1",
    agent,
    agentsManifest: resolveAgentsManifest(flags.agents, agent, deps),
    toolDisclosure,
    observabilityEnabled: typeof flags.observability === "boolean" ? flags.observability : null,
    controlUiPort: flags["control-ui-port"] ?? null,
    gpu: flags.gpu === true,
    noGpu: flags["no-gpu"] === true,
    autoYes: withPortableDefault(flags.yes, experimentalProfile),
    noOllamaAutostart: withPortableDefault(flags["no-ollama-autostart"], experimentalProfile),
    experimentalProfile,
    portableInferenceActivation: null,
    deferProcessExit: true,
    resumeIntentSnapshot: deps.resumeIntent?.snapshot ?? null,
    servingProfile: activeServingProfileId(servingProfileProvenance),
    servingProfileProvenance,
  };
}

// A prompt closed before the user answered (stdin EOF, e.g.
// `nemoclaw onboard ... < /dev/null`) or the user pressed Ctrl+C. `prompt()`
// rejects these with a code so callers can treat them as deliberate
// cancellation rather than a crash. See src/lib/credentials/store.ts.
function promptCancellationCode(error: unknown): "EOF" | "SIGINT" | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EOF" || code === "SIGINT" ? code : null;
}

function reportOnboardCommandError(deps: RunOnboardCommandDeps, message: string): number {
  const redacted = message.split("\n").map(redactOnboardDiagnosticText).join("\n");
  (deps.error ?? console.error)(redacted);
  return 1;
}

function handleOnboardCommandError(error: unknown, deps: RunOnboardCommandDeps): number | null {
  const cancellationCode = promptCancellationCode(error);
  if (cancellationCode === "SIGINT") {
    // The prompt has already restored terminal state and re-raised SIGINT.
    // Let the onboard signal handler print resumable-step guidance and
    // preserve status 130 without leaking this rejected prompt error through
    // oclif as a raw stack trace (#7439).
    return null;
  }
  // A rejected NEMOCLAW_GATEWAY_MANAGEMENT contract is operator input error,
  // not a crash: print the validation reason as a clean single-line CLI error
  // and exit nonzero instead of re-throwing it into a Node.js stack trace
  // (#7627).
  if (error instanceof GatewayManagementDeclarationError) {
    return reportOnboardCommandError(deps, `  ${error.message}`);
  }
  if (error instanceof PortableInferenceDescriptorError) {
    return reportOnboardCommandError(deps, `  ${error.message}`);
  }
  // Gateway-authority refusals are reported, never rethrown. Recreation is not
  // selected in one place: `--recreate-sandbox` sets the flag, but `runOnboard`
  // independently honours NEMOCLAW_RECREATE_SANDBOX and reaches the same
  // journal when it detects sandbox drift. Keying this branch on the flag left
  // both of those paths emitting a raw stack trace (#8103). Within onboarding
  // the recreate journal's authority revalidation is the only source of this
  // typed error, so the operation label holds however recreation was selected.
  if (error instanceof GatewayAuthorityError) {
    return reportOnboardCommandError(
      deps,
      gatewayAuthorityFailureLines(error, "sandbox recreate").join("\n"),
    );
  }
  // Stdin EOF at any onboarding prompt is a cancellation, not a failure:
  // print a clear message and exit non-zero instead of either crashing with
  // a stack trace or — as in the original bug — exiting 0 silently (#5976).
  if (cancellationCode !== "EOF") throw error;
  return reportOnboardCommandError(deps, "  Installation cancelled");
}

function applyServingProfileEnvironment(
  options: OnboardCommandOptions,
  env: NodeJS.ProcessEnv,
): () => void {
  if (!options.servingProfile) return () => {};
  const previous = env[NEMOCLAW_SERVING_PRESET_ENV];
  env[NEMOCLAW_SERVING_PRESET_ENV] = options.servingProfile;
  // The preset selects the model once a provider is chosen; the profile's
  // backend is what selects the provider. Setting only the former left the
  // provider unresolved and onboarding fell back to the menu (#9313).
  // `validateServingProfileConflicts` already rejected an operator-supplied
  // NEMOCLAW_PROVIDER, so nothing of the caller's is being overwritten here.
  const providerKey = options.servingProfileProvenance
    ? servingProfileProviderKey(options.servingProfileProvenance)
    : null;
  const previousProvider = env.NEMOCLAW_PROVIDER;
  if (providerKey) env.NEMOCLAW_PROVIDER = providerKey;
  return () => {
    if (previous === undefined) delete env[NEMOCLAW_SERVING_PRESET_ENV];
    else env[NEMOCLAW_SERVING_PRESET_ENV] = previous;
    if (providerKey) {
      if (previousProvider === undefined) delete env.NEMOCLAW_PROVIDER;
      else env.NEMOCLAW_PROVIDER = previousProvider;
    }
  };
}

function toolDisclosureEnvironmentOverride(
  options: OnboardCommandOptions,
  flags: OnboardFlags,
): ToolDisclosure | null {
  if (!options.toolDisclosure) return null;
  if (!options.experimentalProfile) return options.toolDisclosure;
  return flags["tool-disclosure"] !== undefined ? options.toolDisclosure : null;
}

async function activatePortableInference(
  options: OnboardCommandOptions,
  deps: RunOnboardCommandDeps,
  env: NodeJS.ProcessEnv,
): Promise<{
  options: OnboardCommandOptions;
  credentialOverrides: Readonly<Record<string, string>>;
}> {
  if (!options.experimentalProfile) return { options, credentialOverrides: {} };
  const descriptor = await (
    deps.loadPortableInferenceDescriptor ?? loadPortableInferenceDescriptor
  )({ env });
  if (!descriptor) return { options, credentialOverrides: {} };
  return {
    options: {
      ...options,
      portableInferenceActivation: {
        schemaVersion: descriptor.schemaVersion,
        baseUrl: descriptor.baseUrl,
        model: descriptor.model,
        expiresAt: descriptor.expiresAt,
      },
    },
    credentialOverrides: { [PORTABLE_INFERENCE_CREDENTIAL_ENV]: descriptor.apiKey },
  };
}

export async function runOnboardCommand(deps: RunOnboardCommandDeps): Promise<void> {
  const env = deps.env ?? process.env;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runOnboardCommandAttempt(deps, env, attempt);
    if (result === "retry") continue;
    if (typeof result === "number") deps.exit?.(result) ?? process.exit(result);
    return;
  }
}

type OnboardCommandAttemptResult = "complete" | "retry" | number;

interface OnboardCommandEnvironmentSnapshot {
  agentsManifest: string | undefined;
  toolDisclosure: string | undefined;
  vllmGpuDevice: string | undefined;
  ollamaAutostart: { present: boolean; value: string | undefined };
}

function resolveCommandResumeIntent(deps: RunOnboardCommandDeps): ResolvedOnboardResumeIntent {
  const explicitProfile =
    deps.flags["experimental-profile"] === PORTABLE_EXPERIMENTAL_PROFILE ? "portable" : null;
  try {
    return deps.resolveResumeIntent
      ? deps.resolveResumeIntent({
          explicitResume: deps.flags.resume === true,
          fresh: deps.flags.fresh === true,
          explicitProfile,
        })
      : { effectiveResume: deps.flags.resume === true, snapshot: null };
  } catch (error) {
    if (error instanceof OnboardResumeIntentError) fail(deps, `  ${error.message}`);
    throw error;
  }
}

function handleOnboardCommandAttemptError(
  error: unknown,
  deps: RunOnboardCommandDeps,
  attempt: number,
): OnboardCommandAttemptResult {
  if (isOnboardResumeIntentRaceError(error)) {
    if (attempt === 0) return "retry";
    return reportOnboardCommandError(
      deps,
      "  The onboarding checkpoint changed while resume acquired its lock. Retry the command.",
    );
  }
  if (isOnboardDeferredExitError(error)) return error.code;
  return handleOnboardCommandError(error, deps) ?? "complete";
}

function restoreOnboardCommandEnvironment(
  env: NodeJS.ProcessEnv,
  options: OnboardCommandOptions,
  snapshot: OnboardCommandEnvironmentSnapshot,
  restoreServingProfileEnvironment: () => void,
): void {
  if (options.agentsManifest) {
    if (snapshot.agentsManifest === undefined) delete env.NEMOCLAW_EXTRA_AGENTS_JSON;
    else env.NEMOCLAW_EXTRA_AGENTS_JSON = snapshot.agentsManifest;
  }
  restoreServingProfileEnvironment();
  if (snapshot.toolDisclosure === undefined) delete env[TOOL_DISCLOSURE_ENV];
  else env[TOOL_DISCLOSURE_ENV] = snapshot.toolDisclosure;
  if (snapshot.vllmGpuDevice === undefined) delete env[NEMOCLAW_VLLM_GPU_DEVICE_ENV];
  else env[NEMOCLAW_VLLM_GPU_DEVICE_ENV] = snapshot.vllmGpuDevice;
  if (snapshot.ollamaAutostart.present) {
    env.NEMOCLAW_OLLAMA_NO_AUTOSTART = snapshot.ollamaAutostart.value ?? "";
  } else {
    delete env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
  }
}

async function runOnboardCommandAttempt(
  deps: RunOnboardCommandDeps,
  env: NodeJS.ProcessEnv,
  attempt: number,
): Promise<OnboardCommandAttemptResult> {
  const resumeIntent = resolveCommandResumeIntent(deps);
  const resolvedOptions = resolveOnboardOptions(deps.flags, { ...deps, resumeIntent });
  let restoreServingProfileEnvironment = () => {};
  const environmentSnapshot: OnboardCommandEnvironmentSnapshot = {
    agentsManifest: env.NEMOCLAW_EXTRA_AGENTS_JSON,
    toolDisclosure: env[TOOL_DISCLOSURE_ENV],
    vllmGpuDevice: env[NEMOCLAW_VLLM_GPU_DEVICE_ENV],
    ollamaAutostart: {
      present: Object.prototype.hasOwnProperty.call(env, "NEMOCLAW_OLLAMA_NO_AUTOSTART"),
      value: env.NEMOCLAW_OLLAMA_NO_AUTOSTART,
    },
  };
  let options = resolvedOptions;
  try {
    const activation = await activatePortableInference(resolvedOptions, deps, env);
    options = activation.options;
    restoreServingProfileEnvironment = applyServingProfileEnvironment(options, env);
    const toolDisclosure = toolDisclosureEnvironmentOverride(options, deps.flags);
    if (toolDisclosure) env[TOOL_DISCLOSURE_ENV] = toolDisclosure;
    if (options.vllmGpuDevice) env[NEMOCLAW_VLLM_GPU_DEVICE_ENV] = options.vllmGpuDevice;
    else delete env[NEMOCLAW_VLLM_GPU_DEVICE_ENV];
    if (options.noOllamaAutostart && !options.experimentalProfile) {
      env.NEMOCLAW_OLLAMA_NO_AUTOSTART = "1";
    }
    if (options.agentsManifest) applyAgentsManifestEnv(options.agentsManifest, env);
    await withCredentialOverrides(activation.credentialOverrides, () => deps.runOnboard(options));
    return "complete";
  } catch (error) {
    return handleOnboardCommandAttemptError(error, deps, attempt);
  } finally {
    restoreOnboardCommandEnvironment(
      env,
      options,
      environmentSnapshot,
      restoreServingProfileEnvironment,
    );
  }
}
