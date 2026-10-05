// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  e2eExecutionTitle,
  type E2eExecutionMetadata,
  validateE2eExecutionMetadata,
} from "../../../tools/e2e/execution-coverage.mts";
import type { TargetDefinition, TargetEnvironment } from "./types.ts";

const EXECUTABLE_ROUTES: readonly TargetEnvironment[] = [
  {
    platform: "ubuntu-local",
    install: "repo-current",
    runtime: "managed-runtime-running",
    onboarding: "cloud-openclaw",
  },
  {
    platform: "ubuntu-local",
    install: "repo-current",
    runtime: "managed-runtime-running",
    onboarding: "cloud-langchain-deepagents-code",
    lifecycle: "dcode-rebuild-invalid-credential",
  },
  {
    platform: "ubuntu-local",
    install: "repo-current",
    runtime: "managed-runtime-running",
    onboarding: "cloud-openclaw-policy-custom-missing-presets",
  },
];

const EXECUTION_ROUTE_DIMENSIONS = [
  "platform",
  "install",
  "runtime",
  "onboarding",
  "lifecycle",
] as const;

function missingExecutionRoute(target: TargetDefinition): string[] {
  const { environment } = target;
  const missing: string[] = [];
  for (const dimension of EXECUTION_ROUTE_DIMENSIONS) {
    const value = environment[dimension];
    if (value === undefined) continue;
    const executable = EXECUTABLE_ROUTES.some((route) => route[dimension] === value);
    if (!executable) {
      missing.push(`${dimension} '${value}' has no live fixture`);
    }
  }

  const completeRouteExists = EXECUTABLE_ROUTES.some((route) =>
    EXECUTION_ROUTE_DIMENSIONS.every((dimension) => route[dimension] === environment[dimension]),
  );
  if (missing.length === 0 && !completeRouteExists) {
    const route = EXECUTION_ROUTE_DIMENSIONS.map(
      (dimension) => `${dimension}=${environment[dimension] ?? "none"}`,
    ).join(", ");
    missing.push(`environment tuple '${route}' has no live fixture`);
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
