// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { conciseEvidenceText } from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/build-slide-model.mts";
import {
  type ClaimLedger,
  collectDocumentationEvidence,
  type DocumentationEvidence,
  extractHeadingSection,
  isDocumentationEvidenceVerified,
  verifyDocumentationEvidence,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-doc-evidence.mts";
import {
  applyMetricMode,
  dedupeByNodeId,
  expectedReceiptScopeForSnapshot,
  paginateConnection,
  receiptRequestSha256,
  resolveMilestoneSelections,
  resolveMilestones,
  selectStableTags,
  unmilestonedEpicFindings,
  verifyBaselineReceiptProvenance,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts";
import {
  canonicalJson,
  canonicalSha256,
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

function rehash(value: Record<string, unknown>, key: string): void {
  value[key] = canonicalSha256(withoutTopLevelKey(value, key));
}

function rehashSnapshotReceipts(snapshot: Record<string, unknown>): void {
  const collection = snapshot.collection as Record<string, unknown>;
  collection.receiptsSha256 = canonicalSha256(collection.receipts);
  rehash(snapshot, "snapshotSha256");
}

function publicationCodes(model: Record<string, unknown>): string[] {
  const publication = model.publication as Record<string, unknown>;
  return (publication.blockers as Array<Record<string, unknown>>).map((finding) =>
    String(finding.code),
  );
}

function runEvidenceCli(script: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve(".agents/skills/nemoclaw-maintainer-product-slides/scripts", script),
      ...args,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
}

function createDocumentationGitFixture(): {
  repoRoot: string;
  claims: ClaimLedger;
  evidence: DocumentationEvidence;
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doc-provenance-"));
  const runGit = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  runGit("init", "--initial-branch=main");
  runGit("config", "user.name", "NemoClaw Test");
  runGit("config", "user.email", "nemoclaw-test@example.com");
  runGit("remote", "add", "origin", "https://github.com/NVIDIA/NemoClaw.git");
  for (const relativePath of [
    "docs/about",
    "docs/get-started",
    "docs/inference",
    "docs/reference",
    "ci",
    "scripts",
  ]) {
    fs.mkdirSync(path.join(repoRoot, relativePath), { recursive: true });
  }
  fs.writeFileSync(
    path.join(repoRoot, "docs/about/how-it-works.mdx"),
    "# Architecture\n\n## Reviewed Scope\n\nCommitted truth.\n",
  );
  fs.writeFileSync(
    path.join(repoRoot, "ci/platform-matrix.json"),
    `${JSON.stringify({ version: "1", platforms: [{ name: "Linux", status: "tested" }] })}\n`,
  );
  const generatedPage = "matrix-version: 1\n";
  for (const relativePath of [
    "docs/get-started/prerequisites.mdx",
    "docs/inference/choose-inference-provider.mdx",
    "docs/reference/platform-support.mdx",
  ]) {
    fs.writeFileSync(path.join(repoRoot, relativePath), generatedPage);
  }
  fs.writeFileSync(
    path.join(repoRoot, "scripts/generate-platform-docs.py"),
    [
      "import json",
      "from pathlib import Path",
      "matrix = json.loads(Path('ci/platform-matrix.json').read_text())",
      "expected = f\"matrix-version: {matrix['version']}\\n\"",
      "paths = [",
      "    'docs/get-started/prerequisites.mdx',",
      "    'docs/inference/choose-inference-provider.mdx',",
      "    'docs/reference/platform-support.mdx',",
      "]",
      "if any(Path(item).read_text() != expected for item in paths):",
      "    print('DIFF: generated platform documentation is out of sync')",
      "    raise SystemExit(1)",
      "",
    ].join("\n"),
  );
  runGit("add", ".");
  runGit("commit", "--no-gpg-sign", "-m", "test: add documentation evidence");
  const commitSha = runGit("rev-parse", "HEAD");
  runGit("update-ref", "refs/remotes/origin/main", commitSha);
  const claims: ClaimLedger = {
    schemaVersion: 1,
    claims: [
      {
        claimId: "claim.immutable",
        text: "Committed truth.",
        path: "docs/about/how-it-works.mdx",
        heading: "Reviewed Scope",
        evidenceAnchors: ["Committed truth."],
        platformGate: {
          matrixSection: "platforms",
          entryName: "Linux",
          allowedStatuses: ["tested"],
        },
      },
    ],
  };
  return {
    repoRoot,
    claims,
    evidence: collectDocumentationEvidence({
      repoRoot,
      commitSha,
      claims,
      collectedAt: "2026-08-13T12:00:00.000Z",
    }),
  };
}

describe("NemoClaw product slide evidence fails closed", () => {
  it("documents milestone selection as optional", () => {
    const result = runEvidenceCli("collect-github-snapshot.mts", ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[--milestone TITLE ...]");
  });

  it("requires a commit before documentation collection starts", () => {
    const result = runEvidenceCli("collect-doc-evidence.mts", [
      "--repo-root",
      process.cwd(),
      "--claims",
      path.join(os.tmpdir(), "unused-product-slide-claims.json"),
      "--output",
      path.join(os.tmpdir(), "unused-product-slide-docs.json"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--commit");
  });

  it("rejects an exhausted connection whose total count is incomplete", () => {
    expect(() =>
      paginateConnection({
        source: "synthetic",
        queryId: "truncated",
        query: "query Truncated",
        fetchPage: () => ({
          nodes: [{ id: "one" }],
          pageInfo: { hasNextPage: false, endCursor: "end" },
          totalCount: 2,
        }),
      }),
    ).toThrow(/collected 1 items but GitHub reported 2/u);
  });

  it("blocks a receipt that claims exhaustion while another page exists", () => {
    const snapshot = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
    const collection = snapshot.collection as Record<string, unknown>;
    const receipt = (collection.receipts as Array<Record<string, unknown>>)[0];
    receipt.terminalHasNextPage = true;
    rehash(snapshot, "snapshotSha256");

    expect(publicationCodes(buildSyntheticModel({ snapshot }))).toContain(
      "COLLECTION_RECEIPT_INCOMPLETE",
    );
  });

  it("requires the exact receipt set and repository-owned query hashes", () => {
    const reduced = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
    const reducedCollection = reduced.collection as Record<string, unknown>;
    reducedCollection.receipts = (
      reducedCollection.receipts as Array<Record<string, unknown>>
    ).slice(0, 1);
    rehashSnapshotReceipts(reduced);
    expect(publicationCodes(buildSyntheticModel({ snapshot: reduced }))).toContain(
      "COLLECTION_RECEIPT_SET_INVALID",
    );

    const forgedQuery = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
    const forgedCollection = forgedQuery.collection as Record<string, unknown>;
    (forgedCollection.receipts as Array<Record<string, unknown>>)[0].querySha256 = "0".repeat(64);
    rehashSnapshotReceipts(forgedQuery);
    expect(publicationCodes(buildSyntheticModel({ snapshot: forgedQuery }))).toContain(
      "COLLECTION_RECEIPT_INCOMPLETE",
    );
  });

  it("recomputes each receipt source digest from its retained source records", () => {
    const snapshot = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
    const collection = snapshot.collection as Record<string, unknown>;
    (collection.receipts as Array<Record<string, unknown>>)[0].sourceRecords = [
      { unexpected: true },
    ];
    rehashSnapshotReceipts(snapshot);

    expect(publicationCodes(buildSyntheticModel({ snapshot }))).toContain(
      "COLLECTION_RECEIPT_INCOMPLETE",
    );
  });

  it.each([
    {
      matchCount: 0,
      mutateAnnouncement: (release: Record<string, unknown>) => {
        release.announcement = null;
      },
    },
    {
      matchCount: 2,
      mutateAnnouncement: (_release: Record<string, unknown>) => undefined,
    },
  ])(
    "blocks exact Announcement evidence with $matchCount matches",
    ({ matchCount, mutateAnnouncement }) => {
      const snapshot = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
      const release = (snapshot.releases as Array<Record<string, unknown>>)[0];
      release.announcementMatchCount = matchCount;
      mutateAnnouncement(release);
      rehash(snapshot, "snapshotSha256");

      expect(publicationCodes(buildSyntheticModel({ snapshot }))).toContain(
        "ANNOUNCEMENT_MATCH_INVALID",
      );
    },
  );

  it("blocks a release whose Announcement evidence is not a canonical GitHub Discussion URL", () => {
    const { snapshot } = syntheticFixtureInputs();
    const release = (snapshot.releases as Array<Record<string, unknown>>)[0];
    const announcement = release.announcement as Record<string, unknown>;
    announcement.url = "https://github.com/NVIDIA/NemoClaw/issues/123";
    rehash(snapshot, "snapshotSha256");

    expect(publicationCodes(buildSyntheticModel({ snapshot }))).toContain(
      "ANNOUNCEMENT_EVIDENCE_LINK_INVALID",
    );
  });

  it("blocks a selected Epic without exact native issue-type evidence", () => {
    const snapshot = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
    delete (snapshot.epics as Array<Record<string, unknown>>)[0].nativeIssueType;
    rehash(snapshot, "snapshotSha256");

    expect(publicationCodes(buildSyntheticModel({ snapshot }))).toContain(
      "NATIVE_ISSUE_TYPE_INVALID",
    );
  });

  it("blocks a fourth weekly milestone row instead of collapsing it", () => {
    const narrative = readJson<Record<string, unknown>>(fixturePath("narrative-input.json"));
    const rows = narrative.milestoneRows as Array<Record<string, unknown>>;
    rows.push(structuredClone(rows[0]));
    const model = buildSyntheticModel({ narrative });
    const schema = JSON.parse(fs.readFileSync(slideModelSchemaPath, "utf8"));

    expect(publicationCodes(model)).toContain("WEEKLY_MILESTONE_DENSITY_EXCEEDED");
    expect(validateSlideModel(model, schema, "publish").valid).toBe(false);
  });

  it("uses a bounded placeholder instead of source prose when a reviewed summary is stale", () => {
    const snapshot = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
    const epic = (snapshot.epics as Array<Record<string, unknown>>)[0];
    const presentation = readJson<Record<string, unknown>>(fixturePath("presentation-map.json"));
    const mapping = (presentation.epics as Array<Record<string, unknown>>)[0];
    mapping.shortenedOutcome = "Stale presentation wording.";
    mapping.boundBodySha256 = epic.bodySha256;
    epic.bodySha256 = "a".repeat(64);
    rehash(snapshot, "snapshotSha256");
    const model = buildSyntheticModel({ snapshot, presentation });
    const executive = (model.slides as Array<Record<string, unknown>>)[0];
    const firstMilestone = (executive.milestones as Array<Record<string, unknown>>)[0];
    const outcome = (firstMilestone.outcomes as Array<Record<string, unknown>>)[0];

    expect(publicationCodes(model)).toContain("SHORTENED_OUTCOME_STALE");
    expect(outcome).toMatchObject({
      featureTitle: "Needs summary",
      text: "Review the Epic body recorded in the snapshot.",
    });
    expect(outcome.text).not.toMatch(/^Install and start/u);
  });

  it("blocks duplicate milestones and unresolved Epic milestone identity", () => {
    const duplicate = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
    const milestones = duplicate.milestones as Array<Record<string, unknown>>;
    milestones[1].nodeId = milestones[0].nodeId;
    rehash(duplicate, "snapshotSha256");
    expect(publicationCodes(buildSyntheticModel({ snapshot: duplicate }))).toContain(
      "MILESTONE_DUPLICATE",
    );

    const unresolved = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
    (unresolved.epics as Array<Record<string, unknown>>)[0].milestoneNodeId = "MISSING";
    rehash(unresolved, "snapshotSha256");
    expect(publicationCodes(buildSyntheticModel({ snapshot: unresolved }))).toContain(
      "EPIC_MILESTONE_UNRESOLVED",
    );
  });

  it("blocks a presentation category outside the reviewed taxonomy", () => {
    const presentation = readJson<Record<string, unknown>>(fixturePath("presentation-map.json"));
    (presentation.epics as Array<Record<string, unknown>>)[0].roadmapArea = "Invented area";

    expect(publicationCodes(buildSyntheticModel({ presentation }))).toContain(
      "PRESENTATION_AREA_INVALID",
    );
  });

  it("states the latest stable tag when no stable release falls in the window", () => {
    const snapshot = readJson<Record<string, unknown>>(fixturePath("snapshot-base.json"));
    (snapshot.releases as Array<Record<string, unknown>>).forEach((release) => {
      release.inWindow = false;
    });
    rehash(snapshot, "snapshotSha256");
    const weekly = (buildSyntheticModel({ snapshot }).slides as Array<Record<string, unknown>>)[3];

    expect(weekly.releaseContext).toBe("No stable release this window. Latest: v1.2.3.");
    expect(weekly.milestoneRows).toHaveLength(3);
    expect(
      (weekly.metrics as Array<Record<string, unknown>>).find(
        (metric) => metric.contentId === "metric.latest-release",
      )?.value,
    ).toBe("v1.2.3");
  });

  it("rejects unverified documentation evidence and recomputes copied metric values", () => {
    const docs = readJson<Record<string, unknown>>(fixturePath("docs-evidence.json"));
    docs.complete = false;
    docs.findings = [
      {
        code: "PLATFORM_DOC_DRIFT",
        message: "Synthetic platform evidence conflicts.",
        remediation: "Synchronize the reviewed matrix and generated page.",
        role: "markitecture",
      },
    ];
    rehash(docs, "evidenceSha256");
    expect(() => buildSyntheticModel({ docs })).toThrow(
      /must be verified from immutable official Git objects/u,
    );

    const { snapshot } = syntheticFixtureInputs();
    const metrics = snapshot.metrics as Record<string, Record<string, unknown>>;
    metrics.stars.total = 4321;
    metrics.stars.retainedAdditions = 17;
    metrics.validationIssues.opened = 4;
    metrics.validationIssues.closed = 4;
    rehash(snapshot, "snapshotSha256");
    const weekly = (buildSyntheticModel({ snapshot }).slides as Array<Record<string, unknown>>)[3];
    expect(publicationCodes(buildSyntheticModel({ snapshot }))).toContain(
      "METRIC_RECEIPT_MISMATCH",
    );
    expect(weekly.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentId: "metric.stars",
          value: 1200,
          detailValue: 24,
        }),
        expect.objectContaining({
          contentId: "metric.vdr-uat",
          value: "Opened 3",
          detailValue: 5,
        }),
      ]),
    );
  });

  it("uses repository-summary counters when connection total semantics differ", () => {
    const { snapshot } = syntheticFixtureInputs();
    const collection = snapshot.collection as Record<string, unknown>;
    const receipts = collection.receipts as Array<Record<string, unknown>>;
    const stars = receipts.find((receipt) => receipt.queryId === "stargazers-window");
    const forks = receipts.find((receipt) => receipt.queryId === "forks-window");
    expect(stars, "Synthetic stargazer receipt is missing").toBeDefined();
    expect(forks, "Synthetic fork receipt is missing").toBeDefined();
    const requiredStars = stars as Record<string, unknown>;
    const requiredForks = forks as Record<string, unknown>;
    requiredStars.declaredTotalCount = Number(requiredStars.declaredTotalCount) - 1;
    requiredForks.declaredTotalCount = Number(requiredForks.declaredTotalCount) - 10;
    rehashSnapshotReceipts(snapshot);

    const model = buildSyntheticModel({ snapshot });
    const weekly = (model.slides as Array<Record<string, unknown>>)[3];

    expect(publicationCodes(model)).not.toContain("METRIC_RECEIPT_MISMATCH");
    expect(weekly.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contentId: "metric.stars", value: 1200 }),
        expect.objectContaining({ contentId: "metric.forks", value: 210 }),
      ]),
    );
  });

  it("rejects forged documentation claim identities even after evidence rehashing", () => {
    const docs = readJson<Record<string, unknown>>(fixturePath("docs-evidence.json"));
    const claim = (docs.claims as Array<Record<string, unknown>>)[0];
    claim.commitSha = "c".repeat(40);
    claim.sectionSha256 = "d".repeat(64);
    rehash(docs, "evidenceSha256");

    expect(() => buildSyntheticModel({ docs })).toThrow(
      /must be verified from immutable official Git objects/u,
    );
  });

  it("rejects a self-rehashed documentation envelope that does not match Git objects", () => {
    const fixture = createDocumentationGitFixture();
    try {
      expect(isDocumentationEvidenceVerified(fixture.evidence)).toBe(false);
      expect(
        verifyDocumentationEvidence({
          repoRoot: fixture.repoRoot,
          evidence: fixture.evidence,
          claims: fixture.claims,
        }),
      ).toBe(fixture.evidence);
      expect(isDocumentationEvidenceVerified(fixture.evidence)).toBe(true);

      const forged = structuredClone(fixture.evidence);
      forged.sources[0].blobSha = "a".repeat(40);
      forged.sources[0].sectionSha256 = "b".repeat(64);
      forged.claims[0].blobSha = forged.sources[0].blobSha;
      forged.claims[0].sectionSha256 = forged.sources[0].sectionSha256;
      forged.claims[0].evidenceAnchors = ["Forged anchor."];
      forged.claims[0].platformStatus = "caveated";
      forged.platformMatrix.blobSha = "c".repeat(40);
      forged.platformMatrix.sha256 = "d".repeat(64);
      forged.platformMatrix.generatedPageInSync = false;
      forged.evidenceSha256 = canonicalSha256(withoutTopLevelKey(forged, "evidenceSha256"));

      expect(() =>
        verifyDocumentationEvidence({
          repoRoot: fixture.repoRoot,
          evidence: forged,
          claims: fixture.claims,
        }),
      ).toThrow(/does not match the immutable Git objects/u);
      expect(isDocumentationEvidenceVerified(forged)).toBe(false);
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it("invalidates documentation evidence when the verified object changes", () => {
    const fixture = createDocumentationGitFixture();
    try {
      verifyDocumentationEvidence({
        repoRoot: fixture.repoRoot,
        evidence: fixture.evidence,
        claims: fixture.claims,
      });
      fixture.evidence.claims[0].text = "Changed after verification.";
      expect(isDocumentationEvidenceVerified(fixture.evidence)).toBe(false);
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates metric carriers and preserves complete normalized evidence text", () => {
    expect(
      dedupeByNodeId([
        { nodeId: "one", value: 1 },
        { nodeId: "two", value: 2 },
        { nodeId: "one", value: 3 },
      ]),
    ).toEqual([
      { nodeId: "one", value: 1 },
      { nodeId: "two", value: 2 },
    ]);
    expect(conciseEvidenceText("Alpha beta gamma delta epsilon zeta eta theta iota")).toBe(
      "Alpha beta gamma delta epsilon zeta eta theta iota",
    );
    expect(
      conciseEvidenceText(
        "First complete sentence is longer than the slide budget. Second sentence must remain.",
      ),
    ).toBe("First complete sentence is longer than the slide budget. Second sentence must remain.");
  });

  it("rejects duplicate milestone selection and stable tags that cannot be peeled", () => {
    const milestones = [
      { id: "one", number: 1, title: "Window", dueOn: null },
      { id: "two", number: 2, title: "Other", dueOn: null },
    ] as never[];
    expect(() => resolveMilestones(milestones, ["Window", "Window"])).toThrow(
      /selected more than once/u,
    );
    expect(() =>
      selectStableTags(
        [
          {
            name: "v1.2.3",
            tagObjectId: "tag",
            commitSha: "",
            publishedAt: "2026-08-13T00:00:00Z",
            commitDate: "",
            url: "https://github.com/NVIDIA/NemoClaw/releases/tag/v1.2.3",
            peeled: false,
          },
        ],
        1,
      ),
    ).toThrow(/could not be dereferenced/u);
  });

  it("orders only eligible milestones by due date and number", () => {
    const findings: Array<Record<string, unknown>> = [];
    const milestones = [
      {
        id: "late",
        number: 9,
        title: "Late",
        dueOn: "2026-12-01T00:00:00Z",
        state: "OPEN",
        closedAt: null,
      },
      {
        id: "undated",
        number: 2,
        title: "Undated",
        dueOn: null,
        state: "OPEN",
        closedAt: null,
      },
      {
        id: "early-two",
        number: 4,
        title: "Early two",
        dueOn: "2026-09-01T00:00:00Z",
        state: "OPEN",
        closedAt: null,
      },
      {
        id: "early-one",
        number: 3,
        title: "Early one",
        dueOn: "2026-09-01T00:00:00Z",
        state: "OPEN",
        closedAt: null,
      },
    ] as never[];

    expect(
      resolveMilestones(milestones, [], {}, "2026-08-20T00:00:00.000Z", findings as never).map(
        (milestone) => milestone.id,
      ),
    ).toEqual(["early-one", "early-two", "late"]);
    expect(findings).toEqual([expect.objectContaining({ code: "MILESTONE_DUE_DATE_MISSING" })]);
  });

  it("omits closed, past-due, and undated milestones in automatic and explicit selection", () => {
    const automaticFindings: Array<Record<string, unknown>> = [];
    const milestones = [
      {
        id: "current",
        number: 1,
        title: "Current",
        dueOn: "2026-08-20T23:59:59.000Z",
        state: "OPEN",
        closedAt: null,
      },
      {
        id: "future",
        number: 2,
        title: "Future",
        dueOn: "2026-09-01T00:00:00.000Z",
        state: "OPEN",
        closedAt: null,
      },
      {
        id: "past",
        number: 3,
        title: "Past",
        dueOn: "2026-08-19T23:59:59.000Z",
        state: "OPEN",
        closedAt: null,
      },
      {
        id: "undated",
        number: 4,
        title: "Undated",
        dueOn: null,
        state: "OPEN",
        closedAt: null,
      },
      {
        id: "closed",
        number: 5,
        title: "Closed",
        dueOn: "2026-09-01T00:00:00.000Z",
        state: "CLOSED",
        closedAt: "2026-08-19T12:00:00.000Z",
      },
    ] as never[];
    const openIssues = [
      {
        id: "past-epic",
        number: 901,
        title: "Past Epic",
        state: "OPEN",
        url: "https://github.com/NVIDIA/NemoClaw/issues/901",
        closedAt: null,
        issueType: { id: "EPIC", name: "Epic" },
        milestone: { id: "past", number: 3 },
      },
    ] as never[];

    expect(
      resolveMilestones(
        milestones,
        [],
        {},
        "2026-08-20T00:00:00.000Z",
        automaticFindings as never,
        openIssues,
      ).map((milestone) => milestone.id),
    ).toEqual(["current", "future"]);
    expect(automaticFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MILESTONE_PAST_DUE",
          message: expect.stringContaining("#901"),
        }),
        expect.objectContaining({ code: "MILESTONE_DUE_DATE_MISSING" }),
      ]),
    );

    const explicitFindings: Array<Record<string, unknown>> = [];
    expect(
      resolveMilestones(
        milestones,
        ["Closed", "Past", "Current"],
        {},
        "2026-08-20T00:00:00.000Z",
        explicitFindings as never,
        openIssues,
      ).map((milestone) => milestone.id),
    ).toEqual(["current"]);
    expect(explicitFindings.map((finding) => finding.code)).toEqual([
      "MILESTONE_PAST_DUE",
      "MILESTONE_DUE_DATE_MISSING",
    ]);

    const futureClosed = {
      ...(milestones[4] as unknown as Record<string, unknown>),
      id: "future-closed",
      title: "Future Closed",
      closedAt: "2026-08-20T00:00:00.001Z",
    } as never;
    expect(
      resolveMilestones([futureClosed], ["Future Closed"], {}, "2026-08-20T00:00:00.000Z"),
    ).toEqual([]);

    const malformedClosed = {
      ...(milestones[4] as unknown as Record<string, unknown>),
      id: "malformed-closed",
      title: "Malformed Closed",
      closedAt: "2026-02-30T00:00:00.000Z",
    } as never;
    expect(() =>
      resolveMilestones([malformedClosed], ["Malformed Closed"], {}, "2026-08-20T00:00:00.000Z"),
    ).toThrow(/invalid closedAt timestamp/u);
  });

  it("preserves an eligible milestone alias when an earlier explicit milestone is ineligible", () => {
    const milestones = [
      {
        id: "past",
        number: 1,
        title: "Roadmap: Past 2026",
        dueOn: "2026-08-19T23:59:59.000Z",
        state: "OPEN",
        closedAt: null,
      },
      {
        id: "q4",
        number: 2,
        title: "Roadmap: Q4 2026",
        dueOn: "2026-10-01T00:00:00.000Z",
        state: "OPEN",
        closedAt: null,
      },
    ] as never[];

    const selections = resolveMilestoneSelections(
      milestones,
      ["Past", "Q4"],
      { Past: "Roadmap: Past 2026", Q4: "Roadmap: Q4 2026" },
      "2026-08-20T00:00:00.000Z",
    );

    expect(
      selections.map(({ milestone, displayTitle }) => ({
        id: milestone.id,
        displayTitle,
      })),
    ).toEqual([{ id: "q4", displayTitle: "Q4" }]);
  });

  it("omits an open milestone whose due date is not a real calendar date", () => {
    const findings: Array<Record<string, unknown>> = [];
    const invalidDueDate = {
      id: "invalid-due-date",
      number: 6,
      title: "Invalid Due Date",
      dueOn: "2026-02-30T00:00:00.000Z",
      state: "OPEN",
      closedAt: null,
    } as never;

    expect(
      resolveMilestones([invalidDueDate], [], {}, "2026-01-01T00:00:00.000Z", findings as never),
    ).toEqual([]);
    expect(findings).toEqual([expect.objectContaining({ code: "MILESTONE_DUE_DATE_MISSING" })]);
  });

  it("blocks only open native Epics without a milestone", () => {
    const base = {
      url: "https://github.com/NVIDIA/NemoClaw/issues/9816",
      closedAt: null,
      milestone: null,
    };
    const findings = unmilestonedEpicFindings([
      {
        ...base,
        id: "open-epic",
        number: 9816,
        title: "Open Epic",
        state: "OPEN",
        issueType: { id: "EPIC", name: "Epic" },
      },
      {
        ...base,
        id: "open-feature",
        number: 9817,
        title: "Open Feature",
        state: "OPEN",
        issueType: { id: "FEATURE", name: "Feature" },
      },
      {
        ...base,
        id: "closed-epic",
        number: 9818,
        title: "Closed Epic",
        state: "CLOSED",
        closedAt: "2026-08-19T00:00:00.000Z",
        issueType: { id: "EPIC", name: "Epic" },
      } as never,
    ] as never[]);

    expect(findings).toEqual([
      expect.objectContaining({
        code: "EPIC_MILESTONE_MISSING",
        message: expect.stringContaining("#9816"),
      }),
    ]);
  });

  it("requires complete approved baseline provenance for net change", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-product-slides-baseline-"));
    try {
      const { snapshot } = syntheticFixtureInputs();
      const snapshotPath = path.join(tempRoot, "baseline.json");
      const approvalPath = path.join(tempRoot, "approval.json");
      fs.writeFileSync(snapshotPath, canonicalJson(snapshot));
      const approvalWithoutHash = {
        schemaVersion: 1,
        kind: "nemoclaw-product-slides-baseline-approval",
        repository: "NVIDIA/NemoClaw",
        snapshotSha256: snapshot.snapshotSha256,
        approved: true,
        approvedBy: "maintainer-test",
        approvedAt: "2026-08-13T12:05:00.000Z",
      };
      const approval = {
        ...approvalWithoutHash,
        approvalSha256: canonicalSha256(approvalWithoutHash),
      };
      fs.writeFileSync(approvalPath, canonicalJson(approval));
      const metrics = {
        stars: { total: 5000 },
        forks: { total: 900 },
      };
      applyMetricMode(metrics, "net_change", snapshotPath, approvalPath, String(snapshot.asOf));
      expect(metrics).toMatchObject({
        stars: { netChange: 3800 },
        forks: { netChange: 690 },
        baselineSnapshotSha256: snapshot.snapshotSha256,
        baselineApproval: {
          approvedBy: "maintainer-test",
          approvedAt: "2026-08-13T12:05:00.000Z",
        },
      });

      expect(() =>
        applyMetricMode(
          { stars: { total: 5000 }, forks: { total: 900 } },
          "net_change",
          snapshotPath,
          undefined,
          String(snapshot.asOf),
        ),
      ).toThrow(/baseline-approval/u);

      const incomplete = structuredClone(snapshot);
      (incomplete.collection as Record<string, unknown>).complete = false;
      incomplete.snapshotSha256 = canonicalSha256(withoutTopLevelKey(incomplete, "snapshotSha256"));
      const incompletePath = path.join(tempRoot, "incomplete.json");
      fs.writeFileSync(incompletePath, canonicalJson(incomplete));
      expect(() =>
        applyMetricMode(
          { stars: { total: 5000 }, forks: { total: 900 } },
          "net_change",
          incompletePath,
          approvalPath,
          String(incomplete.asOf),
        ),
      ).toThrow(/complete read-only receipt provenance/u);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies exact termination and ordered cutoff invariants to approved baselines", () => {
    const unknownTermination = syntheticFixtureInputs().snapshot;
    const unknownCollection = unknownTermination.collection as Record<string, unknown>;
    const milestoneReceipt = (unknownCollection.receipts as Array<Record<string, unknown>>).find(
      (receipt) => receipt.queryId === "repository-milestones",
    );
    expect(milestoneReceipt, "Synthetic milestone receipt is missing").toBeDefined();
    const requiredMilestoneReceipt = milestoneReceipt as Record<string, unknown>;
    requiredMilestoneReceipt.termination = "partial";
    rehashSnapshotReceipts(unknownTermination);
    expect(() => verifyBaselineReceiptProvenance(unknownTermination)).toThrow(
      /lacks complete request and source provenance/u,
    );

    const reorderedCutoff = syntheticFixtureInputs().snapshot;
    const cutoffCollection = reorderedCutoff.collection as Record<string, unknown>;
    const starReceipt = (cutoffCollection.receipts as Array<Record<string, unknown>>).find(
      (receipt) => receipt.queryId === "stargazers-window",
    );
    expect(starReceipt, "Synthetic stargazer receipt is missing").toBeDefined();
    const requiredStarReceipt = starReceipt as Record<string, unknown>;
    const starRecords = requiredStarReceipt.sourceRecords as Array<Record<string, unknown>>;
    requiredStarReceipt.sourceRecords = [starRecords.at(-1), starRecords[0]];
    requiredStarReceipt.itemCount = 2;
    requiredStarReceipt.sourceSha256 = canonicalSha256(requiredStarReceipt.sourceRecords);
    rehashSnapshotReceipts(reorderedCutoff);
    expect(() => verifyBaselineReceiptProvenance(reorderedCutoff)).toThrow(
      /lacks complete request and source provenance/u,
    );
  });

  it("revalidates an embedded approved baseline before publishing net change", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-product-slides-model-baseline-"),
    );
    try {
      const baselineInputs = syntheticFixtureInputs();
      const baseline = baselineInputs.snapshot;
      const baselineCollection = baseline.collection as Record<string, unknown>;
      const baselineReceipts = baselineCollection.receipts as Array<Record<string, unknown>>;
      const baselineMetrics = baseline.metrics as Record<string, Record<string, unknown>>;
      baselineMetrics.stars.total = 1100;
      baselineMetrics.forks.total = 200;
      const baselineSummary = baselineReceipts.find(
        (receipt) => receipt.queryId === "repository-summary",
      )?.sourceRecords as Array<Record<string, unknown>>;
      baselineSummary[0].stargazerCount = 1100;
      baselineSummary[0].forkCount = 200;
      const baselineStars = baselineReceipts.find(
        (candidate) => candidate.queryId === "stargazers-window",
      );
      const baselineForks = baselineReceipts.find(
        (candidate) => candidate.queryId === "forks-window",
      );
      expect(baselineStars, "Missing baseline stargazer receipt").toBeDefined();
      expect(baselineForks, "Missing baseline fork receipt").toBeDefined();
      const requiredBaselineStars = baselineStars as Record<string, unknown>;
      const requiredBaselineForks = baselineForks as Record<string, unknown>;
      requiredBaselineStars.declaredTotalCount = 1100;
      requiredBaselineForks.declaredTotalCount = 200;
      baselineReceipts.forEach((receipt) => {
        receipt.sourceSha256 = canonicalSha256(receipt.sourceRecords);
      });
      baselineCollection.receiptsSha256 = canonicalSha256(baselineReceipts);
      rehash(baseline, "snapshotSha256");

      const baselinePath = path.join(tempRoot, "baseline.json");
      const approvalPath = path.join(tempRoot, "approval.json");
      fs.writeFileSync(baselinePath, canonicalJson(baseline));
      const approvalWithoutHash = {
        schemaVersion: 1,
        kind: "nemoclaw-product-slides-baseline-approval",
        repository: "NVIDIA/NemoClaw",
        snapshotSha256: baseline.snapshotSha256,
        approved: true,
        approvedBy: "maintainer-test",
        approvedAt: "2026-08-13T12:05:00.000Z",
      };
      const approval = {
        ...approvalWithoutHash,
        approvalSha256: canonicalSha256(approvalWithoutHash),
      };
      fs.writeFileSync(approvalPath, canonicalJson(approval));

      const currentInputs = syntheticFixtureInputs();
      const current = currentInputs.snapshot;
      current.asOf = "2026-08-20T12:00:00.000Z";
      current.window = {
        start: "2026-08-13T12:00:00.000Z",
        end: "2026-08-20T12:00:00.000Z",
      };
      const currentCollection = current.collection as Record<string, unknown>;
      currentCollection.startedAt = current.asOf;
      currentCollection.completedAt = "2026-08-20T12:00:10.000Z";
      const currentReceipts = currentCollection.receipts as Array<Record<string, unknown>>;
      (current.releases as Array<Record<string, unknown>>).forEach((release) => {
        release.inWindow = false;
      });
      currentReceipts.forEach((receipt) => {
        receipt.startedAt = currentCollection.startedAt;
        receipt.completedAt = currentCollection.completedAt;
        const scope = expectedReceiptScopeForSnapshot(
          current as never,
          currentReceipts as never,
          String(receipt.queryId),
        );
        expect(scope, `Missing current scope ${String(receipt.queryId)}`).toBeDefined();
        const requiredScope = scope as Record<string, unknown>;
        receipt.scope = requiredScope;
        receipt.requestSha256 = receiptRequestSha256(String(receipt.querySha256), requiredScope);
      });
      const currentMetrics = current.metrics as Record<string, unknown>;
      currentMetrics.mode = "net_change";
      currentMetrics.mergedPullRequests = { total: 680, inWindow: 0 };
      currentMetrics.validationIssues = { opened: 0, closed: 0 };
      applyMetricMode(
        currentMetrics,
        "net_change",
        baselinePath,
        approvalPath,
        String((current.window as Record<string, unknown>).start),
      );
      currentCollection.receiptsSha256 = canonicalSha256(currentReceipts);
      rehash(current, "snapshotSha256");

      const model = buildSyntheticModel({
        snapshot: current,
        presentation: currentInputs.presentation,
        narrative: currentInputs.narrative,
      });
      const weekly = (model.slides as Array<Record<string, unknown>>)[3];
      expect(model.publication).toMatchObject({ eligible: true, blockers: [] });
      expect(weekly.metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            contentId: "metric.stars",
            detailLabel: "7-day net change",
            detailValue: 100,
          }),
          expect.objectContaining({
            contentId: "metric.forks",
            detailLabel: "7-day net change",
            detailValue: 10,
          }),
        ]),
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reads documentation bytes from the recorded Git commit", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doc-evidence-"));
    const runGit = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
    try {
      runGit("init");
      runGit("config", "user.name", "NemoClaw Test");
      runGit("config", "user.email", "nemoclaw-test@example.com");
      runGit("remote", "add", "origin", "https://github.com/NVIDIA/NemoClaw.git");
      fs.mkdirSync(path.join(repoRoot, "docs/about"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, "ci"), { recursive: true });
      const committed = "# Architecture\n\n## Reviewed Scope\n\nCommitted truth.\n";
      const docPath = path.join(repoRoot, "docs/about/how-it-works.mdx");
      fs.writeFileSync(docPath, committed);
      fs.writeFileSync(path.join(repoRoot, "ci/platform-matrix.json"), "{}\n");
      runGit("add", ".");
      runGit("commit", "--no-gpg-sign", "-m", "test: add immutable evidence");
      const commitSha = runGit("rev-parse", "HEAD");
      fs.writeFileSync(docPath, "# Architecture\n\n## Reviewed Scope\n\nDirty lie.\n");

      const evidence = collectDocumentationEvidence({
        repoRoot,
        commitSha,
        checkPlatformSync: false,
        collectedAt: "2026-08-13T12:00:00.000Z",
        claims: {
          schemaVersion: 1,
          claims: [
            {
              claimId: "claim.immutable",
              text: "Committed truth.",
              path: "docs/about/how-it-works.mdx",
              heading: "Reviewed Scope",
              evidenceAnchors: ["Committed truth."],
            },
          ],
        },
      });

      expect(evidence.complete).toBe(true);
      expect(evidence.claims[0].sectionSha256).toBe(
        sha256Text(extractHeadingSection(committed, "Reviewed Scope")),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("never executes a platform generator selected from another commit", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doc-generator-"));
    const runGit = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
    const markerPath = path.join(repoRoot, "untrusted-generator-ran");
    try {
      runGit("init");
      runGit("config", "user.name", "NemoClaw Test");
      runGit("config", "user.email", "nemoclaw-test@example.com");
      runGit("remote", "add", "origin", "https://github.com/NVIDIA/NemoClaw.git");
      fs.mkdirSync(path.join(repoRoot, "ci"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "ci/platform-matrix.json"), "{}\n");
      fs.writeFileSync(
        path.join(repoRoot, "scripts/generate-platform-docs.py"),
        `from pathlib import Path\nPath(${JSON.stringify(markerPath)}).write_text("executed")\n`,
      );
      runGit("add", ".");
      runGit("commit", "--no-gpg-sign", "-m", "test: add untrusted generator");
      const selectedCommit = runGit("rev-parse", "HEAD");
      fs.writeFileSync(
        path.join(repoRoot, "scripts/generate-platform-docs.py"),
        "raise SystemExit(0)\n",
      );
      runGit("add", ".");
      runGit("commit", "--no-gpg-sign", "-m", "test: review generator");

      expect(() =>
        collectDocumentationEvidence({
          repoRoot,
          commitSha: selectedCommit,
          collectedAt: "2026-08-13T12:00:00.000Z",
          claims: { schemaVersion: 1, claims: [] },
        }),
      ).toThrow(/different platform documentation generator/u);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects lookalike GitHub hosts before collecting documentation", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doc-remote-"));
    const runGit = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
    try {
      runGit("init");
      runGit("config", "user.name", "NemoClaw Test");
      runGit("config", "user.email", "nemoclaw-test@example.com");
      fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "tracked\n");
      runGit("add", ".");
      runGit("commit", "--no-gpg-sign", "-m", "test: initialize repository");
      runGit("remote", "add", "origin", "https://evilgithub.com/NVIDIA/NemoClaw.git");

      expect(() =>
        collectDocumentationEvidence({
          repoRoot,
          checkPlatformSync: false,
          claims: { schemaVersion: 1, claims: [] },
        }),
      ).toThrow(/must come from NVIDIA\/NemoClaw/u);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
