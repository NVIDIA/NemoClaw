// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  validateSlideModel,
  buildSyntheticModel,
  readJson,
  slideModelSchemaPath,
  syntheticFixtureInputs,
  rehashModel,
  publicationCodes,
  rehashSnapshot,
  rehashSnapshotReceipt,
  addSyntheticInWindowReleases,
  makeSyntheticReleaseAnnouncementAmbiguous,
  buildWithFirstPresentationSummary,
} from "./model-test-support";

describe("NemoClaw product slide source and model contracts", () => {
  it.each([
    [
      "two-word label",
      "Guided onboarding",
      "Start agents in OpenShell sandboxes with fewer manual steps.",
    ],
    [
      "four-word label",
      "Guided agent setup path",
      "Start agents in OpenShell sandboxes with fewer manual steps.",
    ],
    ["three-word context", "Guided onboarding", "Use OpenShell sandboxes."],
    [
      "ten-word context",
      "Guided onboarding",
      "Run agents in OpenShell sandboxes on each approved host today.",
    ],
  ])("accepts the %s boundary", (_name, displayTitle, shortenedOutcome) => {
    const model = buildWithFirstPresentationSummary(displayTitle, shortenedOutcome);
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);

    expect(publicationCodes(model)).not.toContain("EPIC_PRESENTATION_SUMMARY_INVALID");
    expect(validateSlideModel(model, schema, "publish")).toMatchObject({
      valid: true,
      publicationEligible: true,
    });
  });

  it.each([
    [
      "one-word label",
      "Onboarding",
      "Start agents in OpenShell sandboxes with fewer manual steps.",
    ],
    [
      "five-word label",
      "Guided OpenShell enterprise agent onboarding",
      "Start agents in OpenShell sandboxes with fewer manual steps.",
    ],
    ["two-word context", "Guided onboarding", "Use seccomp."],
    [
      "eleven-word context",
      "Guided onboarding",
      "Run agents in OpenShell sandboxes on each approved host with guidance.",
    ],
  ])("rejects the %s boundary", (_name, displayTitle, shortenedOutcome) => {
    const model = buildWithFirstPresentationSummary(displayTitle, shortenedOutcome);

    expect(publicationCodes(model)).toContain("EPIC_PRESENTATION_SUMMARY_INVALID");
    const executive = (model.slides as Array<Record<string, unknown>>)[0];
    const outcome = (executive.milestones as Array<{ outcomes: Array<Record<string, unknown>> }>)
      .flatMap((milestone) => milestone.outcomes)
      .find((candidate) => candidate.issueNumber === 101);
    expect(outcome).toMatchObject({
      featureTitle: "Needs summary",
      text: "Review the Epic body recorded in the snapshot.",
    });
  });

  it("accepts 90 characters and rejects 91 across the complete executive row", () => {
    const displayTitle = "Guided onboarding";
    const contextPrefix = "Deliver with OpenShell sandbox controls ";
    const separatorLength = `${displayTitle}: `.length;
    const contextAt90 = `${contextPrefix}${"x".repeat(90 - separatorLength - contextPrefix.length)}`;
    const contextAt91 = `${contextPrefix}${"x".repeat(91 - separatorLength - contextPrefix.length)}`;
    expect(`${displayTitle}: ${contextAt90}`).toHaveLength(90);
    expect(`${displayTitle}: ${contextAt91}`).toHaveLength(91);

    const accepted = buildWithFirstPresentationSummary(displayTitle, contextAt90);
    expect(publicationCodes(accepted)).not.toContain("EPIC_PRESENTATION_SUMMARY_INVALID");

    const rejected = buildWithFirstPresentationSummary(displayTitle, contextAt91);
    expect(publicationCodes(rejected)).toContain("EPIC_PRESENTATION_SUMMARY_INVALID");
  });

  it("counts the completed checkmark prefix in the 90-character executive row budget", () => {
    const buildCompletedSummary = (totalLength: number): Record<string, unknown> => {
      const { presentation, snapshot } = syntheticFixtureInputs();
      const epic = (snapshot.epics as Array<Record<string, unknown>>).find(
        (candidate) => candidate.issueNumber === 103,
      );
      const entry = (presentation.epics as Array<Record<string, unknown>>).find(
        (candidate) => candidate.issueNumber === 103,
      );
      expect(epic).toBeDefined();
      expect(entry).toBeDefined();
      const displayTitle = "Agent routing";
      const contextPrefix = "Deliver routing ";
      const fixedLength = `✓ ${displayTitle}: ${contextPrefix}`.length;
      entry!.displayTitle = displayTitle;
      entry!.shortenedOutcome = `${contextPrefix}${"x".repeat(totalLength - fixedLength)}`;
      entry!.boundBodySha256 = epic!.bodySha256;
      return buildSyntheticModel({ presentation, snapshot });
    };

    expect(publicationCodes(buildCompletedSummary(90))).not.toContain(
      "EPIC_PRESENTATION_SUMMARY_INVALID",
    );
    expect(publicationCodes(buildCompletedSummary(91))).toContain(
      "EPIC_PRESENTATION_SUMMARY_INVALID",
    );
  });

  it("blocks a presentation row over 90 characters without using source prose", () => {
    const { presentation, snapshot } = syntheticFixtureInputs();
    const firstEpic = (snapshot.epics as Array<Record<string, unknown>>)[0];
    const entry = (presentation.epics as Array<Record<string, unknown>>).find(
      (candidate) => candidate.epicNodeId === firstEpic.nodeId,
    );
    expect(entry).toBeDefined();
    const overlongOutcome =
      "Describe the complete reviewed onboarding outcome with enough added words here.";
    Object.assign(entry as Record<string, unknown>, {
      shortenedOutcome: overlongOutcome,
      boundBodySha256: firstEpic.bodySha256,
    });

    const model = buildSyntheticModel({ presentation, snapshot });
    const executive = (model.slides as Array<Record<string, unknown>>)[0];
    const rendered = (
      executive.milestones as Array<{ outcomes: Array<{ epicNodeId: string; text: string }> }>
    )
      .flatMap((milestone) => milestone.outcomes)
      .find((outcome) => outcome.epicNodeId === firstEpic.nodeId);

    expect(rendered).toMatchObject({
      featureTitle: "Needs summary",
      text: "Review the Epic body recorded in the snapshot.",
    });
    expect(rendered?.text).not.toBe(firstEpic.outcome);
    expect(publicationCodes(model)).toContain("EPIC_PRESENTATION_SUMMARY_INVALID");
  });

  it("rejects a rehashed model whose executive row exceeds 90 characters", () => {
    const model = buildSyntheticModel();
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const executive = (model.slides as Array<Record<string, unknown>>)[0];
    const rendered = (executive.milestones as Array<{ outcomes: Array<Record<string, unknown>> }>)
      .flatMap((milestone) => milestone.outcomes)
      .find((outcome) => outcome.issueNumber === 101);
    expect(rendered).toBeDefined();
    rendered!.featureTitle = "Guided onboarding workflow plan";
    rendered!.text =
      "Deliver repeatable OpenShell sandbox deployment workflows for every approved environment.";
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EXECUTIVE_ROW_LENGTH_INVALID" })]),
    );
  });

  it("keeps a summarized Epic without an area visible as unclassified", () => {
    const { presentation } = syntheticFixtureInputs();
    const entry = (presentation.epics as Array<Record<string, unknown>>)[0];
    delete entry.roadmapArea;
    const model = buildSyntheticModel({ presentation });
    const matrix = (model.slides as Array<Record<string, unknown>>)[1];
    const unclassified = matrix.unclassified as Array<Record<string, unknown>>;
    const executive = (model.slides as Array<Record<string, unknown>>)[0];
    const outcome = (executive.milestones as Array<{ outcomes: Array<Record<string, unknown>> }>)
      .flatMap((milestone) => milestone.outcomes)
      .find((candidate) => candidate.issueNumber === 101);
    const publication = model.publication as Record<string, unknown>;

    expect(outcome).toMatchObject({
      featureTitle: "Guided onboarding",
      text: "Start agents in OpenShell sandboxes with fewer manual steps.",
    });
    expect(unclassified[0].title).toBe("Guided onboarding");
    expect(unclassified[0]).toMatchObject({ state: "OPEN", closedAt: null });
    expect(publication.eligible).toBe(false);
    expect(publication.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EPIC_NEEDS_CLASSIFICATION" })]),
    );
  });

  it("keeps an Epic with missing presentation metadata visible without source fallback", () => {
    const { presentation, snapshot } = syntheticFixtureInputs();
    const firstEpic = (snapshot.epics as Array<Record<string, unknown>>)[0];
    presentation.epics = (presentation.epics as Array<Record<string, unknown>>).slice(1);
    const model = buildSyntheticModel({ presentation, snapshot });
    const [executive, matrix] = model.slides as Array<Record<string, unknown>>;
    const outcome = (executive.milestones as Array<{ outcomes: Array<Record<string, unknown>> }>)
      .flatMap((milestone) => milestone.outcomes)
      .find((candidate) => candidate.issueNumber === 101);
    const unclassified = matrix.unclassified as Array<Record<string, unknown>>;

    expect(outcome).toMatchObject({
      featureTitle: "Needs summary",
      text: "Review the Epic body recorded in the snapshot.",
    });
    expect(`${String(outcome?.featureTitle)}: ${String(outcome?.text)}`).not.toContain(
      String(firstEpic.outcome),
    );
    expect(unclassified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ issueNumber: 101, title: "Needs summary" }),
      ]),
    );
    expect(publicationCodes(model)).toEqual(
      expect.arrayContaining(["EPIC_PRESENTATION_SUMMARY_MISSING", "EPIC_NEEDS_CLASSIFICATION"]),
    );
  });

  it("blocks an unselected Epic row in the runtime presentation map", () => {
    const { presentation, snapshot } = syntheticFixtureInputs();
    (presentation.epics as Array<Record<string, unknown>>).push({
      epicNodeId: "E_SYNTHETIC_UNSELECTED",
      issueNumber: 999,
      displayTitle: "Unused summary",
      shortenedOutcome: "Describe one unselected synthetic Epic.",
      boundBodySha256: "f".repeat(64),
      roadmapArea: "Agent Features",
      displayOrder: 999,
    });

    expect(publicationCodes(buildSyntheticModel({ presentation, snapshot }))).toContain(
      "PRESENTATION_MAPPING_UNSELECTED_EPIC",
    );
  });

  it("derives each milestone focus from the dominant reviewed roadmap area", () => {
    const model = buildSyntheticModel();
    const executive = (model.slides as Array<Record<string, unknown>>)[0];
    const focuses = (executive.milestones as Array<Record<string, unknown>>).map(
      (milestone) => milestone.focus,
    );

    expect(focuses).toEqual([
      "Usability and Onboarding",
      "Acceleration and Optimization",
      "Usability and Onboarding",
    ]);
  });

  it("rejects an omitted or duplicated selected Epic after model rehashing", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const omitted = buildSyntheticModel();
    const omittedExecutive = (omitted.slides as Array<Record<string, unknown>>)[0];
    const omittedMilestones = omittedExecutive.milestones as Array<Record<string, unknown>>;
    (omittedMilestones[0].outcomes as Array<Record<string, unknown>>).pop();
    omittedExecutive.summary =
      "5 native GitHub Epics shown across 3 eligible milestone delivery windows.";
    rehashModel(omitted);
    expect(validateSlideModel(omitted, schema, "publish").errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MATRIX_EPIC_COVERAGE_INVALID" })]),
    );

    const duplicated = buildSyntheticModel();
    const duplicatedExecutive = (duplicated.slides as Array<Record<string, unknown>>)[0];
    const duplicatedMilestones = duplicatedExecutive.milestones as Array<Record<string, unknown>>;
    const outcomes = duplicatedMilestones[0].outcomes as Array<Record<string, unknown>>;
    outcomes.push({ ...structuredClone(outcomes[0]), contentId: "epic.duplicate.101" });
    duplicatedExecutive.summary =
      "7 native GitHub Epics shown across 3 eligible milestone delivery windows.";
    rehashModel(duplicated);
    expect(validateSlideModel(duplicated, schema, "publish").errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MATRIX_EPIC_COVERAGE_INVALID" })]),
    );
  });

  it("rejects a capability label that differs from its executive label", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const matrix = (model.slides as Array<Record<string, unknown>>)[1];
    const item = (matrix.cells as Array<{ items: Array<Record<string, unknown>> }>)
      .flatMap((cell) => cell.items)
      .find((candidate) => candidate.issueNumber === 101);
    expect(item).toBeDefined();
    item!.title = "Different onboarding";
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MATRIX_EPIC_LABEL_MISMATCH" })]),
    );
  });

  it("rejects a capability lifecycle that differs from its executive Epic", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const matrix = (model.slides as Array<Record<string, unknown>>)[1];
    const item = (matrix.cells as Array<{ items: Array<Record<string, unknown>> }>)
      .flatMap((cell) => cell.items)
      .find((candidate) => candidate.issueNumber === 103);
    expect(item).toBeDefined();
    item!.closedAt = null;
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MATRIX_EPIC_LIFECYCLE_MISMATCH" })]),
    );
  });

  it("rejects inconsistent completed-Epic state evidence in both roadmap roles", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const slides = model.slides as Array<Record<string, unknown>>;
    const outcome = (slides[0].milestones as Array<Record<string, unknown>>)
      .flatMap((milestone) => milestone.outcomes as Array<Record<string, unknown>>)
      .find((candidate) => candidate.issueNumber === 103);
    const item = (slides[1].cells as Array<{ items: Array<Record<string, unknown>> }>)
      .flatMap((cell) => cell.items)
      .find((candidate) => candidate.issueNumber === 103);
    expect(outcome).toBeDefined();
    expect(item).toBeDefined();
    outcome!.closedAt = null;
    item!.closedAt = null;
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EPIC_LIFECYCLE_INVALID" })]),
    );
  });

  it("rejects a completed Epic whose closedAt is not a real calendar date", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const slides = model.slides as Array<Record<string, unknown>>;
    const outcome = (slides[0].milestones as Array<Record<string, unknown>>)
      .flatMap((milestone) => milestone.outcomes as Array<Record<string, unknown>>)
      .find((candidate) => candidate.issueNumber === 103);
    const item = (slides[1].cells as Array<{ items: Array<Record<string, unknown>> }>)
      .flatMap((cell) => cell.items)
      .find((candidate) => candidate.issueNumber === 103);
    expect(outcome).toBeDefined();
    expect(item).toBeDefined();
    outcome!.closedAt = "2026-02-30T00:00:00.000Z";
    item!.closedAt = outcome!.closedAt;
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_INVALID" }),
        expect.objectContaining({ code: "EPIC_LIFECYCLE_INVALID" }),
      ]),
    );
  });

  it("rejects an active milestone whose due date is before the as-of calendar date", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const slides = model.slides as Array<Record<string, unknown>>;
    const executiveMilestone = (slides[0].milestones as Array<Record<string, unknown>>)[0];
    const capabilityColumn = (slides[1].columns as Array<Record<string, unknown>>)[0];
    executiveMilestone.dueOn = "2026-08-12T23:59:59.000Z";
    capabilityColumn.dueOn = executiveMilestone.dueOn;
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MILESTONE_STATUS_INVALID" })]),
    );
  });

  it("rejects an active milestone whose due date is not a real calendar date", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const slides = model.slides as Array<Record<string, unknown>>;
    const executiveMilestone = (slides[0].milestones as Array<Record<string, unknown>>)[0];
    const capabilityColumn = (slides[1].columns as Array<Record<string, unknown>>)[0];
    executiveMilestone.dueOn = "2026-02-30T00:00:00.000Z";
    capabilityColumn.dueOn = executiveMilestone.dueOn;
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_INVALID" }),
        expect.objectContaining({ code: "MILESTONE_STATUS_INVALID" }),
      ]),
    );
  });

  it("keeps four releases in the top cards without changing the three milestone rows", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const inputs = syntheticFixtureInputs();
    addSyntheticInWindowReleases(inputs.snapshot, 4);
    const model = buildSyntheticModel(inputs);
    const weekly = (model.slides as Array<Record<string, unknown>>)[3];

    expect(weekly.releaseContext).toBe("4 stable releases this window.");
    expect(weekly.milestoneRows as unknown[]).toHaveLength(3);
    expect(
      (weekly.metrics as Array<Record<string, unknown>>).find(
        (metric) => metric.contentId === "metric.latest-release",
      )?.value,
    ).toBe("v1.2.6");
    expect(validateSlideModel(model, schema, "publish")).toMatchObject({
      valid: true,
      publicationEligible: true,
    });
  });

  it("accepts partial release context when one release has ambiguous Announcement evidence", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const inputs = syntheticFixtureInputs();
    addSyntheticInWindowReleases(inputs.snapshot, 4);
    makeSyntheticReleaseAnnouncementAmbiguous(inputs.snapshot);
    const model = buildSyntheticModel(inputs);
    const weekly = (model.slides as Array<Record<string, unknown>>)[3];

    expect(weekly.releaseContext).toBe("4 stable; 3 validated Announcements.");
    expect(model.publication).toMatchObject({
      eligible: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "ANNOUNCEMENT_MATCH_INVALID" }),
      ]),
    });
    expect(validateSlideModel(model, schema, "preview")).toMatchObject({
      valid: true,
      publicationEligible: false,
    });
  });

  it("rejects a fourth weekly milestone row without changing roadmap pagination", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const weekly = (model.slides as Array<Record<string, unknown>>)[3];
    const seed = structuredClone((weekly.milestoneRows as Array<Record<string, unknown>>)[0]);
    seed.contentId = "weekly.milestone.synthetic-fourth";
    seed.milestoneNodeId = "M_SYNTHETIC_FOURTH";
    seed.title = "Window Four";
    seed.url = "https://github.com/NVIDIA/NemoClaw/milestone/4";
    (weekly.milestoneRows as Array<Record<string, unknown>>).push(seed);
    rehashModel(model);

    const result = validateSlideModel(model, schema, "publish");
    expect(result.publicationEligible).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "WEEKLY_MILESTONE_DENSITY_INVALID" }),
      ]),
    );
    expect(
      (model.slides as Array<Record<string, unknown>>).filter(
        (slide) => slide.role === "roadmap-executive",
      ),
    ).toHaveLength(1);
  });

  it("requires every Epic to be classified before publication", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const matrix = (model.slides as Array<Record<string, unknown>>)[1];
    const cells = matrix.cells as Array<Record<string, unknown>>;
    const sourceCell = cells.find((cell) =>
      (cell.items as Array<Record<string, unknown>>).some(
        (item) => item.url === "https://github.com/NVIDIA/NemoClaw/issues/101",
      ),
    );
    expect(sourceCell).toBeDefined();
    const requiredSourceCell = sourceCell as Record<string, unknown>;
    const [item] = requiredSourceCell.items as Array<Record<string, unknown>>;
    requiredSourceCell.items = [];
    matrix.unclassified = [
      {
        contentId: "unclassified.epic.101",
        milestoneNodeId: requiredSourceCell.milestoneNodeId,
        issueNumber: 101,
        title: String(item.title),
        url: item.url,
        state: item.state,
        closedAt: item.closedAt,
      },
    ];
    model.publication = { eligible: true, blockers: [], findings: [] };
    rehashModel(model);

    expect(validateSlideModel(model, schema, "preview")).toMatchObject({
      valid: true,
      publicationEligible: true,
    });
    const publish = validateSlideModel(model, schema, "publish");
    expect(publish.publicationEligible).toBe(false);
    expect(publish.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNCLASSIFIED_EPICS_PRESENT" })]),
    );
  });

  it("recomputes roadmap alignment, Epic coverage, progress, and weekly report bindings", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const slides = model.slides as Array<Record<string, unknown>>;
    const executive = slides[0];
    const matrix = slides[1];
    const weekly = slides[3];
    (matrix.columns as Array<Record<string, unknown>>)[0].focus = "Unbound focus";
    const outcome = (
      (executive.milestones as Array<Record<string, unknown>>)[0].outcomes as Array<
        Record<string, unknown>
      >
    )[0];
    outcome.progress = { completed: 2, total: 4, percentage: 25 };
    (
      (matrix.cells as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>
    )[0].url = "https://github.com/NVIDIA/NemoClaw/issues/999";
    weekly.releaseContext = "Stale release context.";
    const firstWeeklyRow = (weekly.milestoneRows as Array<Record<string, unknown>>)[0];
    firstWeeklyRow.title = "Stale milestone title";
    const secondWeeklyRow = (weekly.milestoneRows as Array<Record<string, unknown>>)[1];
    const secondWeeklyUpdate = (secondWeeklyRow.updates as Array<Record<string, unknown>>)[0];
    secondWeeklyUpdate.sourceDigest = "0".repeat(64);
    rehashModel(model);

    const result = validateSlideModel(model, schema, "publish");
    expect(result.publicationEligible).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "MATRIX_COLUMN_ALIGNMENT_INVALID",
        "MATRIX_EPIC_COVERAGE_INVALID",
        "PROGRESS_INVALID",
        "RELEASE_CONTEXT_INVALID",
        "WEEKLY_MILESTONE_IDENTITY_INVALID",
        "WEEKLY_REPORT_BINDING_INVALID",
      ]),
    );
  });

  it("requires evidence claims for every visible markitecture relationship", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const markitecture = (model.slides as Array<Record<string, unknown>>)[2];
    (markitecture.connectors as Array<Record<string, unknown>>)[0].claimId = "claim.missing";
    rehashModel(model);

    const result = validateSlideModel(model, schema, "publish");
    expect(result.publicationEligible).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MARKITECTURE_GRAPH_INVALID" })]),
    );
  });

  it("requires the documentation-bound gateway flow for inference and approved egress", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const markitecture = (model.slides as Array<Record<string, unknown>>)[2];
    const connectors = markitecture.connectors as Array<Record<string, unknown>>;
    const inference = connectors.find(
      (connector) => connector.contentId === "connector.gateway-inference",
    );
    const integrations = connectors.find(
      (connector) => connector.contentId === "connector.gateway-integrations",
    );
    const managedRequests = connectors.find(
      (connector) => connector.contentId === "connector.sandbox-gateway",
    );
    expect(inference).toMatchObject({
      from: "node.gateway",
      to: "node.inference",
      label: "routed inference",
      lineStyle: "solid",
    });
    expect(integrations).toMatchObject({
      from: "node.gateway",
      to: "node.integrations",
      label: "approved egress",
      lineStyle: "solid",
    });
    expect(managedRequests).toMatchObject({
      from: "node.sandbox",
      to: "node.gateway",
      label: "managed requests",
      lineStyle: "solid",
    });
    const requiredInference = inference as Record<string, unknown>;
    requiredInference.from = "node.sandbox";
    rehashModel(model);

    const result = validateSlideModel(model, schema, "publish");
    expect(result.publicationEligible).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MARKITECTURE_GRAPH_INVALID" })]),
    );
  });

  it("requires the documented dashed state connector and solid request connectors", () => {
    const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
    const model = buildSyntheticModel();
    const markitecture = (model.slides as Array<Record<string, unknown>>)[2];
    const connectors = markitecture.connectors as Array<Record<string, unknown>>;
    const state = connectors.find((connector) => connector.contentId === "connector.sandbox-state");
    const control = connectors.find(
      (connector) => connector.contentId === "connector.gateway-sandbox",
    );

    expect(state).toMatchObject({ lineStyle: "dashed" });
    expect(control).toMatchObject({ lineStyle: "solid" });
    (state as Record<string, unknown>).lineStyle = "solid";
    rehashModel(model);

    expect(validateSlideModel(model, schema, "publish").errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MARKITECTURE_GRAPH_INVALID" })]),
    );
  });

  it.each<{
    code: string;
    mutate: (snapshot: Record<string, unknown>) => void;
    rehash: (snapshot: Record<string, unknown>) => void;
  }>([
    {
      code: "MILESTONE_RECEIPT_MISMATCH",
      mutate: (snapshot) => {
        const collection = snapshot.collection as Record<string, unknown>;
        const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
          (candidate) => candidate.queryId === "repository-milestones",
        );
        (receipt?.sourceRecords as Array<Record<string, unknown>>)[0].title =
          "Forged milestone title";
      },
      rehash: (snapshot) => rehashSnapshotReceipt(snapshot, "repository-milestones"),
    },
    {
      code: "EPIC_RECEIPT_MISMATCH",
      mutate: (snapshot) => {
        const collection = snapshot.collection as Record<string, unknown>;
        const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
          (candidate) => candidate.queryId === "milestone-3-issues",
        );
        (receipt?.sourceRecords as Array<Record<string, unknown>>)[0].body =
          "## Outcome\n\nForged source body.";
      },
      rehash: (snapshot) => rehashSnapshotReceipt(snapshot, "milestone-3-issues"),
    },
    {
      code: "TAG_RECEIPT_MISMATCH",
      mutate: (snapshot) => {
        (snapshot.releases as Array<Record<string, unknown>>)[0].commitSha = "f".repeat(40);
      },
      rehash: rehashSnapshot,
    },
    {
      code: "ANNOUNCEMENT_RECEIPT_MISMATCH",
      mutate: (snapshot) => {
        const collection = snapshot.collection as Record<string, unknown>;
        const receipt = (collection.receipts as Array<Record<string, unknown>>).find(
          (candidate) => candidate.queryId === "announcement-discussions",
        );
        const sourceRecords = receipt?.sourceRecords as Array<Record<string, unknown>>;
        sourceRecords.push({
          ...structuredClone(sourceRecords[0]),
          id: "DUPLICATE_ANNOUNCEMENT",
          number: 999,
          url: "https://github.com/NVIDIA/NemoClaw/discussions/999",
        });
      },
      rehash: (snapshot) => rehashSnapshotReceipt(snapshot, "announcement-discussions"),
    },
  ])("binds $code derivation to receipt records", ({ code, mutate, rehash }) => {
    const inputs = syntheticFixtureInputs();
    mutate(inputs.snapshot);
    rehash(inputs.snapshot);
    const model = buildSyntheticModel({
      snapshot: inputs.snapshot,
      presentation: inputs.presentation,
      narrative: inputs.narrative,
    });
    expect(publicationCodes(model), code).toContain(code);
  });
});
