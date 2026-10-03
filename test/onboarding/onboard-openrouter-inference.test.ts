// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createNativeSetupProviderAdapter } from "../helpers/onboard-split-context";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";
import {
  createDirectSetupInferenceHarnessFactory,
  withProcessEnv,
} from "../support/setup-inference-test-harness.js";

const onboard = require("../../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const openrouterRuntimeOnboard =
  require("../../src/lib/onboard/openrouter-runtime") as typeof import("../../src/lib/onboard/openrouter-runtime.js");

const createDirectSetupInferenceHarness = createDirectSetupInferenceHarnessFactory(
  onboard.createSetupInference,
);
describe("OpenRouter onboarding inference setup", () => {
  it("configures fixed OpenRouter without the runtime header adapter (#12589)", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: "sk-or-test" }, async () => {
      const providerAdapter = createNativeSetupProviderAdapter("openrouter-api", false);
      const setupOpenRouterRuntimeInference = vi.fn(async () => ({ handled: false as const }));
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          isNonInteractive: () => true,
          providerAdapter,
          openrouterRuntimeOnboard: { setupOpenRouterRuntimeInference },
        },
      });
      await harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "openrouter-api",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
      );
      expect(providerAdapter.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "nemoclaw-openrouter-api-v1",
          type: "nemoclaw-openrouter-inference-v1",
          credentials: [{ name: "OPENROUTER_API_KEY", value: "sk-or-test" }],
          config: [],
        }),
      );
      expect(setupOpenRouterRuntimeInference).not.toHaveBeenCalled();
      expect(harness.commands).toEqual([]);
      expect(harness.verifyInferenceRoute).not.toHaveBeenCalled();
      expect(harness.verifyOnboardInferenceSmoke).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openrouter-api",
          model: "moonshotai/kimi-k2.6",
          endpointUrl: "https://openrouter.ai/api/v1",
          credentialEnv: "OPENROUTER_API_KEY",
        }),
      );
      expect(harness.updateSandbox).toHaveBeenCalledWith(
        "test-box",
        expect.objectContaining({
          provider: "openrouter-api",
          endpointUrl: "https://openrouter.ai/api/v1",
          nativeHostedProviderAttachment: {
            schemaVersion: 1,
            profileId: "nemoclaw-openrouter-inference-v1",
            providerName: "nemoclaw-openrouter-api-v1",
            providerId: "fixture-native-id",
          },
        }),
      );
      expect(harness.errors).toEqual([]);
    });
  });

  it("waits for host smoke verification before reporting OpenRouter success", async () => {
    let finishSmoke: (() => void) | undefined;
    const smokePending = new Promise<void>((resolve) => {
      finishSmoke = resolve;
    });
    const log = vi.fn();

    const setup = openrouterRuntimeOnboard.setupOpenRouterRuntimeInference({
      sandboxName: null,
      provider: "openrouter-api",
      model: "test-model",
      credentialEnv: "OPENROUTER_API_KEY",
      credentialValue: "sk-or-test",
      isNonInteractive: () => true,
      runOpenshell: () => ({ status: 0 }),
      upsertProvider: async () => ({ ok: true }),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(() => smokePending),
      ensureAdapter: vi.fn(async () => ({
        baseUrl: "http://host.openshell.internal:11437/v1",
        localBaseUrl: "http://127.0.0.1:11437/v1",
        credentialEnv: "OPENROUTER_API_KEY",
        logPath: "/tmp/openrouter-runtime-adapter.log",
      })),
      exitProcess: ((code: number) => {
        throw new Error(`unexpected exit ${code}`);
      }) as never,
      error: vi.fn(),
      log,
    });

    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Inference route set"));
    finishSmoke?.();
    await setup;
    expect(log).toHaveBeenCalledWith("  ✓ Inference route set: openrouter-api / test-model");
  });

  it("reuses the gateway-held native OpenRouter credential without updating it (#12589)", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: undefined }, async () => {
      const providerAdapter = createNativeSetupProviderAdapter("openrouter-api");
      const setupOpenRouterRuntimeInference = vi.fn(async () => ({ handled: false as const }));
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          isNonInteractive: () => true,
          providerAdapter,
          openrouterRuntimeOnboard: { setupOpenRouterRuntimeInference },
        },
      });
      await harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "openrouter-api",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
        null,
        [],
        {
          reuseGatewayCredentialWithoutLocalKey: true,
          skipHostInferenceSmoke: true,
        },
      );
      expect(providerAdapter.getProvider).toHaveBeenCalledWith(
        expect.objectContaining({ providerName: "nemoclaw-openrouter-api-v1" }),
      );
      expect(providerAdapter.createProvider).not.toHaveBeenCalled();
      expect(providerAdapter.updateProvider).not.toHaveBeenCalled();
      expect(setupOpenRouterRuntimeInference).not.toHaveBeenCalled();
      expect(harness.commands).toEqual([]);
      expect(harness.verifyInferenceRoute).not.toHaveBeenCalled();
      expect(harness.verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
      expect(harness.updateSandbox).toHaveBeenCalledWith(
        "test-box",
        expect.objectContaining({
          nativeHostedProviderAttachment: {
            schemaVersion: 1,
            profileId: "nemoclaw-openrouter-inference-v1",
            providerName: "nemoclaw-openrouter-api-v1",
            providerId: "fixture-native-id",
          },
        }),
      );
      expect(harness.errors).toEqual([]);
    });
  });
});
