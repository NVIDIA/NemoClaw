// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isBedrockRuntimeEndpoint } from "../inference/bedrock-runtime";
import {
  assertEndpointResolvesPublic,
  type EndpointDnsLookupFn,
} from "../inference/endpoint-ssrf-preflight";
import {
  type CurrentGatewayRouteCompatibilityCheck,
  formatGatewayRouteConflict,
  formatGatewayRouteImpactWarning,
  isAdvisoryGatewayRouteConflict,
} from "../inference/gateway-route-compatibility";
import { withGatewayRouteMutationLock } from "../inference/gateway-route-mutation-lock";
import {
  assertNoExplicitOpenShellGatewayEndpoint,
  assertNoOpenShellGatewayEndpointOverride,
  type OpenShellGatewayEndpointEnvironment,
} from "../openshell-gateway-endpoint-guard";
import { withSandboxMutationLock } from "../state/mcp-lifecycle-lock";

export { assertNoOpenShellGatewayEndpointOverride };

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
  "verifyOnboardInferenceSmoke" | "isNonInteractive" | "exitProcess" | "error" | "log"
> &
  Pick<
    HermesDeps,
    | "lookup"
    | "hermesProviderAuth"
    | "getHermesToolGatewayBroker"
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
    | "openrouterRuntimeOnboard"
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
  /** Injectable resolver for resumed custom-endpoint SSRF preflight tests. */
  resolveEndpointHost?: EndpointDnsLookupFn;
  checkGatewayRouteCompatibility: CurrentGatewayRouteCompatibilityCheck;
  withGatewayRouteMutationLock: typeof withGatewayRouteMutationLock;
  withSandboxMutationLock: typeof withSandboxMutationLock;
  step: (current: number, total: number, label: string) => void;
  getGatewayName: () => string;
  runOpenshell: import("./openshell-cli").OpenshellCliHelpers["runOpenshell"];
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: NodeJS.ProcessEnv | undefined,
    gatewayName: string,
  ) => ReturnType<CommonDeps["upsertProvider"]>;
  verifyInferenceRoute: (gatewayName: string, provider: string, model: string) => void;
  providerExistsInGateway: (name: string, gatewayName: string) => boolean;
  run: typeof import("../runner").run;
  updateSandbox: typeof import("../state/registry").reserveSandboxInferenceRoute;
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

export function scopeGatewayOpenshellArgs(args: string[], gatewayName: string): string[] {
  if (!gatewayName) throw new Error("OpenShell gateway name is required.");
  assertNoExplicitOpenShellGatewayEndpoint(args);
  if (args[0] === "gateway" && args[1] === "select") {
    throw new Error("Gateway-scoped OpenShell operations must not change the selected gateway.");
  }
  const providerCommand = args[0] === "inference" || args[0] === "provider";
  const sandboxCommand = args[0] === "sandbox" && typeof args[1] === "string";
  const sandboxProviderCommand = sandboxCommand && args[1] === "provider";
  if (!providerCommand && !sandboxCommand) return [...args];
  const gatewayFlagIndex = sandboxProviderCommand ? 3 : 2;
  const separatorIndex = args.indexOf("--");
  const optionEnd = separatorIndex === -1 ? args.length : separatorIndex;
  const gatewayTargets = args.slice(0, optionEnd).flatMap((value, index) => {
    if (index < gatewayFlagIndex) return [];
    if (value === "-g" || value === "--gateway") return [args[index + 1] ?? ""];
    return value.startsWith("--gateway=") ? [value.slice("--gateway=".length)] : [];
  });
  if (gatewayTargets.length > 1) {
    throw new Error("OpenShell command contains multiple gateway targets.");
  }
  const existingGatewayName = gatewayTargets[0];
  if (existingGatewayName !== undefined) {
    if (existingGatewayName !== gatewayName) {
      throw new Error(
        `OpenShell command targets gateway '${existingGatewayName}' instead of '${gatewayName}'.`,
      );
    }
    return [...args];
  }
  return [...args.slice(0, gatewayFlagIndex), "-g", gatewayName, ...args.slice(gatewayFlagIndex)];
}

