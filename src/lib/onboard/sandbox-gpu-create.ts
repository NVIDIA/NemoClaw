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

export function getSandboxReadyTimeoutSecs(
  _config: Pick<SandboxGpuCreateConfig, "sandboxGpuEnabled">,
  env: NodeJS.ProcessEnv = process.env,
  _platform: NodeJS.Platform = process.platform,
  _arch: NodeJS.Architecture = process.arch,
): number {
  if (String(env.NEMOCLAW_SANDBOX_READY_TIMEOUT || "").trim()) {
    return envInt("NEMOCLAW_SANDBOX_READY_TIMEOUT", SANDBOX_READY_TIMEOUT_SECS, env);
  }
  return SANDBOX_READY_TIMEOUT_SECS;
}
