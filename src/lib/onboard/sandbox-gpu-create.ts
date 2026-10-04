// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { envInt, SANDBOX_READY_TIMEOUT_SECS } from "./env";

export type SandboxGpuCreateConfig = {
  sandboxGpuEnabled: boolean;
  sandboxGpuDevice?: string | null;
  hostGpuDetected?: boolean;
};

export function buildSandboxGpuCreateArgs(
  config: SandboxGpuCreateConfig,
  options: { suppressGpuFlag?: boolean } = {},
): string[] {
  if (options.suppressGpuFlag) return [];
  if (!config.sandboxGpuEnabled) return [];
  return ["--gpu"];
}

export function normalizeSandboxGpuDeviceForCdi(device: string | null | undefined): string | null {
  const selector = String(device ?? "").trim();
  if (!selector) return null;
  if (selector === "nvidia.com/gpu=") {
    throw new Error(
      "NVIDIA GPU CDI device name must include an identifier after 'nvidia.com/gpu='.",
    );
  }
  return selector.startsWith("nvidia.com/gpu=") ? selector : `nvidia.com/gpu=${selector}`;
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
