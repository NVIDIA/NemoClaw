// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import {
  resolveAgentDefaultCloudModel,
  resolveAgentProviderInferenceApi,
} from "../inference/config";
import type { TrustedPrivateEndpointCapability } from "../inference/endpoint-ssrf-preflight";
import type { GatewayRouteDiscoveryConstraints } from "../inference/gateway-route-compatibility";
import {
  LLAMA_CPP_CREDENTIAL_ENV,
  LLAMA_CPP_HOST_OPENAI_BASE_URL,
  LLAMA_CPP_PROVIDER_NAME,
  LLAMA_CPP_RECIPE_ENV,
} from "../inference/llama-cpp/contract";
import {
  installManagedLlamaCpp,
  resumeManagedLlamaCppRuntime,
} from "../inference/llama-cpp/managed-installer";
import {
  type ManagedLlamaCppSelectionChoice,
  type ManagedLlamaCppSelectionResult,
  listManagedLlamaCppSelectionChoices,
  resolveManagedLlamaCppSelection,
} from "../inference/llama-cpp/managed-selection";
import { getOllamaContextWindowFloorForAgent } from "../inference/ollama-runtime-context";
import {
  type RequestedServingProfileModel,
  resolveRequestedServingProfileModel,
} from "../inference/serving/requested-profile-model";
import type { VllmProfile } from "../inference/vllm";
import { promptManualModelId } from "../inference/model-prompts";
import { isBackToSelection } from "../navigation";
import type { HermesAuthMethod } from "./hermes-auth";
import { isPortableExperimentalProfile } from "./experimental/portable-profile";
import { OnboardInferenceCapabilityCache } from "./inference-capability-cache";
import {
  createLocalModelProfileIntegration,
  type LocalModelProfilePlan,
} from "./local-model-profile/integration";
import type { ProviderSelectionResult } from "./machine/handlers/provider-inference";
import type { ProviderInferenceProbeRoute } from "./machine/handlers/provider-inference-route-containment";
import type {
  NvidiaFeaturedModelSession,
  NvidiaFeaturedModelSessionOptions,
} from "./nvidia-featured-model-selection";
import type { InferenceProviderHostGpu, InferenceProviderHostState } from "./provider-host-state";
import { buildInferenceProviderMenu, type ProviderMenuChoice } from "./provider-menu";
import {
  applyVllmInstallResumeDefaults,
  resolveRequestedProviderSelection,
  vllmInstallRecoveryOptions,
} from "./provider-selection";
import { reportProviderSelectionFailure } from "./provider-selection-failure";
import { promptForInferenceProviderSelection } from "./provider-selection-prompt";
import type { RebuildRouteHandoff, RegistryInferenceRoute } from "./rebuild-route-handoff";
import type { RuntimeProviderBundle } from "./runtime-provider/contract";

export { resolveCurrentRuntimeProviderBundle } from "./runtime-provider/current";
export { createHermesPortableOllamaInferenceResolver } from "./experimental/hermes-portable-ollama-inference";

import { prepareProviderDiscovery } from "./setup-nim-provider-discovery";
import type { SetupNimSelectionState as BaseSetupNimSelectionState } from "./setup-nim-selection";

export { probeLlamaCppAttachment } from "../inference/llama-cpp";
export { createLlamaCppSelectionHandler } from "./llama-cpp-selection";
export { createLocalModelProfileIntegration } from "./local-model-profile/integration";
export { resumeManagedLlamaCppRuntime };

export type SetupNimGpu = ReturnType<typeof import("../inference/nim").detectGpu>;
export type SetupNimSelectionState = BaseSetupNimSelectionState<HermesAuthMethod>;
export type SetupNimSelectionResult = "selected" | "retry-selection";

export interface SetupNimRemoteProviderConfigEntry {
  label: string;
  providerName: string;
  endpointUrl: string;
  credentialEnv: string;
}

export interface SetupNimRemoteSelectionArgs {
  gatewayName: string | null;
  selected: ProviderMenuChoice;
  requestedModel: string | null;
  recoveredFromSandbox: boolean;
  recoveredModel: string | null;
  sandboxName: string | null;
  intendedInferenceApi: string | null;
  recoverySessionId: string | null | undefined;
}

export type SetupNim = (
  gpu: SetupNimGpu,
  sandboxName?: string | null,
  agent?: AgentDefinition | null,
  recoverProvider?: boolean,
  rebuildRegistryInferenceRoute?: RebuildRouteHandoff | null,
  gatewayName?: string | null,
  assertRouteCompatible?: (route: ProviderInferenceProbeRoute) => GatewayRouteDiscoveryConstraints,
  canProbeRoute?: (provider: string) => boolean,
  recoverySessionId?: string | null,
) => Promise<ProviderSelectionResult>;

