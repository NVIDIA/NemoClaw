// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeSandboxGpuMode } from "../../onboard/sandbox-gpu-mode";

export function rebuildShouldOptOutGpu(
  sb:
    | {
        sandboxGpuMode?: string | null;
        sandboxGpuEnabled?: boolean;
        gpuEnabled?: boolean;
      }
    | null
    | undefined,
): boolean {
  if (!sb) return false;
  const mode = normalizeSandboxGpuMode(sb.sandboxGpuMode);
  if (mode === "0") return true;
  if (mode === "1" || mode === "auto") return false;
  if (sb.sandboxGpuEnabled === true) return false;
  return sb.gpuEnabled === false;
}
