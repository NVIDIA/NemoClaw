// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

import {
  exactAnnouncementMatches,
  expectedReceiptQuerySha256,
  expectedReceiptScopeForSnapshot,
  expectedReceiptSourceForQuery,
  extractOutcome,
  inHalfOpenWindow,
  normalizeProgress,
  paginateConnection,
  receiptRequestSha256,
  requiredReceiptQueryIds,
  selectStableTags,
  workTrackingIssueNumbers,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts";
import {
  calculateModelSha256,
  canonicalJson,
  canonicalSha256,
  planManagedSlideRefresh,
  sha256Text,
  validateSlideModel,
  withoutTopLevelKey,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/validate-slide-model.mts";
import {
  buildSyntheticModel,
  fixturePath,
  readJson,
  slideModelSchemaPath,
  syntheticFixtureInputs,
} from "../../helpers/nemoclaw-product-slides-fixture";

export function rehashModel(model: Record<string, unknown>): void {
  const modelSha256 = calculateModelSha256(model);
  model.modelSha256 = modelSha256;
  (model.slides as Array<Record<string, unknown>>).forEach((slide) => {
    const pageBinding =
      typeof slide.instanceId === "string" &&
      typeof slide.pageIndex === "number" &&
      typeof slide.pageCount === "number"
        ? [`instance_id=${slide.instanceId}`, `page=${slide.pageIndex}/${slide.pageCount}`]
        : [];
    const sources = slide.sources as Array<Record<string, unknown>>;
    const weeklyMetadata =
      slide.role === "weekly-release"
        ? (() => {
            const window = slide.window as Record<string, unknown>;
            const reportSource = sources.find(
              (source) => source.sourceId === "mapping.weekly-milestone-report",
            );
            return [
              `snapshot_as_of=${String(window.end)}`,
              `window_start=${String(window.start)}`,
              `window_end=${String(window.end)}`,
              `milestone_report_observed_at=${String(slide.reportObservedAt)}`,
              `milestone_report_sha256=${String(reportSource?.digest ?? "")}`,
              `milestone_rows=${(slide.milestoneRows as Array<Record<string, unknown>>)
                .map((row) => String(row.title))
                .join(" | ")}`,
            ];
          })()
        : [];
    const lines = [
      "[NEMOCLAW-MANAGED-SLIDE v1]",
      `role=${String(slide.role)}`,
      ...pageBinding,
      ...weeklyMetadata,
      `model_sha256=${modelSha256}`,
      `snapshot_sha256=${String(model.snapshotSha256)}`,
      "[Sources]",
      ...sources.map((source) => {
        const location =
          typeof source.url === "string"
            ? source.url
            : `${String(source.path ?? "")}${source.heading ? `#${String(source.heading)}` : ""}`;
        return [source.sourceId, source.kind, location, source.commitSha ?? "", source.digest]
          .map(String)
          .join(" | ");
      }),
    ];
    if (slide.role === "markitecture") {
      lines.push(
        "[Claims]",
        ...(slide.claims as Array<Record<string, unknown>>).map((claim) =>
          [claim.claimId, claim.path, claim.heading, claim.commitSha, claim.sectionSha256]
            .map(String)
            .join(" | "),
        ),
      );
    }
    slide.managedNotes = `${lines.join("\n")}\n`;
  });
}

export function publicationCodes(model: Record<string, unknown>): string[] {
  return (
    (model.publication as Record<string, unknown>).blockers as Array<Record<string, unknown>>
  ).map((finding) => String(finding.code));
}

export function rehashSnapshot(snapshot: Record<string, unknown>): void {
  const collection = snapshot.collection as Record<string, unknown>;
  collection.receiptsSha256 = canonicalSha256(collection.receipts);
  snapshot.snapshotSha256 = canonicalSha256(withoutTopLevelKey(snapshot, "snapshotSha256"));
}

export function rehashSnapshotReceipt(
  snapshot: Record<string, unknown>,
  changedReceiptId: string,
): void {
  const collection = snapshot.collection as Record<string, unknown>;
  const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
    (candidate) => candidate.queryId === changedReceiptId,
  );
  expect(receipt, `Missing test receipt ${changedReceiptId}`).toBeDefined();
  const requiredReceipt = receipt as Record<string, unknown>;
  const sourceRecords = requiredReceipt.sourceRecords as unknown[];
  requiredReceipt.itemCount = sourceRecords.length;
  requiredReceipt.declaredTotalCount = sourceRecords.length;
  requiredReceipt.sourceSha256 = canonicalSha256(sourceRecords);
  rehashSnapshot(snapshot);
}

export function addSyntheticInWindowReleases(
  snapshot: Record<string, unknown>,
  releaseCount: number,
): void {
  const releases = snapshot.releases as Array<Record<string, unknown>>;
  const collection = snapshot.collection as Record<string, unknown>;
  const receipts = collection.receipts as Array<Record<string, unknown>>;
  const receiptById = new Map(receipts.map((receipt) => [receipt.queryId, receipt]));
  const tagRecords = receiptById.get("tag-refs")?.sourceRecords as Array<Record<string, unknown>>;
  const ancestryRecords = receiptById.get("tag-default-branch-ancestry")?.sourceRecords as Array<
    Record<string, unknown>
  >;
  const discussionRecords = receiptById.get("announcement-discussions")?.sourceRecords as Array<
    Record<string, unknown>
  >;
  const additions = Array.from({ length: releaseCount - 1 }, (_, offset) => {
    const patch = releaseCount + 2 - offset;
    const tag = `v1.2.${patch}`;
    const discussionNumber = 120 + patch;
    const commitSha = String(patch).repeat(40).slice(0, 40);
    const timestamp = `2026-08-12T${String(6 - offset).padStart(2, "0")}:00:00.000Z`;
    const body = `${tag} delivers reviewed synthetic release outcomes.`;
    return {
      release: {
        tag,
        url: `https://github.com/NVIDIA/NemoClaw/releases/tag/${tag}`,
        inWindow: true,
        defaultBranchAncestor: true,
        announcementMatchCount: 1,
        announcement: {
          nodeId: `D_SYNTHETIC_${discussionNumber}`,
          number: discussionNumber,
          categoryId: "CATEGORY_ANNOUNCEMENTS",
          title: `NemoClaw ${tag} is out`,
          url: `https://github.com/NVIDIA/NemoClaw/discussions/${discussionNumber}`,
          createdAt: timestamp,
          updatedAt: timestamp,
          bodySha256: sha256Text(body),
        },
        tagObjectId: `REF_SYNTHETIC_${tag}`,
        commitSha,
        publishedAt: timestamp,
        commitDate: timestamp,
      },
      tagRecord: {
        id: `REF_SYNTHETIC_${tag}`,
        name: tag,
        target: {
          __typename: "Commit",
          oid: commitSha,
          committedDate: timestamp,
          url: `https://github.com/NVIDIA/NemoClaw/commit/${commitSha}`,
        },
      },
      ancestryRecord: { tag, commitSha, ancestor: true },
      discussionRecord: {
        id: `D_SYNTHETIC_${discussionNumber}`,
        number: discussionNumber,
        title: `NemoClaw ${tag} is out`,
        body,
        url: `https://github.com/NVIDIA/NemoClaw/discussions/${discussionNumber}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
  });
  releases.unshift(...additions.map((entry) => entry.release));
  tagRecords.unshift(...additions.map((entry) => entry.tagRecord));
  ancestryRecords.unshift(...additions.map((entry) => entry.ancestryRecord));
  discussionRecords.unshift(...additions.map((entry) => entry.discussionRecord));
  for (const queryId of ["tag-refs", "tag-default-branch-ancestry", "announcement-discussions"]) {
    const receipt = receiptById.get(queryId) as Record<string, unknown>;
    const records = receipt.sourceRecords as unknown[];
    receipt.itemCount = records.length;
    receipt.declaredTotalCount = records.length;
    receipt.sourceSha256 = canonicalSha256(records);
  }
  rehashSnapshot(snapshot);
}

export function makeSyntheticReleaseAnnouncementAmbiguous(snapshot: Record<string, unknown>): void {
  const releases = snapshot.releases as Array<Record<string, unknown>>;
  const release = releases.find((candidate) => candidate.tag === "v1.2.6");
  expect(release, "Missing synthetic v1.2.6 release").toBeDefined();
  const collection = snapshot.collection as Record<string, unknown>;
  const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
    (candidate) => candidate.queryId === "announcement-discussions",
  );
  expect(receipt, "Missing Announcement receipt").toBeDefined();
  const sourceRecords = receipt?.sourceRecords as Array<Record<string, unknown>>;
  const sourceRecord = sourceRecords.find(
    (candidate) => candidate.title === "NemoClaw v1.2.6 is out",
  );
  expect(sourceRecord, "Missing v1.2.6 Announcement source record").toBeDefined();
  const duplicate = structuredClone(sourceRecord as Record<string, unknown>);
  duplicate.id = `${String(sourceRecord?.id)}_DUPLICATE`;
  duplicate.number = 1_126;
  duplicate.url = "https://github.com/NVIDIA/NemoClaw/discussions/1126";
  sourceRecords.push(duplicate);
  (release as Record<string, unknown>).announcementMatchCount = 2;
  (release as Record<string, unknown>).announcement = null;
  (receipt as Record<string, unknown>).itemCount = sourceRecords.length;
  (receipt as Record<string, unknown>).declaredTotalCount = sourceRecords.length;
  (receipt as Record<string, unknown>).sourceSha256 = canonicalSha256(sourceRecords);
  rehashSnapshot(snapshot);
}

export function addSyntheticRoadmapEpic(options: {
  snapshot: Record<string, unknown>;
  presentation: Record<string, unknown>;
  milestoneIndex: number;
  issueNumber: number;
  roadmapArea: string;
  displayOrder: number;
}): void {
  const milestones = options.snapshot.milestones as Array<Record<string, unknown>>;
  const epics = options.snapshot.epics as Array<Record<string, unknown>>;
  const milestone = milestones[options.milestoneIndex];
  const collection = options.snapshot.collection as Record<string, unknown>;
  const receipts = collection.receipts as Array<Record<string, unknown>>;
  const milestoneReceipt = receipts.find(
    (receipt) => receipt.queryId === `milestone-${String(milestone.number)}-issues`,
  );
  const receiptTemplate = receipts.find((receipt) => receipt.queryId === "issue-101-subissues");
  expect(milestoneReceipt, "Synthetic milestone receipt is missing").toBeDefined();
  expect(receiptTemplate, "Synthetic sub-issue receipt template is missing").toBeDefined();

  const nodeId = `E_SYNTHETIC_${String(options.issueNumber)}`;
  const title = `Roadmap outcome ${String(options.issueNumber)}`;
  const outcome = `Deliver complete roadmap outcome ${String(options.issueNumber)}.`;
  const body = `## Outcome\n\n${outcome}`;
  const url = `https://github.com/NVIDIA/NemoClaw/issues/${String(options.issueNumber)}`;
  epics.push({
    nodeId,
    issueNumber: options.issueNumber,
    title,
    url,
    state: "OPEN",
    closedAt: null,
    milestoneNodeId: milestone.nodeId,
    bodySha256: sha256Text(body),
    outcome,
    children: [],
    progress: "Unknown",
    nativeIssueType: { id: "IT_SYNTHETIC_EPIC", name: "Epic" },
  });

  const milestoneRecords = milestoneReceipt?.sourceRecords as Array<Record<string, unknown>>;
  milestoneRecords.push({
    id: nodeId,
    number: options.issueNumber,
    title,
    body,
    state: "OPEN",
    url,
    createdAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    issueType: { id: "IT_SYNTHETIC_EPIC", name: "Epic" },
    subIssues: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      totalCount: 0,
    },
  });
  milestoneReceipt!.itemCount = milestoneRecords.length;
  milestoneReceipt!.declaredTotalCount = milestoneRecords.length;
  milestoneReceipt!.sourceSha256 = canonicalSha256(milestoneRecords);

  const openIssueReceipt = receipts.find((receipt) => receipt.queryId === "repository-open-issues");
  expect(openIssueReceipt, "Synthetic open-issue receipt is missing").toBeDefined();
  const openIssueRecords = openIssueReceipt!.sourceRecords as Array<Record<string, unknown>>;
  openIssueRecords.push({
    id: nodeId,
    number: options.issueNumber,
    title,
    body,
    state: "OPEN",
    url,
    createdAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    issueType: { id: "IT_SYNTHETIC_EPIC", name: "Epic" },
    milestone: { id: milestone.nodeId, number: milestone.number },
  });
  openIssueReceipt!.itemCount = openIssueRecords.length;
  openIssueReceipt!.declaredTotalCount = openIssueRecords.length;
  openIssueReceipt!.sourceSha256 = canonicalSha256(openIssueRecords);

  const queryId = `issue-${String(options.issueNumber)}-subissues`;
  const querySha256 = expectedReceiptQuerySha256(queryId);
  const source = expectedReceiptSourceForQuery(queryId);
  expect(querySha256).not.toBeNull();
  expect(source).not.toBeNull();
  const receipt = structuredClone(receiptTemplate) as Record<string, unknown>;
  const scope = { owner: "NVIDIA", name: "NemoClaw", issueNumber: options.issueNumber };
  Object.assign(receipt, {
    queryId,
    querySha256,
    source,
    scope,
    requestSha256: receiptRequestSha256(String(querySha256), scope),
    sourceRecords: [],
    itemCount: 0,
    declaredTotalCount: 0,
    sourceSha256: canonicalSha256([]),
  });
  receipts.push(receipt);

  (options.presentation.epics as Array<Record<string, unknown>>).push({
    epicNodeId: nodeId,
    issueNumber: options.issueNumber,
    displayTitle: title,
    shortenedOutcome: outcome,
    boundBodySha256: sha256Text(body),
    roadmapArea: options.roadmapArea,
    displayOrder: options.displayOrder,
  });
}

export function addSyntheticPresentationMappedEpic(options: {
  snapshot: Record<string, unknown>;
  presentation: Record<string, unknown>;
  milestoneIndex: number;
  issueNumber: number;
}): void {
  const milestones = options.snapshot.milestones as Array<Record<string, unknown>>;
  const milestone = milestones[options.milestoneIndex];
  const epics = options.snapshot.epics as Array<Record<string, unknown>>;
  const collection = options.snapshot.collection as Record<string, unknown>;
  const receipts = collection.receipts as Array<Record<string, unknown>>;
  const openIssueReceipt = receipts.find((receipt) => receipt.queryId === "repository-open-issues");
  const subIssueReceiptTemplate = receipts.find(
    (receipt) => receipt.queryId === "issue-101-subissues",
  );
  const workTrackingReceipt = receipts.find(
    (receipt) => receipt.queryId === "work-tracking-issues",
  );
  expect(openIssueReceipt, "Synthetic open-issue receipt is missing").toBeDefined();
  expect(subIssueReceiptTemplate, "Synthetic sub-issue receipt template is missing").toBeDefined();
  expect(workTrackingReceipt, "Synthetic Work Tracking receipt is missing").toBeDefined();

  const nodeId = `E_SYNTHETIC_${String(options.issueNumber)}`;
  const issueType = { id: "IT_SYNTHETIC_EPIC", name: "Epic" };
  const title = "Kubernetes in-cluster delivery";
  const outcome = "Qualify one external gateway workflow.";
  const trackedIssueNumber = options.issueNumber + 1;
  const body = `## Outcome\n\n${outcome}\n\n## Work Tracking\n\n- #${String(trackedIssueNumber)}`;
  const url = `https://github.com/NVIDIA/NemoClaw/issues/${String(options.issueNumber)}`;
  const nativeChild = {
    id: `CHILD_${String(options.issueNumber)}_1`,
    number: options.issueNumber * 10 + 1,
    state: "CLOSED",
    url: `https://github.com/NVIDIA/NemoClaw/issues/${String(options.issueNumber * 10 + 1)}`,
  };
  const trackedChild = {
    nodeId: `ISSUE_${String(trackedIssueNumber)}`,
    number: trackedIssueNumber,
    issueNumber: trackedIssueNumber,
    state: "OPEN",
    url: `https://github.com/NVIDIA/NemoClaw/issues/${String(trackedIssueNumber)}`,
    sourceKind: "work-tracking",
  };
  const children = [
    {
      nodeId: nativeChild.id,
      issueNumber: nativeChild.number,
      state: nativeChild.state,
      url: nativeChild.url,
      sourceKind: "native-subissue",
    },
    trackedChild,
  ];
  epics.push({
    nodeId,
    issueNumber: options.issueNumber,
    title,
    url,
    state: "OPEN",
    closedAt: null,
    milestoneNodeId: null,
    bodySha256: sha256Text(body),
    outcome,
    children,
    progress: { completed: 1, total: 2, percentage: 50 },
    nativeIssueType: issueType,
  });

  const openIssueRecords = openIssueReceipt!.sourceRecords as Array<Record<string, unknown>>;
  openIssueRecords.push({
    id: nodeId,
    number: options.issueNumber,
    title,
    body,
    state: "OPEN",
    url,
    createdAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    issueType,
    milestone: null,
  });
  openIssueReceipt!.itemCount = openIssueRecords.length;
  openIssueReceipt!.declaredTotalCount = openIssueRecords.length;
  openIssueReceipt!.sourceSha256 = canonicalSha256(openIssueRecords);

  const subIssueQueryId = `issue-${String(options.issueNumber)}-subissues`;
  const subIssueQuerySha256 = expectedReceiptQuerySha256(subIssueQueryId);
  const subIssueSource = expectedReceiptSourceForQuery(subIssueQueryId);
  expect(subIssueQuerySha256).not.toBeNull();
  expect(subIssueSource).not.toBeNull();
  const subIssueScope = {
    owner: "NVIDIA",
    name: "NemoClaw",
    issueNumber: options.issueNumber,
  };
  receipts.push({
    ...structuredClone(subIssueReceiptTemplate),
    queryId: subIssueQueryId,
    querySha256: subIssueQuerySha256,
    source: subIssueSource,
    scope: subIssueScope,
    requestSha256: receiptRequestSha256(String(subIssueQuerySha256), subIssueScope),
    sourceRecords: [nativeChild],
    itemCount: 1,
    declaredTotalCount: 1,
    sourceSha256: canonicalSha256([nativeChild]),
  });

  const workTrackingScope = {
    owner: "NVIDIA",
    name: "NemoClaw",
    requests: [
      {
        parentIssueNumber: options.issueNumber,
        issueNumber: trackedIssueNumber,
      },
    ],
  };
  Object.assign(workTrackingReceipt!, {
    scope: workTrackingScope,
    requestSha256: receiptRequestSha256(
      String(workTrackingReceipt!.querySha256),
      workTrackingScope,
    ),
    sourceRecords: [trackedChild],
    itemCount: 1,
    declaredTotalCount: 1,
    sourceSha256: canonicalSha256([trackedChild]),
  });

  (options.presentation.epics as Array<Record<string, unknown>>).push({
    epicNodeId: nodeId,
    issueNumber: options.issueNumber,
    displayTitle: "Kubernetes In-Cluster",
    shortenedOutcome: "Qualify one external gateway workflow",
    boundBodySha256: sha256Text(body),
    roadmapArea: "Usability and Onboarding",
    displayOrder: 9816,
    presentationMilestoneNodeId: milestone.nodeId,
  });
}

export function addSyntheticRoadmapMilestone(options: {
  snapshot: Record<string, unknown>;
  number: number;
  nodeId: string;
  title: string;
  displayTitle: string;
}): void {
  const milestones = options.snapshot.milestones as Array<Record<string, unknown>>;
  milestones.push({
    nodeId: options.nodeId,
    number: options.number,
    title: options.title,
    displayTitle: options.displayTitle,
    description: null,
    dueOn: "2027-01-01T00:00:00.000Z",
    state: "OPEN",
    closedAt: null,
    url: `https://github.com/NVIDIA/NemoClaw/milestone/${String(options.number)}`,
  });
  const collection = options.snapshot.collection as Record<string, unknown>;
  const receipts = collection.receipts as Array<Record<string, unknown>>;
  const milestoneInventory = receipts.find(
    (receipt) => receipt.queryId === "repository-milestones",
  );
  const milestoneTemplate = receipts.find((receipt) => receipt.queryId === "milestone-2-issues");
  expect(milestoneInventory, "Synthetic milestone inventory receipt is missing").toBeDefined();
  expect(milestoneTemplate, "Synthetic milestone issue receipt template is missing").toBeDefined();
  const inventoryRecords = milestoneInventory?.sourceRecords as Array<Record<string, unknown>>;
  inventoryRecords.push({
    id: options.nodeId,
    number: options.number,
    title: options.title,
    description: null,
    dueOn: "2027-01-01T00:00:00.000Z",
    state: "OPEN",
    closedAt: null,
    url: `https://github.com/NVIDIA/NemoClaw/milestone/${String(options.number)}`,
  });
  milestoneInventory!.itemCount = inventoryRecords.length;
  milestoneInventory!.declaredTotalCount = inventoryRecords.length;
  milestoneInventory!.sourceSha256 = canonicalSha256(inventoryRecords);

  const queryId = `milestone-${String(options.number)}-issues`;
  const querySha256 = expectedReceiptQuerySha256(queryId);
  const source = expectedReceiptSourceForQuery(queryId);
  expect(querySha256).not.toBeNull();
  expect(source).not.toBeNull();
  const scope = { owner: "NVIDIA", name: "NemoClaw", milestoneNumber: options.number };
  receipts.push({
    ...structuredClone(milestoneTemplate),
    queryId,
    querySha256,
    source,
    scope,
    requestSha256: receiptRequestSha256(String(querySha256), scope),
    sourceRecords: [],
    itemCount: 0,
    declaredTotalCount: 0,
    sourceSha256: canonicalSha256([]),
  });
}

export function finalizeSyntheticRoadmap(snapshot: Record<string, unknown>): void {
  const collection = snapshot.collection as Record<string, unknown>;
  const receipts = collection.receipts as Array<Record<string, unknown>>;
  const byQueryId = new Map(receipts.map((receipt) => [String(receipt.queryId), receipt]));
  collection.receipts = requiredReceiptQueryIds(snapshot as never).map((queryId) => {
    const receipt = byQueryId.get(queryId);
    if (!receipt) throw new Error(`Synthetic receipt is missing: ${queryId}`);
    return receipt;
  });
  rehashSnapshot(snapshot);
}

export function buildFourMilestoneModel(): Record<string, unknown> {
  const { presentation, snapshot } = syntheticFixtureInputs();
  addSyntheticRoadmapMilestone({
    snapshot,
    number: 4,
    nodeId: "M_SYNTHETIC_4",
    title: "Roadmap: Window Four",
    displayTitle: "Window Four",
  });
  addSyntheticRoadmapEpic({
    snapshot,
    presentation,
    milestoneIndex: 3,
    issueNumber: 204,
    roadmapArea: "Agent Features",
    displayOrder: 204,
  });
  finalizeSyntheticRoadmap(snapshot);
  return buildSyntheticModel({ snapshot, presentation });
}

export function buildWithFirstPresentationSummary(
  displayTitle: string,
  shortenedOutcome: string,
): Record<string, unknown> {
  const { presentation, snapshot } = syntheticFixtureInputs();
  const [entry] = presentation.epics as Array<Record<string, unknown>>;
  entry.displayTitle = displayTitle;
  entry.shortenedOutcome = shortenedOutcome;
  return buildSyntheticModel({ presentation, snapshot });
}

export {
  exactAnnouncementMatches,
  expectedReceiptQuerySha256,
  expectedReceiptScopeForSnapshot,
  expectedReceiptSourceForQuery,
  extractOutcome,
  inHalfOpenWindow,
  normalizeProgress,
  paginateConnection,
  receiptRequestSha256,
  requiredReceiptQueryIds,
  selectStableTags,
  workTrackingIssueNumbers,
  calculateModelSha256,
  canonicalJson,
  canonicalSha256,
  planManagedSlideRefresh,
  sha256Text,
  validateSlideModel,
  withoutTopLevelKey,
  buildSyntheticModel,
  fixturePath,
  readJson,
  slideModelSchemaPath,
  syntheticFixtureInputs,
};
