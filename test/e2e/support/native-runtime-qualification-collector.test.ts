// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  aggregateNativeRuntimeQualificationCases,
  collectNativeRuntimeQualificationCase,
  type NativeRuntimeQualificationCaseReceipt,
  validateNativeRuntimeQualificationDispatchReceipt,
} from "../../../tools/e2e/native-runtime-qualification-collector.mts";
import {
  buildNativeRuntimeQualificationPlan,
  type NativeRuntimeQualificationPlanRow,
  type NativeRuntimeQualificationPlanSource,
} from "../../../tools/e2e/native-runtime-qualification-plan.mts";

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

function evidence(row: NativeRuntimeQualificationPlanRow): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-case-evidence-v1",
    qualificationId: row.qualificationId,
    providerId: row.providerId,
    source: SOURCE,
    case: row.case,
    result: "passed",
  };
}

function receipts(): NativeRuntimeQualificationCaseReceipt[] {
  return buildNativeRuntimeQualificationPlan(SOURCE).include.map((row, index) =>
    collectNativeRuntimeQualificationCase(
      evidence(row),
      SOURCE,
      row.id,
      { id: String(index + 101), name: row.jobName },
      {
        id: String(index + 1),
        name: row.artifactName,
        digest: `sha256:${String(index).padStart(64, "0")}`,
        sizeInBytes: 4096,
      },
    ),
  );
}

function dispatchReceipt(overrides: Record<string, unknown> = {}): unknown {
  return {
    actor: "maintainer-one",
    allowDgxSparkRunnerQueue: false,
    allowJetsonDispatch: false,
    allowJetsonRunnerQueue: false,
    baseSha: SOURCE.baseSha,
    candidateRepository: SOURCE.candidateRepository,
    candidateSha: SOURCE.candidateSha,
    emptySelectors: false,
    eventName: "workflow_dispatch",
    includeStagingBrevLaunchable: false,
    jobs: "native-runtime-qualification-producer",
    kind: "nemoclaw-e2e-dispatch-v2",
    prNumber: 8062,
    releaseQualificationWaivedJobs: [],
    releaseQualificationWaiverReason: null,
    repository: "NVIDIA/NemoClaw",
    targets: "",
    triggeringActor: "maintainer-one",
    workflowRunAttempt: SOURCE.producerRunAttempt,
    workflowRunId: SOURCE.producerRunId,
    workflowSha: SOURCE.workflowSha,
    ...overrides,
  };
}

