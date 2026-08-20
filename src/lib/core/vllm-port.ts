// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_VLLM_PORT, parsePort, VLLM_PORT, VLLM_PORT_ENV } from "./ports";

export { DEFAULT_VLLM_PORT, VLLM_PORT, VLLM_PORT_ENV };

/** Resolve the vLLM listener from an explicit environment boundary. */
export function resolveVllmPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort(VLLM_PORT_ENV, DEFAULT_VLLM_PORT, env);
}
