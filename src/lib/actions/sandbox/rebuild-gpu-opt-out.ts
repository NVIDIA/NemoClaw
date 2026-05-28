// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeSandboxGpuMode } from "../../onboard/sandbox-gpu-mode";

export type RebuildGpuOptOutEntry = {
  sandboxGpuMode?: string | null;
  sandboxGpuEnabled?: boolean;
  gpuEnabled?: boolean;
};

// Modern source of truth is the persisted `sandboxGpuMode` string ("0" / "1" /
// "auto"). The legacy `gpuEnabled` fallback fires when `normalizeSandboxGpuMode`
// returns null — that covers older registry entries written before
// `sandboxGpuMode` landed and tolerates malformed mode values (treating them
// as "no recorded intent") rather than locking the rebuild into the wrong
// branch on corrupted state.
export function rebuildShouldOptOutGpu(
  sb: RebuildGpuOptOutEntry | null | undefined,
): boolean {
  if (!sb) return false;
  const mode = normalizeSandboxGpuMode(sb.sandboxGpuMode);
  if (mode === "0") return true;
  if (mode === "1" || mode === "auto") return false;
  if (sb.sandboxGpuEnabled === true) return false;
  return sb.gpuEnabled === false;
}

export type RebuildRecreateOnboardOpts = {
  resume: true;
  nonInteractive: true;
  recreateSandbox: true;
  agent: string | null | undefined;
  fromDockerfile: string | null;
  autoYes: boolean;
  noGpu?: true;
};

export function buildRebuildRecreateOnboardOpts(args: {
  sb: RebuildGpuOptOutEntry | null | undefined;
  rebuildAgent: string | null | undefined;
  storedFromDockerfile: string | null;
  autoYes: boolean;
}): RebuildRecreateOnboardOpts {
  return {
    resume: true,
    nonInteractive: true,
    recreateSandbox: true,
    agent: args.rebuildAgent,
    fromDockerfile: args.storedFromDockerfile,
    autoYes: args.autoYes,
    ...(rebuildShouldOptOutGpu(args.sb) ? { noGpu: true as const } : {}),
  };
}
