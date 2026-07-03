// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PreparedDcodeRebuildHandoff } from "../../onboard/prepared-dcode-rebuild";
import { normalizeSandboxGpuMode } from "../../onboard/sandbox-gpu-mode";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";

export type RebuildGpuOptOutEntry = {
  sandboxGpuMode?: string | null;
  sandboxGpuEnabled?: boolean;
  gpuEnabled?: boolean;
};

// Modern source of truth is the persisted `sandboxGpuMode` string ("0" / "1" /
// "auto"). The legacy `gpuEnabled` fallback only runs for older entries with
// no recorded mode field — a malformed but present `sandboxGpuMode` value is
// treated as "do nothing" rather than silently routed through the legacy
// path, so corrupted state cannot flip a sandbox into a permanent opt-out.
function hasRecordedGpuMode(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function rebuildShouldOptOutGpu(sb: RebuildGpuOptOutEntry | null | undefined): boolean {
  if (!sb) return false;
  const mode = normalizeSandboxGpuMode(sb.sandboxGpuMode);
  if (mode === "0") return true;
  if (mode === "1" || mode === "auto") return false;
  if (hasRecordedGpuMode(sb.sandboxGpuMode)) return false;
  if (sb.sandboxGpuEnabled === true) return false;
  return sb.gpuEnabled === false;
}

export type RebuildRecreateOnboardOpts = {
  resume: true;
  nonInteractive: true;
  recreateSandbox: true;
  agent: string | null | undefined;
  fromDockerfile: string | null;
  preparedDcodeRebuild?: PreparedDcodeRebuildHandoff;
  autoYes: boolean;
  baseImageResolutionHint: SandboxBaseImageResolutionMetadata | null;
  noGpu?: true;
};

export function buildRebuildRecreateOnboardOpts(args: {
  sb: RebuildGpuOptOutEntry | null | undefined;
  rebuildAgent: string | null | undefined;
  storedFromDockerfile: string | null;
  preparedDcodeRebuild?: PreparedDcodeRebuildHandoff;
  autoYes: boolean;
  baseImageResolutionHint?: SandboxBaseImageResolutionMetadata | null;
}): RebuildRecreateOnboardOpts {
  return {
    resume: true,
    nonInteractive: true,
    recreateSandbox: true,
    agent: args.rebuildAgent,
    fromDockerfile: args.storedFromDockerfile,
    ...(args.preparedDcodeRebuild ? { preparedDcodeRebuild: args.preparedDcodeRebuild } : {}),
    autoYes: args.autoYes,
    baseImageResolutionHint: args.baseImageResolutionHint ?? null,
    ...(rebuildShouldOptOutGpu(args.sb) ? { noGpu: true as const } : {}),
  };
}
