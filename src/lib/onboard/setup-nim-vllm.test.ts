// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireValue } from "../core/require-value";
import type { SetupNimSelectionState } from "./setup-nim-flow";
import { createSetupNimVllmHandler, type SetupNimVllmDeps } from "./setup-nim-vllm";

function state(model: string | null): SetupNimSelectionState {
  return {
    model,
    provider: "nvidia-prod",
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    allowToolsIncompatible: false,
  };
}

function deps(overrides: Partial<SetupNimVllmDeps> = {}): SetupNimVllmDeps {
  return {
    VLLM_PORT: 8000,
    runCapture: () => JSON.stringify({ data: [{ id: "served/model" }] }),
    getLocalProviderBaseUrl: () => "http://host.openshell.internal:8000/v1",
    getLocalProviderValidationBaseUrl: () => "http://127.0.0.1:8000/v1",
    isSafeModelId: () => true,
    requireValue,
    validateOpenAiLikeSelection: async () => ({ ok: true, api: "openai-completions" }),
    applyVllmRuntimeContextWindow: vi.fn(),
    exitProcess: (code) => {
      throw new Error(`exit ${code}`);
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("setupNim vLLM route containment", () => {
  it("preflights before discovery and exact-checks the detected model before validation (#6315)", async () => {
    const events: string[] = [];
    const selection = state(null);
    selection.assertRouteCompatible = () => {
      events.push(selection.model ? "exact" : "preflight");
      return { requiredModel: null, requiredEndpointUrl: null, requiredInferenceApi: null };
    };
    const handler = createSetupNimVllmHandler(
      deps({
        runCapture: () => {
          events.push("probe");
          return JSON.stringify({ data: [{ id: "served/model" }] });
        },
        validateOpenAiLikeSelection: async () => {
          events.push("validate");
          return { ok: true, api: "openai-completions" };
        },
      }),
    );

    await expect(handler(selection)).resolves.toBe("selected");
    expect(events).toEqual(["preflight", "probe", "exact", "validate"]);
  });

  it("rejects a detected model that differs from the durable shared route before validation", async () => {
    const validate = vi.fn(async () => ({ ok: true }));
    const selection = state("required/model");
    selection.assertRouteCompatible = () => ({
      requiredModel: "required/model",
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    });
    const handler = createSetupNimVllmHandler(deps({ validateOpenAiLikeSelection: validate }));

    await expect(handler(selection)).rejects.toThrow("exit 1");
    expect(validate).not.toHaveBeenCalled();
  });
});