export function createGatewayScopedOpenshellRunner<Rest extends unknown[], Result>(
  runOpenshell: (args: string[], ...rest: Rest) => Result,
  gatewayName: string,
  env: OpenShellGatewayEndpointEnvironment = process.env,
): (args: string[], ...rest: Rest) => Result {
  assertNoOpenShellGatewayEndpointOverride(env);
  return (args, ...rest) => runOpenshell(scopeGatewayOpenshellArgs(args, gatewayName), ...rest);
}

export function bindGatewayUpsertProvider(
  upsertProvider: SetupInferenceDeps["upsertProvider"],
  gatewayName: string,
): CommonDeps["upsertProvider"] {
  return (name, type, credentialEnv, baseUrl, env) =>
    upsertProvider(name, type, credentialEnv, baseUrl, env, gatewayName);
}

export function selectGatewayForFollowupOrExit(
  gatewayName: string,
  runOpenshell: SetupInferenceDeps["runOpenshell"],
  error: (message: string) => void = console.error,
  exitProcess: (code: number) => never = (code) => process.exit(code),
): void {
  const selected = runOpenshell(["gateway", "select", gatewayName], { ignoreError: true });
  if (selected.status === 0) return;
  error(
    `  Error: OpenShell could not select managed gateway '${gatewayName}' after onboarding. ` +
      "No follow-up operations were run against an ambient gateway.",
  );
  exitProcess(typeof selected.status === "number" && selected.status !== 0 ? selected.status : 1);
}

