// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decideReviewAction } from "../../../tools/pr-review-coordinator/decision.mts";
import {
  collectEligibleExistingSamples,
  type CoordinatorShadowResult,
  parseCoordinatorShadowResult,
  selectCoordinatorShadowSample,
  verifyArtifactDownload,
} from "../../../tools/pr-review-coordinator/shadow-sample.mts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function result(prNumber = 12090): CoordinatorShadowResult {
  const snapshot = {
    version: 1 as const,
    pullRequest: {
      number: prNumber,
      state: "OPEN" as const,
      draft: false,
      author: `contributor-${prNumber}`,
      reviewer: "nemoclaw-review-coordinator[bot]",
      headSha: HEAD,
      baseSha: BASE,
    },
    advisor: {
      identity: "exact-head" as const,
      headSha: HEAD,
      baseSha: BASE,
      status: "clear" as const,
      findings: [],
    },
    readiness: {
      requiredChecks: "pass" as const,
      mergeability: "mergeable" as const,
      commitsVerified: true,
      productScope: "accepted" as const,
    },
    history: { contractEvidence: "none" as const, frozenContractKeys: [], writes: [] },
  };
  return { mode: "read-only-shadow", snapshot, decision: decideReviewAction(snapshot) };
}

const sourceRun = {
  id: 3001,
  attempt: 1,
  createdAt: "2026-09-21T12:00:00Z",
};

function eligibleSourceRun(run = sourceRun) {
  return {
    id: run.id,
    run_attempt: run.attempt,
    created_at: run.createdAt,
    path: ".github/workflows/pr-review-advisor.yaml",
    event: "workflow_run",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    repository: { full_name: "NVIDIA/NemoClaw" },
    head_repository: { full_name: "NVIDIA/NemoClaw" },
  };
}

function eligibleSampleProducerRun(id: number, sourceRunId: number) {
  return {
    id,
    display_title: `Shadow sample after Advisor run ${sourceRunId}`,
    path: ".github/workflows/pr-review-coordinator-shadow-sample.yaml",
    event: "workflow_run",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    repository: { full_name: "NVIDIA/NemoClaw" },
    head_repository: { full_name: "NVIDIA/NemoClaw" },
  };
}

describe("coordinator shadow rollout sample", () => {
  it("captures five distinct PR decisions and then stops", () => {
    const first = selectCoordinatorShadowSample(result(12090), [], sourceRun)!;
    const second = selectCoordinatorShadowSample(result(12091), [first], {
      ...sourceRun,
      id: 3002,
    })!;
    const third = selectCoordinatorShadowSample(result(12092), [first, second], {
      ...sourceRun,
      id: 3003,
    })!;
    const fourth = selectCoordinatorShadowSample(result(12093), [first, second, third], {
      ...sourceRun,
      id: 3004,
    })!;
    const fifth = selectCoordinatorShadowSample(result(12094), [first, second, third, fourth], {
      ...sourceRun,
      id: 3005,
    })!;
    const samples = [first, second, third, fourth, fifth];
    expect(samples.map((sample) => sample.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(selectCoordinatorShadowSample(result(12100), samples, sourceRun)).toBeNull();
  });

  it("does not spend another slot on the same PR", () => {
    const sample = selectCoordinatorShadowSample(result(), [], sourceRun)!;
    expect(selectCoordinatorShadowSample(result(), [sample], sourceRun)).toBeNull();
  });

  it("rejects a decision that does not match its snapshot", () => {
    const tampered = structuredClone(result()) as unknown as Record<string, unknown>;
    tampered.decision = {
      ...(tampered.decision as Record<string, unknown>),
      action: "stay-quiet",
    };
    expect(() => parseCoordinatorShadowResult(tampered)).toThrow(
      "decision does not match its validated snapshot",
    );
  });

  it("rejects non-contiguous or duplicate stored samples", () => {
    const first = selectCoordinatorShadowSample(result(12090), [], sourceRun)!;
    expect(() =>
      selectCoordinatorShadowSample(result(12091), [{ ...first, ordinal: 2 }], sourceRun),
    ).toThrow("contiguous ordinals");
    expect(() =>
      selectCoordinatorShadowSample(
        result(12091),
        [first, { ...first, ordinal: 2, sourceRun: { ...sourceRun, id: 3002 } }],
        sourceRun,
      ),
    ).toThrow("distinct pull requests");
  });

  it("ignores an artifact from another workflow before it can spend a slot", async () => {
    const foreignArtifact = { id: 41, workflowRunId: 4001 };
    const trustedArtifact = { id: 42, workflowRunId: 4002 };
    const trustedSample = selectCoordinatorShadowSample(result(12091), [], sourceRun)!;
    const samples = new Map([
      [foreignArtifact.id, selectCoordinatorShadowSample(result(12090), [], sourceRun)!],
      [trustedArtifact.id, trustedSample],
    ]);
    const runs = new Map<number, unknown>([
      [
        foreignArtifact.workflowRunId,
        {
          ...eligibleSampleProducerRun(foreignArtifact.workflowRunId, sourceRun.id),
          path: ".github/workflows/untrusted.yaml",
        },
      ],
      [
        trustedArtifact.workflowRunId,
        eligibleSampleProducerRun(trustedArtifact.workflowRunId, sourceRun.id),
      ],
      [sourceRun.id, eligibleSourceRun()],
    ]);
    const readSampleIds: number[] = [];

    const existing = await collectEligibleExistingSamples([foreignArtifact, trustedArtifact], {
      readRun: async (id) => runs.get(id),
      readSample: async (artifact) => {
        readSampleIds.push(artifact.id);
        return samples.get(artifact.id);
      },
    });

    expect(existing).toEqual([trustedSample]);
    expect(readSampleIds).toEqual([trustedArtifact.id]);
    expect(selectCoordinatorShadowSample(result(12090), existing, sourceRun)?.ordinal).toBe(2);
  });

  it("ignores a stored sample whose recorded Advisor run is ineligible", async () => {
    const artifact = { id: 43, workflowRunId: 4003 };
    const stored = selectCoordinatorShadowSample(result(12090), [], sourceRun)!;
    const existing = await collectEligibleExistingSamples([artifact], {
      readRun: async (id) =>
        id === artifact.workflowRunId
          ? eligibleSampleProducerRun(id, sourceRun.id)
          : { ...eligibleSourceRun(), path: ".github/workflows/untrusted.yaml" },
      readSample: async () => stored,
    });

    expect(existing).toEqual([]);
    expect(selectCoordinatorShadowSample(result(12090), existing, sourceRun)?.ordinal).toBe(1);
  });

  it("validates downloaded bytes independently from artifact metadata size", () => {
    const bytes = Buffer.from("zip bytes");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    expect(verifyArtifactDownload(bytes, { id: 44, digest, size: 1 })).toEqual(bytes);
    expect(() => verifyArtifactDownload(Buffer.alloc(0), { id: 44, digest, size: 1 })).toThrow(
      "download size is invalid",
    );
  });
});
