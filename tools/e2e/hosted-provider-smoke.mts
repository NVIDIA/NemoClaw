// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENROUTER_SMOKE = {
  id: "TC-INF-07",
  selector: "openrouter",
  provider: "openrouter",
  label: "OpenRouter",
  credential: "OPENROUTER_API_KEY",
  modelEnv: "NEMOCLAW_OPENROUTER_MODEL",
  providerKey: "inference",
  endpoint: "https://openrouter.ai/api/v1",
  placeholder: "OPENROUTER_API_KEY",
} as const;

/** Select only the OpenRouter credential and model for the smoke test. */
export function openRouterSmokeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = environment.HOSTED_INFERENCE_API_KEY || environment.OPENROUTER_API_KEY;
  const model = environment.HOSTED_INFERENCE_MODEL || environment.NEMOCLAW_OPENROUTER_MODEL;
  if (!key || !model)
    throw new Error("OpenRouter qualification requires its approved credential and model");
  return { OPENROUTER_API_KEY: key, NEMOCLAW_OPENROUTER_MODEL: model };
}

export function configureOpenRouterSmokeEnvironment(environment: NodeJS.ProcessEnv): void {
  const selected = openRouterSmokeEnvironment(environment);
  for (const key of [
    "HOSTED_INFERENCE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "NOUS_API_KEY",
  ]) {
    delete environment[key];
  }
  Object.assign(environment, selected);
}