function resolveLocalInferenceRouteApplier(
  deps: SetupInferenceDeps,
  runOpenshell: SetupInferenceDeps["runOpenshell"],
) {
  return (
    deps.applyLocalInferenceRoute ??
    createLocalInferenceRouteApplier({
      runOpenshell,
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
    const gatewayName = options.gatewayName ?? deps.getGatewayName();
    const mutateGatewayRoute = (): Promise<SetupInferenceResult> =>
      deps.withGatewayRouteMutationLock(gatewayName, async () => {
        if (
          options.isRecordedProviderRecoveryAuthorized &&
          !options.isRecordedProviderRecoveryAuthorized()
        ) {
          deps.error(
            `  Error: recorded inference recovery for sandbox '${sandboxName}' lost reservation ownership before route setup.`,
          );
          return deps.exitProcess(1);
        }
        const compatibility = deps.checkGatewayRouteCompatibility({
          gatewayName,
          sandboxName,
          route: {
            provider,
            model,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi: options.preferredInferenceApi ?? null,
          },
        });
        if (!compatibility.ok) {
          if (!isAdvisoryGatewayRouteConflict(compatibility)) {
            deps.error(`  Error: ${formatGatewayRouteConflict(compatibility)}`);
            return deps.exitProcess(1);
          }
          deps.error(`  ${formatGatewayRouteImpactWarning(compatibility)}`);
        }
        deps.step(4, 8, "Setting up inference provider");
        let endpointPinnedAddresses = options.endpointPinnedAddresses;
        // Strictly classified AWS Bedrock Runtime hostnames use the dedicated
        // SigV4/bearer adapter rather than the generic curl probe path. Their
        // hostname is constrained to AWS-owned suffixes by the classifier, so
        // do not apply the custom-origin curl pinning contract here.
        const usesBedrockRuntimeAdapter =
          provider === "compatible-anthropic-endpoint" && isBedrockRuntimeEndpoint(endpointUrl);
        if (
          (provider === "compatible-endpoint" || provider === "compatible-anthropic-endpoint") &&
          endpointUrl &&
          !usesBedrockRuntimeAdapter &&
          !endpointPinnedAddresses
        ) {
          const preflight = await assertEndpointResolvesPublic(
            endpointUrl,
            deps.resolveEndpointHost,
          );
          if (!preflight.ok) {
            deps.error(
              `  Endpoint SSRF preflight failed: ${preflight.reason ?? "endpoint is not safe to probe"}`,
            );
            if (deps.isNonInteractive()) return deps.exitProcess(1);
            return { retry: "selection" };
          }
          endpointPinnedAddresses = preflight.addresses;
        }
        const runGatewayOpenshell = createGatewayScopedOpenshellRunner(
          deps.runOpenshell,
          gatewayName,
        );
        let routeReserved = false;
        const reserveRoute = (name: string, selectedProvider: string, selectedModel: string) => {
          if (routeReserved) return true;
          const reserved = deps.updateSandbox(name, {
            provider: selectedProvider,
            model: selectedModel,
            endpointUrl,
            credentialEnv,
            preferredInferenceApi: options.preferredInferenceApi ?? null,
            gatewayName,
            reservationSessionId: options.reservationSessionId,
          });
          routeReserved = reserved;
          return reserved;
        };

        const commonDeps = {
          runOpenshell: runGatewayOpenshell,
          upsertProvider: bindGatewayUpsertProvider(deps.upsertProvider, gatewayName),
          verifyInferenceRoute: (selectedProvider: string, selectedModel: string) => {
            if (sandboxName) reserveRoute(sandboxName, selectedProvider, selectedModel);
            deps.verifyInferenceRoute(gatewayName, selectedProvider, selectedModel);
          },
          verifyOnboardInferenceSmoke: (
            input: Parameters<CommonDeps["verifyOnboardInferenceSmoke"]>[0],
          ) =>
            deps.verifyOnboardInferenceSmoke({
              ...input,
              pinnedAddresses: endpointPinnedAddresses,
              capabilityCache: options.inferenceCapabilityCache,
            }),
          isNonInteractive: deps.isNonInteractive,
          registry: {
            updateSandbox: (name: string) => reserveRoute(name, provider, model),
          },
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
              providerExistsInGateway: (name: string) =>
                deps.providerExistsInGateway(name, gatewayName),
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
              skipHostInferenceSmoke: options.skipHostInferenceSmoke === true,
              preferredInferenceApi: options.preferredInferenceApi ?? null,
              pinnedAddresses: endpointPinnedAddresses,
              capabilityCache: options.inferenceCapabilityCache,
            },
            {
              ...commonDeps,
              REMOTE_PROVIDER_CONFIG: deps.REMOTE_PROVIDER_CONFIG,
              hydrateCredentialEnv: deps.hydrateCredentialEnv,
              promptValidationRecovery: deps.promptValidationRecovery,
              classifyApplyFailure: deps.classifyApplyFailure,
              LOCAL_INFERENCE_TIMEOUT_SECS: deps.localInferenceTimeoutSecs,
              bedrockRuntimeOnboard: deps.bedrockRuntimeOnboard,
              openrouterRuntimeOnboard: deps.openrouterRuntimeOnboard,
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
              applyLocalInferenceRoute: resolveLocalInferenceRouteApplier(
                deps,
                runGatewayOpenshell,
              ),
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
              applyLocalInferenceRoute: resolveLocalInferenceRouteApplier(
                deps,
                runGatewayOpenshell,
              ),
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

        commonDeps.verifyInferenceRoute(provider, model);
        if (options.skipHostInferenceSmoke === true)
          deps.log("  Reusing existing gateway credential; skipping host inference smoke.");
        else
          await deps.verifyOnboardInferenceSmoke({
            provider,
            model,
            endpointUrl,
            credentialEnv,
            pinnedAddresses: endpointPinnedAddresses,
            capabilityCache: options.inferenceCapabilityCache,
          });
        if (sandboxName) {
          commonDeps.registry.updateSandbox(sandboxName);
        }
        deps.log(`  ✓ Inference route set: ${provider} / ${model}`);
        return { ok: true as const };
      });
    return sandboxName
      ? deps.withSandboxMutationLock(sandboxName, mutateGatewayRoute)
      : mutateGatewayRoute();
  };
}
