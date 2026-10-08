// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
vi.mock("../adapters/openshell/provider-policy", () => ({
  requireNativeProviderPolicy: vi.fn(async () => {}),
}));

import { runInferenceSet } from "./inference-set";
import {
  createCompatibleProviderCapture,
  createDeps,
  nativeLocalTestReceipt,
  createFailingNativeLocalRestoreAdapter,
} from "./inference-set.test-support";

describe("runInferenceSet live rollback authority", () => {
  it("does not reapply or report restoration when the observed route already matches the rejected route", async () => {
    const captureOpenshell = createCompatibleProviderCapture({
      name: "compatible-endpoint",
      type: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
      configKey: "OPENAI_BASE_URL",
      initiallyPresent: true,
    });
    const observeInferenceRoute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          state: "configured" as const,
          route: { provider: "compatible-endpoint", model: "old-model" },
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          state: "configured" as const,
          route: { provider: "compatible-endpoint", model: "mock-model" },
        },
      });
    const setInferenceRoute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        ambiguous: true,
        error: {
          kind: "command" as const,
          reason: "indeterminate" as const,
          exitCode: null,
          message: "first route result unknown",
        },
      })
      .mockResolvedValue({ ok: true as const });
    const probeSandboxRoute = vi.fn(async () => ({
      ok: false as const,
      detail: "sandbox rejected route",
      httpStatus: 400,
    }));
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: "http://host.openshell.internal:18767/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      captureOpenshell,
      inferenceRouteObserver: { observeInferenceRoute },
      inferenceRouteMutator: { setInferenceRoute },
      probeSandboxRoute,
    });
    const request = {
      provider: "compatible-endpoint",
      model: "mock-model",
      noVerify: true,
      endpointUrl: "http://host.openshell.internal:18767/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      inferenceApi: "openai-completions" as const,
    };

    await expect(runInferenceSet(request, deps)).rejects.toThrow("first route result unknown");
    await expect(runInferenceSet(request, deps)).rejects.toThrow(
      /no distinct prior inference selection to restore/u,
    );

    expect(observeInferenceRoute).toHaveBeenCalledTimes(2);
    expect(setInferenceRoute).toHaveBeenCalledTimes(2);
    expect(probeSandboxRoute).toHaveBeenCalledTimes(3);
  });
});

describe("native to shared inference rollback", () => {
  it.each([
    { provider: "ollama-local", nativeLocalProviderAttachment: nativeLocalTestReceipt() },
    {
      provider: "nvidia-prod",
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1 as const,
        profileId: "nemoclaw-nvidia-inference-v1" as const,
        providerName: "nemoclaw-nvidia-prod-v1" as const,
        providerId: "11111111-2222-4333-8444-555555555555",
      },
    },
  ])(
    "restores the peer shared route after a rejected switch from $provider (#12558)",
    async (previous) => {
      const before = { provider: "peer-provider", model: "peer-model" };
      const setInferenceRoute = vi.fn(async () => ({ ok: true as const }));
      const deps = createDeps({
        config: {},
        entry: { name: "alpha", agent: "openclaw", model: "old-model", ...previous },
        captureOpenshell: createCompatibleProviderCapture({
          name: "compatible-endpoint",
          type: "openai",
          credentialEnv: "COMPATIBLE_API_KEY",
          configKey: "OPENAI_BASE_URL",
          initiallyPresent: false,
        }),
        inferenceRouteObserver: {
          observeInferenceRoute: vi.fn(async () => ({
            ok: true as const,
            value: { state: "configured" as const, route: before },
          })),
        },
        inferenceRouteMutator: { setInferenceRoute },
        probeSandboxRoute: vi.fn(async () => ({
          ok: false as const,
          detail: "sandbox rejected route",
          httpStatus: 400,
        })),
      });
      await expect(
        runInferenceSet(
          {
            provider: "compatible-endpoint",
            model: "rejected-model",
            endpointUrl: "http://host.openshell.internal:18767/v1",
            credentialEnv: "COMPATIBLE_API_KEY",
            inferenceApi: "openai-completions",
            noVerify: true,
          },
          deps,
        ),
      ).rejects.toThrow("sandbox rejected route");
      expect(setInferenceRoute).toHaveBeenLastCalledWith({
        target: { kind: "named", gatewayName: "nemoclaw" },
        route: before,
        verification: "skip",
      });
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    },
  );
});

it("preserves the original failure and detaches NVIDIA after local restoration fails (#12558)", async () => {
  const previous = nativeLocalTestReceipt();
  const deps = createDeps({
    config: {},
    entry: {
      name: "alpha",
      agent: "openclaw",
      provider: "ollama-local",
      model: "old-model",
      nativeLocalProviderAttachment: previous,
    },
    updateSandbox: () => false,
  });
  const { adapter, detachProvider } = createFailingNativeLocalRestoreAdapter(
    deps.providerAdapter,
    previous,
  );
  await expect(
    runInferenceSet(
      { provider: "nvidia-prod", model: "model-a" },
      { ...deps, providerAdapter: adapter },
    ),
  ).rejects.toThrow(/Failed to update NemoClaw registry[\s\S]*local restoration unavailable/);
  expect(detachProvider).toHaveBeenCalledWith(
    expect.objectContaining({ providerName: "nemoclaw-nvidia-prod-v1" }),
  );
});
