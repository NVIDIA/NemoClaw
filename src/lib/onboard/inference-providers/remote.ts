// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Remote provider inference setup flow (NVIDIA, OpenAI, Anthropic, Gemini,
// compatible endpoints, Bedrock Runtime). Extracted verbatim from
// onboard.setupInference (#767). Bedrock Runtime is delegated to
// `onboard/bedrock-runtime.ts` exactly as the inline branch did.

import { getCompatibleAnthropicOpenAiSurfaceBaseUrl } from "../../inference/config";
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

type StaleProviderReplaceResult = { ok: boolean; status?: number | null; message?: string };

// #5744: keep host-side validation on the user-entered loopback URL, but
// register the sandbox route through OpenShell's host bridge. Remove this when
// OpenShell can verify provider routes from the sandbox/gateway network context.
function gatewayReachableCompatibleEndpointUrl(
  provider: string,
  endpointUrl: string | null | undefined,
): string | null | undefined {
  if (provider !== "compatible-endpoint" || !endpointUrl) return endpointUrl;
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return endpointUrl;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname.includes("%")) return endpointUrl;
  const port = parsed.port ? Number(parsed.port) : null;
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    !isLoopback ||
    (port !== null && (!Number.isInteger(port) || port < 1024))
  ) {
    return endpointUrl;
  }
  parsed.hostname = "host.openshell.internal";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname || "/";
  return parsed.pathname === "/" ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
}

/**
 * Replace a provider that a prior Anthropic-Messages registration left behind
 * so it can be re-registered as `type=openai` for the OpenAI-compatible route
 * (`provider update` cannot change `--type`).
 *
 * Security containment: force-detach recovery may only touch the sandbox being
 * onboarded. The authorized set is exactly the confirmed `sandboxName`; every
 * attachment reported by the delete failure is revalidated against it before
 * any detach, and the same set is threaded into `removeGatewayProvider` so its
 * own re-parse also fails closed on an outside sandbox. With no confirmed
 * sandbox (`sandboxName === null`) there is nothing to authorize against, so
 * force-detach recovery is refused with an actionable error rather than run
 * unconstrained. A provider still attached to other live sandboxes fails closed
 * too — flipping its type would silently break their Anthropic routing.
 */
function replaceStaleAnthropicProviderForOpenAiSurface(args: {
  provider: string;
  sandboxName: string | null;
  runOpenshell: RemoteProviderDeps["runOpenshell"];
  readProviderMetadata: NonNullable<RemoteProviderDeps["readGatewayProviderMetadata"]>;
  removeGatewayProvider: NonNullable<RemoteProviderDeps["deleteGatewayProvider"]>;
  redact: RemoteProviderDeps["redact"];
  compactText: RemoteProviderDeps["compactText"];
}): StaleProviderReplaceResult {
  const {
    provider,
    sandboxName,
    runOpenshell,
    readProviderMetadata,
    removeGatewayProvider,
    redact,
    compactText,
  } = args;
  const live = readProviderMetadata(provider, runOpenshell);
  if (!live || live.type === "openai") return { ok: true };
  const attempt = runOpenshell(["provider", "delete", provider], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (attempt.status === 0) return { ok: true };
  const raw = `${attempt.stderr || ""}\n${attempt.stdout || ""}`;
  const attached = parseAttachedSandboxes(raw);
  const allowedSandboxes = sandboxName === null ? [] : [sandboxName];
  const foreign = attached.filter((name) => !allowedSandboxes.includes(name));
  if (sandboxName === null && attached.length > 0) {
    return {
      ok: false,
      status: attempt.status ?? 1,
      message:
        `Provider '${provider}' is attached to sandbox(es) (${attached.join(", ")}) ` +
        `but no target sandbox was confirmed, so it cannot be safely force-detached ` +
        `and re-registered for the OpenAI-compatible route. Re-run onboarding with an ` +
        `explicit sandbox, or remove those sandboxes first.`,
    };
  }
  if (attached.length > 0 && foreign.length === 0) {
    const recovery = removeGatewayProvider(provider, { runOpenshell, allowedSandboxes });
    const detail = compactText(redact(`${recovery.stderr || ""} ${recovery.stdout || ""}`));
    return recovery.ok
      ? { ok: true }
      : {
          ok: false,
          status: recovery.status ?? 1,
          message: `Failed to replace provider '${provider}' for the OpenAI-compatible route${detail ? `: ${detail}` : "."}`,
        };
  }
  if (foreign.length > 0) {
    return {
      ok: false,
      status: attempt.status ?? 1,
      message:
        `Provider '${provider}' is attached to other sandbox(es) (${foreign.join(", ")}) ` +
        `and cannot be re-registered for the OpenAI-compatible route without breaking ` +
        `their Anthropic Messages routing. Onboard this agent against a dedicated ` +
        `endpoint or remove those sandboxes first.`,
    };
  }
  const detail = compactText(redact(raw));
  return {
    ok: false,
    status: attempt.status ?? 1,
    message: `Failed to replace provider '${provider}' for the OpenAI-compatible route${detail ? `: ${detail}` : "."}`,
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
    preferredInferenceApi?: string | null;
    pinnedAddresses?: readonly string[];
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
    pinnedAddresses,
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
    const gatewayEndpointUrl = gatewayReachableCompatibleEndpointUrl(provider, resolvedEndpointUrl);
    let providerResult;
    if (reuseGatewayCredentialWithoutLocalKey) {
      // This is only a last-moment existence probe. The primary authorization
      // of the provider's non-secret credential/config binding identity is
      // assessRecoveredProviderCredentialReuse in recovered-provider-reuse.ts.
      const existing = runOpenshell(["provider", "get", provider], {
        ignoreError: true,
        suppressOutput: true,
      });
      if (existing.status !== 0) {
        providerResult = {
          ok: false,
          status: existing.status || 1,
          message: `Recovered provider '${provider}' is no longer registered in OpenShell.`,
        };
      } else if (gatewayEndpointUrl !== resolvedEndpointUrl) {
        providerResult = upsertProvider(
          provider,
          config.providerType,
          resolvedCredentialEnv,
          gatewayEndpointUrl,
          {},
        );
      } else {
        providerResult = { ok: true };
      }
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
          getCompatibleAnthropicOpenAiSurfaceBaseUrl(resolvedEndpointUrl);
        const surfaceProbe = probeOpenAiSurface(openAiSurfaceBaseUrl, model, credentialValue, {
          skipResponsesProbe: true,
          pinnedAddresses,
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
                  `uses the native Anthropic Messages route (for example, OpenClaw).`,
              ),
            ),
          };
        } else {
          // `provider update` cannot change --type, so a provider left behind
          // by an earlier Anthropic-Messages registration must be replaced.
          const replaced = replaceStaleAnthropicProviderForOpenAiSurface({
            provider,
            sandboxName,
            runOpenshell,
            readProviderMetadata,
            removeGatewayProvider,
            redact,
            compactText,
          });
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
          gatewayEndpointUrl,
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
