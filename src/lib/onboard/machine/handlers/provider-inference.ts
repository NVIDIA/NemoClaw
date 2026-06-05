// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../../../inference/web-search";
import type { Session, SessionUpdates } from "../../../state/onboard-session";
import { withInferenceTrace, withProviderSelectionTrace } from "../../tracing";
import { advanceTo, type OnboardStateTransitionResult, retryTo } from "../result";

export type ProviderInferenceRetry = { retry: "selection" } | { ok: true; retry?: undefined };

export interface ProviderSelectionResult {
  model: string | null;
  provider: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: string | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  allowToolsIncompatible?: boolean;
}

export interface ProviderInferenceStateOptions<Gpu, Agent, Host> {
  resume: boolean;
  session: Session | null;
  gpu: Gpu;
  sandboxName: string | null;
  agent: Agent;
  forceProviderSelection?: boolean;
  initial: {
    model: string | null;
    provider: string | null;
    endpointUrl: string | null;
    credentialEnv: string | null;
    hermesAuthMethod: string | null;
    hermesToolGateways: string[];
    preferredInferenceApi: string | null;
    nimContainer: string | null;
    webSearchConfig: WebSearchConfig | null;
  };
  selectedMessagingChannels: string[];
  env: NodeJS.ProcessEnv;
  constants: {
    hermesProviderName: string;
    hermesApiKeyAuthMethod: string;
    hermesApiKeyCredentialEnv: string;
  };
  deps: {
    normalizeHermesAuthMethod(value: string | null | undefined): string | null;
    setupNim(gpu: Gpu, sandboxName: string | null, agent: Agent): Promise<ProviderSelectionResult>;
    setupInference(
      sandboxName: string | null,
      model: string,
      provider: string,
      endpointUrl: string | null,
      credentialEnv: string | null,
      hermesAuthMethod: string | null,
      hermesToolGateways: string[],
      options?: { allowToolsIncompatible?: boolean },
    ): Promise<ProviderInferenceRetry>;
    startRecordedStep(
      stepName: string,
      updates?: { provider?: string | null; model?: string | null },
    ): Promise<void>;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    ensureResumeProviderReady(
      provider: string | null | undefined,
      credentialEnv: string | null | undefined,
    ): Promise<{ forceInferenceSetup: boolean; credentialEnv: string | null }>;
    recordStateSkipped(
      state: "provider_selection" | "inference",
      metadata?: Record<string, unknown> | null,
    ): Promise<Session>;
    recordRepairEvent(
      type: "state.repair.started" | "state.repair.completed" | "state.repair.failed",
      options?: { state?: "provider_selection" | "inference"; error?: string | null; metadata?: Record<string, unknown> | null },
    ): Promise<Session>;
    hydrateCredentialEnv(credentialEnv: string | null): void;
    repairLocalInferenceSystemdOverrideOrExit(provider: string | null, isNonInteractive: () => boolean): void;
    isNonInteractive(): boolean;
    getOpenshellBinary(): string;
    needsBedrockRuntimeAdapter(provider: string, endpointUrl: string | null): boolean;
    isInferenceRouteReady(provider: string, model: string): boolean;
    isRoutedInferenceProvider(provider: string): boolean;
    reconcileModelRouter(): Promise<void>;
    reupsertRoutedProvider(
      provider: string,
      endpointUrl: string | null,
      credentialEnv: string | null,
    ): { ok: boolean; endpointUrl: string; message?: string; status?: number };
    registryUpdateSandbox(sandboxName: string, updates: { nimContainer?: string | null }): void;
    promptValidatedSandboxName(agent: Agent): Promise<string>;
    assessHost(): Host;
    formatSandboxBuildEstimateNote(host: Host): string | null;
    formatOnboardConfigSummary(options: {
      provider: string;
      model: string;
      credentialEnv: string | null;
      hermesAuthMethod: string | null;
      webSearchConfig: WebSearchConfig | null;
      hermesToolGateways: string[];
      enabledChannels: string[] | null;
      sandboxName: string;
      notes: string[];
    }): string;
    promptYesNoOrDefault(question: string, envVar: string | null, defaultIsYes: boolean): Promise<boolean>;
    cliName(): string;
    log(message?: string): void;
    error(message?: string): void;
    exitProcess(code: number): never;
    deleteEnv(name: string): void;
  };
}

