// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  type RebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";
import {
  setupOllamaLocalInference,
  setupVllmLocalInference,
} from "../../onboard/inference-providers";
import { createLocalInferenceRouteApplier } from "../../onboard/local-inference-route";

const requireDist = createRequire(import.meta.url);
const openshellRuntime = requireDist("../../adapters/openshell/runtime.js") as {
  runOpenshell(
    args: string[],
    options?: Record<string, unknown>,
  ): { status: number | null; stdout?: string; stderr?: string };
};
const onboardProviders = requireDist("../../onboard/providers.js") as {
  upsertProvider(
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: NodeJS.ProcessEnv,
    runOpenshell: typeof openshellRuntime.runOpenshell,
  ): { ok: boolean; status?: number; message?: string };
};

type SetupResult = { done: true; result: unknown } | { done: false };

function upsertLocalProvider(
  name: string,
  type: string,
  credentialEnv: string,
  baseUrl: string | null,
  env: NodeJS.ProcessEnv = {},
) {
  return onboardProviders.upsertProvider(
    name,
    type,
    credentialEnv,
    baseUrl,
    env,
    openshellRuntime.runOpenshell,
  );
}

const unusedCommonInferenceDeps = {
  runOpenshell: openshellRuntime.runOpenshell,
  verifyInferenceRoute: vi.fn(),
  verifyOnboardInferenceSmoke: vi.fn(),
  isNonInteractive: () => true,
  registry: { updateSandbox: vi.fn() },
  error: vi.fn(),
  log: vi.fn(),
  exitProcess: (code: number): never => {
    throw new Error(`EXIT_CALLED:${code}`);
  },
};

const localProviderScenarios = [
  {
    provider: "ollama-local",
    model: "qwen3.5:9b",
    baseUrl: "http://host.openshell.internal:11435/v1",
    credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    setup: (applyLocalInferenceRoute: (provider: string, model: string) => Promise<boolean>) =>
      setupOllamaLocalInference(
        { model: "qwen3.5:9b", provider: "ollama-local", allowToolsIncompatible: false },
        {
          upsertProvider: upsertLocalProvider,
          validateLocalProvider: () => ({ ok: true }),
          getLocalProviderBaseUrl: () => "http://host.openshell.internal:11435/v1",
          applyLocalInferenceRoute,
          getOllamaWarmupCommand: () => ["true"],
          run: () => ({ status: 0 }),
          shouldFrontOllamaWithProxy: () => false,
          ensureOllamaAuthProxy: vi.fn(),
          isProxyHealthy: () => true,
          getOllamaProxyToken: () => "unused-proxy-token",
          persistAndProbeOllamaProxy: async () => undefined,
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
          },
          OLLAMA_PROXY_CREDENTIAL_ENV: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
          ...unusedCommonInferenceDeps,
        },
      ),
  },
  {
    provider: "vllm-local",
    model: "meta-llama/Llama-3.1-8B-Instruct",
    baseUrl: "http://host.openshell.internal:8000/v1",
    credentialEnv: "NEMOCLAW_VLLM_LOCAL_TOKEN",
    setup: (applyLocalInferenceRoute: (provider: string, model: string) => Promise<boolean>) =>
      setupVllmLocalInference(
        { model: "meta-llama/Llama-3.1-8B-Instruct", provider: "vllm-local" },
        {
          upsertProvider: upsertLocalProvider,
          validateLocalProvider: () => ({ ok: true }),
          getLocalProviderHealthCheck: () => ["true"],
          getLocalProviderBaseUrl: () => "http://host.openshell.internal:8000/v1",
          applyLocalInferenceRoute,
          run: () => ({ status: 0 }),
          VLLM_LOCAL_CREDENTIAL_ENV: "NEMOCLAW_VLLM_LOCAL_TOKEN",
          ...unusedCommonInferenceDeps,
        },
      ),
  },
] as const;

function makeRouteApplier() {
  return createLocalInferenceRouteApplier({
    runOpenshell: openshellRuntime.runOpenshell,
    isNonInteractive: () => true,
    promptValidationRecovery: async () => "selection",
    classifyApplyFailure: () => ({ kind: "unknown" }) as never,
    compactText: (value) => value.trim(),
    redact: (value) => value,
    localInferenceTimeoutSecs: 30,
    error: unusedCommonInferenceDeps.error,
    exitProcess: unusedCommonInferenceDeps.exitProcess,
  });
}

beforeEach(resetRebuildFlowTestEnvironment);
afterEach(restoreRebuildFlowTestEnvironment);

describe("rebuild local-provider recreation", () => {
  it.each(
    localProviderScenarios,
  )("recreates a missing $provider gateway provider through the resumed local setup path", async ({
    provider,
    model,
    baseUrl,
    credentialEnv,
    setup,
  }) => {
    let harness!: RebuildFlowHarness;
    let setupResult: SetupResult | undefined;
    harness = createRebuildFlowHarness({
      sandboxEntry: { provider, model, credentialEnv: null },
      onboard: async (session) => {
        const callsBeforeSetup = harness.runOpenshellSpy.mock.calls.map(
          (call) => call[0] as string[],
        );
        expect(callsBeforeSetup).not.toContainEqual(["provider", "get", provider]);
        expect(session.provider).toBe(provider);
        expect(session.model).toBe(model);
        expect(session.steps.provider_selection.status).toBe("pending");
        expect(session.steps.inference.status).toBe("pending");

        setupResult = await setup(makeRouteApplier());
      },
    });
    harness.session.provider = provider;
    harness.session.model = model;
    harness.runOpenshellSpy.mockImplementation((args: string[]) => ({
      status: args[0] === "provider" && args[1] === "get" ? 1 : 0,
      stdout: "",
      stderr: "",
    }));

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    const calls = harness.runOpenshellSpy.mock.calls.map((call) => call[0] as string[]);
    const deleteCall = calls.findIndex(
      (args) => args[0] === "sandbox" && args[1] === "delete" && args[2] === "alpha",
    );
    const providerLookup = calls.findIndex(
      (args) => args[0] === "provider" && args[1] === "get" && args[2] === provider,
    );
    expect(setupResult).toEqual({ done: false });
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ resume: true, nonInteractive: true, recreateSandbox: true }),
    );
    expect(deleteCall).toBeGreaterThanOrEqual(0);
    expect(providerLookup).toBeGreaterThan(deleteCall);
    expect(calls).toContainEqual(["provider", "get", provider]);
    expect(calls).toContainEqual([
      "provider",
      "create",
      "--name",
      provider,
      "--type",
      "openai",
      "--credential",
      credentialEnv,
      "--config",
      `OPENAI_BASE_URL=${baseUrl}`,
    ]);
    expect(calls).toContainEqual([
      "inference",
      "set",
      "--no-verify",
      "--provider",
      provider,
      "--model",
      model,
      "--timeout",
      "30",
    ]);
    expect(calls.some((args) => args[0] === "provider" && args[1] === "update")).toBe(false);
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      "/tmp/nemoclaw-rebuild-backup",
      { targetAgentType: "openclaw" },
    );
  });
});
