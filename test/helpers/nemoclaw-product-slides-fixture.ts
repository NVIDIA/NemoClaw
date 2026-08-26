// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSlideModel } from "../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/build-slide-model.mts";
import {
  type ClaimLedger,
  collectDocumentationEvidence,
  type DocumentationEvidence,
  verifyDocumentationEvidence,
} from "../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-doc-evidence.mts";
import {
  expectedReceiptQuerySha256,
  expectedReceiptScopeForSnapshot,
  expectedReceiptSourceForQuery,
  receiptRequestSha256,
} from "../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts";
import {
  expectedCapabilityStructureInventory,
  expectedConnectorInventory,
  expectedHyperlinkInventory,
  expectedManagedVisibleTextInventory,
  expectedWeeklyMilestoneStructureInventory,
} from "../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/compare-output-parity.mts";
import {
  canonicalSha256,
  semanticTemplateFingerprint,
  sha256Text,
  withoutTopLevelKey,
} from "../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/validate-slide-model.mts";

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(testRoot, "fixtures", "nemoclaw-maintainer-product-slides");
const skillRoot = path.resolve(
  testRoot,
  "..",
  ".agents",
  "skills",
  "nemoclaw-maintainer-product-slides",
);
const repositoryRoot = path.resolve(testRoot, "..");

type VerifiedDocumentationFixture = {
  repoRoot: string;
  commitSha: string;
  claims: ClaimLedger;
  evidence: DocumentationEvidence;
};

let verifiedDocumentationCache: VerifiedDocumentationFixture | null = null;

