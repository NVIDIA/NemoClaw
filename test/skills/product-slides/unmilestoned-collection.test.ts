// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  collectRoadmapEpicEvidence,
  type DetailedRawOpenIssue,
  expectedReceiptQuerySha256,
  expectedReceiptScopeForSnapshot,
  expectedReceiptSourceForQuery,
  receiptRequestSha256,
  requiredReceiptQueryIds,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts";
import {
  canonicalSha256,
  sha256Text,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/validate-slide-model.mts";
import {
  createReadOnlyGitHubExecutor,
  UNMILESTONED_EPIC_BODY,
  UNMILESTONED_EPIC_NUMBER,
} from "./github-snapshot-test-support";
import {
  addSyntheticPresentationMappedEpic,
  buildSyntheticModel,
  finalizeSyntheticRoadmap,
  publicationCodes,
  syntheticFixtureInputs,
} from "./model-test-support";

function roadmapIssueNumbers(model: Record<string, unknown>, role: string): number[] {
  const slides = (model.slides as Array<Record<string, unknown>>).filter(
    (slide) => slide.role === role,
  );
  return role === "roadmap-executive"
    ? slides.flatMap((slide) =>
        (slide.milestones as Array<Record<string, unknown>>).flatMap((milestone) =>
          (milestone.outcomes as Array<Record<string, unknown>>).map((outcome) =>
            Number(outcome.issueNumber),
          ),
        ),
      )
    : slides.flatMap((slide) =>
        (slide.cells as Array<Record<string, unknown>>).flatMap((cell) =>
          (cell.items as Array<Record<string, unknown>>).map((item) => Number(item.issueNumber)),
        ),
      );
}

function candidateReceipts(snapshot: Record<string, unknown>): Array<Record<string, unknown>> {
  const collection = snapshot.collection as Record<string, unknown>;
  const receipts = collection.receipts as Array<Record<string, unknown>>;
  const candidateQueryIds = new Set([
    "repository-open-issues",
    `issue-${String(UNMILESTONED_EPIC_NUMBER)}-subissues`,
    "work-tracking-issues",
  ]);
  return receipts.filter((receipt) => candidateQueryIds.has(String(receipt.queryId)));
}

function assertExactCandidateReceipts(snapshot: Record<string, unknown>): void {
  const collection = snapshot.collection as Record<string, unknown>;
  const receipts = collection.receipts as Array<Record<string, unknown>>;
  expect(receipts.map((receipt) => receipt.queryId)).toEqual(
    requiredReceiptQueryIds(snapshot as never),
  );
  const candidates = candidateReceipts(snapshot);
  expect(candidates.map((receipt) => receipt.queryId)).toEqual([
    "repository-open-issues",
    `issue-${String(UNMILESTONED_EPIC_NUMBER)}-subissues`,
    "work-tracking-issues",
  ]);
  candidates.forEach((receipt) => {
    const queryId = String(receipt.queryId);
    const sourceRecords = receipt.sourceRecords as unknown[];
    const expectedQuerySha256 = expectedReceiptQuerySha256(queryId);
    const expectedScope = expectedReceiptScopeForSnapshot(
      snapshot as never,
      receipts as never,
      queryId,
    );
    expect(expectedQuerySha256).not.toBeNull();
    expect(expectedScope).not.toBeNull();
    expect(receipt.source).toBe(expectedReceiptSourceForQuery(queryId));
    expect(receipt.querySha256).toBe(expectedQuerySha256);
    expect(receipt.scope).toEqual(expectedScope);
    expect(receipt.requestSha256).toBe(
      receiptRequestSha256(String(expectedQuerySha256), expectedScope ?? {}),
    );
    expect(receipt.itemCount).toBe(sourceRecords.length);
    expect(receipt.declaredTotalCount).toBe(sourceRecords.length);
    expect(receipt.sourceSha256).toBe(canonicalSha256(sourceRecords));
  });
}

describe("post-collection unmilestoned Epic grouping", () => {
  it("collects the same candidate evidence before and after an Epic map row exists", async () => {
    const github = createReadOnlyGitHubExecutor();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-unmilestoned-collector-"));
    const aliasesOnlyPath = path.join(temp, "aliases-only.json");
    const epicRowPath = path.join(temp, "with-epic-row.json");
    const milestoneAliases = { Q3: "Roadmap: Q3" };
    fs.writeFileSync(aliasesOnlyPath, `${JSON.stringify({ milestoneAliases })}\n`);
    fs.writeFileSync(
      epicRowPath,
      `${JSON.stringify({
        milestoneAliases,
        epics: [
          {
            epicNodeId: "EPIC_9816",
            issueNumber: UNMILESTONED_EPIC_NUMBER,
            presentationMilestoneNodeId: "MILESTONE_Q3",
          },
        ],
      })}\n`,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    vi.resetModules();
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, execFileSync: github.execFileSync };
    });

    try {
      const { collectGitHubSnapshot } =
        await import("../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts");
      const collect = (presentationMap: string): Record<string, unknown> =>
        collectGitHubSnapshot({
          repo: "NVIDIA/NemoClaw",
          milestones: ["Q3"],
          releaseCount: 1,
          metricMode: "retained_additions",
          presentationMap,
        });
      const aliasesOnlySnapshot = collect(aliasesOnlyPath);
      const epicRowSnapshot = collect(epicRowPath);
      const aliasesOnlyEpic = (aliasesOnlySnapshot.epics as Array<Record<string, unknown>>).find(
        (epic) => epic.issueNumber === UNMILESTONED_EPIC_NUMBER,
      );

      expect(aliasesOnlySnapshot).toEqual(epicRowSnapshot);
      expect(aliasesOnlySnapshot.snapshotSha256).toBe(epicRowSnapshot.snapshotSha256);
      expect(aliasesOnlyEpic).toEqual({
        nodeId: "EPIC_9816",
        issueNumber: UNMILESTONED_EPIC_NUMBER,
        title: "Kubernetes in-cluster delivery",
        url: "https://github.com/NVIDIA/NemoClaw/issues/9816",
        milestoneNodeId: null,
        state: "OPEN",
        closedAt: null,
        nativeIssueType: { id: "ISSUE_TYPE_EPIC", name: "Epic" },
        bodySha256: sha256Text(UNMILESTONED_EPIC_BODY),
        outcome: "Qualify one external gateway workflow.",
        children: [
          {
            nodeId: "ISSUE_9818",
            issueNumber: 9818,
            state: "CLOSED",
            url: "https://github.com/NVIDIA/NemoClaw/issues/9818",
            sourceKind: "native-subissue",
          },
          {
            nodeId: "ISSUE_9817",
            number: 9817,
            issueNumber: 9817,
            state: "OPEN",
            url: "https://github.com/NVIDIA/NemoClaw/issues/9817",
            sourceKind: "work-tracking",
          },
        ],
        progress: { completed: 1, total: 2, percentage: 50 },
      });
      assertExactCandidateReceipts(aliasesOnlySnapshot);
      expect(candidateReceipts(aliasesOnlySnapshot)).toEqual(candidateReceipts(epicRowSnapshot));
      expect(
        candidateReceipts(aliasesOnlySnapshot).map((receipt) => ({
          queryId: receipt.queryId,
          sourceRecords: receipt.sourceRecords,
        })),
      ).toEqual([
        {
          queryId: "repository-open-issues",
          sourceRecords: [
            {
              id: "EPIC_9816",
              number: UNMILESTONED_EPIC_NUMBER,
              title: "Kubernetes in-cluster delivery",
              body: UNMILESTONED_EPIC_BODY,
              state: "OPEN",
              url: "https://github.com/NVIDIA/NemoClaw/issues/9816",
              createdAt: "2026-08-01T00:00:00.000Z",
              closedAt: null,
              issueType: { id: "ISSUE_TYPE_EPIC", name: "Epic" },
              milestone: null,
            },
          ],
        },
        {
          queryId: `issue-${String(UNMILESTONED_EPIC_NUMBER)}-subissues`,
          sourceRecords: [
            {
              id: "ISSUE_9818",
              number: 9818,
              state: "CLOSED",
              url: "https://github.com/NVIDIA/NemoClaw/issues/9818",
            },
          ],
        },
        {
          queryId: "work-tracking-issues",
          sourceRecords: [
            {
              nodeId: "ISSUE_9817",
              number: 9817,
              issueNumber: 9817,
              state: "OPEN",
              url: "https://github.com/NVIDIA/NemoClaw/issues/9817",
              sourceKind: "work-tracking",
            },
          ],
        },
      ]);
      const midpoint = github.calls.length / 2;
      expect(Number.isInteger(midpoint)).toBe(true);
      expect(github.calls.slice(0, midpoint)).toEqual(github.calls.slice(midpoint));
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      vi.useRealTimers();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("retains candidate evidence before an owner runtime map selects the Epic", () => {
    const inputs = syntheticFixtureInputs();
    addSyntheticPresentationMappedEpic({
      snapshot: inputs.snapshot,
      presentation: inputs.presentation,
      milestoneIndex: 0,
      issueNumber: 9816,
    });
    const presentationEntries = inputs.presentation.epics as Array<Record<string, unknown>>;
    const candidatePresentation = presentationEntries.pop();
    expect(candidatePresentation).toBeDefined();
    const snapshotEpics = inputs.snapshot.epics as Array<Record<string, unknown>>;
    const candidateEpicIndex = snapshotEpics.findIndex((epic) => epic.issueNumber === 9816);
    expect(candidateEpicIndex).toBeGreaterThanOrEqual(0);
    const [candidateEpicEvidence] = snapshotEpics.splice(candidateEpicIndex, 1);
    expect(candidateEpicEvidence).toBeDefined();

    const receipts = (inputs.snapshot.collection as Record<string, unknown>).receipts as Array<
      Record<string, unknown>
    >;
    const openIssueReceipt = receipts.find(
      (receipt) => receipt.queryId === "repository-open-issues",
    );
    const openIssueRecords = openIssueReceipt?.sourceRecords as DetailedRawOpenIssue[];
    const collectedIssueNumbers: number[] = [];
    const roadmapEvidence = collectRoadmapEpicEvidence({
      selectedMilestones: [],
      openIssues: openIssueRecords,
      collectMilestoneIssues: () => [],
      collectEpicEvidence: (issue, nativeMilestone) => {
        collectedIssueNumbers.push(issue.number);
        expect(nativeMilestone).toBeNull();
        expect(issue.number).toBe(9816);
        snapshotEpics.push(candidateEpicEvidence as Record<string, unknown>);
      },
    });
    (inputs.snapshot.excludedIssues as Array<Record<string, unknown>>).push(
      ...roadmapEvidence.excludedIssues,
    );
    (inputs.snapshot.findings as Array<Record<string, unknown>>).push(...roadmapEvidence.findings);
    finalizeSyntheticRoadmap(inputs.snapshot);
    const frozenSnapshotSha256 = inputs.snapshot.snapshotSha256;
    const finalizedReceipts = (inputs.snapshot.collection as Record<string, unknown>)
      .receipts as Array<Record<string, unknown>>;

    expect(collectedIssueNumbers).toEqual([9816]);
    expect(roadmapEvidence.findings.map((finding) => finding.code)).toContain(
      "EPIC_MILESTONE_MISSING",
    );
    expect(
      (inputs.snapshot.epics as Array<Record<string, unknown>>).find(
        (epic) => epic.issueNumber === 9816,
      ),
    ).toMatchObject({ milestoneNodeId: null, state: "OPEN" });
    expect(finalizedReceipts.map((receipt) => receipt.queryId)).toEqual(
      requiredReceiptQueryIds(inputs.snapshot as never),
    );
    expect(finalizedReceipts.map((receipt) => receipt.queryId)).toContain("issue-9816-subissues");

    const unmappedModel = buildSyntheticModel({
      snapshot: inputs.snapshot,
      presentation: inputs.presentation,
      narrative: inputs.narrative,
    });
    expect(publicationCodes(unmappedModel)).toContain("EPIC_MILESTONE_MISSING");
    expect(roadmapIssueNumbers(unmappedModel, "roadmap-executive")).not.toContain(9816);
    expect(roadmapIssueNumbers(unmappedModel, "roadmap-capability")).not.toContain(9816);

    presentationEntries.push(candidatePresentation as Record<string, unknown>);
    const mappedModel = buildSyntheticModel({
      snapshot: inputs.snapshot,
      presentation: inputs.presentation,
      narrative: inputs.narrative,
    });

    expect(inputs.snapshot.snapshotSha256).toBe(frozenSnapshotSha256);
    expect(publicationCodes(mappedModel)).toEqual([]);
    expect(roadmapIssueNumbers(mappedModel, "roadmap-executive")).toContain(9816);
    expect(roadmapIssueNumbers(mappedModel, "roadmap-capability")).toContain(9816);
  });

  it("reports an invalid grouping target without classifying the collected Epic as absent", () => {
    const inputs = syntheticFixtureInputs();
    addSyntheticPresentationMappedEpic({
      snapshot: inputs.snapshot,
      presentation: inputs.presentation,
      milestoneIndex: 0,
      issueNumber: 9816,
    });
    const receipts = (inputs.snapshot.collection as Record<string, unknown>).receipts as Array<
      Record<string, unknown>
    >;
    const openIssueReceipt = receipts.find(
      (receipt) => receipt.queryId === "repository-open-issues",
    );
    const roadmapEvidence = collectRoadmapEpicEvidence({
      selectedMilestones: [],
      openIssues: openIssueReceipt?.sourceRecords as DetailedRawOpenIssue[],
      collectMilestoneIssues: () => [],
      collectEpicEvidence: () => {},
    });
    (inputs.snapshot.findings as Array<Record<string, unknown>>).push(...roadmapEvidence.findings);
    const presentationEntry = (inputs.presentation.epics as Array<Record<string, unknown>>).find(
      (entry) => entry.issueNumber === 9816,
    );
    expect(presentationEntry).toBeDefined();
    (presentationEntry as Record<string, unknown>).presentationMilestoneNodeId = "M_UNKNOWN";
    finalizeSyntheticRoadmap(inputs.snapshot);

    const model = buildSyntheticModel({
      snapshot: inputs.snapshot,
      presentation: inputs.presentation,
      narrative: inputs.narrative,
    });
    const codes = publicationCodes(model);

    expect(codes).toContain("EPIC_MILESTONE_MISSING");
    expect(codes).toContain("PRESENTATION_MILESTONE_UNKNOWN");
    expect(codes).not.toContain("PRESENTATION_MAPPING_UNSELECTED_EPIC");
  });
});
