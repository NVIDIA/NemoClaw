// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  BACK_TO_SELECTION,
  promptCloudModel,
  promptInputModel,
  promptManualModelId,
  promptRemoteModel,
  promptVllmModel,
} from "../../../dist/lib/inference/model-prompts";
import { VLLM_MODELS, modelsForPlatform } from "../../../dist/lib/inference/vllm-models";

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
    const promptFn = promptSequence(["8"]);
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
      "  NVIDIA_INFERENCE_API_KEY is required before validating a custom NVIDIA Endpoints model.",
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

  it("opens the full model list from long curated remote catalogs", async () => {
    const modelOptions = Array.from({ length: 12 }, (_, index) => `model-${index + 1}`);
    const writeLine = vi.fn();
    const result = await promptRemoteModel("Hermes Provider", "hermesProvider", "model-1", null, {
      promptFn: promptSequence(["4", "11"]),
      writeLine,
      remoteModelOptions: { hermesProvider: modelOptions },
      topLevelModelLimit: 3,
      otherShowsFullList: true,
    });

    expect(result).toBe("model-11");
    expect(writeLine).toHaveBeenCalledWith("    4) Other...");
    expect(writeLine).toHaveBeenCalledWith("  Hermes Provider full model list:");
    expect(writeLine).toHaveBeenCalledWith("    11) model-11");
  });

  it("keeps a hidden remote default when the user presses enter", async () => {
    const modelOptions = Array.from({ length: 12 }, (_, index) => `model-${index + 1}`);
    const promptFn = promptSequence([""]);
    const writeLine = vi.fn();
    const result = await promptRemoteModel("Hermes Provider", "hermesProvider", "model-12", null, {
      promptFn,
      writeLine,
      remoteModelOptions: { hermesProvider: modelOptions },
      topLevelModelLimit: 3,
      otherShowsFullList: false,
    });

    expect(result).toBe("model-12");
    expect(promptFn).toHaveBeenCalledWith("  Choose model [12]: ");
    expect(writeLine).toHaveBeenCalledWith("    12) model-12 (current)");
  });

  it("keeps a hidden remote default when the user types its index", async () => {
    const modelOptions = Array.from({ length: 12 }, (_, index) => `model-${index + 1}`);
    const result = await promptRemoteModel("Hermes Provider", "hermesProvider", "model-12", null, {
      promptFn: promptSequence(["12"]),
      writeLine: vi.fn(),
      remoteModelOptions: { hermesProvider: modelOptions },
      topLevelModelLimit: 3,
      otherShowsFullList: true,
    });

    expect(result).toBe("model-12");
  });

  it("keeps a safe current remote default that is not in the curated list", async () => {
    const writeLine = vi.fn();
    const promptFn = promptSequence([""]);
    const result = await promptRemoteModel("OpenAI", "openai", "custom/provider-model", null, {
      promptFn,
      writeLine,
      remoteModelOptions: { openai: ["model-1", "model-2", "model-3"] },
    });

    expect(result).toBe("custom/provider-model");
    expect(promptFn).toHaveBeenCalledWith("  Choose model [5]: ");
    expect(writeLine).toHaveBeenCalledWith("    4) Other...");
    expect(writeLine).toHaveBeenCalledWith("    5) custom/provider-model (current)");
  });

  it("limits top-level remote catalogs before manual-entry fallback", async () => {
    const modelOptions = Array.from({ length: 12 }, (_, index) => `model-${index + 1}`);
    const writeLine = vi.fn();
    const result = await promptRemoteModel("Hermes Provider", "hermesProvider", "model-12", null, {
      promptFn: promptSequence(["4", "custom-model"]),
      writeLine,
      remoteModelOptions: { hermesProvider: modelOptions },
      topLevelModelLimit: 3,
      otherShowsFullList: false,
    });

    expect(result).toBe("custom-model");
    expect(writeLine).toHaveBeenCalledWith("    3) model-3");
    expect(writeLine).not.toHaveBeenCalledWith("    4) model-4");
    expect(writeLine).toHaveBeenCalledWith("    4) Other...");
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

describe("promptVllmModel", () => {
  const sparkModels = modelsForPlatform("spark");
  const sparkDefault = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-35b-a3b-nvfp4")!;
  const gatedModel = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b")!;
  const stationModels = modelsForPlatform("station");
  const stationDefault = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-27b")!;

  it("returns the profile default when the user presses Enter", async () => {
    const promptFn = promptSequence([""]);
    const result = await promptVllmModel("DGX Spark", sparkModels, sparkDefault, {
      promptFn,
      writeLine: vi.fn(),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).toEqual(sparkDefault);
  });

  it("annotates the default as recommended and shows the HF id on a second line", async () => {
    const promptFn = promptSequence([""]);
    const writeLine = vi.fn();
    await promptVllmModel("DGX Spark", sparkModels, sparkDefault, {
      promptFn,
      writeLine,
      env: {} as NodeJS.ProcessEnv,
    });
    const lines = writeLine.mock.calls.map((args) => String(args[0]));
    expect(lines).toContain("  vLLM models for DGX Spark:");
    expect(
      lines.some(
        (line) => line.includes(sparkDefault.label) && line.includes("recommended, default"),
      ),
    ).toBe(true);
    expect(lines).toContain(`       ${sparkDefault.id}`);
  });

  it("renders the default first followed by registry order", async () => {
    const promptFn = promptSequence([""]);
    const writeLine = vi.fn();
    await promptVllmModel("DGX Spark", sparkModels, sparkDefault, {
      promptFn,
      writeLine,
      env: {} as NodeJS.ProcessEnv,
    });
    const numbered = writeLine.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => /^ {4}\d+\) /.test(line));
    expect(numbered[0]).toContain(sparkDefault.label);
    const expectedOrder = [sparkDefault, ...sparkModels.filter((m) => m.id !== sparkDefault.id)];
    expectedOrder.forEach((model, index) => {
      expect(numbered[index]).toContain(model.label);
    });
  });

  it("returns a non-default registry entry when the user picks its number", async () => {
    const promptFn = promptSequence(["2"]);
    const result = await promptVllmModel("DGX Spark", sparkModels, sparkDefault, {
      promptFn,
      writeLine: vi.fn(),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).not.toEqual(sparkDefault);
    expect(sparkModels).toContainEqual(result);
  });

  it("re-prompts when the user enters a number outside the menu", async () => {
    const promptFn = promptSequence(["99", ""]);
    const errorLine = vi.fn();
    const result = await promptVllmModel("DGX Spark", sparkModels, sparkDefault, {
      promptFn,
      writeLine: vi.fn(),
      errorLine,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).toEqual(sparkDefault);
    expect(errorLine).toHaveBeenCalledWith(
      expect.stringMatching(/Pick a number between 1 and \d+/),
    );
  });

  it("rejects malformed input like '2abc' instead of silently treating it as 2", async () => {
    const promptFn = promptSequence(["2abc", " 1x ", ""]);
    const errorLine = vi.fn();
    const result = await promptVllmModel("DGX Spark", sparkModels, sparkDefault, {
      promptFn,
      writeLine: vi.fn(),
      errorLine,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).toEqual(sparkDefault);
    const messages = errorLine.mock.calls.map((args) => String(args[0]));
    expect(messages.filter((m) => /Pick a number between 1 and \d+/.test(m))).toHaveLength(2);
  });

  it("re-prompts when the user picks a gated model without an HF token", async () => {
    const gatedIndex = sparkModels.findIndex((m) => m.id === gatedModel.id);
    expect(gatedIndex).toBeGreaterThanOrEqual(0);
    const orderedGatedPosition = (() => {
      const ordered = [sparkDefault, ...sparkModels.filter((m) => m.id !== sparkDefault.id)];
      return ordered.findIndex((m) => m.id === gatedModel.id) + 1;
    })();
    const promptFn = promptSequence([String(orderedGatedPosition), ""]);
    const errorLine = vi.fn();
    const result = await promptVllmModel("DGX Spark", sparkModels, sparkDefault, {
      promptFn,
      writeLine: vi.fn(),
      errorLine,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).toEqual(sparkDefault);
    const messages = errorLine.mock.calls.map((args) => String(args[0]));
    expect(messages.some((m) => /gated on Hugging Face/.test(m))).toBe(true);
  });

  it("accepts a gated model when HUGGING_FACE_HUB_TOKEN is set", async () => {
    const ordered = [sparkDefault, ...sparkModels.filter((m) => m.id !== sparkDefault.id)];
    const gatedPosition = ordered.findIndex((m) => m.id === gatedModel.id) + 1;
    const promptFn = promptSequence([String(gatedPosition)]);
    const result = await promptVllmModel("DGX Spark", sparkModels, sparkDefault, {
      promptFn,
      writeLine: vi.fn(),
      env: { HUGGING_FACE_HUB_TOKEN: "hf_abc" } as NodeJS.ProcessEnv,
    });
    expect(result).toEqual(gatedModel);
  });

  it("returns BACK_TO_SELECTION when the user types back", async () => {
    const promptFn = promptSequence(["back"]);
    const result = await promptVllmModel("DGX Station", stationModels, stationDefault, {
      promptFn,
      writeLine: vi.fn(),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).toEqual(BACK_TO_SELECTION);
  });
});
