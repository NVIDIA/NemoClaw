// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { clearAutoDetectedCompatibleContextWindow } from "../../../inference/compatible-endpoint-context";
import { resolveAgentProviderInferenceApi } from "../../../inference/config";
import {
  type CurrentGatewayRouteCompatibilityCheck,
  type CurrentGatewayRouteDiscoveryPreflight,
  type GatewayRouteDiscoveryConstraints,
  isAdvisoryGatewayRouteConflict,
} from "../../../inference/gateway-route-compatibility";
import type { WebSearchConfig } from "../../../inference/web-search";
import type { HermesAuthMethod, Session, SessionUpdates } from "../../../state/onboard-session";
import type { OnboardInferenceCapabilityCache } from "../../inference-capability-cache";
import type {
  createProviderRecoveryReceiptLedger,
  ProviderRecoveryReceipt,
} from "../../rebuild-route-handoff";
import { withInferenceTrace, withProviderSelectionTrace } from "../../tracing";
import { advanceTo, type OnboardStateTransitionResult, retryTo } from "../result";
import { createRecovery, type RecoveryAuthority } from "./provider-inference-recovery";
import {
  assertProviderInferenceRouteCompatible,
  guardProviderInferenceRouteSelection,
  type ProviderInferenceProbeRoute,
} from "./provider-inference-route-containment";

export type ProviderInferenceRetry = { retry: "selection" } | { ok: true; retry?: undefined };

export interface ProviderInferenceSetupOptions {
  gatewayName?: string;
  allowToolsIncompatible?: boolean;
  skipHostInferenceSmoke?: boolean;
  reuseGatewayCredentialWithoutLocalKey?: boolean;
  /**
   * Resolved (agent-coerced) inference API for the selection. Lets the
   * remote-provider registration pick the gateway surface that matches the
   * sandbox contract (#6294: openai_compatible agents on
   * compatible-anthropic-endpoint register type=openai).
   */
  preferredInferenceApi?: string | null;
  /** Public addresses approved for custom endpoint host probes. */
  endpointPinnedAddresses?: readonly string[];
  /** One-shot host capability cache carried only through this onboarding run. */
  inferenceCapabilityCache?: OnboardInferenceCapabilityCache;
  /** Onboard session that owns the route reservation this setup creates. */
  reservationSessionId?: string;
  /** Recheck recorded-route ownership after acquiring route mutation locks. */
  isRecordedProviderRecoveryAuthorized?: () => boolean;
}

export interface ProviderSelectionResult {
  model: string | null;
  provider: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: HermesAuthMethod | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: string | null;
  nimContainer: string | null;
  allowToolsIncompatible?: boolean;
  skipHostInferenceSmoke?: boolean;
  reuseGatewayCredentialWithoutLocalKey?: boolean;
  recoveredFromSandbox?: boolean;
  endpointPinnedAddresses?: string[];
  inferenceCapabilityCache?: OnboardInferenceCapabilityCache;
}

