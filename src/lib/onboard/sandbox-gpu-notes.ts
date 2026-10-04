// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function formatSandboxGpuPassthroughNote(options: {
  hostGpuPlatform?: string | null;
  resumeHasResolvedGpuIntent?: boolean;
  recordedGpuPassthroughBeforePreflight?: boolean;
  requestedGpuPassthrough?: boolean;
  sandboxGpuMode?: string | null;
}): string {
  if (options.hostGpuPlatform === "jetson") {
    return "  NVIDIA Jetson/Tegra GPU detected; enabling sandbox GPU through Docker NVIDIA runtime. Use --no-gpu to opt out.";
  }
  if (options.resumeHasResolvedGpuIntent && options.recordedGpuPassthroughBeforePreflight) {
    return "  [resume] Continuing GPU passthrough from the saved onboarding session.";
  }
  if (options.requestedGpuPassthrough || options.sandboxGpuMode === "1") {
    return "  GPU passthrough requested; passing --gpu to OpenShell gateway and sandbox creation.";
  }
  return "  NVIDIA GPU detected; enabling OpenShell GPU passthrough. Use --no-gpu to opt out.";
}
