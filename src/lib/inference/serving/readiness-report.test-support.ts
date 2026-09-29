// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SystemReadinessReport } from "../../readiness/types.js";
import type { ManagedInferenceServingPreset, ServingPreset } from "./types.js";

/** Build a host readiness report that satisfies every readiness requirement of one preset. */
export function readinessReportForPreset(
  preset: ManagedInferenceServingPreset | ServingPreset,
  overrides: Partial<SystemReadinessReport> = {},
): SystemReadinessReport {
  const requirements = (preset.spec.requirements?.all ?? []).flatMap((requirement) =>
    "readiness" in requirement ? [requirement.readiness] : [],
  );
  return {
    schemaVersion: "1.1.0",
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: "a".repeat(40),
      observedAt: new Date().toISOString(),
    },
    observations: requirements.flatMap((requirement) =>
      requirement.kind !== "observation"
        ? []
        : "state" in requirement
          ? [{ id: requirement.id, state: requirement.state }]
          : [
              {
                id: requirement.id,
                state: "present" as const,
                value:
                  requirement.comparison.operator === "one-of"
                    ? requirement.comparison.values[0]
                    : requirement.comparison.value,
              },
            ],
    ),
    capabilities: requirements.flatMap((requirement) =>
      requirement.kind === "capability" ? [{ id: requirement.id, state: requirement.state }] : [],
    ),
    qualifications: requirements.flatMap((requirement) =>
      requirement.kind === "qualification"
        ? [{ id: requirement.id, status: requirement.status }]
        : [],
    ),
    findings: [],
    evidence: [],
    status: "supported",
    exitCode: 0,
    ...overrides,
  } as SystemReadinessReport;
}