export function verifiedDocumentationFixture(): VerifiedDocumentationFixture {
  if (verifiedDocumentationCache) return verifiedDocumentationCache;
  const claims = readJson<ClaimLedger>(
    path.join(skillRoot, "references", "markitecture-claims.json"),
  );
  const sourceCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-product-slide-docs-"));
  const runFixtureGit = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const sourcePaths = new Set([
    "docs/about/how-it-works.mdx",
    "docs/get-started/prerequisites.mdx",
    "docs/inference/choose-inference-provider.mdx",
    "docs/reference/platform-support.mdx",
    "ci/platform-matrix.json",
    "scripts/generate-platform-docs.py",
  ]);
  for (const claim of claims.claims as Array<Record<string, unknown>>) {
    if (typeof claim.path === "string") sourcePaths.add(claim.path);
  }
  const optionalImage = "docs/about/images/nemoclaw-highlevel-component-diagram.png";
  try {
    execFileSync("git", ["cat-file", "-e", `${sourceCommit}:${optionalImage}`], {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    sourcePaths.add(optionalImage);
  } catch {
    // The collector treats the architecture image as optional.
  }
  for (const relativePath of sourcePaths) {
    const bytes = execFileSync("git", ["show", `${sourceCommit}:${relativePath}`], {
      cwd: repositoryRoot,
      encoding: null,
    });
    const destination = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  runFixtureGit("init", "--initial-branch=main");
  runFixtureGit("config", "user.name", "NemoClaw Test");
  runFixtureGit("config", "user.email", "nemoclaw-test@example.com");
  runFixtureGit("remote", "add", "origin", "https://github.com/NVIDIA/NemoClaw.git");
  runFixtureGit("add", ".");
  runFixtureGit("commit", "--no-gpg-sign", "-m", "test: freeze documentation evidence");
  const commitSha = runFixtureGit("rev-parse", "HEAD");
  runFixtureGit("update-ref", "refs/remotes/origin/main", commitSha);
  const evidence = collectDocumentationEvidence({
    repoRoot,
    commitSha,
    claims,
    collectedAt: "2026-08-13T12:00:00.000Z",
  });
  verifyDocumentationEvidence({
    repoRoot,
    evidence,
    claims,
  });
  verifiedDocumentationCache = {
    repoRoot,
    commitSha,
    claims,
    evidence,
  };
  process.once("exit", () => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  return verifiedDocumentationCache;
}

export function fixturePath(...parts: string[]): string {
  return path.join(fixtureRoot, ...parts);
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function bindWeeklyMilestoneReport(
  narrative: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  presentation: Record<string, unknown>,
): void {
  const epics = Array.isArray(snapshot.epics)
    ? (snapshot.epics as Array<Record<string, unknown>>)
    : [];
  const presentationEntries = Array.isArray(presentation.epics)
    ? (presentation.epics as Array<Record<string, unknown>>)
    : [];
  const presentationByEpicId = new Map(
    presentationEntries.map((entry) => [entry.epicNodeId, entry]),
  );
  const milestoneRows = Array.isArray(narrative.milestoneRows)
    ? (narrative.milestoneRows as Array<Record<string, unknown>>)
    : [];
  for (const row of milestoneRows) {
    const existingUpdates = Array.isArray(row.updates)
      ? (row.updates as Array<Record<string, unknown>>)
      : [];
    const existingByEpicId = new Map(existingUpdates.map((update) => [update.epicNodeId, update]));
    row.updates = epics
      .filter((epic) => {
        const entry = presentationByEpicId.get(epic.nodeId);
        const displayMilestoneNodeId = epic.milestoneNodeId ?? entry?.presentationMilestoneNodeId;
        return displayMilestoneNodeId === row.milestoneNodeId;
      })
      .sort((left, right) => {
        const leftOrder = Number(presentationByEpicId.get(left.nodeId)?.displayOrder ?? 0);
        const rightOrder = Number(presentationByEpicId.get(right.nodeId)?.displayOrder ?? 0);
        return leftOrder - rightOrder || Number(left.issueNumber) - Number(right.issueNumber);
      })
      .map((epic) => {
        const entry = presentationByEpicId.get(epic.nodeId);
        const existing = existingByEpicId.get(epic.nodeId);
        return {
          epicNodeId: epic.nodeId,
          epicBodySha256: epic.bodySha256,
          label: entry?.displayTitle ?? epic.title,
          text: existing?.text ?? entry?.shortenedOutcome ?? "Status review remains in progress.",
        };
      });
  }
  narrative.reportSha256 = canonicalSha256(withoutTopLevelKey(narrative, "reportSha256"));
}

function setReceiptRecords(
  snapshot: Record<string, unknown>,
  queryId: string,
  records: unknown[],
): void {
  const collection = snapshot.collection as Record<string, unknown>;
  const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
    (candidate) => candidate.queryId === queryId,
  );
  if (!receipt) throw new Error(`Synthetic receipt is missing: ${queryId}`);
  receipt.sourceRecords = records;
  receipt.itemCount = records.length;
  receipt.declaredTotalCount = records.length;
  receipt.sourceSha256 = canonicalSha256(records);
}

function bindSnapshotRepositoryCommit(snapshot: Record<string, unknown>, commitSha: string): void {
  const repository = snapshot.repository as Record<string, unknown>;
  repository.commitSha = commitSha;
  const collection = snapshot.collection as Record<string, unknown>;
  const receipts = collection.receipts as Array<Record<string, unknown>>;
  const summary = receipts.find((receipt) => receipt.queryId === "repository-summary");
  const summaryRecords = summary?.sourceRecords;
  if (summary && Array.isArray(summaryRecords) && summaryRecords.length === 1) {
    const record = summaryRecords[0] as Record<string, unknown>;
    record.commitSha = commitSha;
    summary.sourceSha256 = canonicalSha256(summaryRecords);
  }
  const ancestry = receipts.find((receipt) => receipt.queryId === "tag-default-branch-ancestry");
  if (ancestry) {
    const scope = expectedReceiptScopeForSnapshot(
      snapshot as never,
      receipts as never,
      "tag-default-branch-ancestry",
    );
    if (scope) {
      ancestry.scope = scope;
      ancestry.requestSha256 = receiptRequestSha256(String(ancestry.querySha256), scope);
    }
  }
  collection.receiptsSha256 = canonicalSha256(receipts);
  snapshot.snapshotSha256 = canonicalSha256(withoutTopLevelKey(snapshot, "snapshotSha256"));
}

export function syntheticFixtureInputs(): {
  snapshot: Record<string, unknown>;
  presentation: Record<string, unknown>;
  narrative: Record<string, unknown>;
} {
  const snapshot = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
  const presentation = readJson<Record<string, unknown>>(fixturePath("presentation-map.json"));
  const narrative = readJson<Record<string, unknown>>(fixturePath("narrative-input.json"));
  const documentation = verifiedDocumentationFixture();
  const repository = snapshot.repository as Record<string, unknown>;
  repository.commitSha = documentation.commitSha;
  const milestones = snapshot.milestones as Array<Record<string, unknown>>;
  const epics = snapshot.epics as Array<Record<string, unknown>>;

  setReceiptRecords(
    snapshot,
    "repository-milestones",
    milestones.map((milestone, index) => {
      milestone.description = null;
      milestone.dueOn = new Date(Date.UTC(2026, 8 + index, 1)).toISOString();
      milestone.state = "OPEN";
      milestone.closedAt = null;
      return {
        id: milestone.nodeId,
        number: milestone.number,
        title: milestone.title,
        description: milestone.description,
        dueOn: milestone.dueOn,
        state: milestone.state,
        closedAt: milestone.closedAt,
        url: milestone.url,
      };
    }),
  );
  const metrics = snapshot.metrics as Record<string, Record<string, unknown>>;
  setReceiptRecords(snapshot, "authenticated-viewer", [{ authenticated: true }]);
  setReceiptRecords(snapshot, "repository-summary", [
    {
      nodeId: repository.nodeId,
      nameWithOwner: repository.nameWithOwner,
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      commitSha: repository.commitSha,
      commitDate: repository.commitDate,
      stargazerCount: metrics.stars.total,
      forkCount: metrics.forks.total,
      mergedPullRequestCount: metrics.mergedPullRequests.total,
    },
  ]);

  setReceiptRecords(
    snapshot,
    "repository-open-issues",
    epics
      .filter((epic) => epic.state === "OPEN")
      .map((epic) => {
        const milestone = milestones.find((candidate) => candidate.nodeId === epic.milestoneNodeId);
        if (!milestone)
          throw new Error(`Synthetic Epic ${String(epic.issueNumber)} has no milestone`);
        epic.closedAt = null;
        return {
          id: epic.nodeId,
          number: epic.issueNumber,
          title: epic.title,
          body: `## Outcome\n\n${String(epic.outcome)}`,
          state: "OPEN",
          url: epic.url,
          createdAt: "2026-08-01T00:00:00.000Z",
          closedAt: null,
          issueType: epic.nativeIssueType,
          milestone: { id: milestone.nodeId, number: milestone.number },
        };
      }),
  );

  for (const milestone of milestones) {
    const milestoneEpics = epics.filter((epic) => epic.milestoneNodeId === milestone.nodeId);
    const issueRecords = milestoneEpics.map((epic) => {
      const body = `## Outcome\n\n${String(epic.outcome)}`;
      epic.bodySha256 = sha256Text(body);
      const progress = epic.progress as
        | "Unknown"
        | { completed: number; total: number; percentage: number };
      const children =
        progress === "Unknown"
          ? []
          : Array.from({ length: progress.total }, (_, index) => ({
              id: `CHILD_${String(epic.issueNumber)}_${index + 1}`,
              number: Number(epic.issueNumber) * 100 + index + 1,
              state: index < progress.completed ? "CLOSED" : "OPEN",
              url: `https://github.com/NVIDIA/NemoClaw/issues/${Number(epic.issueNumber) * 100 + index + 1}`,
            }));
      epic.children = children.map((child) => ({
        nodeId: child.id,
        issueNumber: child.number,
        state: child.state,
        url: child.url,
        sourceKind: "native-subissue",
      }));
      setReceiptRecords(snapshot, `issue-${String(epic.issueNumber)}-subissues`, children);
      epic.closedAt = epic.state === "CLOSED" ? "2026-08-10T00:00:00.000Z" : null;
      return {
        id: epic.nodeId,
        number: epic.issueNumber,
        title: epic.title,
        body,
        state: epic.state,
        url: epic.url,
        createdAt: "2026-08-01T00:00:00.000Z",
        closedAt: epic.closedAt,
        issueType: epic.nativeIssueType,
        subIssues: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: 0,
        },
      };
    });
    setReceiptRecords(snapshot, `milestone-${String(milestone.number)}-issues`, issueRecords);
  }

  const releases = snapshot.releases as Array<Record<string, unknown>>;
  const tagRecords: Array<Record<string, unknown>> = [];
  const ancestryRecords: Array<Record<string, unknown>> = [];
  const discussionRecords: Array<Record<string, unknown>> = [];
  const releaseDates = ["2026-08-12T00:00:00.000Z", "2026-08-01T00:00:00.000Z"];
  for (const [index, release] of releases.entries()) {
    const tag = String(release.tag);
    const commitSha = String(index + 1).repeat(40);
    const publishedAt = releaseDates[index] ?? "2026-07-01T00:00:00.000Z";
    const tagObjectId = `REF_SYNTHETIC_${tag}`;
    release.tagObjectId = tagObjectId;
    release.commitSha = commitSha;
    release.publishedAt = publishedAt;
    release.commitDate = publishedAt;
    tagRecords.push({
      id: tagObjectId,
      name: tag,
      target: {
        __typename: "Commit",
        oid: commitSha,
        committedDate: publishedAt,
        url: `https://github.com/NVIDIA/NemoClaw/commit/${commitSha}`,
      },
    });
    ancestryRecords.push({ tag, commitSha, ancestor: true });
    const body = `${tag} delivers the reviewed synthetic release outcomes.`;
    const bodySha256 = sha256Text(body);
    const announcement = release.announcement as Record<string, unknown>;
    announcement.number = 123 - index;
    announcement.categoryId = "CATEGORY_ANNOUNCEMENTS";
    announcement.title = `NemoClaw ${tag} is out`;
    announcement.createdAt = publishedAt;
    announcement.updatedAt = publishedAt;
    announcement.bodySha256 = bodySha256;
    discussionRecords.push({
      id: announcement.nodeId,
      number: announcement.number,
      title: announcement.title,
      body,
      url: announcement.url,
      createdAt: announcement.createdAt,
      updatedAt: announcement.updatedAt,
    });
  }
  setReceiptRecords(snapshot, "tag-refs", tagRecords);
  setReceiptRecords(snapshot, "tag-default-branch-ancestry", ancestryRecords);
  setReceiptRecords(snapshot, "discussion-categories", [
    {
      id: "CATEGORY_ANNOUNCEMENTS",
      name: "Announcements",
      slug: "announcements",
    },
  ]);
  setReceiptRecords(snapshot, "announcement-discussions", discussionRecords);
  setReceiptRecords(snapshot, "stargazers-window", [
    ...Array.from({ length: 24 }, (_, index) => ({
      nodeId: `STAR_${index + 1}`,
      starredAt: "2026-08-12T00:00:00.000Z",
    })),
    { nodeId: "STAR_BEFORE_WINDOW", starredAt: "2026-08-06T11:59:59.999Z" },
  ]);
  setReceiptRecords(snapshot, "forks-window", [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `FORK_${index + 1}`,
      createdAt: "2026-08-11T00:00:00.000Z",
    })),
    { id: "FORK_BEFORE_WINDOW", createdAt: "2026-08-06T11:59:59.999Z" },
  ]);
  setReceiptRecords(
    snapshot,
    "merged-prs-window",
    Array.from({ length: 31 }, (_, index) => ({
      id: `MERGED_PR_${index + 1}`,
      number: 200 + index,
      url: `https://github.com/NVIDIA/NemoClaw/pull/${200 + index}`,
      mergedAt: "2026-08-10T00:00:00.000Z",
    })),
  );
  setReceiptRecords(snapshot, "vdr-opened-window", [
    {
      id: "ISSUE_OPEN_1",
      number: 301,
      url: "https://github.com/NVIDIA/NemoClaw/issues/301",
      createdAt: "2026-08-09T00:00:00.000Z",
      closedAt: null,
    },
    {
      id: "ISSUE_OPEN_2",
      number: 302,
      url: "https://github.com/NVIDIA/NemoClaw/issues/302",
      createdAt: "2026-08-09T00:00:00.000Z",
      closedAt: null,
    },
  ]);
  setReceiptRecords(snapshot, "uat-opened-window", [
    {
      id: "ISSUE_OPEN_2",
      number: 302,
      url: "https://github.com/NVIDIA/NemoClaw/issues/302",
      createdAt: "2026-08-09T00:00:00.000Z",
      closedAt: null,
    },
    {
      id: "ISSUE_OPEN_3",
      number: 303,
      url: "https://github.com/NVIDIA/NemoClaw/issues/303",
      createdAt: "2026-08-09T00:00:00.000Z",
      closedAt: null,
    },
  ]);
  setReceiptRecords(snapshot, "vdr-closed-window", [
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `ISSUE_CLOSED_${index + 1}`,
      number: 401 + index,
      url: `https://github.com/NVIDIA/NemoClaw/issues/${401 + index}`,
      createdAt: "2026-08-08T00:00:00.000Z",
      closedAt: "2026-08-09T00:00:00.000Z",
    })),
  ]);
  setReceiptRecords(snapshot, "uat-closed-window", [
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `ISSUE_CLOSED_${index + 3}`,
      number: 403 + index,
      url: `https://github.com/NVIDIA/NemoClaw/issues/${403 + index}`,
      createdAt: "2026-08-08T00:00:00.000Z",
      closedAt: "2026-08-09T00:00:00.000Z",
    })),
  ]);

  const collection = snapshot.collection as Record<string, unknown>;
  const receipts = collection.receipts as Array<Record<string, unknown>>;
  if (!receipts.some((receipt) => receipt.queryId === "tag-default-branch-ancestry")) {
    throw new Error("Synthetic receipt is missing: tag-default-branch-ancestry");
  }
  for (const receipt of receipts) {
    const expectedSource = expectedReceiptSourceForQuery(String(receipt.queryId));
    if (!expectedSource)
      throw new Error(`Synthetic receipt has no source kind: ${receipt.queryId}`);
    receipt.source = expectedSource;
    const expectedQuerySha256 = expectedReceiptQuerySha256(String(receipt.queryId));
    if (!expectedQuerySha256)
      throw new Error(`Synthetic receipt has no query hash: ${receipt.queryId}`);
    receipt.querySha256 = expectedQuerySha256;
    if (expectedSource === "github-rest-or-single-object") {
      receipt.pageCount = (receipt.sourceRecords as unknown[]).length;
    }
    const scope = expectedReceiptScopeForSnapshot(
      snapshot as never,
      receipts as never,
      String(receipt.queryId),
    );
    if (!scope) throw new Error(`Synthetic receipt scope is invalid: ${String(receipt.queryId)}`);
    receipt.scope = scope;
    receipt.requestSha256 = receiptRequestSha256(String(receipt.querySha256), scope);
    receipt.declaredTotalCount = (receipt.sourceRecords as unknown[]).length;
  }
  for (const [queryId, declaredTotalCount] of [
    ["stargazers-window", metrics.stars.total],
    ["forks-window", metrics.forks.total],
  ] as const) {
    const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
      (candidate) => candidate.queryId === queryId,
    );
    if (!receipt) throw new Error(`Synthetic receipt is missing: ${queryId}`);
    receipt.declaredTotalCount = declaredTotalCount;
    receipt.termination = "window-cutoff";
    receipt.terminalHasNextPage = true;
    receipt.firstCursor = "synthetic-window-page";
    receipt.finalCursor = "synthetic-window-page";
  }
  collection.receiptsSha256 = canonicalSha256(collection.receipts);
  snapshot.snapshotSha256 = canonicalSha256(withoutTopLevelKey(snapshot, "snapshotSha256"));
  bindWeeklyMilestoneReport(narrative, snapshot, presentation);
  return { snapshot, presentation, narrative };
}

