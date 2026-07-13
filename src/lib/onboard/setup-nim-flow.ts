// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import {
  resolveAgentDefaultCloudModel,
  resolveAgentProviderInferenceApi,
} from "../inference/config";
import type { GatewayRouteDiscoveryConstraints } from "../inference/gateway-route-compatibility";
import type { VllmProfile } from "../inference/vllm";
import { isBackToSelection } from "../navigation";
import type { HermesAuthMethod } from "./hermes-auth";
import { OnboardInferenceCapabilityCache } from "./inference-capability-cache";
import type { ProviderSelectionResult } from "./machine/handlers/provider-inference";
import type { ProviderInferenceProbeRoute } from "./machine/handlers/provider-inference-route-containment";
import type {
  NvidiaFeaturedModelSession,
  NvidiaFeaturedModelSessionOptions,
} from "./nvidia-featured-model-selection";
import type { InferenceProviderHostGpu, InferenceProviderHostState } from "./provider-host-state";
import { buildInferenceProviderMenu, type ProviderMenuChoice } from "./provider-menu";
import { resolveRequestedProviderSelection } from "./provider-selection";
import { reportProviderSelectionFailure } from "./provider-selection-failure";
import { promptForInferenceProviderSelection } from "./provider-selection-prompt";
import type { RebuildRouteHandoff, RegistryInferenceRoute } from "./rebuild-route-handoff";
import { prepareProviderDiscovery } from "./setup-nim-provider-discovery";
import type { SetupNimSelectionState as BaseSetupNimSelectionState } from "./setup-nim-selection";

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
  step(current: number, total: number, label: string): void;
  isNonInteractive(): boolean;
  getNonInteractiveProvider(): string | null;
  getNonInteractiveModel(providerKey: string): string | null;
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
  handleRemoteProviderSelection(
    args: SetupNimRemoteSelectionArgs,
    state: SetupNimSelectionState,
    recoveredRegistryRoute: RegistryInferenceRoute | null,
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
    },
  ): Promise<{ ok: boolean }>;
  handleVllmSelection(state: SetupNimSelectionState): Promise<SetupNimSelectionResult>;
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

export function createSetupNim(
  defaults: SetupNimFlowDeps,
  overrides: Partial<SetupNimFlowDeps> = {},
): SetupNim {
  const deps: SetupNimFlowDeps = { ...defaults, ...overrides };

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
    let allowToolsIncompatible = false;
    let reuseGatewayCredential = false;
    let endpointPinnedAddresses: string[] | undefined;
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
        nimContainer,
        allowToolsIncompatible,
        ...(endpointPinnedAddresses ? { endpointPinnedAddresses } : {}),
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

    const blueprintRouterCfg = deps.loadRoutedProfile();
    const { options, hermesProviderAvailable } = buildInferenceProviderMenu({
      remoteProviderConfig: deps.remoteProviderConfig,
      agentProviderOptions,
      experimental: deps.experimental,
      gpuNimCapable,
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
    });

    function rejectWindowsHostOllama(providerKey: string, windowsHostSelected: boolean): boolean {
      return deps.rejectWindowsHostOllama(
        windowsHostOllamaDockerRequirement,
        providerKey,
        windowsHostSelected,
      );
    }

    let recoveredFromSandbox = false;
    if (options.length > 1) {
      selectionLoop: while (true) {
        let selected: ProviderMenuChoice | undefined;
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
            windowsHostOllamaSupported: windowsHostOllamaDockerRequirement.supported,
            hermesProviderAvailable,
            ...recordedProviderReaders,
          });
          if (providerSelection.kind === "failure") {
            reportProviderSelectionFailure({
              reason: providerSelection.reason,
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
        if (selected.key !== "hermesProvider") {
          hermesAuthMethod = null;
          hermesToolGateways = [];
        }

        if (deps.remoteProviderConfig[selected.key]) {
          const state = createSelectionState();
          const result = await deps.handleRemoteProviderSelection(
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
                deps.remoteProviderConfig[selected.key].providerName,
                agent,
              ),
            },
            state,
            recoveredRegistryRoute,
          );
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
          } = state);
          compatibleEndpointReasoning = state.compatibleEndpointReasoning ?? null;
          reuseGatewayCredential = state.reuseGatewayCredentialWithoutLocalKey === true;
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
          const result = await deps.handleRunningOllamaSelection(
            gpu,
            requestedModel,
            recoveredFromSandbox ? recoveredModel : null,
            ollamaRunning,
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
          const vllmState = createSelectionState();
          preparedVllmState = vllmState;
          const result = await deps.installVllm(vllmProfile, {
            hasImage: hasVllmImage,
            nonInteractive: deps.isNonInteractive(),
            promptFn: deps.prompt,
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
          state.model = preparedVllmState?.model ?? requestedModel ?? recoveredModel;
          const result = await deps.handleVllmSelection(state);
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
    const selectedModel = isBackToSelection(model) ? null : model;
    await deps.maybePromptForInferenceInputCapability(selectedModel);
    return {
      model: selectedModel,
      provider,
      endpointUrl,
      credentialEnv,
      hermesAuthMethod,
      hermesToolGateways,
      preferredInferenceApi: deps.resolveAgentInferenceApi(
        agent?.name ?? null,
        provider,
        deps.coerceAgentInferenceApi(agent, preferredInferenceApi),
      ),
      compatibleEndpointReasoning,
      nimContainer,
      allowToolsIncompatible,
      skipHostInferenceSmoke: reuseGatewayCredential,
      reuseGatewayCredentialWithoutLocalKey: reuseGatewayCredential,
      ...(recoveredFromSandbox ? { recoveredFromSandbox: true } : {}),
      ...(endpointPinnedAddresses ? { endpointPinnedAddresses } : {}),
      inferenceCapabilityCache,
    };
  };
}
