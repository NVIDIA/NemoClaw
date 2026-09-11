// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  LLMMAN_CREDENTIAL_ENV,
  LLMMAN_HOST_OPENAI_BASE_URL,
  type LlmmanAttachmentResult,
} from "../../inference/llmman";
import type { SetupNimSelectionState } from "../setup-nim-flow";
import { createLlmmanSelectionHandler, type LlmmanSelectionDeps } from "./index";

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

function attached(model: string, availableModels = [model]): LlmmanAttachmentResult {
  return { ok: true, model, version: "0.9.3", availableModels };
}

function deps(overrides: Partial<LlmmanSelectionDeps> = {}): LlmmanSelectionDeps {
  return {
    isNonInteractive: () => false,
    resolveCredential: () => "secret-token",
    ensureNamedCredential: async () => "secret-token",
    returningToProviderSelection: () => false,
    probeLlmmanAttachment: () => attached("qwen3.8:latest"),
    validateOpenAiLikeSelection: async () => ({ ok: true, api: "openai-completions" }),
    prompt: async () => "",
    selectFromNumberedMenu: (rawChoice, defaultIndex, options) => {
      const index = Number.parseInt(rawChoice || String(defaultIndex), 10) - 1;
      return options[index] ?? options[defaultIndex - 1]!;
    },
    error: vi.fn(),
    log: vi.fn(),
    exitProcess: (code) => {
      throw new Error(`exit ${code}`);
    },
    ...overrides,
  };
}

describe("createLlmmanSelectionHandler", () => {
  it("binds the attached model to a credential-bearing completions route", async () => {
    const validate = vi.fn(async () => ({ ok: true, api: "openai-completions" }));
    const current = state();
    const handler = createLlmmanSelectionHandler(deps({ validateOpenAiLikeSelection: validate }));

    await expect(handler(current, null, null)).resolves.toBe("selected");
    expect(current).toMatchObject({
      provider: "llmman-local",
      model: "qwen3.8:latest",
      endpointUrl: LLMMAN_HOST_OPENAI_BASE_URL,
      credentialEnv: LLMMAN_CREDENTIAL_ENV,
      preferredInferenceApi: "openai-completions",
    });
    expect(validate).toHaveBeenCalledWith(
      "Local llmman",
      LLMMAN_HOST_OPENAI_BASE_URL,
      "qwen3.8:latest",
      LLMMAN_CREDENTIAL_ENV,
      expect.any(String),
      null,
      expect.objectContaining({
        apiKey: "secret-token",
        pinnedAddresses: [],
        skipResponsesProbe: true,
      }),
    );
  });

  it("uses the requested non-interactive model reference as attachment input", async () => {
    const probe = vi.fn(() => attached("n/gemma4:latest"));
    const handler = createLlmmanSelectionHandler(deps({ probeLlmmanAttachment: probe }));

    await handler(state(), "n/gemma4", null);

    expect(probe).toHaveBeenCalledWith("secret-token", { requestedModel: "n/gemma4" });
  });

  it("exits non-interactively when NEMOCLAW_LLMMAN_LOCAL_TOKEN is absent", async () => {
    const probe = vi.fn();
    const handler = createLlmmanSelectionHandler(
      deps({
        isNonInteractive: () => true,
        resolveCredential: () => null,
        probeLlmmanAttachment: probe,
      }),
    );

    await expect(handler(state(), "qwen3.8", null)).rejects.toThrow("exit 1");
    expect(probe).not.toHaveBeenCalled();
  });

  it("offers the stored models as a menu when none was requested interactively", async () => {
    const probe = vi.fn((_apiKey: string, options: { requestedModel?: string | null }) =>
      options.requestedModel
        ? attached(options.requestedModel, ["qwen3.8:latest", "n/gemma4:latest"])
        : ({
            ok: false,
            reason: "ambiguous-model",
            message: "llmman stores multiple models; specify one model reference.",
            availableModels: ["qwen3.8:latest", "n/gemma4:latest"],
          } satisfies LlmmanAttachmentResult),
    );
    const log = vi.fn();
    const current = state();
    const handler = createLlmmanSelectionHandler(
      deps({ probeLlmmanAttachment: probe, prompt: async () => "2", log }),
    );

    await expect(handler(current, null, null)).resolves.toBe("selected");
    expect(current.model).toBe("n/gemma4:latest");
    expect(probe).toHaveBeenLastCalledWith("secret-token", { requestedModel: "n/gemma4:latest" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1) qwen3.8:latest"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2) n/gemma4:latest"));
  });

  it("returns to provider selection when the operator backs out of the model menu", async () => {
    const handler = createLlmmanSelectionHandler(
      deps({
        probeLlmmanAttachment: () => ({
          ok: false,
          reason: "ambiguous-model",
          message: "llmman stores multiple models; specify one model reference.",
          availableModels: ["qwen3.8:latest", "n/gemma4:latest"],
        }),
        prompt: async () => "back",
      }),
    );

    await expect(handler(state(), null, null)).resolves.toBe("retry-selection");
  });

  it("aborts non-interactively when the store holds several models and none was requested", async () => {
    const error = vi.fn();
    const handler = createLlmmanSelectionHandler(
      deps({
        isNonInteractive: () => true,
        error,
        probeLlmmanAttachment: () => ({
          ok: false,
          reason: "ambiguous-model",
          message: "llmman stores multiple models; specify one model reference.",
          availableModels: ["qwen3.8:latest", "n/gemma4:latest"],
        }),
      }),
    );

    await expect(handler(state(), null, null)).rejects.toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("multiple models"));
  });

  it("lists the stored models when the requested one is missing", async () => {
    const error = vi.fn();
    const handler = createLlmmanSelectionHandler(
      deps({
        error,
        probeLlmmanAttachment: () => ({
          ok: false,
          reason: "model-not-found",
          message: "llmman has no stored model 'missing'.",
          availableModels: ["qwen3.8:latest"],
        }),
      }),
    );

    await expect(handler(state(), "missing", null)).resolves.toBe("retry-selection");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Stored models: qwen3.8:latest"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("did not attach"));
  });

  it("returns to provider selection when route validation fails", async () => {
    const handler = createLlmmanSelectionHandler(
      deps({ validateOpenAiLikeSelection: async () => ({ ok: false }) }),
    );

    await expect(handler(state(), null, null)).resolves.toBe("retry-selection");
  });

  it("preserves a recovered model but never claims daemon lifecycle ownership", async () => {
    const probe = vi.fn(() => attached("qwen3.8:latest"));
    const current = state();
    const handler = createLlmmanSelectionHandler(deps({ probeLlmmanAttachment: probe }));

    await handler(current, null, "qwen3.8:latest");

    expect(probe).toHaveBeenCalledWith("secret-token", { requestedModel: "qwen3.8:latest" });
    expect(current.model).toBe("qwen3.8:latest");
    expect(current.nimContainer).toBeNull();
    expect(current).not.toHaveProperty("vllmModelIdentity");
  });
});
