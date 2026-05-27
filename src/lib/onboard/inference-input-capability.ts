// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type InferenceInputCapabilityDeps = {
  env?: NodeJS.ProcessEnv;
  isNonInteractive: () => boolean;
  prompt: (message: string) => Promise<string>;
};

const VALID_INFERENCE_INPUTS = new Set(["text", "image"]);
const MULTIMODAL_MODEL_HINT_PATTERN = /(^|[\/:_\-.])(omni|vision|vl|image|multimodal)([\/:_\-.]|$)/i;

export function isValidInferenceInputsOverride(value: string | undefined): boolean {
  if (!value) return false;
  const tokens = value.split(",");
  return tokens.every((token) => VALID_INFERENCE_INPUTS.has(token)) && new Set(tokens).size === tokens.length;
}

export function shouldPromptForInferenceInputCapability(
  model: string | null | undefined,
): boolean {
  return !!model && MULTIMODAL_MODEL_HINT_PATTERN.test(model);
}

export async function maybePromptForInferenceInputCapability(
  model: string | null,
  deps: InferenceInputCapabilityDeps,
): Promise<void> {
  const env = deps.env || process.env;
  if (
    deps.isNonInteractive() ||
    !shouldPromptForInferenceInputCapability(model) ||
    isValidInferenceInputsOverride(env.NEMOCLAW_INFERENCE_INPUTS)
  ) {
    return;
  }

  console.log("");
  console.log(`  Selected model: ${model}`);
  console.log("");
  console.log("  Input capability:");
  console.log("    1) Text only");
  console.log("    2) Text + Image");
  console.log("");
  const choice = await deps.prompt("  Choose input capability [1]: ");
  if ((choice || "1").trim() === "2") {
    env.NEMOCLAW_INFERENCE_INPUTS = "text,image";
    console.log("  ✓ Model input capability set to text + image.");
    return;
  }
  env.NEMOCLAW_INFERENCE_INPUTS = "text";
}
