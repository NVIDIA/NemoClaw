// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Remote provider inference setup flow (NVIDIA, OpenAI, Anthropic, Gemini,
// compatible endpoints, Bedrock Runtime). Extracted verbatim from
// onboard.setupInference (#767). Bedrock Runtime is delegated to
// `onboard/bedrock-runtime.ts` exactly as the inline branch did.

import { readGatewayProviderMetadata } from "../gateway-provider-metadata";
import { deleteProviderWithRecovery, parseAttachedSandboxes } from "../sandbox-provider-cleanup";
import type { RemoteProviderDeps, SetupInferenceResult } from "./types";

const { probeOpenAiLikeEndpoint } = require("../../inference/onboard-probes") as {
  probeOpenAiLikeEndpoint: (
    endpointUrl: string,
    model: string,
    apiKey: string,
    options?: Record<string, unknown>,
  ) => { ok: boolean; message?: string };
};

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
    preferredInferenceApi?: string | null;
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
    preferredInferenceApi,
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
  // #6294: an OpenAI-/chat/completions-only agent (dcode) coerced off Anthropic
  // Messages must talk to the gateway route over the openai_chat_completions
  // protocol, and OpenShell routes that protocol only for providers registered
  // with type=openai. Verify the endpoint actually serves the OpenAI surface
  // before registering it as such; endpoints that answer only /v1/messages get
  // an actionable onboarding failure instead of a sandbox that cannot infer.
  // Bedrock endpoints never reach here — the adapter branch above returns first.
  const useOpenAiSurface =
    provider === "compatible-anthropic-endpoint" && preferredInferenceApi === "openai-completions";
  const probeOpenAiSurface = deps.probeOpenAiLikeEndpoint ?? probeOpenAiLikeEndpoint;
  // The concrete modules type their openshell runners independently; the deps
  // runner is call-compatible with both, so bridge the nominal mismatch here.
  const readProviderMetadata =
    deps.readGatewayProviderMetadata ??
    (readGatewayProviderMetadata as unknown as NonNullable<
      RemoteProviderDeps["readGatewayProviderMetadata"]
    >);
  const removeGatewayProvider =
    deps.deleteGatewayProvider ??
    (deleteProviderWithRecovery as unknown as NonNullable<
      RemoteProviderDeps["deleteGatewayProvider"]
    >);
  while (true) {
    const resolvedCredentialEnv = credentialEnv || (config && config.credentialEnv);
    const resolvedEndpointUrl = endpointUrl || (config && config.endpointUrl);
    let providerResult;
    if (reuseGatewayCredentialWithoutLocalKey) {
      // This is only a last-moment existence probe. The primary authorization
      // of the provider's non-secret credential/config binding identity is
      // assessRecoveredProviderCredentialReuse in recovered-provider-reuse.ts.
      const existing = runOpenshell(["provider", "get", provider], {
        ignoreError: true,
        suppressOutput: true,
      });
      providerResult =
        existing.status === 0
          ? { ok: true }
          : {
              ok: false,
              status: existing.status || 1,
              message: `Recovered provider '${provider}' is no longer registered in OpenShell.`,
            };
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
        const trimmedSurfaceBase = String(resolvedEndpointUrl ?? "").replace(/\/+$/, "");
        const openAiSurfaceBaseUrl = trimmedSurfaceBase.endsWith("/v1")
          ? trimmedSurfaceBase
          : `${trimmedSurfaceBase}/v1`;
        const surfaceProbe = probeOpenAiSurface(openAiSurfaceBaseUrl, model, credentialValue, {
          skipResponsesProbe: true,
        });
        if (!surfaceProbe.ok) {
          providerResult = {
            ok: false,
            status: 1,
            message: compactText(
              redact(
                `The selected agent requires an OpenAI-compatible /v1/chat/completions surface, ` +
                  `but the endpoint did not answer it${surfaceProbe.message ? `: ${surfaceProbe.message}` : "."} ` +
                  `Use an endpoint that also serves /v1/chat/completions, or onboard an agent that ` +
                  `supports the Anthropic Messages API (e.g. openclaw or hermes).`,
              ),
            ),
          };
        } else {
          // `provider update` cannot change --type, so a provider left behind
          // by an earlier Anthropic-Messages registration must be replaced.
          // Containment: force-detach recovery may only touch the sandbox
          // being onboarded — flipping a provider that other live sandboxes
          // are attached to would silently break their Anthropic routing, so
          // that case fails closed with an actionable message instead.
          const live = readProviderMetadata(provider, runOpenshell);
          let replaced: { ok: boolean; status?: number | null; message?: string } = { ok: true };
          if (live && live.type !== "openai") {
            const attempt = runOpenshell(["provider", "delete", provider], {
              ignoreError: true,
              suppressOutput: true,
            });
            if (attempt.status !== 0) {
              const raw = `${attempt.stderr || ""}\n${attempt.stdout || ""}`;
              const attached = parseAttachedSandboxes(raw);
              const foreign = attached.filter((name) => name !== sandboxName);
              if (attached.length > 0 && foreign.length === 0) {
                const recovery = removeGatewayProvider(provider, { runOpenshell });
                replaced = recovery.ok
                  ? { ok: true }
                  : {
                      ok: false,
                      status: recovery.status ?? 1,
                      message:
                        `Failed to replace provider '${provider}' for the OpenAI-compatible route` +
                        `${compactText(redact(`${recovery.stderr || ""} ${recovery.stdout || ""}`)) ? `: ${compactText(redact(`${recovery.stderr || ""} ${recovery.stdout || ""}`))}` : "."}`,
                    };
              } else if (foreign.length > 0) {
                replaced = {
                  ok: false,
                  status: attempt.status ?? 1,
                  message:
                    `Provider '${provider}' is attached to other sandbox(es) (${foreign.join(", ")}) ` +
                    `and cannot be re-registered for the OpenAI-compatible route without breaking ` +
                    `their Anthropic Messages routing. Onboard this agent against a dedicated ` +
                    `endpoint or remove those sandboxes first.`,
                };
              } else {
                replaced = {
                  ok: false,
                  status: attempt.status ?? 1,
                  message:
                    `Failed to replace provider '${provider}' for the OpenAI-compatible route` +
                    `${compactText(redact(raw)) ? `: ${compactText(redact(raw))}` : "."}`,
                };
              }
            }
          }
          providerResult = replaced.ok
            ? upsertProvider(provider, "openai", resolvedCredentialEnv, openAiSurfaceBaseUrl, env)
            : {
                ok: false,
                status: replaced.status || 1,
                message: replaced.message ?? `Failed to replace provider '${provider}'.`,
              };
        }
      } else {
        providerResult = upsertProvider(
          provider,
          config.providerType,
          resolvedCredentialEnv,
          resolvedEndpointUrl,
          env,
        );
      }
    }
    if (!providerResult.ok) {
      error(`  ${providerResult.message}`);
      if (isNonInteractive()) {
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
        return { done: true, result: { retry: "selection" } };
      }
      return exitProcess(providerResult.status || 1);
    }
    const argsv = ["inference", "set"];
    if (config.skipVerify) {
      argsv.push("--no-verify");
    }
    argsv.push("--provider", provider, "--model", model);
    if (provider === "compatible-endpoint") {
      argsv.push("--timeout", String(LOCAL_INFERENCE_TIMEOUT_SECS));
    }
    const applyResult = runOpenshell(argsv, { ignoreError: true });
    if (applyResult.status === 0) {
      break;
    }
    const message =
      compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
      `Failed to configure inference provider '${provider}'.`;
    error(`  ${message}`);
    if (isNonInteractive()) {
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
      return { done: true, result: { retry: "selection" } };
    }
    return exitProcess(applyResult.status || 1);
  }
  return { done: false };
}
