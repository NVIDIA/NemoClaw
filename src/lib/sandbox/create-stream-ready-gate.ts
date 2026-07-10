// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const VM_READY_DETACH_OUTPUT_PATTERNS: readonly RegExp[] = [/Setting up NemoClaw/];

function selectedDrivers(env: NodeJS.ProcessEnv): string[] {
  const raw = env.OPENSHELL_DRIVERS ?? (process.platform === "darwin" ? "vm" : "docker");
  return raw
    .split(",")
    .map((driver) => driver.trim())
    .filter(Boolean);
}

export function getReadyCheckOutputPatterns(
  env: NodeJS.ProcessEnv,
  patterns: readonly RegExp[] | undefined,
): readonly RegExp[] {
  if (patterns) return patterns;
  return selectedDrivers(env).includes("vm") ? VM_READY_DETACH_OUTPUT_PATTERNS : [];
}

export function getReadyCheckOutputPatternsForAgent(
  isTerminalAgent: boolean,
  env: NodeJS.ProcessEnv,
): readonly RegExp[] {
  return isTerminalAgent ? [] : getReadyCheckOutputPatterns(env, undefined);
}
