// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GpuDetection } from "../inference/nim";

export type SandboxGpuMode = "auto" | "1" | "0";
export type SandboxGpuFlag = "enable" | "disable" | null;

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
