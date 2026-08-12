// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GpuDetection } from "../inference/nim";

type Logger = (message?: string) => void;

export interface NimImageCompatibilityWarningInput {
  arch?: NodeJS.Architecture;
  gpu: Pick<GpuDetection, "platform" | "spark"> | null | undefined;
  nimLocalAvailable: boolean;
  platform?: NodeJS.Platform;
}

const ARM64_DGX_NIM_PLATFORMS = new Set(["spark", "station"]);

export function shouldWarnAboutArm64NimImageCompatibility({
  arch = process.arch,
  gpu,
  nimLocalAvailable,
  platform = process.platform,
}: NimImageCompatibilityWarningInput): boolean {
  if (!nimLocalAvailable || platform !== "linux" || arch !== "arm64") return false;
  return gpu?.spark === true || (gpu?.platform ? ARM64_DGX_NIM_PLATFORMS.has(gpu.platform) : false);
}

function dgxPlatformLabel(gpu: NimImageCompatibilityWarningInput["gpu"]): string {
  if (gpu?.platform === "station") return "DGX Station";
  return "DGX Spark";
}

export function formatArm64NimImageCompatibilityWarning(
  input: Pick<NimImageCompatibilityWarningInput, "gpu">,
): string[] {
  const hostLabel = dgxPlatformLabel(input.gpu);
  return [
    `  Warning: Local NVIDIA NIM is experimental on Linux arm64 ${hostLabel} hosts.`,
    "  Some NIM images may not publish linux/arm64 manifests.",
    "  NemoClaw will try the selected image/platform digest when possible; if Docker reports no matching platform, choose NVIDIA Endpoints, vLLM, or another provider.",
  ];
}

export function warnAboutArm64NimImageCompatibility(
  input: NimImageCompatibilityWarningInput & { log?: Logger },
): boolean {
  if (!shouldWarnAboutArm64NimImageCompatibility(input)) return false;
  const log = input.log ?? console.log;
  log("");
  for (const line of formatArm64NimImageCompatibilityWarning(input)) log(line);
  log("");
  return true;
}
