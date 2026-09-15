// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS } from "../live/cloud-experimental-check-list.ts";
import { buildLiveTargetRunPlan } from "../live/run-plan.ts";
import { buildTargetRegistry, listTargets } from "../registry/registry.ts";
import type { TargetDefinition, TargetEnvironment } from "../registry/types.ts";

function syntheticTarget(environment: TargetEnvironment): TargetDefinition {
  return {
    ...listTargets()[0]!,
    id: "synthetic-target",
    environment,
  };
}

describe("live target registry discovery", () => {
  // source-shape-contract: compatibility -- Every registry dimension must resolve to a live fixture before a target can be selected
  it.each([
    ["platform", "synthetic-platform"],
    ["install", "synthetic-install"],
    ["runtime", "synthetic-runtime"],
    ["onboarding", "synthetic-onboarding"],
    ["lifecycle", "synthetic-lifecycle"],
  ] as const)("rejects a target whose %s has no executable route (#11407)", (dimension, value) => {
    const environment = {
      ...listTargets()[0]!.environment,
      [dimension]: value,
    };

    expect(() => buildTargetRegistry([syntheticTarget(environment)])).toThrow(
      `${dimension} '${value}' has no live fixture`,
    );
  });

  // source-shape-contract: compatibility -- Registry entries must name an observable execution owner instead of silently becoming skipped tests
  it("rejects unresolved execution coverage (#11407)", () => {
    const target = {
      ...listTargets()[0]!,
      id: "synthetic-unresolved-target",
      executionCoverage: {
        agentRuntime: "unresolved" as const,
        observableOutcome: "unresolved",
        environmentOrInferenceEndpoint: "unresolved",
        unresolvedReason: "No executable owner",
      },
    };

    expect(() => buildTargetRegistry([target])).toThrow("execution coverage is unresolved");
  });

  // source-shape-contract: compatibility -- Executable registry metadata must still compile into the phase plan consumed by the live runner
  it("compiles a run plan from executable target behavior", () => {
    const unsupportedEnvironment = {
      ...listTargets().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw")!.environment,
      lifecycle: "dcode-rebuild-invalid-credential",
    };
    expect(() => buildTargetRegistry([syntheticTarget(unsupportedEnvironment)])).toThrow(
      "environment tuple 'platform=ubuntu-local, install=repo-current, runtime=managed-runtime-running, onboarding=cloud-openclaw, lifecycle=dcode-rebuild-invalid-credential' has no live fixture",
    );

    const target = listTargets().find(
      (entry) => entry.id === "ubuntu-repo-cloud-langchain-deepagents-code",
    )!;
    expect(buildLiveTargetRunPlan(target)).toMatchObject({
      targetId: target.id,
      manifestPath: target.manifestPath,
      expectedStateId: target.expectedStateId,
      suiteIds: target.suiteIds,
      phases: ["environment", "onboarding", "lifecycle", "state-validation"],
      e2eCloudExperimentalChecks: DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS,
    });
  });
});
