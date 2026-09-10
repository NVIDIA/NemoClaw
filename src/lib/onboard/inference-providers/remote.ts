// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Remote provider inference setup flow (NVIDIA, OpenAI, Anthropic, Gemini,
// compatible endpoints, Bedrock Runtime). Extracted verbatim from
// onboard.setupInference (#767). Bedrock Runtime is delegated to
// `onboard/bedrock-runtime.ts` exactly as the inline branch did.

import * as inference from "../../inference/config";
import type { TrustedPrivateEndpointCapability } from "../../inference/endpoint-ssrf-preflight";
import {
  noAuthProxy as noAuth,
  withOllamaProxyLifecycleTransaction,
} from "../../inference/ollama/proxy";
import { OPENROUTER_PROVIDER_NAME } from "../../inference/openrouter";
import { deleteProviderWithRecovery } from "../sandbox-provider-cleanup";
import { createManagedProviderAdapter } from "../../adapters/openshell/managed-provider-adapter";
import {
  gatewayReachableCompatibleEndpointUrl,
  reuseRegisteredProviderWithGatewayEndpoint,
} from "./compatible-endpoint-gateway-route";
import type { RemoteProviderDeps, SetupInferenceResult } from "./types";

const { probeOpenAiLikeEndpointOptimized } = require("../../inference/onboard-probes") as {
  probeOpenAiLikeEndpointOptimized: (
    endpointUrl: string,
    model: string,
    apiKey: string,
    options?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message?: string }>;
};

type StaleProviderReplaceResult = { ok: boolean; status?: number | null; message?: string };

/**
 * Replace a provider that a prior Anthropic-Messages registration left behind
 * so it can be re-registered as `type=openai` for the OpenAI-compatible route
 * (`provider update` cannot change `--type`).
 *
 * Security containment: force-detach recovery may only touch the sandbox being
 * onboarded. The authorized set is exactly the confirmed `sandboxName`; every
 * attachment reported by the delete failure is revalidated against it before
 * any detach by `deleteProviderWithRecovery`. With no confirmed
 * sandbox (`sandboxName === null`) there is nothing to authorize against, so
 * force-detach recovery is refused with an actionable error rather than run
 * unconstrained. A provider still attached to other live sandboxes fails closed
 * too — flipping its type would silently break their Anthropic routing.
 */
async function replaceStaleAnthropicProviderForOpenAiSurface(args: {
  provider: string;
  sandboxName: string | null;
  runOpenshell: RemoteProviderDeps["runOpenshell"];
  providerAdapter: RemoteProviderDeps["providerAdapter"];
  redact: RemoteProviderDeps["redact"];
  compactText: RemoteProviderDeps["compactText"];
}): Promise<StaleProviderReplaceResult> {
  const { provider, sandboxName, runOpenshell, providerAdapter, redact, compactText } = args;
  const adapter =
    providerAdapter ??
    createManagedProviderAdapter((command, options) => {
      const result = runOpenshell(command, options);
      return {
        ...result,
        stdout:
          typeof result.stdout === "string" || Buffer.isBuffer(result.stdout)
            ? result.stdout
            : null,
        stderr:
          typeof result.stderr === "string" || Buffer.isBuffer(result.stderr)
            ? result.stderr
            : null,
      };
    });
  const result = await adapter.getProvider({
    target: { kind: "selected" },
    providerName: provider,
  });
  if (!result.ok) {
    if (result.error.kind === "command" && result.error.reason === "not_found") {
      return { ok: true };
    }
    const detail = compactText(redact(result.error.message));
    return {
      ok: false,
      status: 1,
      message: `Failed to inspect provider '${provider}' before replacement${detail ? `: ${detail}` : "."}`,
    };
  }
  if (result.value.type === "openai") return { ok: true };
  const attempt = await deleteProviderWithRecovery(provider, {
    providerAdapter: adapter,
    allowedSandboxes: sandboxName === null ? [] : [sandboxName],
  });
  if (attempt.ok) return { ok: true };
  const raw = attempt.error.message;
  const attached =
    attempt.error.kind === "command" && attempt.error.reason === "attached"
      ? [...(attempt.error.attachedSandboxes ?? [])]
      : [];
  const allowedSandboxes = sandboxName === null ? [] : [sandboxName];
  const foreign = attached.filter((name) => !allowedSandboxes.includes(name));
  if (sandboxName === null && attached.length > 0) {
    return {
      ok: false,
      status: 1,
      message:
        `Provider '${provider}' is attached to sandbox(es) (${attached.join(", ")}) ` +
        `but no target sandbox was confirmed, so it cannot be safely force-detached ` +
        `and re-registered for the OpenAI-compatible route. Re-run onboarding with an ` +
        `explicit sandbox, or remove those sandboxes first.`,
    };
  }
  if (foreign.length > 0) {
    return {
      ok: false,
      status: 1,
      message:
        `Provider '${provider}' is attached to other sandbox(es) (${foreign.join(", ")}) ` +
        `and cannot be re-registered for the OpenAI-compatible route without breaking ` +
        `their Anthropic Messages routing. Onboard this agent against a dedicated ` +
        `endpoint or remove those sandboxes first.`,
    };
  }
  const recovery = attempt.recoveryFailures
    .map((failure) => compactText(redact(`${failure.sandbox}: ${failure.output}`)))
    .join("; ");
  const detail = compactText(redact(raw));
  return {
    ok: false,
    status: 1,
    message: `Failed to replace provider '${provider}' for the OpenAI-compatible route${detail ? `: ${detail}` : "."}${recovery ? ` (detach failures: ${recovery})` : ""}`,
  };
}

