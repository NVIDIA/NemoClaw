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

/** Only the OpenRouter credential reaches the existing smoke test process. */
export function openRouterSmokeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = environment.HOSTED_INFERENCE_API_KEY || environment.OPENROUTER_API_KEY;
  const model = environment.HOSTED_INFERENCE_MODEL || environment.NEMOCLAW_OPENROUTER_MODEL;
  if (!key || !model)
    throw new Error("OpenRouter qualification requires its approved credential and model");
  return { OPENROUTER_API_KEY: key, NEMOCLAW_OPENROUTER_MODEL: model };
}
