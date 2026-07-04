// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Remote provider inference setup flow (NVIDIA, OpenAI, Anthropic, Gemini,
// compatible endpoints, Bedrock Runtime). Extracted verbatim from
// onboard.setupInference (#767). Bedrock Runtime is delegated to
// `onboard/bedrock-runtime.ts` exactly as the inline branch did.

import type { RemoteProviderDeps, SetupInferenceResult } from "./types";

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
  } = args;
  const {
    runOpenshell,
    upsertProvider,
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    isNonInteractive,
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
    console.error(`  Unsupported provider configuration: ${provider}`);
    process.exit(1);
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
  });
  if (bedrockSetup.handled) return { done: true, result: bedrockSetup.result };
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
      providerResult = credentialValue
        ? upsertProvider(
            provider,
            config.providerType,
            resolvedCredentialEnv,
            resolvedEndpointUrl,
            env,
          )
        : {
            ok: false,
            status: 1,
            message: `A host credential is required to configure provider '${provider}'.`,
          };
    }
    if (!providerResult.ok) {
      console.error(`  ${providerResult.message}`);
      if (isNonInteractive()) {
        process.exit(providerResult.status || 1);
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
      process.exit(providerResult.status || 1);
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
    console.error(`  ${message}`);
    if (isNonInteractive()) {
      process.exit(applyResult.status || 1);
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
    process.exit(applyResult.status || 1);
  }
  return { done: false };
}
