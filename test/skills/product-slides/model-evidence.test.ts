// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  expectedReceiptScopeForSnapshot,
  normalizeProgress,
  receiptRequestSha256,
  sha256Text,
  buildSyntheticModel,
  fixturePath,
  readJson,
  syntheticFixtureInputs,
  publicationCodes,
  rehashSnapshot,
  rehashSnapshotReceipt,
} from "./model-test-support";

describe("NemoClaw product slide source and model contracts", () => {
  it("blocks a source-proven third stable release omitted from the reporting window", () => {
    const inputs = syntheticFixtureInputs();
    const snapshot = inputs.snapshot;
    const releases = snapshot.releases as Array<Record<string, unknown>>;
    const collection = snapshot.collection as Record<string, unknown>;
    const receipts = collection.receipts as Array<Record<string, unknown>>;
    const tagReceipt = receipts.find((receipt) => receipt.queryId === "tag-refs");
    const ancestryReceipt = receipts.find(
      (receipt) => receipt.queryId === "tag-default-branch-ancestry",
    );
    const discussionReceipt = receipts.find(
      (receipt) => receipt.queryId === "announcement-discussions",
    );
    expect(tagReceipt, "Synthetic tag receipt is missing").toBeDefined();
    expect(ancestryReceipt, "Synthetic tag ancestry receipt is missing").toBeDefined();
    expect(discussionReceipt, "Synthetic Announcement receipt is missing").toBeDefined();
    const requiredTagReceipt = tagReceipt as Record<string, unknown>;
    const requiredAncestryReceipt = ancestryReceipt as Record<string, unknown>;
    const requiredDiscussionReceipt = discussionReceipt as Record<string, unknown>;
    const tagRecords = requiredTagReceipt.sourceRecords as Array<Record<string, unknown>>;
    const ancestryRecords = requiredAncestryReceipt.sourceRecords as Array<Record<string, unknown>>;
    const discussions = requiredDiscussionReceipt.sourceRecords as Array<Record<string, unknown>>;
    const secondDate = "2026-08-11T00:00:00.000Z";
    releases[1].publishedAt = secondDate;
    releases[1].commitDate = secondDate;
    releases[1].inWindow = true;
    const secondTarget = tagRecords[1].target as Record<string, unknown>;
    secondTarget.committedDate = secondDate;
    const secondAnnouncement = releases[1].announcement as Record<string, unknown>;
    secondAnnouncement.createdAt = secondDate;
    secondAnnouncement.updatedAt = secondDate;
    discussions[1].createdAt = secondDate;
    discussions[1].updatedAt = secondDate;
    const thirdCommit = "3".repeat(40);
    tagRecords.push({
      id: "REF_SYNTHETIC_v1.2.1",
      name: "v1.2.1",
      target: {
        __typename: "Commit",
        oid: thirdCommit,
        committedDate: "2026-08-10T00:00:00.000Z",
        url: `https://github.com/NVIDIA/NemoClaw/commit/${thirdCommit}`,
      },
    });
    ancestryRecords.push({
      tag: "v1.2.1",
      commitSha: thirdCommit,
      ancestor: true,
    });
    const ancestryScope = expectedReceiptScopeForSnapshot(
      snapshot as never,
      receipts as never,
      "tag-default-branch-ancestry",
    );
    expect(ancestryScope, "Synthetic ancestry scope is invalid").toBeDefined();
    const requiredAncestryScope = ancestryScope as Record<string, unknown>;
    requiredAncestryReceipt.scope = requiredAncestryScope;
    requiredAncestryReceipt.requestSha256 = receiptRequestSha256(
      String(requiredAncestryReceipt.querySha256),
      requiredAncestryScope,
    );
    rehashSnapshotReceipt(snapshot, "tag-refs");
    rehashSnapshotReceipt(snapshot, "tag-default-branch-ancestry");
    rehashSnapshotReceipt(snapshot, "announcement-discussions");

    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot,
          presentation: inputs.presentation,
          narrative: inputs.narrative,
        }),
      ),
    ).toContain("RELEASE_WINDOW_TRUNCATED");
  });

  it("requires one same-repository issue source record for every Work Tracking request", () => {
    const inputs = syntheticFixtureInputs();
    const snapshot = inputs.snapshot;
    const epics = snapshot.epics as Array<Record<string, unknown>>;
    const epic = epics[0];
    const milestones = snapshot.milestones as Array<Record<string, unknown>>;
    const milestone = milestones.find((candidate) => candidate.nodeId === epic.milestoneNodeId);
    expect(milestone, "Synthetic Epic milestone is missing").toBeDefined();
    const requiredMilestone = milestone as Record<string, unknown>;
    const collection = snapshot.collection as Record<string, unknown>;
    const receipts = collection.receipts as Array<Record<string, unknown>>;
    const issueReceipt = receipts.find(
      (receipt) => receipt.queryId === `milestone-${String(requiredMilestone.number)}-issues`,
    );
    const workReceipt = receipts.find((receipt) => receipt.queryId === "work-tracking-issues");
    expect(issueReceipt, "Synthetic Epic issue receipt is missing").toBeDefined();
    expect(workReceipt, "Synthetic Work Tracking receipt is missing").toBeDefined();
    const requiredIssueReceipt = issueReceipt as Record<string, unknown>;
    const requiredWorkReceipt = workReceipt as Record<string, unknown>;
    const issueRecord = (requiredIssueReceipt.sourceRecords as Array<Record<string, unknown>>).find(
      (record) => record.number === epic.issueNumber,
    );
    expect(issueRecord, "Synthetic Epic source record is missing").toBeDefined();
    const requiredIssueRecord = issueRecord as Record<string, unknown>;
    const body = `${String(requiredIssueRecord.body)}\n\n## Work Tracking\n\n- #999`;
    requiredIssueRecord.body = body;
    epic.bodySha256 = sha256Text(body);
    const workScope = expectedReceiptScopeForSnapshot(
      snapshot as never,
      receipts as never,
      "work-tracking-issues",
    );
    expect(workScope, "Synthetic Work Tracking scope is invalid").toBeDefined();
    const requiredWorkScope = workScope as Record<string, unknown>;
    requiredWorkReceipt.scope = requiredWorkScope;
    requiredWorkReceipt.requestSha256 = receiptRequestSha256(
      String(requiredWorkReceipt.querySha256),
      requiredWorkScope,
    );
    rehashSnapshotReceipt(snapshot, String(requiredIssueReceipt.queryId));
    rehashSnapshotReceipt(snapshot, "work-tracking-issues");

    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot,
          presentation: inputs.presentation,
          narrative: inputs.narrative,
        }),
      ),
    ).toContain("WORK_TRACKING_REFERENCE_INVALID");

    const orphaned = syntheticFixtureInputs();
    const orphanedCollection = orphaned.snapshot.collection as Record<string, unknown>;
    const orphanedReceipt = (orphanedCollection.receipts as Array<Record<string, unknown>>).find(
      (receipt) => receipt.queryId === "work-tracking-issues",
    );
    expect(orphanedReceipt, "Synthetic Work Tracking receipt is missing").toBeDefined();
    const requiredOrphanedReceipt = orphanedReceipt as Record<string, unknown>;
    const parentIssueNumber = Number(
      (orphaned.snapshot.epics as Array<Record<string, unknown>>)[0].issueNumber,
    );
    requiredOrphanedReceipt.scope = {
      owner: "NVIDIA",
      name: "NemoClaw",
      requests: [{ parentIssueNumber, issueNumber: 999 }],
    };
    requiredOrphanedReceipt.requestSha256 = receiptRequestSha256(
      String(requiredOrphanedReceipt.querySha256),
      requiredOrphanedReceipt.scope as Record<string, unknown>,
    );
    requiredOrphanedReceipt.sourceRecords = [
      {
        nodeId: "ISSUE_999",
        number: 999,
        issueNumber: 999,
        state: "OPEN",
        url: "https://github.com/NVIDIA/NemoClaw/issues/999",
        sourceKind: "work-tracking",
      },
    ];
    rehashSnapshotReceipt(orphaned.snapshot, "work-tracking-issues");
    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot: orphaned.snapshot,
          presentation: orphaned.presentation,
          narrative: orphaned.narrative,
        }),
      ),
    ).toContain("WORK_TRACKING_REFERENCE_INVALID");
  });

  it("blocks a malformed native sub-issue even when copied progress is shrunk", () => {
    const inputs = syntheticFixtureInputs();
    const snapshot = inputs.snapshot;
    const epic = (snapshot.epics as Array<Record<string, unknown>>).find(
      (candidate) => Array.isArray(candidate.children) && candidate.children.length > 1,
    );
    expect(epic, "Synthetic Epic with children is missing").toBeDefined();
    const requiredEpic = epic as Record<string, unknown>;
    const collection = snapshot.collection as Record<string, unknown>;
    const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
      (candidate) => candidate.queryId === `issue-${String(requiredEpic.issueNumber)}-subissues`,
    );
    expect(receipt, "Synthetic sub-issue receipt is missing").toBeDefined();
    const requiredReceipt = receipt as Record<string, unknown>;
    const records = requiredReceipt.sourceRecords as Array<Record<string, unknown>>;
    delete records[0].url;
    const retained = records.slice(1).map((record) => ({
      nodeId: record.id as string,
      issueNumber: record.number as number,
      state: record.state as string,
      url: record.url as string,
      sourceKind: "native-subissue" as const,
    }));
    requiredEpic.children = retained;
    requiredEpic.progress = normalizeProgress(retained);
    rehashSnapshotReceipt(snapshot, String(requiredReceipt.queryId));

    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot,
          presentation: inputs.presentation,
          narrative: inputs.narrative,
        }),
      ),
    ).toContain("COLLECTION_RECEIPT_INCOMPLETE");
  });

  it.each([
    { field: "url", queryId: "repository-milestones" },
    { field: "target", queryId: "tag-refs" },
    { field: "slug", queryId: "discussion-categories" },
    { field: "updatedAt", queryId: "announcement-discussions" },
  ] as const)("rejects malformed $queryId source records", ({ queryId, field }) => {
    const inputs = syntheticFixtureInputs();
    const collection = inputs.snapshot.collection as Record<string, unknown>;
    const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
      (candidate) => candidate.queryId === queryId,
    );
    expect(receipt, `Synthetic receipt is missing: ${queryId}`).toBeDefined();
    const requiredReceipt = receipt as Record<string, unknown>;
    delete (requiredReceipt.sourceRecords as Array<Record<string, unknown>>)[0][field];
    rehashSnapshotReceipt(inputs.snapshot, queryId);
    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot: inputs.snapshot,
          presentation: inputs.presentation,
          narrative: inputs.narrative,
        }),
      ),
      queryId,
    ).toContain("COLLECTION_RECEIPT_INCOMPLETE");
  });

  it("binds authenticated viewer evidence and each receipt source kind", () => {
    const forgedSource = syntheticFixtureInputs();
    const forgedCollection = forgedSource.snapshot.collection as Record<string, unknown>;
    const tagReceipt = (forgedCollection.receipts as Array<Record<string, unknown>>).find(
      (receipt) => receipt.queryId === "tag-refs",
    );
    expect(tagReceipt, "Synthetic tag receipt is missing").toBeDefined();
    const requiredTagReceipt = tagReceipt as Record<string, unknown>;
    requiredTagReceipt.source = "github-rest-or-single-object";
    rehashSnapshot(forgedSource.snapshot);
    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot: forgedSource.snapshot,
          presentation: forgedSource.presentation,
          narrative: forgedSource.narrative,
        }),
      ),
    ).toContain("COLLECTION_RECEIPT_INCOMPLETE");

    const unauthenticated = syntheticFixtureInputs();
    const unauthenticatedCollection = unauthenticated.snapshot.collection as Record<
      string,
      unknown
    >;
    const viewerReceipt = (
      unauthenticatedCollection.receipts as Array<Record<string, unknown>>
    ).find((receipt) => receipt.queryId === "authenticated-viewer");
    expect(viewerReceipt, "Synthetic viewer receipt is missing").toBeDefined();
    const requiredViewerReceipt = viewerReceipt as Record<string, unknown>;
    requiredViewerReceipt.sourceRecords = [{ authenticated: false }];
    rehashSnapshotReceipt(unauthenticated.snapshot, "authenticated-viewer");
    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot: unauthenticated.snapshot,
          presentation: unauthenticated.presentation,
          narrative: unauthenticated.narrative,
        }),
      ),
    ).toContain("COLLECTION_RECEIPT_INCOMPLETE");
  });

  it.each([
    {
      queryId: "stargazers-window",
      recordIdentity: { nodeId: "OLD_STAR" },
      timestampField: "starredAt",
    },
    {
      queryId: "forks-window",
      recordIdentity: { id: "OLD_FORK" },
      timestampField: "createdAt",
    },
  ])(
    "requires a real before-window record for $queryId cutoffs",
    ({ queryId, recordIdentity, timestampField }) => {
      const missing = syntheticFixtureInputs();
      const missingCollection = missing.snapshot.collection as Record<string, unknown>;
      const missingReceipt = (missingCollection.receipts as Array<Record<string, unknown>>).find(
        (candidate) => candidate.queryId === queryId,
      );
      expect(missingReceipt, `Missing test receipt ${queryId}`).toBeDefined();
      const requiredMissingReceipt = missingReceipt as Record<string, unknown>;
      requiredMissingReceipt.termination = "window-cutoff";
      requiredMissingReceipt.terminalHasNextPage = true;
      requiredMissingReceipt.sourceRecords = [];
      rehashSnapshotReceipt(missing.snapshot, queryId);
      expect(
        publicationCodes(
          buildSyntheticModel({
            snapshot: missing.snapshot,
            presentation: missing.presentation,
            narrative: missing.narrative,
          }),
        ),
      ).toContain("COLLECTION_RECEIPT_INCOMPLETE");

      const proven = syntheticFixtureInputs();
      const provenCollection = proven.snapshot.collection as Record<string, unknown>;
      const provenReceipt = (provenCollection.receipts as Array<Record<string, unknown>>).find(
        (candidate) => candidate.queryId === queryId,
      );
      expect(provenReceipt, `Missing test receipt ${queryId}`).toBeDefined();
      const requiredProvenReceipt = provenReceipt as Record<string, unknown>;
      requiredProvenReceipt.termination = "window-cutoff";
      requiredProvenReceipt.terminalHasNextPage = true;
      const declaredTotalCount = requiredProvenReceipt.declaredTotalCount;
      const sourceRecords = requiredProvenReceipt.sourceRecords as Array<Record<string, unknown>>;
      expect(sourceRecords.length).toBeGreaterThan(1);
      requiredProvenReceipt.sourceRecords = [
        ...sourceRecords.slice(0, -1),
        {
          ...recordIdentity,
          [timestampField]: "2026-08-06T11:59:59.999Z",
        },
      ];
      rehashSnapshotReceipt(proven.snapshot, queryId);
      requiredProvenReceipt.declaredTotalCount = declaredTotalCount;
      rehashSnapshot(proven.snapshot);
      const provenModel = buildSyntheticModel({
        snapshot: proven.snapshot,
        presentation: proven.presentation,
        narrative: proven.narrative,
      });
      expect(publicationCodes(provenModel)).toEqual([]);
      expect((provenModel.publication as Record<string, unknown>).eligible).toBe(true);
    },
  );

  it.each([
    { field: "termination", value: "partial" },
    { field: "terminalHasNextPage", value: "false" },
    { field: "firstCursor", value: {} },
    { field: "finalCursor", value: [] },
  ])("rejects non-exact receipt $field", ({ field, value }) => {
    const inputs = syntheticFixtureInputs();
    const collection = inputs.snapshot.collection as Record<string, unknown>;
    const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
      (candidate) => candidate.queryId === "repository-milestones",
    );
    expect(receipt, "Synthetic milestone receipt is missing").toBeDefined();
    const requiredReceipt = receipt as Record<string, unknown>;
    requiredReceipt[field] = value;
    rehashSnapshot(inputs.snapshot);
    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot: inputs.snapshot,
          presentation: inputs.presentation,
          narrative: inputs.narrative,
        }),
      ),
    ).toContain("COLLECTION_RECEIPT_INCOMPLETE");
  });

  it("rejects receipt cutoff records outside their exact ordering", () => {
    const reordered = syntheticFixtureInputs();
    const reorderedCollection = reordered.snapshot.collection as Record<string, unknown>;
    const stars = (reorderedCollection.receipts as Array<Record<string, unknown>>).find(
      (candidate) => candidate.queryId === "stargazers-window",
    );
    expect(stars, "Synthetic stargazer receipt is missing").toBeDefined();
    const requiredStars = stars as Record<string, unknown>;
    const records = requiredStars.sourceRecords as Array<Record<string, unknown>>;
    requiredStars.sourceRecords = [records.at(-1), records[0]];
    rehashSnapshotReceipt(reordered.snapshot, "stargazers-window");
    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot: reordered.snapshot,
          presentation: reordered.presentation,
          narrative: reordered.narrative,
        }),
      ),
    ).toContain("COLLECTION_RECEIPT_INCOMPLETE");
  });

  it.each([
    {
      queryId: "milestone-3-issues",
      scope: { owner: "NVIDIA", name: "NemoClaw", milestoneNumber: 999 },
    },
    {
      queryId: "merged-prs-window",
      scope: {
        queryText: "repo:NVIDIA/NemoClaw is:pr is:merged merged:forged",
      },
    },
    {
      queryId: "authenticated-viewer",
      scope: { restPath: "repos/NVIDIA/NemoClaw" },
    },
  ])("binds the exact request scope for $queryId", ({ queryId, scope }) => {
    const inputs = syntheticFixtureInputs();
    const collection = inputs.snapshot.collection as Record<string, unknown>;
    const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
      (candidate) => candidate.queryId === queryId,
    );
    expect(receipt, `Missing test receipt ${queryId}`).toBeDefined();
    const requiredReceipt = receipt as Record<string, unknown>;
    requiredReceipt.scope = scope;
    requiredReceipt.requestSha256 = receiptRequestSha256(
      String(requiredReceipt.querySha256),
      scope,
    );
    rehashSnapshot(inputs.snapshot);
    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot: inputs.snapshot,
          presentation: inputs.presentation,
          narrative: inputs.narrative,
        }),
      ),
    ).toContain("COLLECTION_RECEIPT_INCOMPLETE");
  });

  it("binds receipt declared totals to retained source records", () => {
    const inputs = syntheticFixtureInputs();
    const collection = inputs.snapshot.collection as Record<string, unknown>;
    const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
      (candidate) => candidate.queryId === "repository-milestones",
    );
    expect(receipt, "Missing repository-milestones receipt").toBeDefined();
    const requiredReceipt = receipt as Record<string, unknown>;
    requiredReceipt.declaredTotalCount = Number(requiredReceipt.itemCount) + 1;
    rehashSnapshot(inputs.snapshot);
    expect(
      publicationCodes(
        buildSyntheticModel({
          snapshot: inputs.snapshot,
          presentation: inputs.presentation,
          narrative: inputs.narrative,
        }),
      ),
    ).toContain("COLLECTION_RECEIPT_INCOMPLETE");
  });

  it("rejects rehashed forged repository, collection time, and net-change metrics", () => {
    const inputs = syntheticFixtureInputs();
    const snapshot = inputs.snapshot;
    const repository = snapshot.repository as Record<string, unknown>;
    const metrics = snapshot.metrics as Record<string, unknown>;
    repository.url = "https://github.example.test/NVIDIA/NemoClaw";
    snapshot.asOf = "2026-08-14T12:00:00.000Z";
    metrics.mode = "net_change";
    metrics.stars = { total: 1200, netChange: 4242 };
    metrics.forks = { total: 210, netChange: -313 };
    delete metrics.baselineSnapshotSha256;
    delete metrics.baselineApproval;
    delete metrics.baselineEvidence;
    rehashSnapshot(snapshot);

    const model = buildSyntheticModel({
      snapshot,
      presentation: inputs.presentation,
      narrative: inputs.narrative,
    });
    const weekly = (model.slides as Array<Record<string, unknown>>)[3];
    const weeklyMetrics = weekly.metrics as Array<Record<string, unknown>>;

    expect((model.publication as Record<string, unknown>).eligible).toBe(false);
    expect(publicationCodes(model)).toEqual(
      expect.arrayContaining([
        "REPOSITORY_IDENTITY_UNBOUND",
        "SNAPSHOT_TIME_UNBOUND",
        "METRIC_RECEIPT_MISMATCH",
        "NET_CHANGE_BASELINE_INVALID",
      ]),
    );
    expect(model.repository).toMatchObject({
      nameWithOwner: "NVIDIA/NemoClaw",
      url: "https://github.com/NVIDIA/NemoClaw",
    });
    expect(model.asOf).toBe("2026-08-13T12:00:00.000Z");
    expect(weeklyMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentId: "metric.stars",
          value: 1200,
          detailValue: 0,
        }),
        expect.objectContaining({
          contentId: "metric.forks",
          value: 210,
          detailValue: 0,
        }),
      ]),
    );
  });

  it("rejects free-form wording outside the milestone report envelope", () => {
    const narrative = readJson<Record<string, unknown>>(fixturePath("narrative-input.json"));
    narrative.executiveSummary = "Unbound executive claim.";

    expect(() => buildSyntheticModel({ narrative })).toThrow(
      /must contain only schemaVersion 1, observedAt, reportSha256, and milestoneRows/u,
    );
  });
});
