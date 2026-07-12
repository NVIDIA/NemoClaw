// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Parse a numeric env var, returning `fallback` when unset or non-finite. */
export function envInt(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

/** Inference timeout (seconds) for local providers (Ollama, vLLM, NIM). */
export const LOCAL_INFERENCE_TIMEOUT_SECS = envInt("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", 180);

/** Sandbox Ready wait after OpenShell create returns but k3s is still converging. */
export const SANDBOX_READY_TIMEOUT_SECS = envInt("NEMOCLAW_SANDBOX_READY_TIMEOUT", 180);
