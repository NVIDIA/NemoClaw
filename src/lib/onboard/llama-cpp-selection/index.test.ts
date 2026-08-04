// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  LLAMA_CPP_CREDENTIAL_ENV,
  LLAMA_CPP_HOST_OPENAI_BASE_URL,
} from "../../inference/llama-cpp";
import type { SetupNimSelectionState } from "../setup-nim-flow";
import { createLlamaCppSelectionHandler, type LlamaCppSelectionDeps } from "./index";

function state(): SetupNimSelectionState {
  return {
    model: null,
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

function deps(overrides: Partial<LlamaCppSelectionDeps> = {}): LlamaCppSelectionDeps {
  return {
    isNonInteractive: () => false,
    resolveCredential: () => "secret-token",
    ensureNamedCredential: async () => "secret-token",
    returningToProviderSelection: () => false,
    probeLlamaCppAttachment: () => ({ ok: true, model: "team/model-alias" }),
    validateOpenAiLikeSelection: async () => ({ ok: true, api: "openai-completions" }),
    error: vi.fn(),
    log: vi.fn(),
    exitProcess: (code) => {
      throw new Error(`exit ${code}`);
    },
    ...overrides,
  };
}

describe("createLlamaCppSelectionHandler", () => {
  it("binds the classified alias to a credential-bearing completions route (#8161)", async () => {
    const validate = vi.fn(async () => ({ ok: true, api: "openai-completions" }));
    const current = state();
    const handler = createLlamaCppSelectionHandler(deps({ validateOpenAiLikeSelection: validate }));

    await expect(handler(current, null, null)).resolves.toBe("selected");
    expect(current).toMatchObject({
      provider: "llama-cpp-local",
      model: "team/model-alias",
      endpointUrl: LLAMA_CPP_HOST_OPENAI_BASE_URL,
      credentialEnv: LLAMA_CPP_CREDENTIAL_ENV,
      preferredInferenceApi: "openai-completions",
    });
    expect(validate).toHaveBeenCalledWith(
      "Local llama.cpp",
      LLAMA_CPP_HOST_OPENAI_BASE_URL,
      "team/model-alias",
      LLAMA_CPP_CREDENTIAL_ENV,
      expect.any(String),
      null,
      expect.objectContaining({
        apiKey: "secret-token",
        pinnedAddresses: [],
        skipResponsesProbe: true,
      }),
    );
  });

  it("uses the requested non-interactive served alias as classification input (#8161)", async () => {
    const probe = vi.fn(() => ({ ok: true as const, model: "team/requested" }));
    const handler = createLlamaCppSelectionHandler(deps({ probeLlamaCppAttachment: probe }));

    await handler(state(), "team/requested", null);

    expect(probe).toHaveBeenCalledWith("secret-token", {
      requestedModel: "team/requested",
    });
  });

  it("exits non-interactively when NEMOCLAW_LLAMACPP_LOCAL_TOKEN is absent (#8161)", async () => {
    const probe = vi.fn();
    const handler = createLlamaCppSelectionHandler(
      deps({
        isNonInteractive: () => true,
        resolveCredential: () => null,
        probeLlamaCppAttachment: probe,
      }),
    );

    await expect(handler(state(), "team/model", null)).rejects.toThrow("exit 1");
    expect(probe).not.toHaveBeenCalled();
  });

  it("routes ambiguous fingerprint evidence back to manual provider selection (#8161)", async () => {
    const error = vi.fn();
    const handler = createLlamaCppSelectionHandler(
      deps({
        error,
        probeLlamaCppAttachment: () => ({
          ok: false,
          reason: "ambiguous-model",
          message: "The llama.cpp server exposes multiple models.",
        }),
      }),
    );

    await expect(handler(state(), null, null)).resolves.toBe("retry-selection");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Other OpenAI-compatible endpoint"));
  });

  it("preserves a recovered alias but never claims server lifecycle ownership (#8161)", async () => {
    const current = state();
    const handler = createLlamaCppSelectionHandler(deps());

    await handler(current, null, "team/model-alias");

    expect(current.model).toBe("team/model-alias");
    expect(current.nimContainer).toBeNull();
    expect(current).not.toHaveProperty("vllmModelIdentity");
  });
});
