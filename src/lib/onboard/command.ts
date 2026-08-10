// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { formatAgentAliasSuffix, resolveAgentNameAlias } from "../agent/aliases";
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
import { VLLM_EXTRA_ARGS_ENV } from "../inference/vllm-models";
import {
  resolveToolDisclosureRequest,
  TOOL_DISCLOSURE_ENV,
  type ToolDisclosure,
} from "../tool-disclosure";
import { applyAgentsManifestEnv } from "./agents-manifest";
import type { OnboardFlags } from "./command-support";
import {
  EXPERIMENTAL_PROFILE_ENV,
  type ExperimentalOnboardProfile,
  PORTABLE_EXPERIMENTAL_PROFILE,
} from "./docker-driver-platform";
import { GatewayManagementDeclarationError } from "./gateway-management";
import { GatewayAuthorityError, gatewayAuthorityFailureLines } from "./gateway-teardown-authority";
import {
  LOCAL_MODEL_PROFILE_ENABLED_ENV,
  LOCAL_MODEL_PROFILE_RUNTIME_ENV,
  resolveLocalModelProfilePlan,
} from "./local-model-profile/plan";
import { managedSandboxFeatureIssue } from "./managed-sandbox-feature";
import { DCODE_OBSERVABILITY_FEATURE } from "./observability-policy-presets";
import { isOpenclawAgent } from "./openclaw-otel-policy-presets";
import { NOTICE_ACCEPT_ENV, NOTICE_ACCEPT_FLAG_NAME } from "./usage-notice";

export interface OnboardCommandOptions {
  tempManagedRuntime: boolean;
  tempManagedRuntimeCatalog: string | null;
  nonInteractive: boolean;
  resume: boolean;
  fresh: boolean;
  recreateSandbox: boolean;
  fromDockerfile: string | null;
  sandboxName: string | null;
  sandboxGpu: "enable" | "disable" | null;
  sandboxGpuDevice: string | null;
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
  servingProfile: string | null;
  servingProfileProvenance: ServingProfileProvenance | null;
}

