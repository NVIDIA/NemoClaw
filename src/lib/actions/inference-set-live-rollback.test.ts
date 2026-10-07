// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runInferenceSet } from "./inference-set";
import {
  HERMES_TARGET,
  OPENCLAW_TARGET,
  createCompatibleProviderCapture,
  createDeps,
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

describe("native NVIDIA departure rollback", () => {
  const attachment = {
    schemaVersion: 1 as const,
    profileId: "nemoclaw-nvidia-inference-v1" as const,
    providerName: "nemoclaw-nvidia-prod-v1" as const,
    providerId: "11111111-2222-4333-8444-555555555555",
  };
  const priorRoute = { provider: "openai-api", model: "peer-model" };

  function departureDeps(agent: "openclaw" | "hermes") {
    const setInferenceRoute = vi.fn(async () => ({ ok: true as const }));
    const observeInferenceRoute = vi.fn(async () => ({
      ok: true as const,
      value: { state: "configured" as const, route: priorRoute },
    }));
    const deps = createDeps({
      config: {},
      target: agent === "hermes" ? HERMES_TARGET : OPENCLAW_TARGET,
      entry: {
        name: "alpha",
        agent,
        gatewayName: "nemoclaw",
        provider: "nvidia-prod",
        model: "nvidia/native-model",
        nativeNvidiaProviderAttachment: attachment,
      },
      inferenceRouteObserver: { observeInferenceRoute },
      inferenceRouteMutator: { setInferenceRoute },
    });
    return { deps, setInferenceRoute, observeInferenceRoute };
  }

  it.each(["openclaw", "hermes"] as const)(
    "restores the observed peer route when %s departure verification fails",
    async (agent) => {
      const { deps, setInferenceRoute } = departureDeps(agent);
      deps.calls.probeSandboxRoute.mockResolvedValue({
        ok: false,
        httpStatus: 401,
        detail: "HTTP 401",
      });
      await expect(
        runInferenceSet({ provider: "openrouter-api", model: "new-model" }, deps),
      ).rejects.toThrow(/previous OpenShell inference selection was restored/u);
      expect(setInferenceRoute.mock.calls).toEqual([
        [
          {
            target: { kind: "named", gatewayName: "nemoclaw" },
            route: { provider: "openrouter-api", model: "new-model" },
            verification: "skip",
          },
        ],
        [
          {
            target: { kind: "named", gatewayName: "nemoclaw" },
            route: priorRoute,
            verification: "skip",
          },
        ],
      ]);
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
      expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      stage: "detach",
      fail: (deps: ReturnType<typeof departureDeps>["deps"]) => {
        deps.providerAdapter.detachProvider = vi.fn(async () => ({
          ok: false as const,
          error: { kind: "command" as const, reason: "failed" as const, message: "detach denied" },
        }));
      },
      expected: /Could not detach/u,
    },
    {
      stage: "registry",
      fail: (deps: ReturnType<typeof departureDeps>["deps"]) => {
        deps.calls.updateSandbox.mockReturnValue(false);
      },
      expected: /Failed to update NemoClaw registry/u,
    },
  ])(
    "restores the peer route when native departure fails during $stage",
    async ({ fail, expected }) => {
      const { deps, setInferenceRoute } = departureDeps("openclaw");
      fail(deps);
      await expect(
        runInferenceSet({ provider: "openrouter-api", model: "new-model" }, deps),
      ).rejects.toThrow(expected);
      expect(setInferenceRoute).toHaveBeenCalledTimes(2);
      expect(setInferenceRoute).toHaveBeenLastCalledWith({
        target: { kind: "named", gatewayName: "nemoclaw" },
        route: priorRoute,
        verification: "skip",
      });
      const attached = await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      });
      expect(attached).toMatchObject({ ok: true, value: { names: [attachment.providerName] } });
      expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
    },
  );

  it.each(["openrouter-api", "openai-api"])(
    "refuses native departure to %s without an observed rollback route",
    async (provider) => {
      const { deps, setInferenceRoute } = departureDeps("openclaw");
      deps.inferenceRouteObserver = {
        observeInferenceRoute: vi.fn(async () => ({
          ok: true as const,
          value: { state: "unconfigured" as const },
        })),
      };
      await expect(runInferenceSet({ provider, model: "new-model" }, deps)).rejects.toThrow(
        /no configured inference selection to restore/u,
      );
      expect(setInferenceRoute).not.toHaveBeenCalled();
      expect(deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    },
  );
  it("reports a failed peer-route restore without retrying it", async () => {
    const { deps } = departureDeps("openclaw");
    const setInferenceRoute = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        ambiguous: false,
        error: { kind: "command", exitCode: 19, message: "restore denied" },
      });
    deps.inferenceRouteMutator = { setInferenceRoute };
    deps.calls.updateSandbox.mockReturnValue(false);
    await expect(
      runInferenceSet({ provider: "openrouter-api", model: "new-model" }, deps),
    ).rejects.toThrow(/Failed to update NemoClaw registry.*Failed to restore.*status 19/su);
    expect(setInferenceRoute).toHaveBeenCalledTimes(2);
    expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
    expect(
      await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      }),
    ).toMatchObject({ ok: true, value: { names: [attachment.providerName] } });
  });
});