export interface SetupNimFlowDeps {
  remoteProviderConfig: Record<string, SetupNimRemoteProviderConfigEntry>;
  experimental: boolean;
  ollamaPort: number;
  vllmPort: number;
  getGatewayPort(): number;
  getRuntimeProvider(): RuntimeProviderBundle;
  step(current: number, total: number, label: string): void;
  isNonInteractive(): boolean;
  getNonInteractiveProvider(): string | null;
  getVllmInstallResumeModel?(): string | null;
  getNonInteractiveModel(
    providerKey: string,
    options?: { allowProviderModelFallback?: boolean },
  ): string | null;
  createNvidiaFeaturedModelSession(
    options?: NvidiaFeaturedModelSessionOptions,
  ): NvidiaFeaturedModelSession;
  detectInferenceProviderHostState(input: {
    gpu: InferenceProviderHostGpu | null | undefined;
    experimental: boolean;
    probeOllama?: boolean;
    probeVllm?: boolean;
  }): InferenceProviderHostState;
  getAgentInferenceProviderOptions(agent: AgentDefinition | null | undefined): string[];
  loadRoutedProfile(): { router?: { enabled?: boolean } } | null | undefined;
  readRecordedProvider(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null;
  readRecordedNimContainer(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null;
  readRecordedModel(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null;
  rejectWindowsHostOllama(
    requirement: InferenceProviderHostState["windowsHostOllamaDockerRequirement"],
    providerKey: string,
    windowsHostSelected: boolean,
  ): boolean;
  prompt(message: string): Promise<string>;
  selectFromNumberedMenu(
    rawChoice: string,
    defaultIndex: number,
    options: ProviderMenuChoice[],
  ): ProviderMenuChoice;
  note(message: string): void;
  log(message?: string): void;
  error(message: string): void;
  exitProcess(code: number): never;
  abortNonInteractive(message: string): never;
  localModelProfileIntegration?: ReturnType<typeof createLocalModelProfileIntegration>;
  resolveManagedLlamaCppSelection?(env?: NodeJS.ProcessEnv): ManagedLlamaCppSelectionResult;
  listManagedLlamaCppSelectionChoices?(): readonly ManagedLlamaCppSelectionChoice[];
  installManagedLlamaCpp?: typeof installManagedLlamaCpp;
  handleRemoteProviderSelection(
    args: SetupNimRemoteSelectionArgs,
    state: SetupNimSelectionState,
    recoveredRegistryRoute: RegistryInferenceRoute | null,
  ): Promise<SetupNimSelectionResult>;
  handleLlamaCppSelection(
    state: SetupNimSelectionState,
    requestedModel: string | null,
    recoveredModel: string | null,
  ): Promise<SetupNimSelectionResult>;
  handleNimLocalSelection(
    gpu: SetupNimGpu,
    args: Pick<
      SetupNimRemoteSelectionArgs,
      "requestedModel" | "recoveredFromSandbox" | "recoveredModel"
    >,
    state: SetupNimSelectionState,
  ): Promise<SetupNimSelectionResult>;
  handleRunningOllamaSelection(
    gpu: SetupNimGpu,
    requestedModel: string | null,
    recoveredModel: string | null,
    ollamaRunning: boolean,
    state: SetupNimSelectionState,
    isWindowsHostOllama?: boolean,
  ): Promise<SetupNimSelectionResult>;
  handleWindowsHostOllamaSelection(
    gpu: SetupNimGpu,
    selectedKey: string,
    requestedModel: string | null,
    windowsOllamaReachable: boolean,
    winOllamaLoopbackOnly: boolean,
    winOllamaInstalledPath: string | null,
    state: SetupNimSelectionState,
  ): Promise<SetupNimSelectionResult>;
  handleInstallOllamaSelection(
    gpu: SetupNimGpu,
    requestedModel: string | null,
    recoveredModel: string | null,
    state: SetupNimSelectionState,
    ollamaInstallMenu: InferenceProviderHostState["ollamaInstallMenu"],
  ): Promise<SetupNimSelectionResult>;
  installVllm(
    profile: VllmProfile,
    options: {
      hasImage: boolean;
      nonInteractive: boolean;
      promptFn: (question: string) => Promise<string>;
      beforeInstall?: (modelId: string) => void;
      checkpointInstallIntent?: (modelId: string) => void;
      modelIntent?: string;
    },
  ): Promise<{ ok: boolean }>;
  checkpointVllmInstallModel?(modelId: string): void;
  handleVllmSelection(
    state: SetupNimSelectionState,
    options?: {
      managedInstall?: boolean;
      sparkHost?: boolean;
      servingProfileModel?: RequestedServingProfileModel | null;
    },
  ): Promise<SetupNimSelectionResult>;
  resolveRequestedServingProfileModel?(
    env?: NodeJS.ProcessEnv,
  ): RequestedServingProfileModel | null;
  selectVllmModelFromEnv?(env?: NodeJS.ProcessEnv): { id: string; servedModelId?: string } | null;
  handleRoutedSelection(state: SetupNimSelectionState): Promise<SetupNimSelectionResult>;
  coerceAgentInferenceApi(
    agent: AgentDefinition | null,
    preferredInferenceApi: string | null,
  ): string | null;
  resolveAgentInferenceApi(
    agentName: string | null,
    provider: string,
    preferredInferenceApi: string | null,
  ): string | null;
  clearCompatibleEndpointReasoning(): null;
  clearCompatibleEndpointReasoningEffort?(): null;
  maybePromptForInferenceInputCapability(model: string | null): Promise<void>;
}

function requireSelectedProvider(
  selected: ProviderMenuChoice | undefined,
  deps: Pick<SetupNimFlowDeps, "error" | "exitProcess">,
): ProviderMenuChoice {
  if (!selected) {
    deps.error("  No provider was selected.");
    deps.exitProcess(1);
  }
  return selected;
}

function assertVllmGpuProviderSelection(
  selected: ProviderMenuChoice,
  recoveredFromSandbox: boolean,
  deps: Pick<
    SetupNimFlowDeps,
    "abortNonInteractive" | "error" | "exitProcess" | "isNonInteractive"
  >,
): void {
  const requestedDevice = String(process.env.NEMOCLAW_VLLM_GPU_DEVICE ?? "").trim();
  const resumedManagedVllm = recoveredFromSandbox && selected.key === "vllm";
  if (!requestedDevice || selected.key === "install-vllm" || resumedManagedVllm) return;

  const message =
    `--vllm-gpu-device applies only when NemoClaw installs managed vLLM; ` +
    `the selected provider is '${selected.key}'.`;
  deps.error(`  ${message}`);
  if (deps.isNonInteractive()) deps.abortNonInteractive(message);
  deps.exitProcess(1);
}

function handleSelectedOllama(
  deps: Pick<SetupNimFlowDeps, "handleInstallOllamaSelection" | "handleRunningOllamaSelection">,
  args: {
    gpu: SetupNimGpu;
    requestedModel: string | null;
    recoveredModel: string | null;
    ollamaRunning: boolean;
    isWindowsHostOllama: boolean;
    state: SetupNimSelectionState;
    ollamaInstallMenu: InferenceProviderHostState["ollamaInstallMenu"];
  },
): Promise<SetupNimSelectionResult> {
  if (args.ollamaInstallMenu.hasUpgradableOllama) {
    return deps.handleInstallOllamaSelection(
      args.gpu,
      args.requestedModel,
      args.recoveredModel,
      args.state,
      args.ollamaInstallMenu,
    );
  }
  return deps.handleRunningOllamaSelection(
    args.gpu,
    args.requestedModel,
    args.recoveredModel,
    args.ollamaRunning,
    args.state,
    args.isWindowsHostOllama,
  );
}

function resolveValidationInferenceApi(
  selectedKey: string,
  provider: string,
  agent: AgentDefinition | null,
): string | null {
  if (selectedKey !== "anthropicCompatible") return null;
  return resolveAgentProviderInferenceApi(
    agent?.name ?? "openclaw",
    agent,
    provider,
    "anthropic-messages",
  );
}

function clearReasoningUnlessCompatible(
  provider: string,
  current: string | null,
  deps: Pick<SetupNimFlowDeps, "clearCompatibleEndpointReasoning">,
): string | null {
  if (provider === "compatible-endpoint") return current;
  return deps.clearCompatibleEndpointReasoning();
}

function readSelectionReasoningState(state: SetupNimSelectionState): {
  reasoning: string | null;
  effort: string | null;
} {
  return {
    reasoning: state.compatibleEndpointReasoning ?? null,
    effort: state.compatibleEndpointReasoningEffort ?? null,
  };
}

function clearReasoningEffortUnlessCompatible(
  provider: string,
  current: string | null,
  deps: Pick<SetupNimFlowDeps, "clearCompatibleEndpointReasoningEffort">,
): string | null {
  if (provider === "compatible-endpoint") return current;
  return deps.clearCompatibleEndpointReasoningEffort?.() ?? null;
}

function applyGatewayRouteDiscoveryConstraints(
  state: SetupNimSelectionState,
  constraints: GatewayRouteDiscoveryConstraints,
): void {
  if (!state.model && constraints.requiredModel) {
    state.model = constraints.requiredModel;
  }
  if (!state.endpointUrl && constraints.requiredEndpointUrl) {
    state.endpointUrl = constraints.requiredEndpointUrl;
  }
  if (!state.preferredInferenceApi && constraints.requiredInferenceApi) {
    state.preferredInferenceApi = constraints.requiredInferenceApi;
  }
}

function isEndpointProviderSelection(deps: SetupNimFlowDeps, providerKey: string): boolean {
  return providerKey === "llama-cpp" || Boolean(deps.remoteProviderConfig[providerKey]);
}

function resolveManagedLlamaCppSafely(
  deps: SetupNimFlowDeps,
  env?: NodeJS.ProcessEnv,
): ManagedLlamaCppSelectionResult {
  try {
    return (deps.resolveManagedLlamaCppSelection ?? resolveManagedLlamaCppSelection)(env);
  } catch (error) {
    return {
      kind: "rejected",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildManagedLlamaCppOptions(input: {
  deps: SetupNimFlowDeps;
  candidate: boolean;
  requestedProvider: string | null;
  resolution: ManagedLlamaCppSelectionResult | null;
}): ProviderMenuChoice[] {
  const { deps, candidate, requestedProvider, resolution } = input;
  if (!candidate) return [];

  let choices: readonly ManagedLlamaCppSelectionChoice[] = [];
  try {
    if (deps.listManagedLlamaCppSelectionChoices) {
      choices = deps.listManagedLlamaCppSelectionChoices();
    } else if (deps.resolveManagedLlamaCppSelection) {
      choices =
        resolution?.kind === "selected" ? [{ priority: 0, selection: resolution.selection }] : [];
    } else {
      choices = listManagedLlamaCppSelectionChoices();
    }
  } catch (error) {
    deps.note(
      `  Managed llama.cpp profiles unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    choices = [];
  }

  const defaultRecipeId =
    resolution?.kind === "selected" ? resolution.selection.recipe.metadata.id : null;
  const options = choices.map(({ selection }): ProviderMenuChoice => {
    const recipeId = selection.recipe.metadata.id;
    const displayName =
      selection.preset?.metadata.displayName ?? selection.recipe.metadata.displayName ?? recipeId;
    return {
      key: "install-llama-cpp",
      label: `Managed llama.cpp: ${displayName}${recipeId === defaultRecipeId ? " (recommended)" : ""}`,
      managedLlamaCppRecipeId: recipeId,
    };
  });
  if (options.length === 0 && requestedProvider === "install-llama-cpp") {
    options.push({ key: "install-llama-cpp", label: "Managed llama.cpp" });
  }
  return options;
}

function prepareManagedLlamaCppMenu(input: {
  deps: SetupNimFlowDeps;
  platform: InferenceProviderHostGpu["platform"] | undefined;
  requestedProvider: string | null;
}): {
  resolution: ManagedLlamaCppSelectionResult | null;
  options: ProviderMenuChoice[];
} {
  const { deps, platform, requestedProvider } = input;
  const candidate = platform === "spark" || requestedProvider === "install-llama-cpp";
  const resolution = candidate
    ? resolveManagedLlamaCppSafely(
        deps,
        !deps.isNonInteractive() && !requestedProvider
          ? { ...process.env, [LLAMA_CPP_RECIPE_ENV]: "" }
          : undefined,
      )
    : null;
  return {
    resolution,
    options: buildManagedLlamaCppOptions({ deps, candidate, requestedProvider, resolution }),
  };
}

function resolveSelectedManagedLlamaCpp(input: {
  deps: SetupNimFlowDeps;
  selectedFromInteractiveMenu: boolean;
  selectedRecipeId: string | undefined;
}): ManagedLlamaCppSelectionResult {
  const { deps, selectedFromInteractiveMenu, selectedRecipeId } = input;
  const env =
    selectedFromInteractiveMenu && selectedRecipeId
      ? { ...process.env, [LLAMA_CPP_RECIPE_ENV]: selectedRecipeId }
      : undefined;
  return resolveManagedLlamaCppSafely(deps, env);
}

async function runDedicatedLocalModelProfile(input: {
  deps: SetupNimFlowDeps;
  integration: ReturnType<typeof createLocalModelProfileIntegration>;
  gpu: SetupNimGpu;
  hasVllmImage: boolean;
  vllmProfile: VllmProfile | null;
  vllmRunning: boolean;
  providerMenuOptionCount: number;
  createSelectionState: () => SetupNimSelectionState;
}): Promise<{ state: SetupNimSelectionState | null; providerMenuOptionCount: number }> {
  let plan: LocalModelProfilePlan | null;
  try {
    plan = input.integration.resolvePlan();
  } catch (error) {
    input.deps.abortNonInteractive((error as Error).message);
  }
  if (!plan) return { state: null, providerMenuOptionCount: input.providerMenuOptionCount };
  if (!input.deps.isNonInteractive()) {
    input.deps.abortNonInteractive("The local model profile requires non-interactive onboarding.");
  }
  const state = input.createSelectionState();
  const result = await input.integration.onboard(
    plan,
    {
      hasVllmImage: input.hasVllmImage,
      sparkHost: input.gpu?.platform === "spark" || input.gpu?.spark === true,
      vllmProfile: input.vllmProfile,
      vllmRunning: input.vllmRunning,
    },
    state,
  );
  if (result === "retry-selection") {
    input.deps.abortNonInteractive("The local model profile could not be configured.");
  }
  return { state, providerMenuOptionCount: 0 };
}

async function handleEndpointProviderSelection(input: {
  deps: SetupNimFlowDeps;
  selected: ProviderMenuChoice;
  state: SetupNimSelectionState;
  requestedModel: string | null;
  recoveredFromSandbox: boolean;
  recoveredModel: string | null;
  sandboxName: string | null;
  gatewayName: string | null;
  recoverySessionId: string | null | undefined;
  agent: AgentDefinition | null;
  recoveredRegistryRoute: RegistryInferenceRoute | null;
}): Promise<SetupNimSelectionResult> {
  const {
    deps,
    selected,
    state,
    requestedModel,
    recoveredFromSandbox,
    recoveredModel,
    sandboxName,
    gatewayName,
    recoverySessionId,
    agent,
    recoveredRegistryRoute,
  } = input;
  if (selected.key === "llama-cpp") {
    return deps.handleLlamaCppSelection(
      state,
      requestedModel,
      recoveredFromSandbox ? recoveredModel : null,
    );
  }
  const remoteConfig = deps.remoteProviderConfig[selected.key];
  if (!remoteConfig) throw new Error(`Missing remote provider config for '${selected.key}'.`);
  return deps.handleRemoteProviderSelection(
    {
      selected,
      requestedModel,
      recoveredFromSandbox,
      recoveredModel,
      sandboxName,
      gatewayName,
      recoverySessionId,
      intendedInferenceApi: resolveValidationInferenceApi(
        selected.key,
        remoteConfig.providerName,
        agent,
      ),
    },
    state,
    recoveredRegistryRoute,
  );
}

function vllmPortConflictMessage(
  platform: InferenceProviderHostGpu["platform"],
  port: number,
): string {
  if (platform === "n1x") {
    return `The N1x Deferred preview requires managed vLLM, but vLLM is already running on localhost:${port}. Stop the existing server, then rerun with NEMOCLAW_PROVIDER=install-vllm.`;
  }
  return "vLLM is already running on this host. Select Local vLLM, or stop the existing server before selecting the managed install path.";
}

/**
 * Model a requested serving profile declares, when a vLLM selection can serve it.
 *
 * A preset for another backend reaches this selection through the environment,
 * and no vLLM server can answer it, so it is left out rather than compared.
 */
function requestedVllmServingProfileModel(
  resolve: SetupNimFlowDeps["resolveRequestedServingProfileModel"],
): RequestedServingProfileModel | null {
  const requested = (resolve ?? resolveRequestedServingProfileModel)();
  return requested?.backend === "vllm" ? requested : null;
}

/** Model ID that an explicit managed-vLLM model selection exposes through `/v1/models`. */
function requestedManagedVllmModel(
  resolve: SetupNimFlowDeps["selectVllmModelFromEnv"],
): string | null {
  if (!resolve) throw new Error("Managed vLLM model selection could not be resolved.");
  const requested = resolve();
  return requested?.servedModelId ?? requested?.id ?? null;
}

function resolveInitialVllmSelectionModel(input: {
  preparedState: SetupNimSelectionState | null;
  requestedProvider: string | null;
  requestedModel: string | null;
  recoveredModel: string | null;
  selectVllmModelFromEnv: SetupNimFlowDeps["selectVllmModelFromEnv"];
}): SetupNimSelectionState["model"] {
  return (
    input.preparedState?.model ??
    input.requestedModel ??
    (input.preparedState === null && input.requestedProvider === "install-vllm"
      ? requestedManagedVllmModel(input.selectVllmModelFromEnv)
      : null) ??
    input.recoveredModel
  );
}

async function resolveFreshHermesPortableOllamaSelection(input: {
  deps: SetupNimFlowDeps;
  agent: AgentDefinition | null;
  requestedProvider: string | null;
  requestedModel: string | null;
  recoverProvider: boolean;
  recoveredRegistryRoute: RegistryInferenceRoute | null;
  createSelectionState: () => SetupNimSelectionState;
  inferenceCapabilityCache: OnboardInferenceCapabilityCache;
}): Promise<ProviderSelectionResult | null> {
  if (
    input.agent?.name !== "hermes" ||
    !isPortableExperimentalProfile(process.env) ||
    input.requestedProvider !== "ollama" ||
    input.recoverProvider ||
    input.recoveredRegistryRoute !== null
  ) {
    return null;
  }
  const nonInteractive = input.deps.isNonInteractive();
  let portableModel =
    input.requestedModel ??
    input.deps.getNonInteractiveModel("ollama", { allowProviderModelFallback: false });
  if (!portableModel && !nonInteractive) {
    const promptedModel = await promptManualModelId("  Ollama model id: ", "Ollama", null, {
      promptFn: input.deps.prompt,
      errorLine: input.deps.error,
      writeLine: input.deps.log,
      exitFn: () => input.deps.exitProcess(1),
    });
    if (isBackToSelection(promptedModel)) {
      throw new Error("Hermes Portable Ollama model selection was cancelled.");
    }
    portableModel = promptedModel;
  }
  if (!portableModel) {
    input.deps.abortNonInteractive(
      "Hermes Portable Ollama requires an explicit local model selection.",
    );
  }
  const state = input.createSelectionState();
  state.provider = "ollama-local";
  state.model = portableModel;
  state.endpointUrl = null;
  state.credentialEnv = null;
  state.preferredInferenceApi = "openai-completions";
  state.assertRouteCompatible?.();
  const selectedModel = isBackToSelection(state.model) ? null : state.model;
  await input.deps.maybePromptForInferenceInputCapability(selectedModel);
  return {
    model: selectedModel,
    provider: state.provider,
    endpointUrl: state.endpointUrl,
    endpointSource: null,
    credentialEnv: state.credentialEnv,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: input.deps.resolveAgentInferenceApi(
      input.agent.name,
      state.provider,
      input.deps.coerceAgentInferenceApi(input.agent, state.preferredInferenceApi),
    ),
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
    allowToolsIncompatible: false,
    skipHostInferenceSmoke: false,
    reuseGatewayCredentialWithoutLocalKey: false,
    inferenceCapabilityCache: input.inferenceCapabilityCache,
  };
}

/** Create the provider-selection flow and seed agent-specific Ollama defaults. */
export function createSetupNim(
  defaults: SetupNimFlowDeps,
  overrides: Partial<SetupNimFlowDeps> = {},
): SetupNim {
  const deps: SetupNimFlowDeps = applyVllmInstallResumeDefaults({
    ...defaults,
    ...overrides,
  });
  const localModelProfileIntegration =
    deps.localModelProfileIntegration ?? createLocalModelProfileIntegration(deps);

  return async function setupNimWithDeps(
    gpu: SetupNimGpu,
    sandboxName: string | null = null,
    agent: AgentDefinition | null = null,
    recoverProvider = true,
    rebuildRegistryInferenceRoute: RebuildRouteHandoff | null = null,
    gatewayName: string | null = null,
    assertRouteCompatible?: (
      route: ProviderInferenceProbeRoute,
    ) => GatewayRouteDiscoveryConstraints,
    canProbeRoute?: (provider: string) => boolean,
    recoverySessionId?: string | null,
  ): Promise<ProviderSelectionResult> {
    deps.step(3, 8, "Configuring inference provider");

    let model: string | BaseSetupNimSelectionState["model"] = null;
    let provider = deps.remoteProviderConfig.build.providerName;
    let nimContainer: string | null = null;
    let endpointUrl: string | null = deps.remoteProviderConfig.build.endpointUrl;
    let credentialEnv: string | null = deps.remoteProviderConfig.build.credentialEnv;
    let hermesAuthMethod: HermesAuthMethod | null = null;
    let hermesToolGateways: string[] = [];
    let preferredInferenceApi: string | null = null;
    let compatibleEndpointReasoning: string | null = null;
    let compatibleEndpointReasoningEffort: string | null = null;
    let allowToolsIncompatible = false;
    let reuseGatewayCredential = false;
    let endpointPinnedAddresses: string[] | undefined;
    let endpointTrustedPrivateCapability: TrustedPrivateEndpointCapability | undefined;
    let vllmModelIdentity: string | undefined;
    const inferenceCapabilityCache = new OnboardInferenceCapabilityCache();
    const nvidiaFeaturedModels = deps.createNvidiaFeaturedModelSession({
      defaultModel: resolveAgentDefaultCloudModel(agent),
      writeLine: deps.log,
    });
    const openRouterFeaturedModels = nvidiaFeaturedModels;
    const createSelectionState = (): SetupNimSelectionState => {
      const state: SetupNimSelectionState = {
        model,
        provider,
        endpointUrl,
        credentialEnv,
        hermesAuthMethod,
        hermesToolGateways,
        preferredInferenceApi,
        compatibleEndpointReasoning,
        compatibleEndpointReasoningEffort,
        nimContainer,
        allowToolsIncompatible,
        ollamaContextWindowFloor: getOllamaContextWindowFloorForAgent(agent?.name ?? null),
        ...(endpointPinnedAddresses ? { endpointPinnedAddresses } : {}),
        ...(endpointTrustedPrivateCapability ? { endpointTrustedPrivateCapability } : {}),
        inferenceCapabilityCache,
        nvidiaFeaturedModels,
        openRouterFeaturedModels,
      };
      state.assertRouteCompatible = () => {
        const effectiveInferenceApi = () =>
          deps.resolveAgentInferenceApi(
            agent?.name ?? null,
            state.provider,
            deps.coerceAgentInferenceApi(agent, state.preferredInferenceApi),
          );
        const route = (): ProviderInferenceProbeRoute => ({
          provider: state.provider,
          model: typeof state.model === "string" && state.model.trim() ? state.model.trim() : null,
          endpointUrl: state.endpointUrl,
          preferredInferenceApi: effectiveInferenceApi(),
          credentialEnv: state.credentialEnv,
        });
        const constraints = assertRouteCompatible?.(route()) ?? {
          requiredModel: null,
          requiredEndpointUrl: null,
          requiredInferenceApi: null,
        };
        applyGatewayRouteDiscoveryConstraints(state, constraints);
        assertRouteCompatible?.(route());
        return constraints;
      };
      return state;
    };

    const {
      requestedProvider,
      requestedModel,
      recoveredRegistryRoute,
      recordedProviderReaders,
      probeOllama,
      probeVllm,
    } = prepareProviderDiscovery({
      deps,
      sandboxName,
      recoverProvider,
      rebuildRegistryInferenceRoute,
      assertRouteCompatible,
      canProbeRoute,
      recoverySessionId,
    });
    const freshHermesPortableOllama = await resolveFreshHermesPortableOllamaSelection({
      deps,
      agent,
      requestedProvider,
      requestedModel,
      recoverProvider,
      recoveredRegistryRoute,
      createSelectionState,
      inferenceCapabilityCache,
    });
    if (freshHermesPortableOllama) {
      return freshHermesPortableOllama;
    }
    const providerHostState = deps.detectInferenceProviderHostState({
      gpu,
      experimental: deps.experimental,
      probeOllama,
      probeVllm,
    });
    const {
      hasOllama,
      ollamaHost,
      ollamaRunning,
      isWindowsHostOllama,
      isWsl: isWslHost,
      hasWindowsOllama,
      winOllamaInstalledPath,
      winOllamaLoopbackOnly,
      windowsOllamaReachable,
      windowsHostOllamaDockerRequirement,
      vllmRunning,
      vllmProfile,
      hasVllmImage,
      vllmEntries,
      ollamaInstallMenu,
      gpuNimCapable,
    } = providerHostState;
    const agentProviderOptions = deps.getAgentInferenceProviderOptions(agent);
    const { options: managedLlamaCppOptions } = prepareManagedLlamaCppMenu({
      deps,
      platform: gpu?.platform,
      requestedProvider,
    });

    const blueprintRouterCfg = deps.loadRoutedProfile();
    const { options, hermesProviderAvailable } = buildInferenceProviderMenu({
      remoteProviderConfig: deps.remoteProviderConfig,
      agentProviderOptions,
      experimental: deps.experimental,
      gpuNimCapable,
      nvidiaPlatform: gpu?.platform,
      hasOllama,
      ollamaRunning,
      ollamaHost,
      ollamaPort: deps.ollamaPort,
      isWsl: isWslHost,
      hasWindowsOllama,
      isWindowsHostOllama,
      windowsHostLabelSuffix: windowsHostOllamaDockerRequirement.supported
        ? ""
        : windowsHostOllamaDockerRequirement.labelSuffix,
      windowsHostInstallLabel: windowsHostOllamaDockerRequirement.installLabel,
      windowsHostStartLabel: windowsHostOllamaDockerRequirement.startLabel,
      windowsOllamaReachable,
      winOllamaLoopbackOnly,
      ollamaInstallEntry: ollamaInstallMenu.entry,
      vllmEntries,
      routedEnabled: blueprintRouterCfg?.router?.enabled === true,
      managedLlamaCppOptions,
    });

    function rejectWindowsHostOllama(providerKey: string, windowsHostSelected: boolean): boolean {
      return deps.rejectWindowsHostOllama(
        windowsHostOllamaDockerRequirement,
        providerKey,
        windowsHostSelected,
      );
    }

    let recoveredFromSandbox = false;
    const localModelProfile = await runDedicatedLocalModelProfile({
      deps,
      integration: localModelProfileIntegration,
      gpu,
      hasVllmImage,
      vllmProfile,
      vllmRunning,
      providerMenuOptionCount: options.length,
      createSelectionState,
    });
    const localModelState = localModelProfile.state;
    ({
      model,
      provider,
      endpointUrl,
      credentialEnv,
      preferredInferenceApi,
      nimContainer,
      allowToolsIncompatible,
    } = localModelState ?? {
      model,
      provider,
      endpointUrl,
      credentialEnv,
      preferredInferenceApi,
      nimContainer,
      allowToolsIncompatible,
    });
    vllmModelIdentity = localModelState?.vllmModelIdentity;
    if (localModelProfile.providerMenuOptionCount > 1) {
      selectionLoop: while (true) {
        let selected: ProviderMenuChoice | undefined;
        let selectedFromInteractiveMenu = false;
        recoveredFromSandbox = false;
        let recoveredModel: string | null = null;
        let preparedVllmState: SetupNimSelectionState | null = null;
        hermesAuthMethod = null;

        if (deps.isNonInteractive() || requestedProvider) {
          const providerSelection = resolveRequestedProviderSelection({
            options,
            requestedProvider,
            sandboxName,
            remoteProviderConfig: deps.remoteProviderConfig,
            isWsl: isWslHost,
            isWindowsHostOllama,
            ollamaRunning,
            windowsHostOllamaSupported: windowsHostOllamaDockerRequirement.supported,
            hermesProviderAvailable,
            preferManagedVllmDefault: gpu?.platform === "spark",
            ...recordedProviderReaders,
          });
          if (providerSelection.kind === "failure") {
            reportProviderSelectionFailure({
              reason: providerSelection.reason,
              availableProviderKeys: options.map((option) => option.key),
              isWindowsHostOllama,
              rejectWindowsHostOllama,
              writeError: deps.error,
            });
            deps.exitProcess(1);
          }
          selected = providerSelection.selected;
          recoveredFromSandbox = providerSelection.recoveredFromSandbox;
          recoveredModel = providerSelection.recoveredModel;
          deps.note(
            recoveredFromSandbox
              ? `  [non-interactive] Provider: ${selected.key} (recovered from sandbox '${sandboxName}')`
              : `  [non-interactive] Provider: ${selected.key}`,
          );
        } else {
          selectedFromInteractiveMenu = true;
          selected = await promptForInferenceProviderSelection({
            options,
            vllmRunning,
            ollamaRunning,
            prompt: deps.prompt,
            log: deps.log,
            selectFromNumberedMenu: deps.selectFromNumberedMenu,
          });
        }

        selected = requireSelectedProvider(selected, deps);
        assertVllmGpuProviderSelection(selected, recoveredFromSandbox, deps);
        if (selected.key !== "hermesProvider") {
          hermesAuthMethod = null;
          hermesToolGateways = [];
        }

        if (isEndpointProviderSelection(deps, selected.key)) {
          const state = createSelectionState();
          const result = await handleEndpointProviderSelection({
            deps,
            selected,
            state,
            requestedModel,
            recoveredFromSandbox,
            recoveredModel,
            sandboxName,
            gatewayName,
            recoverySessionId,
            agent,
            recoveredRegistryRoute,
          });
          ({
            model,
            provider,
            endpointUrl,
            credentialEnv,
            hermesAuthMethod,
            hermesToolGateways,
            preferredInferenceApi,
            allowToolsIncompatible,
            endpointPinnedAddresses,
            endpointTrustedPrivateCapability,
          } = state);
          const reasoningState = readSelectionReasoningState(state);
          compatibleEndpointReasoning = reasoningState.reasoning;
          compatibleEndpointReasoningEffort = reasoningState.effort;
          reuseGatewayCredential = state.reuseGatewayCredentialWithoutLocalKey === true;
          if (result === "retry-selection") continue selectionLoop;
          break;
        } else if (selected.key === "install-llama-cpp") {
          if (!sandboxName) {
            const message = "Managed llama.cpp requires a selected sandbox name.";
            deps.error(`  ${message}`);
            if (deps.isNonInteractive()) deps.abortNonInteractive(message);
            continue selectionLoop;
          }
          // Menu discovery is advisory. Re-read the canonical readiness/catalog
          // inputs immediately before any install effect so a delayed interactive
          // choice cannot activate against stale host state.
          const selectedRecipeId = selected.managedLlamaCppRecipeId;
          const resolved = resolveSelectedManagedLlamaCpp({
            deps,
            selectedFromInteractiveMenu,
            selectedRecipeId,
          });
          if (resolved.kind === "rejected") {
            deps.error(`  Managed llama.cpp selection failed: ${resolved.reason}`);
            if (deps.isNonInteractive()) deps.abortNonInteractive(resolved.reason);
            continue selectionLoop;
          }
          const state = createSelectionState();
          state.provider = LLAMA_CPP_PROVIDER_NAME;
          state.model = resolved.selection.recipe.spec.model.servedName;
          state.endpointUrl = LLAMA_CPP_HOST_OPENAI_BASE_URL;
          state.credentialEnv = LLAMA_CPP_CREDENTIAL_ENV;
          state.preferredInferenceApi = "openai-completions";
          state.assertRouteCompatible?.();
          const installed = await (deps.installManagedLlamaCpp ?? installManagedLlamaCpp)(
            resolved.selection,
            {
              sandboxName,
              gatewayPort: deps.getGatewayPort(),
              runtimeProvider: deps.getRuntimeProvider(),
            },
          );
          if (!installed.ok) {
            deps.error(`  Managed llama.cpp install failed: ${installed.reason}`);
            if (deps.isNonInteractive()) deps.abortNonInteractive(installed.reason);
            continue selectionLoop;
          }
          state.model = installed.model;
          const result = await deps.handleLlamaCppSelection(state, installed.model, null);
          ({
            model,
            provider,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
            allowToolsIncompatible,
          } = state);
          if (result === "retry-selection") continue selectionLoop;
          break;
        } else if (selected.key === "nim-local") {
          const state = createSelectionState();
          const result = await deps.handleNimLocalSelection(
            gpu,
            { requestedModel, recoveredFromSandbox, recoveredModel },
            state,
          );
          ({
            model,
            provider,
            endpointUrl,
            credentialEnv,
            hermesAuthMethod,
            hermesToolGateways,
            preferredInferenceApi,
            nimContainer,
          } = state);
          if (result === "retry-selection") continue selectionLoop;
          break;
        } else if (selected.key === "ollama") {
          if (rejectWindowsHostOllama(selected.key, isWindowsHostOllama)) {
            continue selectionLoop;
          }
          const state = createSelectionState();
          const result = await handleSelectedOllama(deps, {
            gpu,
            requestedModel,
            recoveredModel: recoveredFromSandbox ? recoveredModel : null,
            ollamaRunning,
            isWindowsHostOllama,
            state,
            ollamaInstallMenu,
          });
          ({
            model,
            provider,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
            allowToolsIncompatible,
          } = state);
          if (result === "retry-selection") continue selectionLoop;
          break;
        } else if (["start-windows-ollama", "install-windows-ollama"].includes(selected.key)) {
          if (rejectWindowsHostOllama(selected.key, true)) {
            continue selectionLoop;
          }
          const state = createSelectionState();
          const result = await deps.handleWindowsHostOllamaSelection(
            gpu,
            selected.key,
            requestedModel,
            windowsOllamaReachable,
            winOllamaLoopbackOnly,
            winOllamaInstalledPath,
            state,
          );
          ({
            model,
            provider,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
            allowToolsIncompatible,
          } = state);
          if (result === "retry-selection") continue selectionLoop;
          break;
        } else if (selected.key === "install-ollama") {
          const state = createSelectionState();
          const result = await deps.handleInstallOllamaSelection(
            gpu,
            requestedModel,
            recoveredFromSandbox ? recoveredModel : null,
            state,
            ollamaInstallMenu,
          );
          ({
            model,
            provider,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
            allowToolsIncompatible,
          } = state);
          if (result === "retry-selection") continue selectionLoop;
          break;
        } else if (selected.key === "install-vllm") {
          if (!vllmProfile) {
            deps.error("  No vLLM install profile available for this host.");
            if (deps.isNonInteractive()) deps.exitProcess(1);
            continue selectionLoop;
          }
          if (vllmRunning) {
            const message = vllmPortConflictMessage(gpu?.platform, deps.vllmPort);
            deps.error(`  ${message}`);
            if (deps.isNonInteractive()) {
              deps.abortNonInteractive(message);
            }
            continue selectionLoop;
          }
          const vllmState = createSelectionState();
          preparedVllmState = vllmState;
          const result = await deps.installVllm(vllmProfile, {
            hasImage: hasVllmImage,
            nonInteractive: deps.isNonInteractive(),
            promptFn: deps.prompt,
            ...vllmInstallRecoveryOptions(deps),
            beforeInstall: (modelId) => {
              vllmState.provider = "vllm-local";
              vllmState.model = modelId;
              vllmState.endpointUrl = null;
              vllmState.credentialEnv = null;
              vllmState.preferredInferenceApi = "openai-completions";
              vllmState.assertRouteCompatible?.();
            },
          });
          if (!result.ok) {
            if (deps.isNonInteractive())
              deps.abortNonInteractive("vLLM install failed. See errors above.");
            continue selectionLoop;
          }
          selected = {
            key: "vllm",
            label: `Local vLLM (localhost:${deps.vllmPort}) — running`,
          };
        }
        if (selected.key === "vllm") {
          const state = preparedVllmState ?? createSelectionState();
          state.model = resolveInitialVllmSelectionModel({
            preparedState: preparedVllmState,
            requestedProvider,
            requestedModel,
            recoveredModel,
            selectVllmModelFromEnv: deps.selectVllmModelFromEnv,
          });
          // A requested profile reaches this branch two ways: its own install
          // finished, or `install-vllm` collapsed onto a server that was already
          // listening. The second path runs no install, so nothing seeds a
          // required model and the endpoint's own report becomes the route.
          // Comparing the profile's model is the only check that the server
          // serves what the profile declares.
          const result = await deps.handleVllmSelection(state, {
            managedInstall: preparedVllmState !== null,
            sparkHost: gpu?.spark === true,
            servingProfileModel: requestedVllmServingProfileModel(
              deps.resolveRequestedServingProfileModel,
            ),
          });
          ({
            model,
            provider,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
            nimContainer,
            allowToolsIncompatible,
          } = state);
          vllmModelIdentity = state.vllmModelIdentity;
          if (result === "retry-selection") continue selectionLoop;
          break;
        } else if (selected.key === "routed") {
          const state = createSelectionState();
          const result = await deps.handleRoutedSelection(state);
          ({
            model,
            provider,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
            nimContainer,
            allowToolsIncompatible,
          } = state);
          if (result === "retry-selection") continue selectionLoop;
          break;
        }
      }
    }

    compatibleEndpointReasoning = clearReasoningUnlessCompatible(
      provider,
      compatibleEndpointReasoning,
      deps,
    );
    compatibleEndpointReasoningEffort = clearReasoningEffortUnlessCompatible(
      provider,
      compatibleEndpointReasoningEffort,
      deps,
    );
    const selectedModel = isBackToSelection(model) ? null : model;
    const recoveredRegistryRouteMatches =
      recoveredRegistryRoute?.provider === provider &&
      recoveredRegistryRoute.endpointUrl === endpointUrl;
    const endpointSource = recoveredRegistryRouteMatches
      ? (recoveredRegistryRoute.endpointSource ?? null)
      : endpointPinnedAddresses || endpointTrustedPrivateCapability
        ? "onboard"
        : null;
    await deps.maybePromptForInferenceInputCapability(selectedModel);
    return {
      model: selectedModel,
      provider,
      endpointUrl,
      endpointSource,
      credentialEnv,
      hermesAuthMethod,
      hermesToolGateways,
      preferredInferenceApi: deps.resolveAgentInferenceApi(
        agent?.name ?? null,
        provider,
        deps.coerceAgentInferenceApi(agent, preferredInferenceApi),
      ),
      compatibleEndpointReasoning,
      compatibleEndpointReasoningEffort,
      nimContainer,
      allowToolsIncompatible,
      skipHostInferenceSmoke: reuseGatewayCredential,
      reuseGatewayCredentialWithoutLocalKey: reuseGatewayCredential,
      ...(recoveredFromSandbox ? { recoveredFromSandbox: true } : {}),
      ...(endpointPinnedAddresses ? { endpointPinnedAddresses } : {}),
      ...(endpointTrustedPrivateCapability ? { endpointTrustedPrivateCapability } : {}),
      ...(provider === "vllm-local" && vllmModelIdentity ? { vllmModelIdentity } : {}),
      inferenceCapabilityCache,
    };
  };
}

/**
 * Bind the serving-port probe to the vLLM installer (#8685).
 *
 * The installer declares the probe it needs instead of importing the preflight
 * layer, because `src/lib/inference/vllm.ts` sits at its recorded fan-out
 * budget. The wiring lives here rather than in `onboard.ts`, which the codebase
 * growth guardrail keeps net-neutral.
 */
export function withServingPortGuard<
  Options,
  Install extends (
    profile: VllmProfile,
    options: Options & {
      checkServingPort?: (port: number) => Promise<{ ok: boolean; reason?: string }>;
    },
  ) => Promise<{ ok: boolean }>,
>(
  install: Install,
  checkServingPort: (port: number) => Promise<{ ok: boolean; reason?: string }>,
): (profile: VllmProfile, options: Options) => Promise<{ ok: boolean }> {
  return (profile, options) => install(profile, { ...options, checkServingPort });
}
