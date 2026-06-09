// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Hermes Provider inference setup flow.
// Extracted verbatim from onboard.setupInference (#767).

import type { HermesAuthMethod } from "../hermes-auth";
import type { HermesDeps, SetupInferenceResult } from "./types";

export async function setupHermesProviderInference(
  args: {
    sandboxName: string | null;
    model: string;
    provider: string;
    endpointUrl: string | null;
    credentialEnv: string | null;
    hermesAuthMethod: HermesAuthMethod | string | null;
    hermesToolGateways: string[];
  },
  deps: HermesDeps,
): Promise<SetupInferenceResult> {
  const {
    sandboxName,
    model,
    provider,
    endpointUrl,
    credentialEnv,
    hermesAuthMethod,
    hermesToolGateways,
  } = args;
  const {
    runOpenshell,
    upsertProvider: _upsertProvider, // intentionally unused; matches inline branch
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    isNonInteractive,
    registry,
    hermesProviderAuth,
    getHermesToolGatewayBroker,
    providerExistsInGateway,
    normalizeHermesAuthMethod,
    resolveHermesNousApiKey,
    checkHermesProviderStoreReachable,
    hermesAuthMethodLabel,
    hermesConstants: {
      HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
      HERMES_AUTH_METHOD_API_KEY,
      HERMES_AUTH_METHOD_OAUTH,
    },
    requireValue,
    redact,
    compactText,
  } = deps;
  void _upsertProvider;

  const targetSandbox = requireValue(sandboxName, "Hermes Provider requires a sandbox name");
  const resolvedHermesAuthMethod =
    normalizeHermesAuthMethod(hermesAuthMethod) ||
    (credentialEnv === HERMES_NOUS_API_KEY_CREDENTIAL_ENV
      ? HERMES_AUTH_METHOD_API_KEY
      : HERMES_AUTH_METHOD_OAUTH);
  const providerStore = checkHermesProviderStoreReachable(runOpenshell);
  if (!providerStore.ok) {
    console.error("  ✗ OpenShell provider storage is unreachable.");
    console.error(`    ${providerStore.message}`);
    console.error("    Restart or recreate the OpenShell gateway, then rerun onboarding.");
    if (isNonInteractive()) process.exit(1);
    return { retry: "selection" };
  }
  const providerRegistered = hermesProviderAuth.isHermesProviderRegistered(runOpenshell);
  const toolGatewayProviderRegistered =
    hermesToolGateways.length === 0
      ? true
      : providerExistsInGateway(
          getHermesToolGatewayBroker().getHermesToolGatewayProviderName(targetSandbox),
        );
  const hasFreshNousApiKey =
    resolvedHermesAuthMethod === HERMES_AUTH_METHOD_API_KEY && !!resolveHermesNousApiKey();
  const shouldPrepareHermesCredentials =
    !providerRegistered ||
    !toolGatewayProviderRegistered ||
    hasFreshNousApiKey ||
    (resolvedHermesAuthMethod === HERMES_AUTH_METHOD_OAUTH && !isNonInteractive());
  if (shouldPrepareHermesCredentials) {
    try {
      const state =
        resolvedHermesAuthMethod === HERMES_AUTH_METHOD_API_KEY
          ? await hermesProviderAuth.ensureHermesProviderApiKeyCredentials(targetSandbox, {
              apiKey: resolveHermesNousApiKey(),
              runOpenshell,
              baseUrl: endpointUrl || undefined,
            })
          : await hermesProviderAuth.ensureHermesProviderOAuthCredentials(targetSandbox, {
              allowInteractiveLogin: !isNonInteractive(),
              runOpenshell,
              baseUrl: endpointUrl || undefined,
              toolGatewayPresets: hermesToolGateways,
            });
      if (!state) {
        const authLabel = hermesAuthMethodLabel(resolvedHermesAuthMethod);
        console.error(`  ✗ Hermes Provider ${authLabel} is not available on the host.`);
        console.error(
          "    Re-run `nemoclaw onboard --agent hermes` interactively to configure credentials.",
        );
        process.exit(1);
      }
    } catch (err) {
      console.error(
        `  ✗ Failed to prepare Hermes Provider credentials: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (isNonInteractive()) process.exit(1);
      return { retry: "selection" };
    }
  }

  const applyResult = runOpenshell(
    ["inference", "set", "--no-verify", "--provider", provider, "--model", model],
    { ignoreError: true },
  );
  if (applyResult.status !== 0) {
    const message =
      compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
      `Failed to configure inference provider '${provider}'.`;
    console.error(`  ${message}`);
    if (isNonInteractive()) process.exit(applyResult.status || 1);
    return { retry: "selection" };
  }

  verifyInferenceRoute(provider, model);
  verifyOnboardInferenceSmoke({ provider, model, endpointUrl, credentialEnv });
  if (sandboxName) {
    registry.updateSandbox(sandboxName, { model, provider });
  }
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);
  return { ok: true };
}
