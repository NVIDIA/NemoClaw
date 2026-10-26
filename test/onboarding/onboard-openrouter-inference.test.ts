// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";
import {
  createDirectSetupInferenceHarnessFactory,
  withProcessEnv,
  runProductionSetupInferenceCredentialBoundary,
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
  it("creates native OpenRouter access without starting the host header adapter (#12589)", () => {
    const { commands, credentialEvidence } = runProductionSetupInferenceCredentialBoundary({
      credentialEnv: "OPENROUTER_API_KEY",
      credentialValue: "sk-or-TEST-NOT-A-REAL-VALUE",
      endpointUrl: "https://openrouter.ai/api/v1",
      model: "moonshotai/kimi-k2.6",
      provider: "openrouter-api",
    });
    assert.match(
      credentialEvidence.providerCommand.argv.join(" "),
      /--type nemoclaw-openrouter-inference-v1/,
    );
    assert.deepEqual(credentialEvidence.secretBearingCommands, ["provider create"]);
    assert.deepEqual(credentialEvidence.argvContainingSecret, []);
    assert.ok(commands.every(({ argv }) => !(argv[0] === "inference" && argv[1] === "set")));
    assert.ok(commands.every(({ argv }) => !argv.join(" ").includes("11437")));
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
      gatewayName: "nemoclaw",
      inferenceRouteMutator: {
        setInferenceRoute: vi.fn(async () => ({ ok: true as const })),
      },
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

  it("stops without retry or success publication after an ambiguous OpenRouter route update", async () => {
    const setInferenceRoute = vi.fn(async () => ({
      ok: false as const,
      ambiguous: true,
      error: {
        kind: "command" as const,
        reason: "indeterminate" as const,
        exitCode: null,
        message: "route result unknown",
      },
    }));
    const verifyInferenceRoute = vi.fn();
    const verifyOnboardInferenceSmoke = vi.fn();
    const updateSandbox = vi.fn();
    const error = vi.fn();
    const log = vi.fn();

    await expect(
      openrouterRuntimeOnboard.setupOpenRouterRuntimeInference({
        sandboxName: "alpha",
        provider: "openrouter-api",
        model: "test-model",
        credentialEnv: "OPENROUTER_API_KEY",
        credentialValue: "sk-or-test",
        isNonInteractive: () => true,
        gatewayName: "nemoclaw",
        inferenceRouteMutator: { setInferenceRoute },
        upsertProvider: async () => ({ ok: true }),
        verifyInferenceRoute,
        verifyOnboardInferenceSmoke,
        ensureAdapter: vi.fn(async () => ({
          baseUrl: "http://host.openshell.internal:11437/v1",
          localBaseUrl: "http://127.0.0.1:11437/v1",
          credentialEnv: "OPENROUTER_API_KEY",
          logPath: "/tmp/openrouter-runtime-adapter.log",
        })),
        updateSandbox,
        exitProcess: ((code: number) => {
          throw new Error(`EXIT_CALLED:${code}`);
        }) as never,
        error,
        log,
      }),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(setInferenceRoute).toHaveBeenCalledOnce();
    expect(verifyInferenceRoute).not.toHaveBeenCalled();
    expect(verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "  The route update result is unknown. Inspect gateway 'nemoclaw' before retrying onboarding.",
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Inference route set"));
  });

  it("reuses owned native OpenRouter credentials without starting a host adapter (#12589)", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: undefined }, async () => {
      const receipt = {
        schemaVersion: 1,
        profileId: "nemoclaw-openrouter-inference-v1",
        providerName: "nemoclaw-openrouter-api-v1",
        providerId: "owned-openrouter",
      } as const;
      const mutateProvider = vi.fn(async () => {
        throw new Error("Credential reuse must not rewrite the provider");
      });
      const setupOpenRouterRuntimeInference = vi.fn();
      const providerAdapter = {
        importProviderProfile: vi.fn(async () => ({ ok: true as const })),
        ensureProviderPolicyComposition: vi.fn(async () => ({
          ok: true as const,
          value: undefined,
        })),
        getProvider: vi.fn(async () => ({
          ok: true as const,
          value: {
            name: receipt.providerName,
            type: receipt.profileId,
            credentialKeys: ["OPENROUTER_API_KEY"],
            configKeys: [],
            revision: { id: receipt.providerId, resourceVersion: 1 },
          },
        })),
        createProvider: mutateProvider,
        updateProvider: mutateProvider,
      } as unknown as NonNullable<SetupInferenceDeps["providerAdapter"]>;
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          isNonInteractive: () => true,
          providerAdapter,
          getNativeHostedProviderAuthority: () => receipt,
          setNativeHostedProviderAuthority: vi.fn(),
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
        { reuseGatewayCredentialWithoutLocalKey: true, skipHostInferenceSmoke: true },
      );
      expect(mutateProvider).not.toHaveBeenCalled();
      expect(setupOpenRouterRuntimeInference).not.toHaveBeenCalled();
      expect(providerAdapter.getProvider).toHaveBeenCalledWith({
        target: { kind: "named", gatewayName: "nemoclaw" },
        providerName: receipt.providerName,
      });
      expect(harness.commands).toEqual([]);
      expect(harness.updateSandbox).toHaveBeenCalledWith(
        "test-box",
        expect.objectContaining({
          nativeHostedProviderAttachment: receipt,
          endpointUrl: "https://openrouter.ai/api/v1",
        }),
      );
      expect(harness.errors).toEqual([]);
    });
  });
});
