// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { envInt, SANDBOX_READY_TIMEOUT_SECS } from "./env";

export type SandboxGpuCreateConfig = {
  sandboxGpuEnabled: boolean;
  sandboxGpuDevice?: string | null;
};

export function buildSandboxGpuCreateArgs(
  config: SandboxGpuCreateConfig,
  options: { suppressGpuFlag?: boolean } = {},
): string[] {
  if (options.suppressGpuFlag) return [];
  if (!config.sandboxGpuEnabled) return [];
  const args = ["--gpu"];
  if (config.sandboxGpuDevice) {
    args.push("--gpu-device", config.sandboxGpuDevice);
  }
  return args;
}

/**
 * GPU sandboxes need extra readiness headroom because image extract + GPU device
 * attach can take 3-5 minutes on RTX-class hardware (#3344). Non-GPU sandboxes
 * keep the baseline SANDBOX_READY_TIMEOUT_SECS default.
 */
const GPU_SANDBOX_READY_TIMEOUT_SECS = 300;

export function getSandboxReadyTimeoutSecs(
  config: Pick<SandboxGpuCreateConfig, "sandboxGpuEnabled">,
  env: NodeJS.ProcessEnv = process.env,
  _platform: NodeJS.Platform = process.platform,
  _arch: NodeJS.Architecture = process.arch,
): number {
  const defaultSecs = config.sandboxGpuEnabled
    ? GPU_SANDBOX_READY_TIMEOUT_SECS
    : SANDBOX_READY_TIMEOUT_SECS;
  if (String(env.NEMOCLAW_SANDBOX_READY_TIMEOUT || "").trim()) {
    return envInt("NEMOCLAW_SANDBOX_READY_TIMEOUT", defaultSecs, env);
  }
  return defaultSecs;
}