export interface ProviderInferenceStateResult {
  sandboxName: string | null;
  model: string;
  provider: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: string | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  webSearchConfig: WebSearchConfig | null;
  session: Session | null;
  stateResult: OnboardStateTransitionResult;
  stateResults: OnboardStateTransitionResult[];
  retryStateResults: OnboardStateTransitionResult[];
}

function requireSelection(
  provider: string | null,
  model: string | null,
  deps: Pick<ProviderInferenceStateOptions<unknown, unknown, unknown>["deps"], "error" | "exitProcess">,
): { provider: string; model: string } {
  if (typeof provider !== "string" || typeof model !== "string") {
    deps.error("  Inference selection did not yield a provider/model.");
    deps.exitProcess(1);
  }
  return { provider, model };
}

function clearStagedCredentialEnv(
  deps: Pick<ProviderInferenceStateOptions<unknown, unknown, unknown>["deps"], "deleteEnv">,
  credentialEnv: string | null,
): void {
  if (credentialEnv) deps.deleteEnv(credentialEnv);
}

export async function handleProviderInferenceState<Gpu, Agent, Host>({
  resume,
  session,
  gpu,
  sandboxName,
  agent,
  forceProviderSelection: initialForceProviderSelection = false,
  initial,
  selectedMessagingChannels,
  env,
  constants,
  deps,
}: ProviderInferenceStateOptions<Gpu, Agent, Host>): Promise<ProviderInferenceStateResult> {
  let model = initial.model;
  let provider = initial.provider;
  let endpointUrl = initial.endpointUrl;
  let credentialEnv = initial.credentialEnv;
  let hermesAuthMethod =
    deps.normalizeHermesAuthMethod(initial.hermesAuthMethod) ||
    (provider === constants.hermesProviderName && credentialEnv === constants.hermesApiKeyCredentialEnv
      ? constants.hermesApiKeyAuthMethod
      : null);
  let hermesToolGateways = initial.hermesToolGateways;
  let preferredInferenceApi = initial.preferredInferenceApi;
  let nimContainer = initial.nimContainer;
  const webSearchConfig = initial.webSearchConfig;
  let forceProviderSelection = initialForceProviderSelection;
  let allowToolsIncompatible = false;
  const stateResults: OnboardStateTransitionResult[] = [];
  const retryStateResults: OnboardStateTransitionResult[] = [];

  while (true) {
    let forceInferenceSetup = false;
    const resumeProviderSelection =
      !forceProviderSelection &&
      resume &&
      session?.steps?.provider_selection?.status === "complete" &&
      typeof provider === "string" &&
      typeof model === "string";
    let shouldRecordProviderSelection = false;
    if (resumeProviderSelection) {
      const recovery = await deps.ensureResumeProviderReady(provider, credentialEnv);
      forceInferenceSetup = recovery.forceInferenceSetup;
      credentialEnv = recovery.credentialEnv;
      deps.skippedStepMessage("provider_selection", `${provider} / ${model}`);
      await deps.recordStateSkipped("provider_selection", {
        reason: "resume",
        provider,
        model,
      });
      deps.hydrateCredentialEnv(credentialEnv);
      if (provider === "ollama-local") {
        const repairMetadata = { repair: "ollama-systemd-loopback" };
        await deps.recordRepairEvent("state.repair.started", {
          state: "provider_selection",
          metadata: repairMetadata,
        });
        try {
          deps.repairLocalInferenceSystemdOverrideOrExit(provider, deps.isNonInteractive);
        } catch (err) {
          await deps.recordRepairEvent("state.repair.failed", {
            state: "provider_selection",
            error: err instanceof Error ? err.message : String(err),
            metadata: repairMetadata,
          });
          throw err;
        }
        await deps.recordRepairEvent("state.repair.completed", {
          state: "provider_selection",
          metadata: repairMetadata,
        });
      } else {
        deps.repairLocalInferenceSystemdOverrideOrExit(provider, deps.isNonInteractive);
      }
    } else {
      await deps.startRecordedStep("provider_selection");
      const selection = await withProviderSelectionTrace(
        sandboxName,
        (agent as { name?: string } | null)?.name,
        () => deps.setupNim(gpu, sandboxName, agent),
      );
      model = selection.model;
      provider = selection.provider;
      endpointUrl = selection.endpointUrl;
      credentialEnv = selection.credentialEnv;
      hermesAuthMethod = selection.hermesAuthMethod;
      hermesToolGateways = selection.hermesToolGateways;
      preferredInferenceApi = selection.preferredInferenceApi;
      nimContainer = selection.nimContainer;
      allowToolsIncompatible = selection.allowToolsIncompatible === true;
      shouldRecordProviderSelection = true;
    }

    const selected = requireSelection(provider, model, deps);
    const selectedProvider = selected.provider;
    const selectedModel = selected.model;
    provider = selectedProvider;
    model = selectedModel;
    if (shouldRecordProviderSelection) {
      session = await deps.recordStepComplete(
        "provider_selection",
        deps.toSessionUpdates({
          provider,
          model,
          endpointUrl,
          credentialEnv,
          hermesAuthMethod,
          hermesToolGateways,
          preferredInferenceApi,
          nimContainer,
        }),
      );
    }
    stateResults.push(
      advanceTo("inference", {
        metadata: { state: "provider_selection", provider, model },
      }),
    );
    env.NEMOCLAW_OPENSHELL_BIN = deps.getOpenshellBinary();
    const needsBedrockRuntimeAdapter = deps.needsBedrockRuntimeAdapter(provider, endpointUrl);
    const resumeInference =
      !needsBedrockRuntimeAdapter &&
      !forceProviderSelection &&
      !forceInferenceSetup &&
      resume &&
      deps.isInferenceRouteReady(provider, model);
    if (resumeInference) {
      if (provider === constants.hermesProviderName) {
        let inferenceResult: ProviderInferenceRetry;
        try {
          if (!sandboxName) sandboxName = await deps.promptValidatedSandboxName(agent);
          const confirmedSandboxName = sandboxName;
          await deps.startRecordedStep("inference", { provider, model });
          inferenceResult = await withInferenceTrace(
            confirmedSandboxName,
            selectedProvider,
            selectedModel,
            credentialEnv,
            () =>
              deps.setupInference(
                confirmedSandboxName,
                selectedModel,
                selectedProvider,
                endpointUrl,
                credentialEnv,
                hermesAuthMethod,
                hermesToolGateways,
                { allowToolsIncompatible },
              ),
          );
        } finally {
          clearStagedCredentialEnv(deps, credentialEnv);
        }
        if (inferenceResult?.retry === "selection") {
          const retryStateResult = retryTo("provider_selection", {
            metadata: { state: "inference", provider, model, reason: "selection_retry" },
          });
          retryStateResults.push(retryStateResult);
          stateResults.push(retryStateResult);
          forceProviderSelection = true;
          continue;
        }
        session = await deps.recordStepComplete(
          "inference",
          deps.toSessionUpdates({ provider, model, hermesAuthMethod, nimContainer, hermesToolGateways }),
        );
        break;
      }
      if (deps.isRoutedInferenceProvider(provider)) {
        try {
          await deps.reconcileModelRouter();
        } catch (err) {
          deps.error(`  ✗ Failed to reconcile model router: ${err instanceof Error ? err.message : String(err)}`);
          deps.exitProcess(1);
        }
        // #4564: re-upsert the gateway provider with the sandbox-facing
        // endpoint so a stale localhost base URL recorded by an earlier run is
        // repaired on resume instead of surviving and breaking inference.local.
        const reupserted = deps.reupsertRoutedProvider(provider, endpointUrl, credentialEnv);
        if (!reupserted.ok) {
          deps.error(`  ${reupserted.message ?? "Failed to update the routed inference provider."}`);
          deps.exitProcess(reupserted.status ?? 1);
        }
        endpointUrl = reupserted.endpointUrl;
      }
      deps.skippedStepMessage("inference", `${provider} / ${model}`);
      await deps.recordStateSkipped("inference", {
        reason: "resume",
        provider,
        model,
      });
      if (nimContainer && sandboxName) deps.registryUpdateSandbox(sandboxName, { nimContainer });
      session = await deps.recordStepComplete(
        "inference",
        deps.toSessionUpdates({ provider, model, hermesAuthMethod, nimContainer, hermesToolGateways }),
      );
      break;
    }

    let inferenceResult: ProviderInferenceRetry;
    try {
      if (!sandboxName) sandboxName = await deps.promptValidatedSandboxName(agent);
      const confirmedSandboxName = sandboxName;
      const buildEstimateNote =
        env.NEMOCLAW_IGNORE_RUNTIME_RESOURCES === "1"
          ? null
          : deps.formatSandboxBuildEstimateNote(deps.assessHost());
      deps.log(
        deps.formatOnboardConfigSummary({
          provider,
          model,
          credentialEnv,
          hermesAuthMethod,
          webSearchConfig,
          hermesToolGateways,
          enabledChannels: selectedMessagingChannels.length > 0 ? selectedMessagingChannels : null,
          sandboxName: confirmedSandboxName,
          notes: buildEstimateNote ? [buildEstimateNote] : [],
        }),
      );
      deps.log("  Web search and messaging channels will be prompted next.");
      if (!deps.isNonInteractive()) {
        if (!(await deps.promptYesNoOrDefault("  Apply this configuration?", null, true))) {
          deps.log(`  Aborted. Re-run \`${deps.cliName()} onboard\` to start over.`);
          deps.log("  Credentials entered so far were only staged in memory for this run.");
          deps.log("  No new gateway credential was registered because onboarding stopped here.");
          deps.exitProcess(0);
        }
      }

      await deps.startRecordedStep("inference", { provider, model });
      inferenceResult = await withInferenceTrace(
        confirmedSandboxName,
        selectedProvider,
        selectedModel,
        credentialEnv,
        () =>
          deps.setupInference(
            confirmedSandboxName,
            selectedModel,
            selectedProvider,
            endpointUrl,
            credentialEnv,
            hermesAuthMethod,
            hermesToolGateways,
            { allowToolsIncompatible },
          ),
      );
    } finally {
      clearStagedCredentialEnv(deps, credentialEnv);
    }
    if (inferenceResult?.retry === "selection") {
      const retryStateResult = retryTo("provider_selection", {
        metadata: { state: "inference", provider, model, reason: "selection_retry" },
      });
      retryStateResults.push(retryStateResult);
      stateResults.push(retryStateResult);
      forceProviderSelection = true;
      continue;
    }
    if (nimContainer && sandboxName) deps.registryUpdateSandbox(sandboxName, { nimContainer });
    session = await deps.recordStepComplete(
      "inference",
      deps.toSessionUpdates({ provider, model, hermesAuthMethod, nimContainer, hermesToolGateways }),
    );
    break;
  }

  const stateResult = advanceTo("sandbox", {
    metadata: { state: "inference", provider, model },
  });
  stateResults.push(stateResult);

  return {
    sandboxName,
    model,
    provider,
    endpointUrl,
    credentialEnv,
    hermesAuthMethod,
    hermesToolGateways,
    preferredInferenceApi,
    nimContainer,
    webSearchConfig,
    session,
    stateResult,
    stateResults,
    retryStateResults,
  };
}
