// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HOSTED_PROVIDER_SMOKE_CASES = [
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
