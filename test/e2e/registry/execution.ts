// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  e2eExecutionTitle,
  type E2eExecutionMetadata,
  validateE2eExecutionMetadata,
} from "../../../tools/e2e/execution-coverage.mts";
import type { TargetDefinition } from "./types.ts";

const EXECUTABLE_PLATFORMS = new Set(["ubuntu-local"]);
const EXECUTABLE_INSTALLS = new Set(["repo-current"]);
const EXECUTABLE_RUNTIMES = new Set(["docker-running", "managed-runtime-running"]);
const EXECUTABLE_ONBOARDING = new Set([
  "cloud-openclaw",
  "cloud-openclaw-policy-custom-missing-presets",
  "cloud-langchain-deepagents-code",
]);
const EXECUTABLE_LIFECYCLES = new Set(["post-reboot-recovery", "dcode-rebuild-invalid-credential"]);

function missingExecutionRoute(target: TargetDefinition): string[] {
  const { environment } = target;
  const missing: string[] = [];
  for (const [dimension, value, executable] of [
    ["platform", environment.platform, EXECUTABLE_PLATFORMS],
    ["install", environment.install, EXECUTABLE_INSTALLS],
    ["runtime", environment.runtime, EXECUTABLE_RUNTIMES],
    ["onboarding", environment.onboarding, EXECUTABLE_ONBOARDING],
  ] as const) {
    if (!executable.has(value)) {
      missing.push(`${dimension} '${value}' has no live fixture`);
    }
  }
  if (environment.lifecycle && !EXECUTABLE_LIFECYCLES.has(environment.lifecycle)) {
    missing.push(`lifecycle '${environment.lifecycle}' has no live fixture`);
  }
  return missing;
}

export function requireLiveTargetExecution(target: TargetDefinition): E2eExecutionMetadata {
  const missing = missingExecutionRoute(target);
  if (missing.length > 0) {
    throw new Error(`Target '${target.id}' is not executable: ${missing.join("; ")}`);
  }
  const coverage = validateE2eExecutionMetadata(
    target.executionCoverage,
    `Typed E2E target ${target.id}`,
  );
  if (coverage.unresolvedReason !== "") {
    throw new Error(`Target '${target.id}' is not executable: execution coverage is unresolved`);
  }
  return coverage;
}

export function liveTargetTestTitle(target: TargetDefinition): string {
  return `${target.id}: ${e2eExecutionTitle(requireLiveTargetExecution(target))}`;
}
