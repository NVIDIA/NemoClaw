// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildNativeRuntimeQualificationProducerPlan,
  nativeRuntimeQualificationOperationFile,
  NATIVE_RUNTIME_QUALIFICATION_FOCUSED_CASE,
  NATIVE_RUNTIME_QUALIFICATION_FOCUSED_OPERATIONS,
  type NativeRuntimeQualificationProducerPlanInput,
} from "../../../tools/e2e/native-runtime-qualification-producer-plan.mts";

const CANDIDATE_SHA = "a".repeat(40);

function input(): NativeRuntimeQualificationProducerPlanInput {
  return {
    source: {
      repository: "NVIDIA/NemoClaw",
      producerWorkflow: ".github/workflows/e2e.yaml",
      pullRequestNumber: 8064,
      candidateRepository: "NVIDIA/NemoClaw",
      candidateSha: CANDIDATE_SHA,
      baseRef: "main",
      baseSha: "b".repeat(40),
      workflowSha: "b".repeat(40),
      producerRunId: "123456789",
      producerRunAttempt: 1,
      dispatchArtifact: {
        id: "42",
        name: "e2e-dispatch-123456789-1",
        digest: `sha256:${"c".repeat(64)}`,
        sizeInBytes: 4096,
      },
    },
    installerSha256: "d".repeat(64),
    arm64GpuRunner: "reviewed-native-arm64-gpu-runner",
  };
}

describe("native runtime qualification producer plan", () => {
  it("routes every canonical case and preserves source and case identities", () => {
    const plan = buildNativeRuntimeQualificationProducerPlan(input());

    expect(plan.include).toHaveLength(24);
    expect(new Set(plan.include.map((entry) => entry.id)).size).toBe(24);
    for (const entry of plan.include) {
      expect(entry.jobName).toBe(`Native runtime qualification / ${entry.id}`);
      expect(entry.artifactName).toBe(
        `native-runtime-qualification-evidence-${CANDIDATE_SHA}-${entry.id}`,
      );
      expect(entry.source.candidateSha).toBe(CANDIDATE_SHA);
      expect(entry.source.baseSha).toBe(entry.source.workflowSha);
      expect(entry.case.id).toBe(entry.id);
      expect(
        new Set(entry.case.obligations.map(nativeRuntimeQualificationOperationFile)).size,
      ).toBe(entry.case.obligations.length);
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(
      plan.include.find(
        (entry) => entry.case.architecture === "amd64" && entry.case.acceleration === "cpu",
      )?.runner,
    ).toBe("ubuntu-26.04");
    expect(
      plan.include.find(
        (entry) => entry.case.architecture === "arm64" && entry.case.acceleration === "cpu",
      )?.runner,
    ).toBe("ubuntu-26.04-arm");
    expect(
      plan.include.find(
        (entry) => entry.case.architecture === "amd64" && entry.case.acceleration === "nvidia-gpu",
      )?.runner,
    ).toBe("linux-amd64-gpu-rtxpro6000-latest-1");
    expect(
      plan.include.find(
        (entry) => entry.case.architecture === "arm64" && entry.case.acceleration === "nvidia-gpu",
      )?.runner,
    ).toBe("reviewed-native-arm64-gpu-runner");
  });

  it("adds rootful and extended lifecycle work to one focused canonical case", () => {
    const plan = buildNativeRuntimeQualificationProducerPlan(input());
    const focused = plan.include.find(
      (entry) => entry.id === NATIVE_RUNTIME_QUALIFICATION_FOCUSED_CASE,
    );

    expect(focused?.rootModes).toEqual(["rootless", "rootful"]);
    expect(focused?.focusedOperations).toEqual(NATIVE_RUNTIME_QUALIFICATION_FOCUSED_OPERATIONS);
    expect(
      plan.include
        .filter((entry) => entry.id !== NATIVE_RUNTIME_QUALIFICATION_FOCUSED_CASE)
        .every(
          (entry) =>
            JSON.stringify(entry.rootModes) === JSON.stringify(["rootless"]) &&
            entry.focusedOperations.length === 0,
        ),
    ).toBe(true);
  });

  it("rejects a candidate workflow SHA as qualification authority", () => {
    const baseInput = input();
    const candidateWorkflow = {
      ...baseInput,
      source: { ...baseInput.source, workflowSha: CANDIDATE_SHA },
    } satisfies NativeRuntimeQualificationProducerPlanInput;

    expect(() => buildNativeRuntimeQualificationProducerPlan(candidateWorkflow)).toThrow(
      "Native runtime qualification producer source is invalid",
    );
  });

  it.each([
    ["fork candidate", { source: { ...input().source, candidateRepository: "fork/NemoClaw" } }],
    ["candidate commit", { source: { ...input().source, candidateSha: "A".repeat(40) } }],
    ["unbound workflow", { source: { ...input().source, workflowSha: "e".repeat(40) } }],
    ["run attempt", { source: { ...input().source, producerRunAttempt: 2 } }],
    ["installer digest", { installerSha256: "short" }],
    ["ARM64 GPU runner", { arm64GpuRunner: "" }],
    [
      "dispatch artifact",
      {
        source: {
          ...input().source,
          dispatchArtifact: { ...input().source.dispatchArtifact, sizeInBytes: 1_048_577 },
        },
      },
    ],
  ])("fails closed for an invalid %s", (_label, override) => {
    expect(() =>
      buildNativeRuntimeQualificationProducerPlan({
        ...input(),
        ...override,
      } as NativeRuntimeQualificationProducerPlanInput),
    ).toThrow("Native runtime qualification");
  });
});
