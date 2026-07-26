// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compactText } from "../core/url-utils";
import { OPENROUTER_CREDENTIAL_ENV, OPENROUTER_PROVIDER_NAME } from "../inference/openrouter";
import { ensureOpenRouterRuntimeAdapter } from "../inference/openrouter-runtime-adapter";
import { redact } from "../runner";
import * as registry from "../state/registry";
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

type SetupInferenceResult = { ok: true; retry?: undefined } | { retry: "selection" };

type OpenRouterRuntimeDependencies = {
  exitProcess: (code: number) => never;
  error: (message: string) => void;
  log: (message: string) => void;
};

// TODO: Replace this NemoClaw runtime-adapter workaround when OpenShell exposes
// L7 middleware/default-header injection for provider routes. OpenRouter needs
// static HTTP-Referer and X-OpenRouter-Title headers at runtime, and today's
// OpenShell OpenAI-compatible profile cannot configure those per provider.
export async function setupOpenRouterRuntimeInference(
  options: {
    sandboxName: string | null;
    provider: string;
    model: string;
    credentialEnv: string | null;
    credentialValue: string | null;
    reuseGatewayCredentialWithoutLocalKey?: boolean;
    skipHostInferenceSmoke?: boolean;
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
    }) => void | Promise<void>;
    ensureAdapter?: typeof ensureOpenRouterRuntimeAdapter;
    updateSandbox?: typeof registry.updateSandbox;
  } & OpenRouterRuntimeDependencies,
): Promise<{ handled: false } | { handled: true; result: SetupInferenceResult }> {
  const { error, exitProcess, log } = options;
  if (options.provider !== OPENROUTER_PROVIDER_NAME) return { handled: false };

  const credentialEnv = options.credentialEnv || OPENROUTER_CREDENTIAL_ENV;
  if (!options.credentialValue && !options.reuseGatewayCredentialWithoutLocalKey) {
    error(`  ${credentialEnv} is required to configure OpenRouter.`);
    if (options.isNonInteractive()) return exitProcess(1);
    return { handled: true, result: { retry: "selection" } };
  }

  let adapter: Awaited<ReturnType<typeof ensureOpenRouterRuntimeAdapter>>;
  try {
    adapter = await (options.ensureAdapter ?? ensureOpenRouterRuntimeAdapter)({
      authorizationToken: options.credentialValue,
    });
  } catch (err) {
    error(
      `  Failed to start OpenRouter Runtime adapter: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (options.isNonInteractive()) return exitProcess(1);
    return { handled: true, result: { retry: "selection" } };
  }

  const env = options.credentialValue ? { [credentialEnv]: options.credentialValue } : {};
  const providerResult = options.upsertProvider(
    options.provider,
    "openai",
    credentialEnv,
    adapter.baseUrl,
    env,
  );
  if (!providerResult.ok) {
    error(`  ${providerResult.message}`);
    if (options.isNonInteractive()) return exitProcess(providerResult.status || 1);
    return { handled: true, result: { retry: "selection" } };
  }
  log(
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
      compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
      `Failed to configure inference provider '${options.provider}'.`;
    error(`  ${message}`);
    if (options.isNonInteractive()) return exitProcess(applyResult.status || 1);
    return { handled: true, result: { retry: "selection" } };
  }

  options.verifyInferenceRoute(options.provider, options.model);
  if (options.skipHostInferenceSmoke === true || !options.credentialValue) {
    log("  Reusing existing gateway credential; skipping host inference smoke.");
  } else {
    await options.verifyOnboardInferenceSmoke({
      provider: options.provider,
      model: options.model,
      endpointUrl: adapter.localBaseUrl,
      credentialEnv,
      forceOpenAiLike: true,
    });
  }
  if (options.sandboxName) {
    (options.updateSandbox ?? registry.updateSandbox)(options.sandboxName, {
      model: options.model,
      provider: options.provider,
    });
  }
  log(`  ✓ Inference route set: ${options.provider} / ${options.model}`);
  return { handled: true, result: { ok: true } };
}
