// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Routes that carry NEMOCLAW_LOCAL_INFERENCE_TIMEOUT to `openshell inference set
// --timeout` used to fail after the provider update with a generic route error
// when the value was outside 1..3600 (#13734). Routes that do not carry it must
// keep accepting any value.

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSetupInference, type SetupInferenceDeps } from "./setup-inference";

vi.mock("./sandbox-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-lifecycle")>()),
  releaseAbandonedRouteReservation: vi.fn(() => false),
}));

class StepReached extends Error {}

function harness() {
  const upsertProvider = vi.fn(async () => ({ ok: true }));
  const setInferenceRoute = vi.fn(async () => ({ ok: true as const }));
  const error = vi.fn();
  const step = vi.fn((_index: number) => {
    throw new StepReached();
  });
  const setupInference = createSetupInference({
    checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
    withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    step,
    getGatewayName: () => "nemoclaw",
    getSandbox: () => null,
    inferenceRouteObserver: {
      observeInferenceRoute: vi.fn(async () => ({
        ok: true as const,
        value: { state: "unconfigured" as const },
      })),
    },
    inferenceRouteMutator: { setInferenceRoute },
    upsertProvider,
    isNonInteractive: () => true,
    hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
    log: vi.fn(),
    error,
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  } as unknown as SetupInferenceDeps);
  return { setupInference, upsertProvider, setInferenceRoute, error, step };
}

describe("setup inference local timeout range (#13734)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["3601", "7200", "0"])(
    "rejects %s for a compatible endpoint before any provider or route change",
    async (value) => {
      vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", value);
      const { setupInference, upsertProvider, setInferenceRoute, error, step } = harness();

      await expect(
        setupInference(
          "test-a",
          "qwen2.5:1.5b",
          "compatible-endpoint",
          "http://localhost:11434/v1",
          "NEMOCLAW_OLLAMA_PROXY_TOKEN",
          null,
          [],
          { preferredInferenceApi: "openai-completions" },
        ),
      ).rejects.toThrow("exit 1");

      expect(error).toHaveBeenCalledWith(
        `  Error: NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must be from 1 to 3600 seconds; got "${value}".`,
      );
      expect(step).not.toHaveBeenCalled();
      expect(upsertProvider).not.toHaveBeenCalled();
      expect(setInferenceRoute).not.toHaveBeenCalled();
    },
  );

  it("rejects 7200 for a Bedrock Runtime adapter route before any provider or route change", async () => {
    // The Personal tier keeps a hosted custom endpoint off the native custom path.
    vi.stubEnv("NEMOCLAW_POLICY_TIER", "personal");
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "7200");
    const { setupInference, upsertProvider, setInferenceRoute, error, step } = harness();

    await expect(
      setupInference(
        "test-a",
        "anthropic.claude",
        "compatible-anthropic-endpoint",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        "COMPATIBLE_ANTHROPIC_API_KEY",
        null,
        [],
        { preferredInferenceApi: "anthropic-messages" },
      ),
    ).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith(
      '  Error: NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must be from 1 to 3600 seconds; got "7200".',
    );
    expect(step).not.toHaveBeenCalled();
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(setInferenceRoute).not.toHaveBeenCalled();
  });

  it("does not check the timeout for OpenRouter, which onboards as a native hosted provider", async () => {
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "7200");
    const { setupInference, error, step } = harness();

    await expect(
      setupInference(
        "test-a",
        "openai/gpt-5",
        "openrouter-api",
        null,
        "OPENROUTER_API_KEY",
        null,
        [],
        { preferredInferenceApi: "openai-completions" },
      ),
    ).rejects.toBeInstanceOf(StepReached);
    expect(step).toHaveBeenCalledWith(4, 8, "Setting up inference provider");
    expect(error).not.toHaveBeenCalled();
  });

  it("continues to provider setup with the largest supported timeout", async () => {
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "3600");
    const { setupInference, error, step } = harness();

    await expect(
      setupInference(
        "test-a",
        "qwen2.5:1.5b",
        "compatible-endpoint",
        "http://localhost:11434/v1",
        "NEMOCLAW_OLLAMA_PROXY_TOKEN",
        null,
        [],
        { preferredInferenceApi: "openai-completions" },
      ),
    ).rejects.toBeInstanceOf(StepReached);
    expect(step).toHaveBeenCalledWith(4, 8, "Setting up inference provider");
    expect(error).not.toHaveBeenCalled();
  });

  it("does not check the timeout for a route that does not carry it", async () => {
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "7200");
    const { setupInference, error, step } = harness();

    await expect(
      setupInference(
        "test-a",
        "claude-sonnet-5-5",
        "compatible-anthropic-endpoint",
        "http://localhost:8000",
        "COMPATIBLE_ANTHROPIC_API_KEY",
        null,
        [],
        { preferredInferenceApi: "anthropic-messages" },
      ),
    ).rejects.toBeInstanceOf(StepReached);
    expect(step).toHaveBeenCalledWith(4, 8, "Setting up inference provider");
    expect(error).not.toHaveBeenCalled();
  });
});
