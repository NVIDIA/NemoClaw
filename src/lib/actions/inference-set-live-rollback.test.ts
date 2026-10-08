// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runInferenceSet } from "./inference-set";
import { createCompatibleProviderCapture, createDeps } from "./inference-set.test-support";

describe("runInferenceSet live rollback authority", () => {
  it("restores the peer shared route after a failed departure from native inference", async () => {
    const setInferenceRoute = vi.fn<
      import("../adapters/openshell/inference-route").OpenShellInferenceRouteMutator["setInferenceRoute"]
    >(async () => ({ ok: true as const }));
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "old-model",
        nativeHostedProviderAttachment: {
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: "11111111-2222-4333-8444-555555555555",
        },
      },
      captureOpenshell: createCompatibleProviderCapture({
        name: "compatible-endpoint",
        type: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
        configKey: "OPENAI_BASE_URL",
        initiallyPresent: false,
      }),
      inferenceRouteMutator: { setInferenceRoute },
      inferenceRouteObserver: {
        observeInferenceRoute: async () => ({
          ok: true,
          value: {
            state: "configured",
            route: { provider: "peer-provider", model: "peer-model" },
          },
        }),
      },
      probeSandboxRoute: async () => ({ ok: false, detail: "probe refused", httpStatus: 401 }),
    });
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new-model",
          endpointUrl: "http://host.openshell.internal:18767/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("probe refused");
    expect(setInferenceRoute.mock.calls.map(([input]) => input.route)).toEqual([
      { provider: "compatible-endpoint", model: "new-model" },
      { provider: "peer-provider", model: "peer-model" },
    ]);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([
    { failure: "registry", configure: (_deps: ReturnType<typeof createDeps>) => {} },
    {
      failure: "rollback",
      configure: (deps: ReturnType<typeof createDeps>) => {
        vi.mocked(deps.inferenceRouteMutator.setInferenceRoute)
          .mockResolvedValueOnce({ ok: true })
          .mockRejectedValueOnce(new Error("route restore denied"));
        vi.mocked(deps.providerAdapter.attachProvider).mockRejectedValueOnce(
          new Error("attachment restore denied"),
        );
      },
    },
    {
      failure: "config",
      configure: (deps: ReturnType<typeof createDeps>) => {
        deps.calls.setOpenClawConfigValues.mockImplementation(() => {
          throw new Error("config sync denied");
        });
      },
    },
  ])(
    "preserves the correct rollback boundary for $failure failure",
    async ({ failure, configure }) => {
      const setInferenceRoute = vi.fn<
        import("../adapters/openshell/inference-route").OpenShellInferenceRouteMutator["setInferenceRoute"]
      >(async () => ({ ok: true as const }));
      const deps = createDeps({
        config: { models: { providers: {} } },
        entry: {
          name: "alpha",
          agent: "openclaw",
          provider: "nvidia-prod",
          model: "nvidia/old-model",
          nativeHostedProviderAttachment: {
            schemaVersion: 1,
            profileId: "nemoclaw-nvidia-inference-v1",
            providerName: "nemoclaw-nvidia-prod-v1",
            providerId: "11111111-2222-4333-8444-555555555555",
          },
        },
        captureOpenshell: createCompatibleProviderCapture({
          name: "compatible-endpoint",
          type: "openai",
          credentialEnv: "COMPATIBLE_API_KEY",
          configKey: "OPENAI_BASE_URL",
          initiallyPresent: false,
        }),
        inferenceRouteMutator: { setInferenceRoute },
        inferenceRouteObserver: {
          observeInferenceRoute: async () => ({
            ok: true,
            value: { state: "configured", route: { provider: "anthropic", model: "peer-model" } },
          }),
        },
        updateSandbox: () => failure === "config",
      });
      const attachProvider = vi.spyOn(deps.providerAdapter, "attachProvider");
      configure(deps);
      await expect(
        runInferenceSet(
          {
            provider: "compatible-endpoint",
            model: "gpt-5.4",
            noVerify: true,
            endpointUrl: "http://host.openshell.internal:18767/v1",
            credentialEnv: "COMPATIBLE_API_KEY",
            inferenceApi: "openai-completions",
          },
          deps,
        ),
      ).rejects.toThrow(
        failure === "rollback"
          ? /Failed to update NemoClaw registry.*route restore denied.*attachment restore denied/su
          : failure === "config"
            ? /config sync denied/su
            : /Failed to update NemoClaw registry/u,
      );
      expect(setInferenceRoute.mock.calls.map(([input]) => input.route)).toEqual([
        { provider: "compatible-endpoint", model: "gpt-5.4" },
        ...(failure === "config" ? [] : [{ provider: "anthropic", model: "peer-model" }]),
      ]);
      expect(attachProvider).toHaveBeenCalledTimes(failure === "config" ? 0 : 1);
    },
  );

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