describe("native runtime qualification evidence collection", () => {
  it("authenticates the producer dispatch receipt against every source revision", () => {
    expect(() =>
      validateNativeRuntimeQualificationDispatchReceipt(dispatchReceipt(), SOURCE, {
        repository: "NVIDIA/NemoClaw",
        prNumber: 8062,
      }),
    ).not.toThrow();
  });

  it.each([
    ["candidate SHA", { candidateSha: "e".repeat(40) }],
    ["base SHA", { baseSha: "e".repeat(40) }],
    ["run attempt", { workflowRunAttempt: 2 }],
    ["workflow SHA", { workflowSha: "e".repeat(40) }],
    [
      "release waiver",
      { releaseQualificationWaivedJobs: ["native-runtime-qualification-producer"] },
    ],
    ["producer selector", { jobs: "native-runtime-qualification" }],
  ])("rejects a dispatch receipt with a different %s", (_label, override) => {
    expect(() =>
      validateNativeRuntimeQualificationDispatchReceipt(dispatchReceipt(override), SOURCE, {
        repository: "NVIDIA/NemoClaw",
        prNumber: 8062,
      }),
    ).toThrow("dispatch receipt identity is invalid");
  });

  it("rejects a dispatch receipt whose pull request differs from the authority source", () => {
    expect(() =>
      validateNativeRuntimeQualificationDispatchReceipt(
        dispatchReceipt(),
        { ...SOURCE, pullRequestNumber: 8063 },
        { repository: "NVIDIA/NemoClaw", prNumber: 8062 },
      ),
    ).toThrow("dispatch receipt identity is invalid");
  });

  it("normalizes one case only when its canonical identity and source match", () => {
    const row = buildNativeRuntimeQualificationPlan(SOURCE).include[0]!;
    const receipt = collectNativeRuntimeQualificationCase(
      evidence(row),
      SOURCE,
      row.id,
      { id: "101", name: row.jobName },
      {
        id: "1",
        name: row.artifactName,
        digest: `sha256:${"0".repeat(64)}`,
        sizeInBytes: 4096,
      },
    );

    expect(receipt).toMatchObject({
      caseId: row.id,
      qualificationId: row.qualificationId,
      source: SOURCE,
      result: "passed",
    });
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("aggregates all canonical cases in deterministic order", () => {
    const aggregate = aggregateNativeRuntimeQualificationCases(receipts().reverse(), SOURCE);

    expect(aggregate.kind).toBe("nemoclaw-native-runtime-qualification-authority-v1");
    expect(aggregate.source.protectedJobs).toHaveLength(24);
    expect(aggregate.source.protectedJobs.map((entry) => entry.caseId)).toEqual(
      buildNativeRuntimeQualificationPlan(SOURCE).include.map((entry) => entry.id),
    );
  });

  it.each([
    ["missing", (values: NativeRuntimeQualificationCaseReceipt[]) => values.slice(1)],
    ["duplicate", (values: NativeRuntimeQualificationCaseReceipt[]) => [...values, values[0]!]],
    [
      "unexpected",
      (values: NativeRuntimeQualificationCaseReceipt[]) => [
        { ...values[0]!, caseId: "podman-unexpected" },
        ...values.slice(1),
      ],
    ],
  ])("rejects %s case receipts", (_label, mutate) => {
    expect(() => aggregateNativeRuntimeQualificationCases(mutate(receipts()), SOURCE)).toThrow(
      "Native runtime qualification",
    );
  });

  it.each(["candidateSha", "baseSha", "workflowSha"] as const)(
    "rejects mixed %s receipt identities",
    (field) => {
      const values = receipts();
      values[0] = {
        ...values[0]!,
        source: { ...values[0]!.source, [field]: "d".repeat(40) },
      };

      expect(() => aggregateNativeRuntimeQualificationCases(values, SOURCE)).toThrow(
        "source identity does not match the trusted plan",
      );
    },
  );

  it("rejects a case body that does not match its case ID", () => {
    const plan = buildNativeRuntimeQualificationPlan(SOURCE);
    const first = plan.include[0]!;

    expect(() =>
      collectNativeRuntimeQualificationCase(
        { ...evidence(first), case: plan.include[1]!.case },
        SOURCE,
        first.id,
        { id: "101", name: first.jobName },
        {
          id: "1",
          name: first.artifactName,
          digest: `sha256:${"0".repeat(64)}`,
          sizeInBytes: 4096,
        },
      ),
    ).toThrow(`case '${first.id}' does not match the trusted plan`);
  });

  it("rejects a case artifact from a different protected job", () => {
    const row = buildNativeRuntimeQualificationPlan(SOURCE).include[0]!;

    expect(() =>
      collectNativeRuntimeQualificationCase(
        evidence(row),
        SOURCE,
        row.id,
        { id: "101", name: "Native runtime qualification / unexpected" },
        {
          id: "1",
          name: row.artifactName,
          digest: `sha256:${"0".repeat(64)}`,
          sizeInBytes: 4096,
        },
      ),
    ).toThrow("protected job identity is invalid");
  });

  it("rejects producer artifact metadata outside the reviewed size bound", () => {
    const row = buildNativeRuntimeQualificationPlan(SOURCE).include[0]!;

    expect(() =>
      collectNativeRuntimeQualificationCase(
        evidence(row),
        SOURCE,
        row.id,
        {
          id: "101",
          name: row.jobName,
        },
        {
          id: "1",
          name: row.artifactName,
          digest: `sha256:${"0".repeat(64)}`,
          sizeInBytes: 1_048_577,
        },
      ),
    ).toThrow("artifact identity is invalid");
  });
});
