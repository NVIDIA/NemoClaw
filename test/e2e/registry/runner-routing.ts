// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Maps a typed target definition to the GitHub Actions runner label it
// should execute on.

import type { TargetDefinition } from "./types.ts";

export interface ResolvedRunner {
  /** GitHub Actions `runs-on` label. */
  runner: string;
  /** Reason the runner was selected, surfaced in matrix entries for debugging. */
  reason: string;
}

const PLATFORM_DEFAULT_RUNNER: Record<string, string> = {
  "ubuntu-local": "ubuntu-latest",
};

/**
 * Resolve the GitHub Actions runner label for a typed target.
 *
 * Throws when the target names a platform with no executable route.
 */
export function resolveRunnerForTarget(target: TargetDefinition): ResolvedRunner {
  const platform = target.environment.platform;
  if (PLATFORM_DEFAULT_RUNNER[platform]) {
    return { runner: PLATFORM_DEFAULT_RUNNER[platform], reason: `platform:${platform}` };
  }

  throw new Error(
    `Cannot resolve runner for target '${target.id}': no executable route for platform '${platform}'.`,
  );
}
