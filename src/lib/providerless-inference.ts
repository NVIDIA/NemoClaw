// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Explicit absence shared by Dockerfile generation and managed startup. */
export const PROVIDERLESS_INFERENCE_ENV = Object.freeze({
  NEMOCLAW_MODEL: "",
  NEMOCLAW_INFERENCE_PROVIDER_ID: "",
  NEMOCLAW_UPSTREAM_PROVIDER: "",
  NEMOCLAW_INFERENCE_BASE_URL: "",
  NEMOCLAW_INFERENCE_API: "",
});

/** Partial inference input must still pass the agent's ordinary validation. */
export function hasProviderlessInferenceEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    Object.entries(PROVIDERLESS_INFERENCE_ENV).every(([key, value]) => env[key] === value) &&
    !env.NEMOCLAW_PRIMARY_MODEL_REF &&
    !env.NEMOCLAW_PROVIDER_KEY &&
    !env.NEMOCLAW_UPSTREAM_ENDPOINT_URL
  );
}