/**
 * Returns `{ done: true, result }` when the flow handled the request
 * (e.g. Bedrock short-circuit or a retry-to-selection); returns
 * `{ done: false }` so the dispatcher can run the shared verify + registry
 * finalization that used to live after the provider branches.
 */
export async function setupRemoteProviderInference(
  args: {
    sandboxName: string | null;
    model: string;
    provider: string;
    endpointUrl: string | null;
    credentialEnv: string | null;
    reuseGatewayCredentialWithoutLocalKey?: boolean;
    skipHostInferenceSmoke?: boolean;
    preferredInferenceApi?: string | null;
    pinnedAddresses?: readonly string[];
    trustedPrivateCapability?: TrustedPrivateEndpointCapability;
    capabilityCache?: import("../inference-capability-cache").OnboardInferenceCapabilityCache;
  },
  deps: RemoteProviderDeps,
): Promise<{ done: true; result: SetupInferenceResult } | { done: false }> {
  const {
    sandboxName,
    model,
    provider,
    endpointUrl,
    credentialEnv,
    reuseGatewayCredentialWithoutLocalKey,
    skipHostInferenceSmoke,
    preferredInferenceApi,
    pinnedAddresses,
    trustedPrivateCapability,
    capabilityCache,
  } = args;
  const {
    runOpenshell,
    upsertProvider,
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    isNonInteractive,
    registry,
    exitProcess,
    error,
    log,
    REMOTE_PROVIDER_CONFIG,
    hydrateCredentialEnv,
    promptValidationRecovery,
    classifyApplyFailure,
    LOCAL_INFERENCE_TIMEOUT_SECS,
    bedrockRuntimeOnboard,
    openrouterRuntimeOnboard,
    redact,
    compactText,
  } = deps;

  const config =
    provider === "nvidia-nim"
      ? REMOTE_PROVIDER_CONFIG.build
      : Object.values(REMOTE_PROVIDER_CONFIG).find((entry) => entry.providerName === provider);
  if (!config) {
    error(`  Unsupported provider configuration: ${provider}`);
    return exitProcess(1);
  }
  const bedrockSetup = await bedrockRuntimeOnboard.setupBedrockRuntimeInference({
    sandboxName,
    provider,
    model,
    endpointUrl,
    credentialEnv,
    isNonInteractive,
    runOpenshell,
    upsertProvider,
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    updateSandbox: registry.updateSandbox,
    exitProcess,
    error,
    log,
  });
  if (bedrockSetup.handled) return { done: true, result: bedrockSetup.result };
  const openrouterCredentialEnv = credentialEnv || config.credentialEnv;
  const openrouterCredentialValue =
    provider === OPENROUTER_PROVIDER_NAME ? hydrateCredentialEnv(openrouterCredentialEnv) : null;
  const openrouterSetup = await openrouterRuntimeOnboard.setupOpenRouterRuntimeInference({
    sandboxName,
    provider,
    model,
    credentialEnv: openrouterCredentialEnv,
    credentialValue: openrouterCredentialValue,
    reuseGatewayCredentialWithoutLocalKey,
    skipHostInferenceSmoke,
    isNonInteractive,
    runOpenshell,
    upsertProvider,
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    updateSandbox: registry.updateSandbox,
    exitProcess,
    error,
    log,
  });
  if (openrouterSetup.handled) return { done: true, result: openrouterSetup.result };
  // #6294: an OpenAI-/chat/completions-only agent (dcode) coerced off Anthropic
  // Messages must talk to the gateway route over the openai_chat_completions
  // protocol, and OpenShell routes that protocol only for providers registered
  // with type=openai. Verify the endpoint actually serves the OpenAI surface
  // before registering it as such; endpoints that answer only /v1/messages get
  // an actionable onboarding failure instead of a sandbox that cannot infer.
  // Bedrock endpoints never reach here — the adapter branch above returns first.
  const useOpenAiSurface =
    provider === "compatible-anthropic-endpoint" && preferredInferenceApi === "openai-completions";
  const probeOpenAiSurface = deps.probeOpenAiLikeEndpoint ?? probeOpenAiLikeEndpointOptimized;
  const configureProvider = async (): Promise<
    { done: true; result: SetupInferenceResult } | { done: false }
  > => {
    const previousProxyCredential = credentialEnv ? process.env[credentialEnv] : undefined;
    const proxy =
      credentialEnv === inference.OLLAMA_LOCAL_CREDENTIAL_ENV ? noAuth(endpointUrl!) : null;
    if (proxy) process.env[credentialEnv!] = proxy.credentialValue;
    let proxySettled = proxy === null;
    const restoreUncommittedProxy = () => {
      if (!proxy || proxySettled) return;
      try {
        proxy.restore();
      } finally {
        if (previousProxyCredential === undefined) {
          delete process.env[credentialEnv!];
        } else {
          process.env[credentialEnv!] = previousProxyCredential;
        }
        proxySettled = true;
      }
    };
    try {
      while (true) {
        const resolvedCredentialEnv = credentialEnv || (config && config.credentialEnv);
        const resolvedEndpointUrl = endpointUrl || (config && config.endpointUrl);
        const gatewayEndpointUrl =
          proxy?.baseUrl ?? gatewayReachableCompatibleEndpointUrl(provider, resolvedEndpointUrl);
        let providerResult;
        if (reuseGatewayCredentialWithoutLocalKey) {
          providerResult = await reuseRegisteredProviderWithGatewayEndpoint({
            provider,
            providerType: config.providerType,
            credentialEnv: resolvedCredentialEnv,
            endpointUrl: resolvedEndpointUrl,
            gatewayEndpointUrl,
            runOpenshell,
            upsertProvider,
          });
        } else {
          const credentialValue = hydrateCredentialEnv(resolvedCredentialEnv);
          const env =
            resolvedCredentialEnv && credentialValue
              ? { [resolvedCredentialEnv]: credentialValue }
              : {};
          if (!credentialValue) {
            providerResult = {
              ok: false,
              status: 1,
              message: `A host credential is required to configure provider '${provider}'.`,
            };
          } else if (useOpenAiSurface) {
            // The anthropic-flavor endpoint normalization strips a trailing /v1
            // (core/url-utils), while OpenShell resolves openai_chat_completions
            // to <OPENAI_BASE_URL>/v1/chat/completions, deduping only bases that
            // already end in /v1. Re-add the suffix so the probe and the runtime
            // route exercise the identical URL.
            const openAiSurfaceBaseUrl =
              inference.getCompatibleAnthropicOpenAiSurfaceBaseUrl(resolvedEndpointUrl);
            const surfaceProbe = await probeOpenAiSurface(
              openAiSurfaceBaseUrl,
              model,
              credentialValue,
              {
                skipResponsesProbe: true,
                pinnedAddresses,
                trustedPrivateCapability,
              },
            );
            if (!surfaceProbe.ok) {
              providerResult = {
                ok: false,
                status: 1,
                message: compactText(
                  redact(
                    `The selected agent requires an OpenAI-compatible /v1/chat/completions surface, ` +
                      `but the endpoint did not answer it${surfaceProbe.message ? `: ${surfaceProbe.message}` : "."} ` +
                      `Use an endpoint that also serves /v1/chat/completions, or onboard an agent that ` +
                      `uses the native Anthropic Messages route (for example, OpenClaw).`,
                  ),
                ),
              };
            } else {
              // `provider update` cannot change --type, so a provider left behind
              // by an earlier Anthropic-Messages registration must be replaced.
              const replaced = await replaceStaleAnthropicProviderForOpenAiSurface({
                provider,
                sandboxName,
                runOpenshell,
                providerAdapter: deps.providerAdapter,
                redact,
                compactText,
              });
              providerResult = replaced.ok
                ? await upsertProvider(
                    provider,
                    "openai",
                    resolvedCredentialEnv,
                    openAiSurfaceBaseUrl,
                    env,
                  )
                : {
                    ok: false,
                    status: replaced.status || 1,
                    message: replaced.message ?? `Failed to replace provider '${provider}'.`,
                  };
            }
          } else {
            providerResult = await upsertProvider(
              provider,
              config.providerType,
              resolvedCredentialEnv,
              gatewayEndpointUrl,
              env,
            );
          }
        }
        if (!providerResult.ok) {
          capabilityCache?.invalidate();
          error(`  ${providerResult.message}`);
          if (isNonInteractive()) {
            restoreUncommittedProxy();
            return exitProcess(providerResult.status || 1);
          }
          const retry = await promptValidationRecovery(
            config.label,
            classifyApplyFailure(providerResult.message || ""),
            resolvedCredentialEnv,
            config.helpUrl,
          );
          if (retry === "credential" || retry === "retry") {
            continue;
          }
          if (retry === "selection" || retry === "model") {
            restoreUncommittedProxy();
            return { done: true, result: { retry: "selection" } };
          }
          restoreUncommittedProxy();
          return exitProcess(providerResult.status || 1);
        }
        const argsv = ["inference", "set"];
        if (config.skipVerify || gatewayEndpointUrl !== resolvedEndpointUrl) {
          // Host-side verification cannot resolve the sandbox-only bridge URL.
          argsv.push("--no-verify");
        }
        argsv.push("--provider", provider, "--model", model);
        if (provider === "compatible-endpoint") {
          argsv.push("--timeout", String(LOCAL_INFERENCE_TIMEOUT_SECS));
        }
        const applyResult = runOpenshell(argsv, { ignoreError: true });
        if (applyResult.status === 0) {
          proxy?.persist();
          proxySettled = true;
          break;
        }
        const message =
          compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
          `Failed to configure inference provider '${provider}'.`;
        capabilityCache?.invalidate();
        error(`  ${message}`);
        if (isNonInteractive()) {
          restoreUncommittedProxy();
          return exitProcess(applyResult.status || 1);
        }
        const retry = await promptValidationRecovery(
          config.label,
          classifyApplyFailure(message),
          resolvedCredentialEnv,
          config.helpUrl,
        );
        if (retry === "credential" || retry === "retry") {
          continue;
        }
        if (retry === "selection" || retry === "model") {
          restoreUncommittedProxy();
          return { done: true, result: { retry: "selection" } };
        }
        restoreUncommittedProxy();
        return exitProcess(applyResult.status || 1);
      }
      return { done: false } as const;
    } finally {
      restoreUncommittedProxy();
    }
  };

  return credentialEnv === inference.OLLAMA_LOCAL_CREDENTIAL_ENV
    ? withOllamaProxyLifecycleTransaction(configureProvider)
    : configureProvider();
}
