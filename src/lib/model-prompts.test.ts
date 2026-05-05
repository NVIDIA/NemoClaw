// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  BACK_TO_SELECTION,
  promptCloudModel,
  promptInputModel,
  promptManualModelId,
  promptRemoteModel,
} from "../../dist/lib/model-prompts";

function promptSequence(responses: string[]) {
  const queue = [...responses];
  return vi.fn(async () => queue.shift() ?? "");
}

describe("model prompt helpers", () => {
  it("returns the selected cloud model from the curated list", async () => {
    const promptFn = promptSequence(["2"]);
    const result = await promptCloudModel({
      promptFn,
      writeLine: vi.fn(),
      cloudModelOptions: [
        { id: "nemotron", label: "Nemotron" },
        { id: "llama", label: "Llama" },
      ],
    });

    expect(result).toBe("llama");
  });

  it("returns DeepSeek V4 Pro from the default cloud model menu", async () => {
    const promptFn = promptSequence(["6"]);
    const result = await promptCloudModel({
      promptFn,
      writeLine: vi.fn(),
    });

    expect(result).toBe("deepseek-ai/deepseek-v4-pro");
  });

  it("validates manual cloud model ids against the saved NVIDIA key", async () => {
    const promptFn = promptSequence(["9", "bad-model", "nemotron-custom"]);
    const errorLine = vi.fn();
    const result = await promptCloudModel({
      promptFn,
      errorLine,
      writeLine: vi.fn(),
      cloudModelOptions: [{ id: "nemotron", label: "Nemotron" }],
      getCredentialFn: () => "nvapi-test",
      validateNvidiaEndpointModelFn: (model) => ({
        ok: model === "nemotron-custom",
        message: `Model '${model}' is not available from NVIDIA Endpoints. Checked https://integrate.api.nvidia.com/v1/models.`,
      }),
    });

    expect(result).toBe("nemotron-custom");
    expect(errorLine).toHaveBeenCalledWith(
      "  Model 'bad-model' is not available from NVIDIA Endpoints. Checked https://integrate.api.nvidia.com/v1/models.",
    );
  });

  it("returns back-to-selection with a clear message when the NVIDIA key is missing", async () => {
    const errorLine = vi.fn();
    const result = await promptCloudModel({
      promptFn: promptSequence(["abc"]),
      errorLine,
      writeLine: vi.fn(),
      cloudModelOptions: [{ id: "nemotron", label: "Nemotron" }],
      getCredentialFn: () => null,
    });

    expect(result).toBe(BACK_TO_SELECTION);
    expect(errorLine).toHaveBeenCalledWith(
      "  NVIDIA_API_KEY is required before validating a custom NVIDIA Endpoints model.",
    );
  });

  it("defers transient manual validation failures back to the caller flow", async () => {
    const errorLine = vi.fn();
    const result = await promptManualModelId(
      "  Model: ",
      "Provider",
      () => ({ ok: false, message: "Could not validate model against /models: timeout" }),
      { promptFn: promptSequence(["custom-model"]), errorLine },
    );

    expect(result).toBe("custom-model");
    expect(errorLine).toHaveBeenCalledWith("  Could not validate model against /models: timeout");
  });

  it("returns back-to-selection for manual ids and input prompts", async () => {
    await expect(
      promptManualModelId("  Model: ", "Provider", null, { promptFn: promptSequence(["back"]) }),
    ).resolves.toBe(BACK_TO_SELECTION);
    await expect(
      promptInputModel("Provider", "default-model", null, { promptFn: promptSequence(["back"]) }),
    ).resolves.toBe(BACK_TO_SELECTION);
  });

  it("uses the default remote model choice when the user presses enter", async () => {
    const result = await promptRemoteModel("OpenAI", "openai", "gpt-5.4-mini", null, {
      promptFn: promptSequence([""]),
      writeLine: vi.fn(),
    });

    expect(result).toBe("gpt-5.4-mini");
  });

  it("treats non-numeric curated selections as manual-entry fallback", async () => {
    const result = await promptRemoteModel("OpenAI", "openai", "gpt-5.4-mini", null, {
      promptFn: promptSequence(["abc", "custom-model"]),
      writeLine: vi.fn(),
    });

    expect(result).toBe("custom-model");
  });

  it("retries invalid input models until validation succeeds", async () => {
    const promptFn = promptSequence(["bad model", "other", "candidate"]);
    const errorLine = vi.fn();
    const result = await promptInputModel(
      "Custom",
      "default-model",
      (model) => ({ ok: model === "candidate", message: "try again" }),
      { promptFn, errorLine },
    );

    expect(result).toBe("candidate");
    expect(errorLine).toHaveBeenCalledWith("  Invalid Custom model id.");
    expect(errorLine).toHaveBeenCalledWith("  try again");
  });

  it("returns input models immediately when validation should be deferred", async () => {
    const errorLine = vi.fn();
    const result = await promptInputModel(
      "Custom",
      "default-model",
      () => ({ ok: false, message: "Could not validate model against /models: auth failed" }),
      { promptFn: promptSequence(["candidate"]), errorLine },
    );

    expect(result).toBe("candidate");
    expect(errorLine).toHaveBeenCalledWith(
      "  Could not validate model against /models: auth failed",
    );
  });
});
