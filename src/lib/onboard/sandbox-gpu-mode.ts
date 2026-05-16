// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GpuDetection } from "../inference/nim";

export type SandboxGpuMode = "auto" | "1" | "0";
export type SandboxGpuFlag = "enable" | "disable" | null;

export type SandboxGpuConfig = {
  mode: SandboxGpuMode;
  hostGpuDetected: boolean;
  sandboxGpuEnabled: boolean;
  sandboxGpuDevice: string | null;
  errors: string[];
};

export type ResumeSandboxGpuOverrides = {
  flag: SandboxGpuFlag;
  device: string | null;
};

export function normalizeSandboxGpuMode(value: string | null | undefined): SandboxGpuMode | null {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw === "auto") return "auto";
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return "1";
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return "0";
  return null;
}

function isNvidiaGpuDetected(gpu: GpuDetection | null | undefined): boolean {
  return Boolean(gpu && gpu.type === "nvidia");
}

export function resolveSandboxGpuMode(args: {
  envMode: SandboxGpuMode | null;
  gpu: GpuDetection | null | undefined;
  flag?: SandboxGpuFlag;
}): SandboxGpuMode {
  let mode: SandboxGpuMode = args.envMode ?? "auto";
  // GPU sandbox passthrough does not currently work on Jetson; disable by default
  if (args.gpu?.platform === "jetson" && args.envMode === null) mode = "0";
  if (args.flag === "enable") mode = "1";
  if (args.flag === "disable") mode = "0";
  return mode;
}

export function resolveSandboxGpuConfig(
  gpu: GpuDetection | null | undefined,
  options: {
    flag?: SandboxGpuFlag;
    device?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): SandboxGpuConfig {
  const env = options.env ?? process.env;
  const errors: string[] = [];
  const envModeRaw = env.NEMOCLAW_SANDBOX_GPU;
  const envMode = normalizeSandboxGpuMode(envModeRaw);
  if (envModeRaw !== undefined && envMode === null) {
    errors.push("NEMOCLAW_SANDBOX_GPU must be one of: auto, 1, 0.");
  }

  let mode = resolveSandboxGpuMode({ envMode, gpu, flag: options.flag });

  const requestedDevice = (options.device ?? env.NEMOCLAW_SANDBOX_GPU_DEVICE ?? "").trim() || null;
  if (requestedDevice && mode !== "1") {
    errors.push(
      "NEMOCLAW_SANDBOX_GPU_DEVICE requires sandbox GPU mode 1; " +
        "set NEMOCLAW_SANDBOX_GPU=1 or pass --sandbox-gpu.",
    );
  }
  const sandboxGpuDevice = mode === "1" ? requestedDevice : null;

  const hostGpuDetected = isNvidiaGpuDetected(gpu);
  if (mode === "1" && !hostGpuDetected) {
    errors.push("Sandbox GPU was requested, but no NVIDIA GPU was detected on the host.");
  }

  return {
    mode,
    hostGpuDetected,
    sandboxGpuEnabled: mode === "1" || (mode === "auto" && hostGpuDetected),
    sandboxGpuDevice,
    errors,
  };
}

export function getResumeSandboxGpuOverrides(
  entry:
    | { sandboxGpuMode?: SandboxGpuMode | string | null; sandboxGpuDevice?: string | null }
    | null
    | undefined,
  sessionGpuPassthrough: boolean | undefined,
): ResumeSandboxGpuOverrides {
  const recordedMode = normalizeSandboxGpuMode(entry?.sandboxGpuMode);
  if (recordedMode === "1") {
    return { flag: "enable", device: entry?.sandboxGpuDevice || null };
  }
  if (recordedMode === "0") {
    return { flag: "disable", device: null };
  }
  if (recordedMode === "auto") {
    return { flag: null, device: null };
  }
  if (sessionGpuPassthrough === true) {
    return { flag: "enable", device: entry?.sandboxGpuDevice || null };
  }
  return { flag: null, device: null };
}