export function buildSyntheticModel(
  overrides: {
    snapshot?: Record<string, unknown>;
    presentation?: Record<string, unknown>;
    docs?: Record<string, unknown>;
    narrative?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const baseline = readJson<Record<string, unknown>>(fixturePath("template", "baseline.json"));
  const inputs = syntheticFixtureInputs();
  const documentation = verifiedDocumentationFixture();
  const snapshot = (overrides.snapshot ?? inputs.snapshot) as Record<string, unknown>;
  const presentation = (overrides.presentation ?? inputs.presentation) as Record<string, unknown>;
  bindSnapshotRepositoryCommit(snapshot, documentation.commitSha);
  const narrative = overrides.narrative ? structuredClone(overrides.narrative) : inputs.narrative;
  bindWeeklyMilestoneReport(narrative, snapshot, presentation);
  return buildSlideModel({
    snapshot: snapshot as never,
    docs: (overrides.docs ?? documentation.evidence) as never,
    presentation: presentation as never,
    claims: readJson(path.join(skillRoot, "references", "markitecture-claims.json")) as never,
    narrative: narrative as never,
    templateFingerprint: semanticTemplateFingerprint(baseline as never),
  });
}

export function semanticReadback(model: Record<string, unknown>): Record<string, unknown> {
  const nativeKinds: Record<string, string[]> = {
    "roadmap-executive": ["group", "line", "shape", "text"],
    "roadmap-capability": ["shape", "table", "text"],
    markitecture: ["connector", "shape", "text"],
    "weekly-release": ["shape", "text"],
  };
  const expectedManaged = new Map(
    expectedManagedVisibleTextInventory(model).map((slide) => [
      slide.instanceId ?? slide.role,
      slide.visibleTextInventory,
    ]),
  );
  const expectedHyperlinks = new Map(
    expectedHyperlinkInventory(model).map((slide) => [
      slide.instanceId ?? slide.role,
      slide.hyperlinkInventory,
    ]),
  );
  const expectedConnectors = new Map(
    expectedConnectorInventory(model).map((slide) => [
      slide.instanceId ?? slide.role,
      slide.connectorInventory,
    ]),
  );
  const expectedCapabilityStructure = new Map(
    expectedCapabilityStructureInventory(model).map((slide) => [
      slide.instanceId ?? slide.role,
      slide.capabilityStructureInventory,
    ]),
  );
  const expectedWeeklyMilestoneStructure = new Map(
    expectedWeeklyMilestoneStructureInventory(model).map((slide) => [
      slide.role,
      slide.weeklyMilestoneStructureInventory,
    ]),
  );
  return {
    schemaVersion: 1,
    modelSha256: model.modelSha256,
    snapshotSha256: model.snapshotSha256,
    templateFingerprint: model.templateFingerprint,
    slides: (model.slides as Array<Record<string, unknown>>).map((slide) => {
      const { managedNotes, sources, ...content } = slide;
      const role = String(slide.role);
      const identity = typeof slide.instanceId === "string" ? slide.instanceId : role;
      const managedVisibleTextInventory = expectedManaged.get(identity) as string[];
      const inheritedVisibleTextInventory = role === "roadmap-executive" ? ["‹#›", "‹#›"] : ["‹#›"];
      const protectedVisibleTextInventory: string[] = [];
      return {
        role,
        ...(slide.instanceId ? { instanceId: slide.instanceId } : {}),
        nativeObjectKinds: nativeKinds[role],
        hyperlinkInventory: expectedHyperlinks.get(identity),
        connectorInventory: expectedConnectors.get(identity),
        ...(role === "roadmap-capability"
          ? { capabilityStructureInventory: expectedCapabilityStructure.get(identity) }
          : {}),
        ...(role === "weekly-release"
          ? {
              weeklyMilestoneStructureInventory:
                expectedWeeklyMilestoneStructure.get("weekly-release"),
            }
          : {}),
        managedVisibleTextInventory,
        protectedVisibleTextInventory,
        inheritedVisibleTextInventory,
        visibleTextInventory: [
          ...managedVisibleTextInventory,
          ...protectedVisibleTextInventory,
          ...inheritedVisibleTextInventory,
        ].sort(),
        content,
        managedNotes,
        sources,
      };
    }),
  };
}

export const slideModelSchemaPath = path.join(skillRoot, "references", "slide-model.schema.json");