export interface ProviderInferenceStateOptions<Gpu, Agent, Host> {
  gatewayName: string;
  resume: boolean;
  fresh: boolean;
  session: Session | null;
  gpu: Gpu;
  sandboxName: string | null;
  agent: Agent;
  forceProviderSelection?: boolean;
  /** Force setup for a provider that authoritative rebuild preflight observed missing. */
  forceInferenceSetup?: boolean;
  /** Trust the rebuild-preflighted session selection even if its old step marker is incomplete. */
  authoritativeResumeConfig?: boolean;
  /** One-shot authority, activated at selection, to recover a recorded provider during rebuild. */
  providerRecoveryReceipt?: ProviderRecoveryReceipt | null;
  providerRecoveryReceiptLedger?: ReturnType<typeof createProviderRecoveryReceiptLedger>;
  initial: {
    model: string | null;
    provider: string | null;
    endpointUrl: string | null;
    credentialEnv: string | null;
    hermesAuthMethod: HermesAuthMethod | null;
    hermesToolGateways: string[];
    preferredInferenceApi: string | null;
    compatibleEndpointReasoning: string | null;
    nimContainer: string | null;
    webSearchConfig: WebSearchConfig | null;
  };
  selectedMessagingChannels: string[];
  env: NodeJS.ProcessEnv;
  constants: {
    hermesProviderName: string;
    hermesApiKeyAuthMethod: HermesAuthMethod;
    hermesApiKeyCredentialEnv: string;
  };
  deps: {
    checkGatewayRouteCompatibility: CurrentGatewayRouteCompatibilityCheck;
    preflightGatewayRouteDiscovery: CurrentGatewayRouteDiscoveryPreflight;
    getSandboxRecoveryAuthority(
      sandboxName: string,
      sessionId: string | null | undefined,
    ): RecoveryAuthority;
    withGatewayRouteMutationLock<T>(
      gatewayName: string,
      operation: () => Promise<T> | T,
    ): Promise<T>;
    normalizeHermesAuthMethod(value: string | null | undefined): HermesAuthMethod | null;
    setupNim(
      gpu: Gpu,
      sandboxName: string | null,
      agent: Agent,
      allowRecordedProviderRecovery?: boolean,
      gatewayName?: string,
      assertRouteCompatible?: (
        route: ProviderInferenceProbeRoute,
      ) => GatewayRouteDiscoveryConstraints,
      canProbeRoute?: (provider: string) => boolean,
      recoverySessionId?: string | null,
    ): Promise<ProviderSelectionResult>;
    setupInference(
      sandboxName: string | null,
      model: string,
      provider: string,
      endpointUrl: string | null,
      credentialEnv: string | null,
      hermesAuthMethod: HermesAuthMethod | null,
      hermesToolGateways: string[],
      options?: ProviderInferenceSetupOptions,
    ): Promise<ProviderInferenceRetry>;
    startRecordedStep(
      stepName: string,
      updates?: { provider?: string | null; model?: string | null },
    ): Promise<void>;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    ensureResumeProviderReady(
      gatewayName: string,
      provider: string | null | undefined,
      credentialEnv: string | null | undefined,
    ): Promise<{ forceInferenceSetup: boolean; credentialEnv: string | null }>;
    isResumeProviderSurfaceReady(
      gatewayName: string,
      provider: string | null | undefined,
      preferredInferenceApi: string | null | undefined,
      credentialEnv: string | null | undefined,
      endpointUrl: string | null | undefined,
    ): boolean;
    recordStateSkipped(
      state: "provider_selection" | "inference",
      metadata?: Record<string, unknown> | null,
    ): Promise<Session>;
    recordRepairEvent(
      type: "state.repair.started" | "state.repair.completed" | "state.repair.failed",
      options?: {
        state?: "provider_selection" | "inference";
        error?: string | null;
        metadata?: Record<string, unknown> | null;
      },
    ): Promise<Session>;
    hydrateCredentialEnv(credentialEnv: string | null): string | null | undefined;
    configureCompatibleEndpointReasoning(storedValue?: string | null): Promise<"true" | "false">;
    clearCompatibleEndpointReasoning(): null;
    repairLocalInferenceSystemdOverrideOrExit(
      provider: string | null,
      isNonInteractive: () => boolean,
    ): void;
    isNonInteractive(): boolean;
    getOpenshellBinary(): string;
    needsBedrockRuntimeAdapter(provider: string, endpointUrl: string | null): boolean;
    isInferenceRouteReady(gatewayName: string, provider: string, model: string): boolean;
    isRoutedInferenceProvider(provider: string): boolean;
    reconcileModelRouter(): Promise<void>;
    reupsertRoutedProvider(
      gatewayName: string,
      provider: string,
      endpointUrl: string | null,
      credentialEnv: string | null,
    ): { ok: boolean; endpointUrl: string; message?: string; status?: number };
    reserveSandboxInferenceRoute(
      sandboxName: string,
      route: {
        provider: string;
        model: string;
        endpointUrl: string | null;
        credentialEnv: string | null;
        preferredInferenceApi: string | null;
        gatewayName: string;
        reservationSessionId?: string;
      },
    ): boolean;
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
    promptYesNoOrDefault(
      question: string,
      envVar: string | null,
      defaultIsYes: boolean,
    ): Promise<boolean>;
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
  hermesAuthMethod: HermesAuthMethod | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: string | null;
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
  deps: Pick<
    ProviderInferenceStateOptions<unknown, unknown, unknown>["deps"],
    "error" | "exitProcess"
  >,
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

function agentName(agent: unknown): string {
  const name = (agent as { name?: string | null } | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : "openclaw";
}

function hasActiveMessagingChannels(
  selectedMessagingChannels: string[],
  session: Session | null,
): boolean {
  if (selectedMessagingChannels.length > 0) return true;
  const channels = session?.messagingPlan?.channels;
  return Boolean(
    Array.isArray(channels) &&
      channels.some((channel) => channel.active === true && channel.disabled !== true),
  );
}

function shouldRefreshCompatibleEndpointRouteForMessaging(
  provider: string | null,
  selectedMessagingChannels: string[],
  session: Session | null,
  agent: unknown,
): boolean {
  return (
    provider === "compatible-endpoint" &&
    agentName(agent) === "openclaw" &&
    hasActiveMessagingChannels(selectedMessagingChannels, session)
  );
}

export async function handleProviderInferenceState<Gpu, Agent, Host>({
  gatewayName,
  resume,
  fresh,
  session,
  gpu,
  sandboxName,
  agent,
  forceProviderSelection: initialForceProviderSelection = false,
  forceInferenceSetup: initialForceInferenceSetup = false,
  authoritativeResumeConfig = false,
  providerRecoveryReceipt = null,
  providerRecoveryReceiptLedger,
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
    (provider === constants.hermesProviderName &&
    credentialEnv === constants.hermesApiKeyCredentialEnv
      ? constants.hermesApiKeyAuthMethod
      : null);
  let hermesToolGateways = initial.hermesToolGateways;
  // Sessions persisted before #6294/#6289 can carry an API family that the
  // selected agent cannot safely use. Normalize the seed before the resume
  // shortcut so the gateway provider is revalidated and, when necessary,
  // re-registered on the matching protocol surface before sandbox creation.
  let preferredInferenceApi = resolveAgentProviderInferenceApi(
    agentName(agent),
    agent,
    provider,
    initial.preferredInferenceApi,
  );
  let compatibleEndpointReasoning = initial.compatibleEndpointReasoning;
  let nimContainer = initial.nimContainer;
  const webSearchConfig = initial.webSearchConfig;
  let forceProviderSelection = initialForceProviderSelection;
  let allowToolsIncompatible = false;
  let skipHostInferenceSmoke = false;
  let reuseGatewayCredentialWithoutLocalKey = false;
  let endpointPinnedAddresses: string[] | undefined;
  let inferenceCapabilityCache: OnboardInferenceCapabilityCache | undefined;
  const effectiveResume = resume && !fresh;
  const stateResults: OnboardStateTransitionResult[] = [];
  const retryStateResults: OnboardStateTransitionResult[] = [];

  while (true) {
    // Drop a context window auto-detected by a prior compatible-endpoint pass
    // before every provider-selection path — fresh, resume, and repair — so a
    // retry to a different provider/endpoint cannot inherit endpoint A's probed
    // max_model_len as a bogus user override. Only clears a value this process
    // auto-detected, never a user override or a legitimately resumed window
    // (#6177; resume/repair coverage per PR #6293 PRA-3).
    clearAutoDetectedCompatibleContextWindow(process.env);
    let forceInferenceSetup = initialForceInferenceSetup;
    let recoveredRecordedProvider = false;
    const providerRecovery = createRecovery(fresh, sandboxName, session, deps, {
      recoveryReceipt: providerRecoveryReceipt,
      recoveryReceiptLedger: providerRecoveryReceiptLedger,
      gatewayName,
    });
    const resumeProviderSelection =
      !forceProviderSelection &&
      effectiveResume &&
      (authoritativeResumeConfig || session?.steps?.provider_selection?.status === "complete") &&
      typeof provider === "string" &&
      typeof model === "string";
    let shouldRecordProviderSelection = false;
    if (resumeProviderSelection) {
      assertProviderInferenceRouteCompatible(deps, gatewayName, sandboxName, {
        provider,
        model,
        endpointUrl,
        credentialEnv,
        preferredInferenceApi,
      });
      const recovery = await deps.ensureResumeProviderReady(gatewayName, provider, credentialEnv);
      forceInferenceSetup ||= recovery.forceInferenceSetup;
      credentialEnv = recovery.credentialEnv;
      // Rebuild may be resuming a legacy session whose step marker was never
      // completed even though the pre-delete registry selection was validated
      // and rewritten into the session. Persist that trusted selection so a
      // later plain `onboard --resume` recovery cannot fall back to ambient or
      // default provider selection if the recreate fails after this point.
      shouldRecordProviderSelection = authoritativeResumeConfig;
      if (preferredInferenceApi !== initial.preferredInferenceApi) {
        // #6294/#6289 heal: the pre-fix session can leave the gateway provider
        // registered for a protocol that no longer matches the agent route.
        // Re-run inference setup so the provider surface is revalidated and
        // refreshed. Persist the adjusted value only after setup succeeds.
        forceInferenceSetup = true;
      }
      if (
        !deps.isResumeProviderSurfaceReady(
          gatewayName,
          provider,
          preferredInferenceApi,
          credentialEnv,
          endpointUrl,
        )
      ) {
        forceInferenceSetup = true;
        deps.log(
          "  [resume] Refreshing the gateway provider to match the required inference surface.",
        );
      }
      const hydratedCredential = deps.hydrateCredentialEnv(credentialEnv);
      // A rebuild recreate may leave `openshell inference get` reporting the
      // same provider/model while the newly created messaging sandbox's
      // `inference.local` route is not actually wired to the compatible
      // endpoint. For the OpenClaw+messaging path that later performs a
      // sandbox-side compatible-endpoint smoke, refresh the gateway route in
      // the inference phase instead of trusting the provider/model-only resume
      // shortcut. If the local key is absent, force provider selection through
      // the strict recovered-route checks; only that path can authorize reuse
      // of the stored gateway credential and suppression of the unauthenticated
      // host smoke.
      if (
        shouldRefreshCompatibleEndpointRouteForMessaging(
          provider,
          selectedMessagingChannels,
          session,
          agent,
        )
      ) {
        if (!hydratedCredential) {
          deps.log(
            "  [resume] Revalidating recovered compatible-endpoint identity before reusing its gateway credential.",
          );
          forceProviderSelection = true;
          continue;
        }
        forceInferenceSetup = true;
        deps.log("  [resume] Refreshing compatible-endpoint inference route for messaging.");
      }
      deps.skippedStepMessage("provider_selection", `${provider} / ${model}`);
      await deps.recordStateSkipped("provider_selection", {
        reason: "resume",
        provider,
        model,
      });
      compatibleEndpointReasoning =
        provider === "compatible-endpoint"
          ? await deps.configureCompatibleEndpointReasoning(compatibleEndpointReasoning)
          : deps.clearCompatibleEndpointReasoning();
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
      const recoverRecordedProvider = providerRecovery.shouldRecover();
      const selection = await withProviderSelectionTrace(
        sandboxName,
        (agent as { name?: string } | null)?.name,
        () =>
          deps.setupNim(
            gpu,
            sandboxName,
            agent,
            recoverRecordedProvider,
            gatewayName,
            (route) => guardProviderInferenceRouteSelection(deps, gatewayName, sandboxName, route),
            (provider) => {
              const preflight = deps.preflightGatewayRouteDiscovery({
                gatewayName,
                sandboxName,
                route: {
                  provider,
                  model: null,
                  endpointUrl: null,
                  preferredInferenceApi: null,
                  credentialEnv: null,
                },
              });
              return preflight.ok || isAdvisoryGatewayRouteConflict(preflight.result);
            },
            providerRecovery.sessionId,
          ),
      );
      model = selection.model;
      provider = selection.provider;
      endpointUrl = selection.endpointUrl;
      credentialEnv = selection.credentialEnv;
      hermesAuthMethod = selection.hermesAuthMethod;
      hermesToolGateways = selection.hermesToolGateways;
      preferredInferenceApi = selection.preferredInferenceApi;
      compatibleEndpointReasoning = selection.compatibleEndpointReasoning;
      nimContainer = selection.nimContainer;
      allowToolsIncompatible = selection.allowToolsIncompatible === true;
      skipHostInferenceSmoke = selection.skipHostInferenceSmoke === true;
      reuseGatewayCredentialWithoutLocalKey =
        selection.reuseGatewayCredentialWithoutLocalKey === true;
      recoveredRecordedProvider = selection.recoveredFromSandbox === true;
      forceInferenceSetup ||= recoveredRecordedProvider;
      endpointPinnedAddresses = selection.endpointPinnedAddresses;
      inferenceCapabilityCache = selection.inferenceCapabilityCache;
      shouldRecordProviderSelection = true;
    }

    // Persist a repaired API family only together with a successful inference
    // step. A failed heal must leave the stale seed in place so resume re-arms.
    const healAdjustedInferenceApi =
      resumeProviderSelection && preferredInferenceApi !== initial.preferredInferenceApi;
    const selected = requireSelection(provider, model, deps);
    const selectedProvider = selected.provider;
    const selectedModel = selected.model;
    provider = selectedProvider;
    model = selectedModel;
    preferredInferenceApi = resolveAgentProviderInferenceApi(
      agentName(agent),
      agent,
      provider,
      preferredInferenceApi,
    );
    if (!resumeProviderSelection) {
      assertProviderInferenceRouteCompatible(deps, gatewayName, sandboxName, {
        provider,
        model,
        endpointUrl,
        credentialEnv,
        preferredInferenceApi,
      });
    }
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
          // An authoritative rebuild records route fidelity before inference
          // setup. Keep the stale marker until the provider surface heal
          // succeeds so a failed attempt remains armed on the next resume.
          preferredInferenceApi: healAdjustedInferenceApi
            ? initial.preferredInferenceApi
            : preferredInferenceApi,
          compatibleEndpointReasoning,
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
      effectiveResume &&
      deps.isInferenceRouteReady(gatewayName, provider, model);
    if (resumeInference) {
      if (provider === constants.hermesProviderName) {
        let inferenceResult: ProviderInferenceRetry;
        try {
          if (!sandboxName) sandboxName = await deps.promptValidatedSandboxName(agent);
          const confirmedSandboxName = sandboxName;
          const inferenceOptions = {
            gatewayName,
            allowToolsIncompatible,
            ...(skipHostInferenceSmoke ? { skipHostInferenceSmoke } : {}),
            ...(reuseGatewayCredentialWithoutLocalKey
              ? { reuseGatewayCredentialWithoutLocalKey }
              : {}),
            ...(preferredInferenceApi ? { preferredInferenceApi } : {}),
            ...(endpointPinnedAddresses ? { endpointPinnedAddresses } : {}),
            ...(inferenceCapabilityCache ? { inferenceCapabilityCache } : {}),
            reservationSessionId: session?.sessionId,
          };
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
                inferenceOptions,
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
          deps.toSessionUpdates({
            provider,
            model,
            hermesAuthMethod,
            compatibleEndpointReasoning,
            nimContainer,
            hermesToolGateways,
          }),
        );
        break;
      }
      const sandboxStepComplete = session?.steps?.sandbox?.status === "complete";
      const resumeReservationName =
        authoritativeResumeConfig || !sandboxStepComplete
          ? (sandboxName ?? (await deps.promptValidatedSandboxName(agent)))
          : null;
      if (resumeReservationName) sandboxName = resumeReservationName;
      const routedInferenceProvider = deps.isRoutedInferenceProvider(provider);
      if (routedInferenceProvider) {
        // #4564: re-upsert the gateway provider with the sandbox-facing
        // endpoint so a stale localhost base URL recorded by an earlier run is
        // repaired on resume instead of surviving and breaking inference.local.
        const routedRepair = await deps.withGatewayRouteMutationLock(gatewayName, async () => {
          assertProviderInferenceRouteCompatible(deps, gatewayName, sandboxName, {
            provider: selectedProvider,
            model: selectedModel,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
          });
          try {
            await deps.reconcileModelRouter();
          } catch (err) {
            deps.error(
              `  ✗ Failed to reconcile model router: ${err instanceof Error ? err.message : String(err)}`,
            );
            deps.exitProcess(1);
          }
          const reupserted = deps.reupsertRoutedProvider(
            gatewayName,
            selectedProvider,
            endpointUrl,
            credentialEnv,
          );
          const reserved =
            reupserted.ok && resumeReservationName
              ? deps.reserveSandboxInferenceRoute(resumeReservationName, {
                  provider: selectedProvider,
                  model: selectedModel,
                  endpointUrl: reupserted.endpointUrl,
                  credentialEnv,
                  preferredInferenceApi,
                  gatewayName,
                  reservationSessionId: session?.sessionId,
                })
              : null;
          return { reupserted, reserved };
        });
        const { reupserted, reserved } = routedRepair;
        if (!reupserted.ok) {
          deps.error(
            `  ${reupserted.message ?? "Failed to update the routed inference provider."}`,
          );
          deps.exitProcess(reupserted.status ?? 1);
        }
        if (reserved === false) {
          deps.error(`  Failed to reserve inference route for sandbox '${resumeReservationName}'.`);
          deps.exitProcess(1);
        }
        endpointUrl = reupserted.endpointUrl;
      }
      if (resumeReservationName && !routedInferenceProvider) {
        const reserved = await deps.withGatewayRouteMutationLock(gatewayName, () => {
          assertProviderInferenceRouteCompatible(deps, gatewayName, resumeReservationName, {
            provider: selectedProvider,
            model: selectedModel,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
          });
          return deps.reserveSandboxInferenceRoute(resumeReservationName, {
            provider: selectedProvider,
            model: selectedModel,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi,
            gatewayName,
            reservationSessionId: session?.sessionId,
          });
        });
        if (!reserved) {
          deps.error(`  Failed to reserve inference route for sandbox '${resumeReservationName}'.`);
          deps.exitProcess(1);
        }
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
        deps.toSessionUpdates({
          provider,
          model,
          hermesAuthMethod,
          compatibleEndpointReasoning,
          nimContainer,
          hermesToolGateways,
        }),
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

      const inferenceOptions = {
        gatewayName,
        allowToolsIncompatible,
        ...(skipHostInferenceSmoke ? { skipHostInferenceSmoke } : {}),
        ...(reuseGatewayCredentialWithoutLocalKey ? { reuseGatewayCredentialWithoutLocalKey } : {}),
        ...(preferredInferenceApi ? { preferredInferenceApi } : {}),
        ...(endpointPinnedAddresses ? { endpointPinnedAddresses } : {}),
        ...(inferenceCapabilityCache ? { inferenceCapabilityCache } : {}),
        ...providerRecovery.setupOptions(
          recoveredRecordedProvider,
          confirmedSandboxName,
          session?.sessionId,
        ),
      };
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
            inferenceOptions,
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
      deps.toSessionUpdates({
        provider,
        model,
        hermesAuthMethod,
        compatibleEndpointReasoning,
        nimContainer,
        hermesToolGateways,
        // The forced #6294/#6289 heal succeeded: the gateway registration now
        // matches the adjusted route, so the stale session seed can be replaced.
        ...(healAdjustedInferenceApi ? { preferredInferenceApi } : {}),
      }),
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
    compatibleEndpointReasoning,
    nimContainer,
    webSearchConfig,
    session,
    stateResult,
    stateResults,
    retryStateResults,
  };
}
