// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildNativeRuntimeQualificationPlan,
  type NativeRuntimeQualificationPlanSource,
} from "../../../tools/e2e/native-runtime-qualification-plan.mts";
import { PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION } from "../registry/native-runtime-qualification";

const SOURCE: NativeRuntimeQualificationPlanSource = {
  repository: "NVIDIA/NemoClaw",
  producerWorkflow: ".github/workflows/e2e.yaml",
  pullRequestNumber: 8062,
  candidateRepository: "NVIDIA/NemoClaw",
  candidateSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "c".repeat(40),
  workflowSha: "c".repeat(40),
  producerRunId: "123456789",
  producerRunAttempt: 1,
  dispatchArtifact: {
    id: "42",
    name: "e2e-dispatch-123456789-1",
    digest: `sha256:${"d".repeat(64)}`,
    sizeInBytes: 4096,
  },
};

describe("native runtime qualification trusted plan", () => {
  it("emits the complete canonical matrix with separate source identities", () => {
    const plan = buildNativeRuntimeQualificationPlan(SOURCE);

    expect(plan.include).toHaveLength(24);
    expect(plan.include.map((entry) => entry.id)).toEqual(
      PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION.cases.map((entry) => entry.id),
    );
    expect(plan.include.every((entry) => entry.candidateSha === SOURCE.candidateSha)).toBe(true);
    expect(plan.include.every((entry) => entry.baseSha === SOURCE.baseSha)).toBe(true);
    expect(plan.include.every((entry) => entry.workflowSha === SOURCE.workflowSha)).toBe(true);
    expect(plan.include.every((entry) => entry.producerRunId === SOURCE.producerRunId)).toBe(true);
    expect(plan.include.every((entry) => entry.jobName.endsWith(entry.id))).toBe(true);
    expect(
      plan.include.every((entry) => entry.producerRunAttempt === SOURCE.producerRunAttempt),
    ).toBe(true);
    expect(plan.include.every((entry) => Object.isFrozen(entry.dispatchArtifact))).toBe(true);
    expect(plan.include.map((entry) => entry.dispatchArtifact)).toEqual(
      plan.include.map(() => SOURCE.dispatchArtifact),
    );
    expect(
      plan.include.every(
        (entry) =>
          entry.artifactName ===
          `native-runtime-qualification-evidence-${SOURCE.candidateSha}-${entry.id}`,
      ),
    ).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.include)).toBe(true);
    expect(
      plan.include.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.case)),
    ).toBe(true);
  });

  it("emits deterministic rows for the same source", () => {
    const first = buildNativeRuntimeQualificationPlan(SOURCE);
    const second = buildNativeRuntimeQualificationPlan({ ...SOURCE });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it.each([
    ["repository", { repository: "example/NemoClaw" }],
    ["producer workflow", { producerWorkflow: ".github/workflows/other.yaml" }],
    ["pull request number", { pullRequestNumber: 0 }],
    ["candidate repository", { candidateRepository: "invalid" }],
    ["candidate SHA", { candidateSha: "A".repeat(40) }],
    ["base ref", { baseRef: "release" }],
    ["base SHA", { baseSha: "short" }],
    ["trusted workflow SHA", { workflowSha: "z".repeat(40) }],
    ["candidate and base revisions", { candidateSha: SOURCE.baseSha }],
    ["base and workflow revisions", { workflowSha: "e".repeat(40) }],
    ["producer run ID", { producerRunId: "0" }],
    ["producer run attempt", { producerRunAttempt: 2 }],
    ["dispatch artifact", { dispatchArtifact: { ...SOURCE.dispatchArtifact, name: "unexpected" } }],
  ])("rejects invalid %s", (_label, override) => {
    expect(() => buildNativeRuntimeQualificationPlan({ ...SOURCE, ...override })).toThrow(
      "Native runtime qualification",
    );
  });
});
