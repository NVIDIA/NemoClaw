// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Maps a typed scenario definition to the GitHub Actions runner label it
// should execute on. The mapping is derived from the typed
// `ScenarioEnvironment.platform` and `ScenarioDefinition.runnerRequirements`
// fields so that adding a scenario to the registry automatically resolves a
// runner without editing workflow YAML.

import type { ScenarioDefinition } from "./types.ts";

export interface ResolvedRunner {
  /** GitHub Actions `runs-on` label. */
  runner: string;
  /** Reason the runner was selected, surfaced in matrix entries for debugging. */
  reason: string;
}

const PLATFORM_DEFAULT_RUNNER: Record<string, string> = {
  "ubuntu-local": "ubuntu-latest",
  "gpu-runner": "linux-amd64-gpu-rtxpro6000-latest-1",
  "macos-local": "macos-26",
  "wsl-local": "windows-latest",
  "brev-launchable": "ubuntu-latest",
};

/**
 * Resolve the GitHub Actions runner label for a typed scenario.
 *
 * Routing precedence:
 *   1. An explicit `runs-on:<label>` entry in `runnerRequirements`.
 *   2. The default runner mapped from `environment.platform`.
 *
 * Throws when neither path yields a runner so missing platform mappings fail
 * loudly during matrix generation rather than silently falling back to
 * `ubuntu-latest` (which used to mask routing bugs in the legacy bash map).
 */
export function resolveRunnerForScenario(scenario: ScenarioDefinition): ResolvedRunner {
  const explicit = (scenario.runnerRequirements ?? []).find((req) => req.startsWith("runs-on:"));
  if (explicit) {
    const runner = explicit.slice("runs-on:".length).trim();
    if (!runner) {
      throw new Error(
        `Cannot resolve runner for scenario '${scenario.id}': empty runs-on override.`,
      );
    }
    return { runner, reason: "runnerRequirements override" };
  }

  const platform = scenario.environment?.platform;
  if (platform && PLATFORM_DEFAULT_RUNNER[platform]) {
    return { runner: PLATFORM_DEFAULT_RUNNER[platform], reason: `platform:${platform}` };
  }

  throw new Error(
    `Cannot resolve runner for scenario '${scenario.id}': no runs-on override and no default for platform '${platform ?? "<missing>"}'.`,
  );
}
