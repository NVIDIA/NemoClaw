// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runInferenceSet } from "./inference-set";
import { createCompatibleProviderCapture, createDeps } from "./inference-set.test-support";

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