export interface ResolveOnboardOptionsDeps {
  env: NodeJS.ProcessEnv;
  listAgents?: () => string[];
  listServingProfiles?: () => ServingProfileListEntry[];
  loadServingCatalog?: () => CompiledServingCatalog;
  loadSession?: () => { servingProfileProvenance?: ServingProfileProvenance | null } | null;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

export interface RunOnboardCommandDeps extends ResolveOnboardOptionsDeps {
  flags: OnboardFlags;
  runOnboard: (options: OnboardCommandOptions) => Promise<void>;
}

function fail(deps: ResolveOnboardOptionsDeps, message: string): never {
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  error(message);
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

function resolveExperimentalProfile(flags: OnboardFlags): ExperimentalOnboardProfile | null {
  return flags["experimental-profile"] === PORTABLE_EXPERIMENTAL_PROFILE
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
  if (flags.resume !== true) return requested;
  return resolveResumedServingProfile(requested, deps);
}

function activeServingProfileId(provenance: ServingProfileProvenance | null): string | null {
  if (!provenance || provenance.preset.supportState === "disabled") return null;
  return provenance.preset.id;
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

function validateExperimentalProfileLifecycle(
  flags: OnboardFlags,
  profile: ExperimentalOnboardProfile | null,
  deps: ResolveOnboardOptionsDeps,
): void {
  if (profile && flags.resume === true) {
    fail(deps, "  --resume cannot be combined with --experimental-profile portable.");
  }
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
  const experimentalProfile = resolveExperimentalProfile(flags);
  validateExperimentalProfileLifecycle(flags, experimentalProfile, deps);
  const agent = resolveAgent(flags.agent, deps);
  const servingProfileProvenance = resolveServingProfileLifecycle(flags, deps);
  validateObservabilityAgent(flags.observability, agent, deps);
  let toolDisclosure: ToolDisclosure | null;
  try {
    toolDisclosure = resolveToolDisclosureRequest(flags["tool-disclosure"], deps.env);
  } catch (error) {
    fail(deps, `  ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    tempManagedRuntime: flags["temp-managed-runtime"] === true,
    tempManagedRuntimeCatalog: resolveFileOption(
      "--temp-managed-runtime-catalog",
      flags["temp-managed-runtime-catalog"],
      deps,
      false,
    ),
    nonInteractive: withPortableDefault(flags["non-interactive"], experimentalProfile),
    resume: flags.resume === true,
    fresh: withPortableDefault(flags.fresh, experimentalProfile),
    recreateSandbox: flags["recreate-sandbox"] === true,
    fromDockerfile: resolveFileOption("--from", flags.from, deps, true),
    sandboxName: flags.name ?? null,
    sandboxGpu: resolveSandboxGpu(flags),
    sandboxGpuDevice: flags["sandbox-gpu-device"] ?? null,
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

function handleOnboardCommandError(error: unknown, deps: RunOnboardCommandDeps): void {
  const cancellationCode = promptCancellationCode(error);
  if (cancellationCode === "SIGINT") {
    // The prompt has already restored terminal state and re-raised SIGINT.
    // Let the onboard signal handler print resumable-step guidance and
    // preserve status 130 without leaking this rejected prompt error through
    // oclif as a raw stack trace (#7439).
    return;
  }
  // A rejected NEMOCLAW_GATEWAY_MANAGEMENT contract is operator input error,
  // not a crash: print the validation reason as a clean single-line CLI error
  // and exit nonzero instead of re-throwing it into a Node.js stack trace
  // (#7627). `fail` sets exit code 1.
  if (error instanceof GatewayManagementDeclarationError) {
    fail(deps, `  ${error.message}`);
  }
  // Gateway-authority refusals are reported, never rethrown. Recreation is not
  // selected in one place: `--recreate-sandbox` sets the flag, but `runOnboard`
  // independently honours NEMOCLAW_RECREATE_SANDBOX and reaches the same
  // journal when it detects sandbox drift. Keying this branch on the flag left
  // both of those paths emitting a raw stack trace (#8103). Within onboarding
  // the recreate journal's authority revalidation is the only source of this
  // typed error, so the operation label holds however recreation was selected.
  if (error instanceof GatewayAuthorityError) {
    fail(deps, gatewayAuthorityFailureLines(error, "sandbox recreate").join("\n"));
  }
  // Stdin EOF at any onboarding prompt is a cancellation, not a failure:
  // print a clear message and exit non-zero instead of either crashing with
  // a stack trace or — as in the original bug — exiting 0 silently (#5976).
  if (cancellationCode !== "EOF") throw error;
  fail(deps, "  Installation cancelled");
}

function applyPortableEnvironment(
  options: OnboardCommandOptions,
  env: NodeJS.ProcessEnv,
): () => void {
  if (!options.experimentalProfile) return () => {};
  const portableEnvDefaults = {
    [EXPERIMENTAL_PROFILE_ENV]: options.experimentalProfile ?? undefined,
    [TOOL_DISCLOSURE_ENV]: "direct",
    NEMOCLAW_PROVIDER: "ollama",
    NEMOCLAW_MODEL: "qwen3-vl:4b",
    NEMOCLAW_OLLAMA_NO_AUTOSTART: "1",
    NEMOCLAW_POLICY_MODE: "suggested",
    NEMOCLAW_POLICY_TIER: "personal",
  } as const;
  const previousPortableEnv = new Map<string, string | undefined>();
  const restore = () => {
    for (const [key, value] of previousPortableEnv) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
  try {
    for (const [key, value] of Object.entries(portableEnvDefaults)) {
      previousPortableEnv.set(key, env[key]);
      if (value !== undefined) env[key] = value;
    }
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}

function applyServingProfileEnvironment(
  options: OnboardCommandOptions,
  env: NodeJS.ProcessEnv,
): () => void {
  if (!options.servingProfile) return () => {};
  const previous = env[NEMOCLAW_SERVING_PRESET_ENV];
  env[NEMOCLAW_SERVING_PRESET_ENV] = options.servingProfile;
  return () => {
    if (previous === undefined) delete env[NEMOCLAW_SERVING_PRESET_ENV];
    else env[NEMOCLAW_SERVING_PRESET_ENV] = previous;
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

export async function runOnboardCommand(deps: RunOnboardCommandDeps): Promise<void> {
  const options = resolveOnboardOptions(deps.flags, deps);
  const env = deps.env ?? process.env;
  let restorePortableEnvironment = () => {};
  let restoreServingProfileEnvironment = () => {};
  const previousAgentsManifest = env.NEMOCLAW_EXTRA_AGENTS_JSON;
  try {
    restorePortableEnvironment = applyPortableEnvironment(options, env);
    restoreServingProfileEnvironment = applyServingProfileEnvironment(options, env);
    if (options.noOllamaAutostart) env.NEMOCLAW_OLLAMA_NO_AUTOSTART = "1";
    // Keep direct callers and the legacy monolithic onboard path on the same
    // canonical source. No value is written for the default so resume/rebuild
    // can distinguish an explicit request from an unset environment.
    const toolDisclosure = toolDisclosureEnvironmentOverride(options, deps.flags);
    if (toolDisclosure) env[TOOL_DISCLOSURE_ENV] = toolDisclosure;
    if (options.agentsManifest) applyAgentsManifestEnv(options.agentsManifest, env);
    await deps.runOnboard(options);
  } catch (error) {
    handleOnboardCommandError(error, deps);
  } finally {
    if (options.agentsManifest) {
      if (previousAgentsManifest === undefined) delete env.NEMOCLAW_EXTRA_AGENTS_JSON;
      else env.NEMOCLAW_EXTRA_AGENTS_JSON = previousAgentsManifest;
    }
    restoreServingProfileEnvironment();
    restorePortableEnvironment();
  }
}
