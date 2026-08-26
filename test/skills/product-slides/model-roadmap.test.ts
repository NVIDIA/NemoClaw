// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  exactAnnouncementMatches,
  extractOutcome,
  inHalfOpenWindow,
  normalizeProgress,
  paginateConnection,
  presentationMappedUnmilestonedEpics,
  receiptRequestSha256,
  requiredReceiptQueryIds,
  selectStableTags,
  workTrackingIssueNumbers,
  canonicalJson,
  planManagedSlideRefresh,
  validateSlideModel,
  buildSyntheticModel,
  readJson,
  slideModelSchemaPath,
  syntheticFixtureInputs,
  rehashModel,
  publicationCodes,
  rehashSnapshot,
  rehashSnapshotReceipt,
  addSyntheticRoadmapEpic,
  addSyntheticPresentationMappedEpic,
  addSyntheticRoadmapMilestone,
  finalizeSyntheticRoadmap,
  buildFourMilestoneModel,
} from "./model-test-support";

describe("NemoClaw product slide source and model contracts", () => {
  it("refreshes alternating repeated roadmap instances in contract order", () => {
    const replacements = [
      {
        id: "new-executive-1",
        managedRole: "roadmap-executive" as const,
        managedInstanceId: "roadmap-executive.1",
      },
      {
        id: "new-capability-1",
        managedRole: "roadmap-capability" as const,
        managedInstanceId: "roadmap-capability.1",
      },
      {
        id: "new-executive-2",
        managedRole: "roadmap-executive" as const,
        managedInstanceId: "roadmap-executive.2",
      },
      {
        id: "new-capability-2",
        managedRole: "roadmap-capability" as const,
        managedInstanceId: "roadmap-capability.2",
      },
      { id: "new-markitecture", managedRole: "markitecture" as const },
      { id: "new-weekly", managedRole: "weekly-release" as const },
    ];
    const result = planManagedSlideRefresh({
      slides: [
        { id: "title" },
        ...replacements.map((slide) => ({ ...slide, id: `old-${slide.id}` })),
        { id: "appendix" },
      ],
      replacements,
      insertionIndex: 1,
    });

    expect(result.map((slide) => slide.id)).toEqual([
      "title",
      ...replacements.map((slide) => slide.id),
      "appendix",
    ]);
    expect(() =>
      planManagedSlideRefresh({
        slides: [],
        replacements: [
          replacements[0],
          replacements[2],
          replacements[1],
          replacements[3],
          replacements[4],
          replacements[5],
        ],
        insertionIndex: 0,
      }),
    ).toThrow(/malformed managed slide order/u);
    expect(() =>
      planManagedSlideRefresh({
        slides: [],
        replacements: replacements.map((slide, index) =>
          index === 2 ? { ...slide, managedInstanceId: "roadmap-executive.1" } : slide,
        ),
        insertionIndex: 0,
      }),
    ).toThrow(/Duplicate managed slide instance/u);
    expect(() =>
      planManagedSlideRefresh({
        slides: [],
        replacements: replacements.map(
          ({ managedInstanceId: _managedInstanceId, ...slide }) => slide,
        ),
        insertionIndex: 0,
      }),
    ).toThrow(/identify every repeated managed roadmap slide instance/u);
  });

  it("canonicalizes object keys while preserving semantic array order", () => {
    expect(canonicalJson({ z: 1, a: ["second", "first"], nested: { y: 2, x: 1 } })).toBe(
      '{"a":["second","first"],"nested":{"x":1,"y":2},"z":1}\n',
    );
  });

  it("records complete multi-page collection evidence", () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `node-${index}`,
    }));
    const result = paginateConnection({
      source: "synthetic",
      queryId: "items",
      query: "query Items",
      scope: { owner: "NVIDIA", name: "NemoClaw", milestoneNumber: 7 },
      startedAt: "2026-08-13T12:00:00.000Z",
      fetchPage: (cursor) =>
        cursor === null
          ? {
              nodes: firstPage,
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              totalCount: 101,
            }
          : {
              nodes: [{ id: "node-100" }],
              pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
              totalCount: 101,
            },
    });

    expect(result.nodes).toHaveLength(101);
    expect(result.receipt).toMatchObject({
      pageCount: 2,
      itemCount: 101,
      declaredTotalCount: 101,
      finalCursor: "cursor-2",
      terminalHasNextPage: false,
      termination: "exhausted",
      scope: { owner: "NVIDIA", name: "NemoClaw", milestoneNumber: 7 },
    });
    expect(result.receipt.requestSha256).toBe(
      receiptRequestSha256(result.receipt.querySha256, result.receipt.scope),
    );
  });

  it("rejects missing and repeated pagination cursors", () => {
    expect(() =>
      paginateConnection({
        source: "synthetic",
        queryId: "missing-cursor",
        query: "query Missing",
        fetchPage: () => ({
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: null },
        }),
      }),
    ).toThrow(/no end cursor/u);

    expect(() =>
      paginateConnection({
        source: "synthetic",
        queryId: "repeated-cursor",
        query: "query Repeated",
        fetchPage: () => ({
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "same" },
        }),
      }),
    ).toThrow(/repeated cursor/u);
  });

  it("uses native progress evidence and Unknown for no children", () => {
    expect(
      normalizeProgress([
        { nodeId: "one", state: "CLOSED" },
        { nodeId: "two", state: "OPEN" },
        { nodeId: "three", state: "CLOSED" },
        { nodeId: "four", state: "OPEN" },
        { nodeId: "one", state: "CLOSED" },
      ]),
    ).toEqual({ completed: 2, total: 4, percentage: 50 });
    expect(normalizeProgress([])).toBe("Unknown");
  });

  it("extracts only explicit Outcome and Work Tracking sections", () => {
    const body = [
      "# Context",
      "Ignore #900 here.",
      "## Outcome",
      "Deliver a concise operator result.",
      "## Work Tracking",
      "- #101",
      "- https://github.com/NVIDIA/NemoClaw/issues/102",
      "- https://github.com/another/repo/issues/103",
      "## Notes",
      "Ignore #104 here.",
    ].join("\n");
    expect(extractOutcome(body)).toBe("Deliver a concise operator result.");
    expect(workTrackingIssueNumbers(body)).toEqual([101, 102]);
  });

  it("selects only identity-bound unmilestoned Epics with an eligible presentation milestone", () => {
    const milestone = {
      id: "M_SYNTHETIC_Q3",
      number: 7,
      title: "Roadmap: Q3 2026",
      description: null,
      dueOn: "2026-09-30T00:00:00.000Z",
      state: "OPEN" as const,
      closedAt: null,
      url: "https://github.com/NVIDIA/NemoClaw/milestone/7",
    };
    const openEpics = [9816, 9817].map((issueNumber) => ({
      id: `E_SYNTHETIC_${String(issueNumber)}`,
      number: issueNumber,
      title: `Epic ${String(issueNumber)}`,
      state: "OPEN" as const,
      url: `https://github.com/NVIDIA/NemoClaw/issues/${String(issueNumber)}`,
      closedAt: null,
      issueType: { id: "IT_EPIC", name: "Epic" },
      milestone: null,
    }));
    const resolved = presentationMappedUnmilestonedEpics(
      openEpics,
      [
        {
          epicNodeId: openEpics[0].id,
          issueNumber: openEpics[0].number,
          presentationMilestoneNodeId: milestone.id,
        },
        {
          epicNodeId: openEpics[1].id,
          issueNumber: openEpics[1].number,
          presentationMilestoneNodeId: "M_UNKNOWN",
        },
      ],
      [milestone],
    );

    expect(resolved.map(({ issue }) => issue.number)).toEqual([9816]);
  });

  it("uses a half-open seven-day interval", () => {
    const start = "2026-08-06T12:00:00.000Z";
    const end = "2026-08-13T12:00:00.000Z";
    expect(inHalfOpenWindow(start, start, end)).toBe(true);
    expect(inHalfOpenWindow("2026-08-13T11:59:59.999Z", start, end)).toBe(true);
    expect(inHalfOpenWindow(end, start, end)).toBe(false);
    expect(inHalfOpenWindow("2026-08-06T11:59:59.999Z", start, end)).toBe(false);
  });

  it("selects only stable tags and matches exact Announcement tokens", () => {
    const tags = [
      ["v1.2.3", "2026-08-12T00:00:00Z"],
      ["v1.2.3-rc.1", "2026-08-13T00:00:00Z"],
      ["latest", "2026-08-13T00:00:00Z"],
      ["v1.2.2", "2026-08-01T00:00:00Z"],
    ].map(([name, publishedAt]) => ({
      name,
      publishedAt,
      commitDate: publishedAt,
      commitSha: "a".repeat(40),
      tagObjectId: `tag-${name}`,
      url: `https://github.com/NVIDIA/NemoClaw/releases/tag/${name}`,
      peeled: true,
    }));
    expect(selectStableTags(tags, 5).map((tag) => tag.name)).toEqual(["v1.2.3", "v1.2.2"]);
    const discussions = [
      { title: "NemoClaw v1.2.30", body: "A different release." },
      { title: "NemoClaw v1.2.3", body: "The exact stable release." },
      {
        title: "NemoClaw v1.2.3+cuda",
        body: "A SemVer build variant, not the exact release.",
      },
    ];
    expect(exactAnnouncementMatches("v1.2.3", discussions)).toEqual([discussions[1]]);
  });

  it("builds a valid four-role model in the supplied milestone order", () => {
    const model = buildSyntheticModel();
    const schema = JSON.parse(fs.readFileSync(slideModelSchemaPath, "utf8"));
    const result = validateSlideModel(model, schema, "preview");
    const slides = model.slides as Array<Record<string, unknown>>;

    expect(result).toMatchObject({ valid: true, publicationEligible: true });
    expect(slides.map((slide) => slide.role)).toEqual([
      "roadmap-executive",
      "roadmap-capability",
      "markitecture",
      "weekly-release",
    ]);
    expect(
      (slides[0].milestones as Array<Record<string, unknown>>).map((milestone) => milestone.title),
    ).toEqual(["Window Three", "Window One", "Window Two"]);
    const executive = slides[0];
    const presentedEpicCount = (
      executive.milestones as Array<{ outcomes: Array<{ text: string }> }>
    ).reduce((count, milestone) => count + milestone.outcomes.length, 0);
    expect(executive.title).toBe("NemoClaw Feature Roadmap");
    expect(slides[1].title).toBe("NemoClaw Feature Roadmap");
    expect(executive.summary).toBe(
      `${presentedEpicCount} native GitHub Epics shown across 3 eligible milestone delivery windows.`,
    );
    expect(presentedEpicCount).toBe(6);
    const executiveItems = (
      executive.milestones as Array<{
        outcomes: Array<{ issueNumber: number; featureTitle: string; text: string }>;
      }>
    ).flatMap((milestone) => milestone.outcomes);
    const matrixItems = (
      slides[1].cells as Array<{ items: Array<{ issueNumber: number; title: string }> }>
    ).flatMap((cell) => cell.items);
    expect(matrixItems.map((item) => item.issueNumber).sort((left, right) => left - right)).toEqual(
      [101, 102, 103, 104, 105, 106],
    );
    expect(
      matrixItems.map((item) => [
        item.issueNumber,
        item.title,
        executiveItems.find((outcome) => outcome.issueNumber === item.issueNumber)?.featureTitle,
      ]),
    ).toEqual(matrixItems.map((item) => [item.issueNumber, item.title, item.title]));
    executiveItems.forEach((outcome) => {
      expect(JSON.stringify(slides[1])).not.toContain(outcome.text);
    });
    expect(
      (slides[1].sources as Array<Record<string, unknown>>).find(
        (source) => source.sourceId === "mapping.roadmap-presentation",
      ),
    ).toMatchObject({ kind: "mapping", path: "runtime/presentation-map.json" });
    const weekly = slides[3];
    expect(weekly.title).toMatch(
      /^NemoClaw Weekly Executive Scorecard \| [A-Z][a-z]{2} \d{1,2}–\d{1,2}, 2026$/u,
    );
    expect(weekly.releaseContext).toBe("1 stable release this window.");
    expect(
      (weekly.milestoneRows as Array<Record<string, unknown>>).map((row) => row.title),
    ).toEqual(["Window Three", "Window One", "Window Two"]);
    expect(weekly.managedNotes).toContain("milestone_report_observed_at=2026-08-12T12:00:00.000Z");
    expect(weekly.managedNotes).toContain("milestone_rows=Window Three | Window One | Window Two");
    expect(
      (executive.milestones as Array<{ outcomes: Array<{ text: string }> }>).flatMap((milestone) =>
        milestone.outcomes.map((outcome) => outcome.text),
      ),
    ).not.toEqual(expect.arrayContaining([expect.stringContaining("…")]));
    expect(canonicalJson(model).endsWith("\n")).toBe(true);
  });

  it("source-binds an owner-reviewed unmilestoned Epic to one presentation milestone", () => {
    const inputs = syntheticFixtureInputs();
    addSyntheticPresentationMappedEpic({
      snapshot: inputs.snapshot,
      presentation: inputs.presentation,
      milestoneIndex: 0,
      issueNumber: 9816,
    });
    finalizeSyntheticRoadmap(inputs.snapshot);

    const model = buildSyntheticModel({
      snapshot: inputs.snapshot,
      presentation: inputs.presentation,
      narrative: inputs.narrative,
    });
    const result = validateSlideModel(
      model,
      readJson<Record<string, unknown>>(slideModelSchemaPath),
      "publish",
    );
    const slides = model.slides as Array<Record<string, unknown>>;
    const executive = slides.find((slide) => slide.role === "roadmap-executive");
    const weekly = slides.find((slide) => slide.role === "weekly-release");
    expect(executive, "Synthetic executive slide is missing").toBeDefined();
    expect(weekly, "Synthetic weekly slide is missing").toBeDefined();
    const targetMilestoneNodeId = String(
      (inputs.snapshot.milestones as Array<Record<string, unknown>>)[0].nodeId,
    );
    const executiveMilestone = (executive!.milestones as Array<Record<string, unknown>>).find(
      (milestone) => milestone.milestoneNodeId === targetMilestoneNodeId,
    );
    const weeklyRow = (weekly!.milestoneRows as Array<Record<string, unknown>>).find(
      (row) => row.milestoneNodeId === targetMilestoneNodeId,
    );
    const mappedEpic = (inputs.snapshot.epics as Array<Record<string, unknown>>).find(
      (epic) => epic.issueNumber === 9816,
    );
    const receiptIds = (
      (inputs.snapshot.collection as Record<string, unknown>).receipts as Array<
        Record<string, unknown>
      >
    ).map((receipt) => receipt.queryId);

    expect(result).toMatchObject({ valid: true, publicationEligible: true });
    expect(mappedEpic).toMatchObject({ milestoneNodeId: null, state: "OPEN" });
    expect(
      (executiveMilestone?.outcomes as Array<Record<string, unknown>>).map(
        (outcome) => outcome.issueNumber,
      ),
    ).toContain(9816);
    expect(
      (weeklyRow?.updates as Array<Record<string, unknown>>).find(
        (update) => update.epicNodeId === mappedEpic?.nodeId,
      ),
    ).toMatchObject({
      epicBodySha256: mappedEpic?.bodySha256,
      label: "Kubernetes In-Cluster",
    });
    expect(receiptIds).toEqual(requiredReceiptQueryIds(inputs.snapshot as never));
    expect(receiptIds.indexOf("issue-9816-subissues")).toBeLessThan(
      receiptIds.indexOf("work-tracking-issues"),
    );
    expect(publicationCodes(model)).toEqual([]);
  });

  it("paginates four eligible milestones into two complete roadmap slide pairs", () => {
    const model = buildFourMilestoneModel();
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const slides = model.slides as Array<Record<string, unknown>>;
    expect(slides.map((slide) => slide.role)).toEqual([
      "roadmap-executive",
      "roadmap-capability",
      "roadmap-executive",
      "roadmap-capability",
      "markitecture",
      "weekly-release",
    ]);
    expect(slides.slice(0, 4).map((slide) => slide.instanceId)).toEqual([
      "roadmap-executive.1",
      "roadmap-capability.1",
      "roadmap-executive.2",
      "roadmap-capability.2",
    ]);
    expect((slides[0].milestones as unknown[]).length).toBe(3);
    expect((slides[2].milestones as unknown[]).length).toBe(1);
    expect(slides[2].summary).toBe(
      "1 native GitHub Epic shown across 1 eligible milestone delivery window. Page 2 of 2.",
    );
    expect(
      (slides[2].sources as Array<Record<string, unknown>>).map((source) => source.sourceId),
    ).toEqual(["github.epic.204", "github.milestone.4"]);
    const weekly = slides.find((slide) => slide.role === "weekly-release");
    expect(
      (weekly?.milestoneRows as Array<Record<string, unknown>>).map((row) => row.milestoneNodeId),
    ).toEqual(["M_SYNTHETIC_3", "M_SYNTHETIC_1", "M_SYNTHETIC_2"]);
    expect(validateSlideModel(model, schema, "publish")).toMatchObject({
      valid: true,
      publicationEligible: true,
    });
  });

  it("rejects a rehashed capability slide with any other title", () => {
    const model = buildSyntheticModel();
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const capability = (model.slides as Array<Record<string, unknown>>).find(
      (slide) => slide.role === "roadmap-capability",
    );
    expect(capability).toBeDefined();
    capability!.title = "NemoClaw roadmap capability matrix";
    rehashModel(model);

    const result = validateSlideModel(model, schema, "publish");

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_INVALID" }),
        expect.objectContaining({ code: "CAPABILITY_TITLE_INVALID" }),
      ]),
    );
  });

  it("paginates seven eligible milestones into three ordered roadmap slide pairs", () => {
    const { presentation, snapshot } = syntheticFixtureInputs();
    [4, 5, 6, 7].forEach((number) => {
      addSyntheticRoadmapMilestone({
        snapshot,
        number,
        nodeId: `M_SYNTHETIC_${String(number)}`,
        title: `Roadmap: Window ${String(number)}`,
        displayTitle: `Window ${String(number)}`,
      });
      addSyntheticRoadmapEpic({
        snapshot,
        presentation,
        milestoneIndex: number - 1,
        issueNumber: 200 + number,
        roadmapArea: "Agent Features",
        displayOrder: 200 + number,
      });
    });
    finalizeSyntheticRoadmap(snapshot);

    const model = buildSyntheticModel({ snapshot, presentation });
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const slides = model.slides as Array<Record<string, unknown>>;
    expect(slides.map((slide) => slide.instanceId ?? slide.role)).toEqual([
      "roadmap-executive.1",
      "roadmap-capability.1",
      "roadmap-executive.2",
      "roadmap-capability.2",
      "roadmap-executive.3",
      "roadmap-capability.3",
      "markitecture",
      "weekly-release",
    ]);
    expect(
      slides
        .filter((slide) => slide.role === "roadmap-executive")
        .map((slide) => (slide.milestones as unknown[]).length),
    ).toEqual([3, 3, 1]);
    expect(slides[4].summary).toBe(
      "1 native GitHub Epic shown across 1 eligible milestone delivery window. Page 3 of 3.",
    );
    expect(
      (slides[4].sources as Array<Record<string, unknown>>).map((source) => source.sourceId),
    ).toEqual(["github.epic.207", "github.milestone.7"]);
    const weekly = slides.find((slide) => slide.role === "weekly-release");
    expect(
      (weekly?.milestoneRows as Array<Record<string, unknown>>).map((row) => row.milestoneNodeId),
    ).toEqual(["M_SYNTHETIC_3", "M_SYNTHETIC_1", "M_SYNTHETIC_2"]);
    expect(validateSlideModel(model, schema, "publish")).toMatchObject({
      valid: true,
      publicationEligible: true,
    });
  });

  it("rejects a repeated native milestone identity across roadmap pages", () => {
    const model = buildFourMilestoneModel();
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const slides = model.slides as Array<Record<string, unknown>>;
    const firstExecutive = slides[0];
    const secondExecutive = slides[2];
    const firstMilestone = (firstExecutive.milestones as Array<Record<string, unknown>>)[0];
    const secondMilestone = (secondExecutive.milestones as Array<Record<string, unknown>>)[0];
    secondMilestone.url = firstMilestone.url;
    const firstMilestoneSource = (firstExecutive.sources as Array<Record<string, unknown>>).find(
      (source) => source.sourceId === "github.milestone.3",
    );
    expect(firstMilestoneSource).toBeDefined();
    [slides[2], slides[3]].forEach((slide) => {
      const sources = slide.sources as Array<Record<string, unknown>>;
      const sourceIndex = sources.findIndex((source) => source.sourceId === "github.milestone.4");
      expect(sourceIndex).toBeGreaterThanOrEqual(0);
      sources[sourceIndex] = structuredClone(firstMilestoneSource) as Record<string, unknown>;
      sources.sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId)));
    });
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ROADMAP_MILESTONE_COVERAGE_INVALID" }),
      ]),
    );
  });

  it("rejects an extra source even when managed notes repeat it", () => {
    const model = buildSyntheticModel();
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const executive = (model.slides as Array<Record<string, unknown>>)[0];
    (executive.sources as Array<Record<string, unknown>>).push({
      sourceId: "github.unexpected",
      kind: "github",
      url: "https://github.com/NVIDIA/NemoClaw",
      digest: "f".repeat(64),
    });
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ROADMAP_PAGE_SOURCE_SCOPE_INVALID" }),
      ]),
    );
  });

  it("rejects managed notes with content outside the exact source inventory", () => {
    const model = buildSyntheticModel();
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const executive = (model.slides as Array<Record<string, unknown>>)[0];
    executive.managedNotes = `${String(executive.managedNotes)}unexpected source\n`;

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MANAGED_NOTES_INVALID" })]),
    );
  });

  it("carries exact due dates and Active status for eligible milestones", () => {
    const model = buildSyntheticModel();
    const slides = model.slides as Array<Record<string, unknown>>;
    const executiveMilestone = (slides[0].milestones as Array<Record<string, unknown>>)[0];
    const capabilityColumn = (slides[1].columns as Array<Record<string, unknown>>)[0];
    expect(executiveMilestone).toMatchObject({
      dueOn: "2026-09-01T00:00:00.000Z",
      status: { state: "open", label: "Active" },
    });
    expect(capabilityColumn).toMatchObject({
      dueOn: executiveMilestone.dueOn,
      status: executiveMilestone.status,
    });
  });

  it("retains a closed Epic in its eligible milestone with exact completion evidence", () => {
    const model = buildSyntheticModel();
    const slides = model.slides as Array<Record<string, unknown>>;
    const outcome = (slides[0].milestones as Array<{ outcomes: Array<Record<string, unknown>> }>)
      .flatMap((milestone) => milestone.outcomes)
      .find((candidate) => candidate.issueNumber === 103);
    const capabilityItem = (slides[1].cells as Array<{ items: Array<Record<string, unknown>> }>)
      .flatMap((cell) => cell.items)
      .find((candidate) => candidate.issueNumber === 103);

    expect(outcome).toMatchObject({
      state: "CLOSED",
      closedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(capabilityItem).toMatchObject({
      state: "CLOSED",
      closedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(publicationCodes(model)).not.toContain("EPIC_LIFECYCLE_INVALID");
  });

  it("retains an Epic closed during collection using its exact native completion evidence", () => {
    const { snapshot } = syntheticFixtureInputs();
    const epic = (snapshot.epics as Array<Record<string, unknown>>).find(
      (candidate) => candidate.issueNumber === 103,
    );
    expect(epic).toBeDefined();
    epic!.closedAt = "2026-08-13T12:00:00.001Z";
    const receipt = (
      (snapshot.collection as Record<string, unknown>).receipts as Array<Record<string, unknown>>
    ).find((candidate) => candidate.queryId === "milestone-1-issues");
    const sourceRecord = (
      receipt?.sourceRecords as Array<Record<string, unknown>> | undefined
    )?.find((candidate) => candidate.number === 103);
    expect(sourceRecord).toBeDefined();
    sourceRecord!.closedAt = epic!.closedAt;
    rehashSnapshotReceipt(snapshot, "milestone-1-issues");

    const model = buildSyntheticModel({ snapshot });
    const outcome = (
      (model.slides as Array<Record<string, unknown>>)[0].milestones as Array<{
        outcomes: Array<Record<string, unknown>>;
      }>
    )
      .flatMap((milestone) => milestone.outcomes)
      .find((candidate) => candidate.issueNumber === 103);

    expect(outcome).toMatchObject({
      state: "CLOSED",
      closedAt: "2026-08-13T12:00:00.001Z",
    });
    expect(publicationCodes(model)).not.toContain("EPIC_LIFECYCLE_INVALID");
  });

  it("includes every selected Epic without slicing an executive milestone", () => {
    const { snapshot } = syntheticFixtureInputs();
    const milestones = snapshot.milestones as Array<Record<string, unknown>>;
    const firstMilestoneNodeId = milestones[0].nodeId;
    (snapshot.epics as Array<Record<string, unknown>>).forEach((epic) => {
      epic.milestoneNodeId = firstMilestoneNodeId;
    });
    rehashSnapshot(snapshot);

    const model = buildSyntheticModel({ snapshot });
    const executive = (model.slides as Array<Record<string, unknown>>)[0];
    const outcomes = (executive.milestones as Array<{ outcomes: unknown[] }>).map(
      (milestone) => milestone.outcomes.length,
    );

    expect(outcomes).toEqual([6, 0, 0]);
    expect(executive.summary).toBe(
      "6 native GitHub Epics shown across 3 eligible milestone delivery windows.",
    );
    expect(publicationCodes(model)).not.toContain("ROADMAP_COLUMN_OVER_BUDGET");
  });

  it("builds every selected Epic into 6/6/2 milestone columns", () => {
    const { snapshot, presentation } = syntheticFixtureInputs();
    const additions = [
      [0, 201, "Usability and Onboarding"],
      [0, 202, "Agent Features"],
      [0, 203, "Acceleration and Optimization"],
      [0, 204, "Integrations and Blueprints"],
      [1, 205, "Usability and Onboarding"],
      [1, 206, "Usability and Onboarding"],
      [1, 207, "Agent Features"],
      [1, 208, "Agent Features"],
    ] as const;
    additions.forEach(([milestoneIndex, issueNumber, roadmapArea], index) => {
      addSyntheticRoadmapEpic({
        snapshot,
        presentation,
        milestoneIndex,
        issueNumber,
        roadmapArea,
        displayOrder: 100 + index,
      });
    });
    finalizeSyntheticRoadmap(snapshot);

    const model = buildSyntheticModel({ snapshot, presentation });
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const slides = model.slides as Array<Record<string, unknown>>;
    const executive = slides[0];
    const counts = (executive.milestones as Array<{ outcomes: unknown[] }>).map(
      (milestone) => milestone.outcomes.length,
    );

    expect(counts).toEqual([6, 6, 2]);
    expect(executive.summary).toBe(
      "14 native GitHub Epics shown across 3 eligible milestone delivery windows.",
    );
    expect(validateSlideModel(model, schema, "publish")).toMatchObject({
      valid: true,
      publicationEligible: true,
    });
  });

  it("retains three short Epic labels in one capability cell", () => {
    const { snapshot, presentation } = syntheticFixtureInputs();
    [201, 202].forEach((issueNumber, index) => {
      addSyntheticRoadmapEpic({
        snapshot,
        presentation,
        milestoneIndex: 0,
        issueNumber,
        roadmapArea: "Usability and Onboarding",
        displayOrder: 100 + index,
      });
    });
    finalizeSyntheticRoadmap(snapshot);

    const model = buildSyntheticModel({ snapshot, presentation });
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const matrix = (model.slides as Array<Record<string, unknown>>)[1];
    const cell = (matrix.cells as Array<Record<string, unknown>>).find(
      (candidate) =>
        candidate.milestoneNodeId === "M_SYNTHETIC_3" &&
        candidate.roadmapArea === "Usability and Onboarding",
    );

    expect((cell?.items as unknown[]).length).toBe(3);
    expect(publicationCodes(model)).not.toContain("MATRIX_CELL_OVER_BUDGET");
    expect(validateSlideModel(model, schema, "publish")).toMatchObject({
      valid: true,
      publicationEligible: true,
    });
  });

  it("retains four Epic labels but fails closed when one capability cell exceeds its layout", () => {
    const { snapshot, presentation } = syntheticFixtureInputs();
    [201, 202, 203].forEach((issueNumber, index) => {
      addSyntheticRoadmapEpic({
        snapshot,
        presentation,
        milestoneIndex: 0,
        issueNumber,
        roadmapArea: "Usability and Onboarding",
        displayOrder: 100 + index,
      });
    });
    finalizeSyntheticRoadmap(snapshot);

    const model = buildSyntheticModel({ snapshot, presentation });
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const [executive, matrix] = model.slides as Array<Record<string, unknown>>;
    const cell = (matrix.cells as Array<Record<string, unknown>>).find(
      (candidate) =>
        candidate.milestoneNodeId === "M_SYNTHETIC_3" &&
        candidate.roadmapArea === "Usability and Onboarding",
    );

    expect((cell?.items as unknown[]).length).toBe(4);
    expect(
      (executive.milestones as Array<{ outcomes: unknown[] }>).reduce(
        (count, milestone) => count + milestone.outcomes.length,
        0,
      ),
    ).toBe(9);
    expect(publicationCodes(model)).toContain("MATRIX_CELL_OVER_BUDGET");
    expect(validateSlideModel(model, schema, "publish").valid).toBe(false);
  });
});
