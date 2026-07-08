// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compactText } from "../core/url-utils";
import {
  OPENROUTER_CREDENTIAL_ENV,
  OPENROUTER_PROVIDER_NAME,
  OPENROUTER_PROVIDER_TYPE,
} from "../inference/openrouter";
import {
  ensureOpenRouterRuntimeAdapter,
  openRouterRuntimeAuthorizationHash,
} from "../inference/openrouter-runtime-adapter";
import type { SetupInferenceResult } from "./inference-providers/types";
import { LOCAL_INFERENCE_TIMEOUT_SECS } from "./env";

type RunOpenshell = (
  args: string[],
  options?: { ignoreError?: boolean; suppressOutput?: boolean; timeout?: number },
) => { status: number | null; stdout?: unknown; stderr?: unknown };

type UpsertProvider = (
  name: string,
  type: string,
  credentialEnv: string,
  baseUrl: string | null,
  env?: NodeJS.ProcessEnv,
) => { ok: boolean; message?: string; status?: number };

type OpenRouterRuntimeDependencies = {
  exitProcess: (code: number) => never;
  error: (message: string) => void;
  log: (message: string) => void;
  redact: (input: string) => string;
  hydrateCredentialEnv: (envName: string) => string | null;
};

function normalizeCredentialEnv(value: string | null | undefined): string {
  return String(value || "").trim() || OPENROUTER_CREDENTIAL_ENV;
}

export function needsOpenRouterRuntimeAdapter(provider: string | null | undefined): boolean {
  return provider === OPENROUTER_PROVIDER_NAME;
}

// TODO(OpenShell middleware): This onboarding path is a temporary bridge for
// OpenRouter's required attribution headers. Once OpenShell supports
// provider-route middleware for extra outbound headers, register OpenRouter
// directly through that capability and remove the local runtime adapter.
export async function setupOpenRouterRuntimeInference(
  options: {
    sandboxName: string | null;
    provider: string;
    model: string;
    credentialEnv: string | null;
    reuseGatewayCredentialWithoutLocalKey?: boolean;
    isNonInteractive: () => boolean;
    runOpenshell: RunOpenshell;
    upsertProvider: UpsertProvider;
    verifyInferenceRoute: (provider: string, model: string) => void;
    verifyOnboardInferenceSmoke: (options: {
      provider: string;
      model: string;
      endpointUrl?: string | null;
      credentialEnv?: string | null;
      forceOpenAiLike?: boolean;
    }) => void;
    ensureAdapter?: typeof ensureOpenRouterRuntimeAdapter;
    updateSandbox?: (name: string, updates: { model: string; provider: string }) => unknown;
  } & OpenRouterRuntimeDependencies,
): Promise<{ handled: false } | { handled: true; result: SetupInferenceResult }> {
  if (!needsOpenRouterRuntimeAdapter(options.provider)) return { handled: false };

  const credentialEnv = normalizeCredentialEnv(options.credentialEnv);
  const credentialValue = options.reuseGatewayCredentialWithoutLocalKey
    ? null
    : options.hydrateCredentialEnv(credentialEnv);
  if (!options.reuseGatewayCredentialWithoutLocalKey && !credentialValue) {
    options.error(`  A host credential is required to configure provider '${options.provider}'.`);
    if (options.isNonInteractive()) return options.exitProcess(1);
    return { handled: true, result: { retry: "selection" } };
  }

  let adapter: Awaited<ReturnType<typeof ensureOpenRouterRuntimeAdapter>>;
  try {
    adapter = await (options.ensureAdapter ?? ensureOpenRouterRuntimeAdapter)({
      authorizationHash: credentialValue
        ? openRouterRuntimeAuthorizationHash(credentialValue)
        : undefined,
    });
  } catch (err) {
    options.error(
      `  Failed to start OpenRouter Runtime adapter: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (options.isNonInteractive()) return options.exitProcess(1);
    return { handled: true, result: { retry: "selection" } };
  }

  const providerResult = options.upsertProvider(
    options.provider,
    OPENROUTER_PROVIDER_TYPE,
    credentialEnv,
    adapter.baseUrl,
    credentialValue ? { [credentialEnv]: credentialValue } : {},
  );
  if (!providerResult.ok) {
    options.error(`  ${providerResult.message}`);
    if (options.isNonInteractive()) return options.exitProcess(providerResult.status || 1);
    return { handled: true, result: { retry: "selection" } };
  }
  options.log(
    `  OpenRouter Runtime adapter ready: sandbox route ${adapter.baseUrl}, host log ${adapter.logPath}`,
  );

  const applyResult = options.runOpenshell(
    [
      "inference",
      "set",
      "--no-verify",
      "--provider",
      options.provider,
      "--model",
      options.model,
      "--timeout",
      String(LOCAL_INFERENCE_TIMEOUT_SECS),
    ],
    { ignoreError: true },
  );
  if (applyResult.status !== 0) {
    const message =
      compactText(options.redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
      `Failed to configure inference provider '${options.provider}'.`;
    options.error(`  ${message}`);
    if (options.isNonInteractive()) return options.exitProcess(applyResult.status || 1);
    return { handled: true, result: { retry: "selection" } };
  }

  options.verifyInferenceRoute(options.provider, options.model);
  options.verifyOnboardInferenceSmoke({
    provider: options.provider,
    model: options.model,
    endpointUrl: adapter.localBaseUrl,
    credentialEnv,
    forceOpenAiLike: true,
  });
  if (options.sandboxName) {
    options.updateSandbox?.(options.sandboxName, {
      model: options.model,
      provider: options.provider,
    });
  }
  options.log(`  ✓ Inference route set: ${options.provider} / ${options.model}`);
  return { handled: true, result: { ok: true } };
}
