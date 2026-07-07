// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesAuthMethod } from "./hermes-auth";
import type {
  CommonDeps,
  HermesDeps,
  OllamaDeps,
  RemoteProviderDeps,
  RoutedDeps,
  SetupInferenceResult,
  VllmDeps,
} from "./inference-providers";
import * as inferenceProviders from "./inference-providers";
import { createLocalInferenceRouteApplier } from "./local-inference-route";
import type { ProviderInferenceSetupOptions } from "./machine/handlers/provider-inference";

type ProviderBranchDeps = Pick<
  CommonDeps,
  | "upsertProvider"
  | "verifyInferenceRoute"
  | "verifyOnboardInferenceSmoke"
  | "isNonInteractive"
  | "exitProcess"
  | "error"
  | "log"
> &
  Pick<
    HermesDeps,
    | "lookup"
    | "hermesProviderAuth"
    | "getHermesToolGatewayBroker"
    | "providerExistsInGateway"
    | "normalizeHermesAuthMethod"
    | "resolveHermesNousApiKey"
    | "checkHermesProviderStoreReachable"
    | "hermesAuthMethodLabel"
    | "hermesConstants"
    | "requireValue"
    | "redact"
    | "compactText"
  > &
  Pick<
    RemoteProviderDeps,
    | "REMOTE_PROVIDER_CONFIG"
    | "hydrateCredentialEnv"
    | "promptValidationRecovery"
    | "classifyApplyFailure"
    | "bedrockRuntimeOnboard"
  > &
  Pick<
    VllmDeps,
    "validateLocalProvider" | "getLocalProviderHealthCheck" | "getLocalProviderBaseUrl"
  > &
  Pick<
    OllamaDeps,
    | "getOllamaWarmupCommand"
    | "shouldFrontOllamaWithProxy"
    | "ensureOllamaAuthProxy"
    | "isProxyHealthy"
    | "getOllamaProxyToken"
    | "persistAndProbeOllamaProxy"
    | "localInference"
  > &
  Pick<RoutedDeps, "reconcileModelRouter" | "routedInference">;

export type SetupInferenceDeps = ProviderBranchDeps & {
  step: (current: number, total: number, label: string) => void;
  getGatewayName: () => string;
  runOpenshell: import("./openshell-cli").OpenshellCliHelpers["runOpenshell"];
  run: typeof import("../runner").run;
  updateSandbox: CommonDeps["registry"]["updateSandbox"];
  localInferenceTimeoutSecs: number;
  vllmLocalCredentialEnv: string;
  ollamaProxyCredentialEnv: string;
  isRoutedInferenceProvider: (provider: string) => boolean;
  applyLocalInferenceRoute?: VllmDeps["applyLocalInferenceRoute"];
  // #6294 optional overrides for the remote-provider OpenAI-surface branch;
  // production omits these and remote.ts falls back to the real modules.
  probeOpenAiLikeEndpoint?: RemoteProviderDeps["probeOpenAiLikeEndpoint"];
  readGatewayProviderMetadata?: RemoteProviderDeps["readGatewayProviderMetadata"];
  deleteGatewayProvider?: RemoteProviderDeps["deleteGatewayProvider"];
  log: (message: string) => void;
  error: (message: string) => void;
  exitProcess: (code: number) => never;
};

function resolveLocalInferenceRouteApplier(deps: SetupInferenceDeps) {
  return (
    deps.applyLocalInferenceRoute ??
    createLocalInferenceRouteApplier({
      runOpenshell: deps.runOpenshell,
      isNonInteractive: deps.isNonInteractive,
      promptValidationRecovery: deps.promptValidationRecovery,
      classifyApplyFailure: deps.classifyApplyFailure,
      compactText: deps.compactText,
      redact: deps.redact,
      localInferenceTimeoutSecs: deps.localInferenceTimeoutSecs,
      error: deps.error,
      exitProcess: deps.exitProcess,
    })
  );
}

export type SetupInference = (
  sandboxName: string | null,
  model: string,
  provider: string,
  endpointUrl?: string | null,
  credentialEnv?: string | null,
  hermesAuthMethod?: HermesAuthMethod | string | null,
  hermesToolGateways?: string[],
  options?: ProviderInferenceSetupOptions,
) => Promise<SetupInferenceResult>;

