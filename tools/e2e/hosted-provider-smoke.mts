// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HOSTED_PROVIDER_SMOKE_CASES = [
  {
    id: "TC-INF-02",
    selector: "openai",
    provider: "openai",
    label: "OpenAI",
    credential: "OPENAI_API_KEY",
    modelEnv: "NEMOCLAW_OPENAI_MODEL",
    defaultModel: "gpt-4o-mini",
    providerKey: "openai",
    endpoint: "https://api.openai.com/v1",
    placeholder: "OPENAI_API_KEY",
  },
  {
    id: "TC-INF-03",
    selector: "anthropic",
    provider: "anthropic",
    label: "Anthropic",
    credential: "ANTHROPIC_API_KEY",
    modelEnv: "NEMOCLAW_ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-4-6",
    providerKey: "anthropic",
    endpoint: "https://api.anthropic.com",
    placeholder: "ANTHROPIC_API_KEY",
  },
  {
    id: "TC-INF-06",
    selector: "gemini",
    provider: "gemini",
    label: "Gemini",
    credential: "GEMINI_API_KEY",
    modelEnv: "NEMOCLAW_GEMINI_MODEL",
    providerKey: "inference",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/",
    placeholder: "GEMINI_API_KEY",
  },
  {
    id: "TC-INF-07",
    selector: "openrouter",
    provider: "openrouter",
    label: "OpenRouter",
    credential: "OPENROUTER_API_KEY",
    modelEnv: "NEMOCLAW_OPENROUTER_MODEL",
    providerKey: "inference",
    endpoint: "https://openrouter.ai/api/v1",
    placeholder: "OPENROUTER_API_KEY",
  },
  {
    id: "TC-INF-08",
    selector: "hermes",
    provider: "hermes",
    label: "Hermes Provider",
    credential: "NOUS_API_KEY",
    modelEnv: "NEMOCLAW_HERMES_MODEL",
    providerKey: "inference",
    endpoint: "https://inference-api.nousresearch.com/v1",
    placeholder: "OPENAI_API_KEY",
  },
] as const;

/** Only the selected provider credential reaches the existing smoke test process. */
export function hostedProviderSmokeEnvironment(
  id: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const selected = HOSTED_PROVIDER_SMOKE_CASES.find(
    (entry) => id === `hosted-inference-${entry.selector}`,
  );
  if (!selected) throw new Error("Unknown hosted inference qualification target");
  const key = environment.HOSTED_INFERENCE_API_KEY || environment[selected.credential];
  const model = environment.HOSTED_INFERENCE_MODEL || environment[selected.modelEnv];
  if (!key || !model)
    throw new Error(
      "Selected hosted inference qualification requires its approved credential and model",
    );
  return { [selected.credential]: key, [selected.modelEnv]: model };
}