export function createSetupInference(
  defaults: SetupInferenceDeps,
  overrides: Partial<SetupInferenceDeps> = {},
): SetupInference {
  const deps: SetupInferenceDeps = { ...defaults, ...overrides };

  return async function setupInferenceWithDeps(
    sandboxName: string | null,
    model: string,
    provider: string,
    endpointUrl: string | null = null,
    credentialEnv: string | null = null,
    hermesAuthMethod: HermesAuthMethod | string | null = null,
    hermesToolGateways: string[] = [],
    options: ProviderInferenceSetupOptions = {},
  ): Promise<SetupInferenceResult> {
    deps.step(4, 8, "Setting up inference provider");
    deps.runOpenshell(["gateway", "select", deps.getGatewayName()], { ignoreError: true });

    const commonDeps = {
      runOpenshell: deps.runOpenshell,
      upsertProvider: deps.upsertProvider,
      verifyInferenceRoute: deps.verifyInferenceRoute,
      verifyOnboardInferenceSmoke: deps.verifyOnboardInferenceSmoke,
      isNonInteractive: deps.isNonInteractive,
      registry: { updateSandbox: deps.updateSandbox },
      exitProcess: deps.exitProcess,
      error: deps.error,
      log: deps.log,
    } satisfies CommonDeps;

    if (provider === deps.hermesProviderAuth.HERMES_PROVIDER_NAME) {
      return inferenceProviders.setupHermesProviderInference(
        {
          sandboxName,
          model,
          provider,
          endpointUrl,
          credentialEnv,
          hermesAuthMethod,
          hermesToolGateways,
        },
        {
          ...commonDeps,
          hermesProviderAuth: deps.hermesProviderAuth,
          getHermesToolGatewayBroker: deps.getHermesToolGatewayBroker,
          providerExistsInGateway: deps.providerExistsInGateway,
          normalizeHermesAuthMethod: deps.normalizeHermesAuthMethod,
          resolveHermesNousApiKey: deps.resolveHermesNousApiKey,
          checkHermesProviderStoreReachable: deps.checkHermesProviderStoreReachable,
          hermesAuthMethodLabel: deps.hermesAuthMethodLabel,
          hermesConstants: deps.hermesConstants,
          requireValue: deps.requireValue,
          redact: deps.redact,
          compactText: deps.compactText,
          lookup: deps.lookup,
        },
      );
    }

    if (inferenceProviders.isRemoteProviderName(provider)) {
      const outcome = await inferenceProviders.setupRemoteProviderInference(
        {
          sandboxName,
          model,
          provider,
          endpointUrl,
          credentialEnv,
          reuseGatewayCredentialWithoutLocalKey:
            options.reuseGatewayCredentialWithoutLocalKey === true,
          preferredInferenceApi: options.preferredInferenceApi ?? null,
        },
        {
          ...commonDeps,
          REMOTE_PROVIDER_CONFIG: deps.REMOTE_PROVIDER_CONFIG,
          hydrateCredentialEnv: deps.hydrateCredentialEnv,
          promptValidationRecovery: deps.promptValidationRecovery,
          classifyApplyFailure: deps.classifyApplyFailure,
          LOCAL_INFERENCE_TIMEOUT_SECS: deps.localInferenceTimeoutSecs,
          bedrockRuntimeOnboard: deps.bedrockRuntimeOnboard,
          redact: deps.redact,
          compactText: deps.compactText,
          probeOpenAiLikeEndpoint: deps.probeOpenAiLikeEndpoint,
          readGatewayProviderMetadata: deps.readGatewayProviderMetadata,
          deleteGatewayProvider: deps.deleteGatewayProvider,
        },
      );
      if (outcome.done) return outcome.result;
    } else if (provider === "vllm-local") {
      const outcome = await inferenceProviders.setupVllmLocalInference(
        { model, provider },
        {
          ...commonDeps,
          validateLocalProvider: deps.validateLocalProvider,
          getLocalProviderHealthCheck: deps.getLocalProviderHealthCheck,
          getLocalProviderBaseUrl: deps.getLocalProviderBaseUrl,
          applyLocalInferenceRoute: resolveLocalInferenceRouteApplier(deps),
          run: deps.run,
          VLLM_LOCAL_CREDENTIAL_ENV: deps.vllmLocalCredentialEnv,
        },
      );
      if (outcome.done) return outcome.result;
    } else if (provider === "ollama-local") {
      const outcome = await inferenceProviders.setupOllamaLocalInference(
        { model, provider, allowToolsIncompatible: options.allowToolsIncompatible === true },
        {
          ...commonDeps,
          validateLocalProvider: deps.validateLocalProvider,
          getLocalProviderBaseUrl: deps.getLocalProviderBaseUrl,
          applyLocalInferenceRoute: resolveLocalInferenceRouteApplier(deps),
          getOllamaWarmupCommand: deps.getOllamaWarmupCommand,
          run: deps.run,
          shouldFrontOllamaWithProxy: deps.shouldFrontOllamaWithProxy,
          ensureOllamaAuthProxy: deps.ensureOllamaAuthProxy,
          isProxyHealthy: deps.isProxyHealthy,
          getOllamaProxyToken: deps.getOllamaProxyToken,
          persistAndProbeOllamaProxy: deps.persistAndProbeOllamaProxy,
          localInference: deps.localInference,
          OLLAMA_PROXY_CREDENTIAL_ENV: deps.ollamaProxyCredentialEnv,
        },
      );
      if (outcome.done) return outcome.result;
    } else if (deps.isRoutedInferenceProvider(provider)) {
      await inferenceProviders.setupRoutedInference(
        { model, provider, endpointUrl, credentialEnv },
        {
          ...commonDeps,
          reconcileModelRouter: deps.reconcileModelRouter,
          routedInference: deps.routedInference,
          hydrateCredentialEnv: deps.hydrateCredentialEnv,
          redact: deps.redact,
          compactText: deps.compactText,
        },
      );
    } else {
      deps.error(`  Unsupported provider configuration: ${provider}`);
      deps.exitProcess(1);
    }

    deps.verifyInferenceRoute(provider, model);
    if (options.skipHostInferenceSmoke === true)
      deps.log("  Reusing existing gateway credential; skipping host inference smoke.");
    else deps.verifyOnboardInferenceSmoke({ provider, model, endpointUrl, credentialEnv });
    if (sandboxName) {
      deps.updateSandbox(sandboxName, { model, provider });
    }
    deps.log(`  ✓ Inference route set: ${provider} / ${model}`);
    return { ok: true };
  };
}
