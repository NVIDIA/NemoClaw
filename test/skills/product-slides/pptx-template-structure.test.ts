// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertForbiddenText,
  audienceStrings,
  capabilityDividerInventoryFromSlideXml,
  COMPLETED_EPIC_CONTEXT_COLOR,
  createTemplateFidelityStarterComparisonLayouts,
  createTemporaryPptxAuthoringSurface,
  expectedMetricText,
  hyperlinkInventoryFromSlideXml,
  managedOperationTextByIdentity,
  validateCapabilityClassificationWarningAuthorization,
  validateRoadmapCapabilityDeleteAuthorization,
  validateRoadmapExecutiveDeleteAuthorization,
  validateTemplateLayoutFidelity,
  validateWeeklyMilestoneRowLayout,
  validateWeeklyMilestoneRowRoleMap,
  weeklyMilestoneLabelText,
  validateSingleSlideLayoutPair,
} from "./pptx-template-test-support";

describe("NemoClaw PowerPoint template authoring contracts", () => {
  it("keeps protected template links out of the model-managed hyperlink inventory", () => {
    const protectedText = "Template source: github.com/NVIDIA/NemoClaw";
    const slideXml = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Template source: </a:t></a:r><a:r><a:rPr><a:hlinkClick r:id="rId7"/></a:rPr><a:t>github.com/NVIDIA/NemoClaw</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const relationshipsXml = `<Relationships><Relationship Id="rId7" Target="https://github.com/NVIDIA/NemoClaw"/></Relationships>`;
    const expectedLink = {
      text: "github.com/NVIDIA/NemoClaw",
      url: "https://github.com/NVIDIA/NemoClaw",
    };

    expect(hyperlinkInventoryFromSlideXml(slideXml, relationshipsXml)).toEqual([expectedLink]);
    expect(
      hyperlinkInventoryFromSlideXml(slideXml, relationshipsXml, [
        createHash("sha256").update(protectedText).digest("hex"),
      ]),
    ).toEqual([]);
  });

  it("uses the weekly template's rendered metric wording and spacing", () => {
    const metrics = [
      { contentId: "metric.stars", label: "Stars", value: 12_345, detailValue: 123 },
      { contentId: "metric.forks", label: "Forks", value: 1_234, detailValue: 12 },
      { contentId: "metric.merged-prs", label: "Merged PRs", value: 456, detailValue: 45 },
      { contentId: "metric.vdr-uat", value: "Opened 29", detailValue: 25 },
      { contentId: "metric.latest-release", value: "v0.0.114" },
    ];
    const weekly = { role: "weekly-release", title: "Weekly", metrics, milestoneRows: [] };

    expect(
      expectedMetricText(weekly, {
        kind: "momentum",
        metricContentIds: ["metric.stars", "metric.forks", "metric.merged-prs"],
      }),
    ).toBe("Stars 12,345 (+123)  |  Forks 1,234 (+12)  |  Merged PRs 456 (+45)");
    expect(
      expectedMetricText(weekly, { kind: "opened-closed", metricContentId: "metric.vdr-uat" }),
    ).toBe("29 OPENED  |  25 CLOSED");
    expect(audienceStrings(weekly)).toEqual(
      expect.arrayContaining(["29 OPENED", "25 CLOSED", "v0.0.114"]),
    );
  });

  it("stacks uppercase weekly milestone labels in the green left rail", () => {
    expect(weeklyMilestoneLabelText("Q3")).toBe("Q3");
    expect(weeklyMilestoneLabelText("GTC Berlin")).toBe("GTC\nBERLIN");
    expect(weeklyMilestoneLabelText("Q4")).toBe("Q4");
  });

  it("registers role-map literals as managed output text", () => {
    expect(
      managedOperationTextByIdentity(
        {
          slides: [
            { role: "roadmap-executive", instanceId: "roadmap-executive.1" },
            { role: "weekly-release" },
          ],
        },
        {
          roles: {
            "roadmap-executive": {
              operations: [
                { literal: "GITHUB SNAPSHOT", prefix: "PREVIEW • ", suffix: " 2026-08-25" },
              ],
            },
            "weekly-release": { operations: [{ literal: "UPDATES" }] },
          },
        },
      ),
    ).toEqual({
      "roadmap-executive.1": ["PREVIEW • GITHUB SNAPSHOT 2026-08-25"],
      "weekly-release": ["UPDATES"],
    });
  });

  it("allows reviewed exemplar words when the shared model intentionally uses them", () => {
    const slide = {
      elements: { items: [{ text: "configure resources" }] },
      toProto: () => ({}),
    };
    const contract = { forbiddenText: ["configure"] };
    const modelSlide = {
      role: "markitecture",
      title: "NemoClaw system flow",
      nodes: [],
      connectors: [{ label: "configure resources" }],
    };

    expect(() => assertForbiddenText(slide, contract, modelSlide, "preview")).not.toThrow();
    expect(() =>
      assertForbiddenText(
        slide,
        contract,
        { ...modelSlide, connectors: [{ label: "provision resources" }] },
        "preview",
      ),
    ).toThrow(/retains forbidden exemplar text/u);
  });

  it("authorizes classification warnings only on capability pages that need them", () => {
    const warningPosition = { left: 1, top: 2, width: 3, height: 4 };
    const warningTarget = {
      action: "add",
      contentId: "matrix-needs-classification",
      newPrimitiveAllowed: true,
      mustNotOverlapInherited: true,
      zone: warningPosition,
    };
    const capabilityContract = { unclassifiedWarning: { position: warningPosition } };

    expect(() =>
      validateCapabilityClassificationWarningAuthorization({
        capabilityEntry: { editTargets: [warningTarget] },
        capabilityContract,
        modelSlide: {
          role: "roadmap-capability",
          instanceId: "roadmap-capability.1",
          unclassified: [{ number: 1 }],
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateCapabilityClassificationWarningAuthorization({
        capabilityEntry: { editTargets: [] },
        capabilityContract,
        modelSlide: {
          role: "roadmap-capability",
          instanceId: "roadmap-capability.2",
          unclassified: [],
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateCapabilityClassificationWarningAuthorization({
        capabilityEntry: { editTargets: [warningTarget] },
        capabilityContract,
        modelSlide: {
          role: "roadmap-capability",
          instanceId: "roadmap-capability.2",
          unclassified: [],
        },
      }),
    ).toThrow(/roadmap-capability\.2.*must not authorize/u);
    expect(() =>
      validateCapabilityClassificationWarningAuthorization({
        capabilityEntry: { editTargets: [] },
        capabilityContract,
        modelSlide: {
          role: "roadmap-capability",
          instanceId: "roadmap-capability.1",
          unclassified: [{ number: 1 }],
        },
      }),
    ).toThrow(/roadmap-capability\.1.*exact native classification warning zone/u);
  });

  it("copies the actual plain-JavaScript authoring source to an owner-only .mjs surface", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pptx-authoring-surface-"));
    const runtimeNodeModules = path.join(temp, "runtime-node-modules");
    fs.mkdirSync(runtimeNodeModules);
    let surface: Awaited<ReturnType<typeof createTemporaryPptxAuthoringSurface>> | undefined;
    try {
      const sourcePath = path.resolve(
        ".agents/skills/nemoclaw-maintainer-product-slides/scripts/pptx-authoring-module.mts",
      );
      surface = await createTemporaryPptxAuthoringSurface({
        tmpDir: temp,
        runtimeNodeModules,
        authoringSourcePath: sourcePath,
      });
      const source = fs.readFileSync(sourcePath);
      const copied = fs.readFileSync(surface.modulePath);
      expect(copied).toEqual(source);
      expect(path.extname(surface.modulePath)).toBe(".mjs");
      expect(fs.statSync(surface.directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(surface.modulePath).mode & 0o777).toBe(0o600);
      expect(fs.realpathSync(path.join(surface.directory, "node_modules"))).toBe(
        fs.realpathSync(runtimeNodeModules),
      );
      const text = copied.toString("utf8");
      expect(text).toContain('from "@oai/artifact-tool"');
      expect(text).toContain("PresentationFile.importPptx(");
      expect(text).toContain("slide.shapes.connect(");
      expect(text).toContain('tail: { type: "triangle", width: "med", length: "med" }');
      expect(text).not.toContain('head: { type: "triangle", width: "med", length: "med" }');
      expect(text).toContain("connectorShape.setConnectorFrom(fromNode, fromIdx)");
      expect(text).toContain("connectorShape.setConnectorTo(toNode.id, toIdx)");
      expect(text).toContain("for (const node of stagingNodes.values()) node.delete()");
      expect(text).toContain("const baseStyle = artifactTextStyle(operation.textStyle)");
      expect(text).toContain("...(operation.paragraphStyle ?? {})");
      expect(text).toContain("outcomeParagraphStyle(operation, index, outcomes.length)");
      expect(text).toContain("operation.paragraphStyles.length === 0");
      expect(text).toContain("function retainedOperations(");
      expect(text).toContain("const deletedNames = applyAuthorizedDeletes(");
      expect(text).toContain("Unused runtime outcome target was not deleted by its frame map");
      expect(text).toContain('if (next === "")');
      expect(text).toContain('target.text.set([{ runs: [{ run: "" }], bulletCharacter: "" }])');
      expect(text).toContain("if (index === outcomeCount - 1) return styles.at(-1)");
      expect(text).toContain("function epicCompletionPrefix(item, context)");
      expect(text).toContain('return item.state === "CLOSED" ? "✓ " : ""');
      expect(text).toContain('const COMPLETED_EPIC_CONTEXT_COLOR = "#5B5B5B"');
      expect(text).toContain("${outcome.featureTitle}:`");
      expect(text).toContain("color: COMPLETED_EPIC_CONTEXT_COLOR");
      expect(text).not.toContain("link: { uri: outcome.url, isExternal: true }");
      expect(text).toContain('underline: "none"');
      expect(text).not.toContain(
        "addLink(target, `${outcome.featureTitle}: ${outcome.text}`, outcome.url)",
      );
      expect(text).toContain("target.text.style = artifactTextStyle(operation.textFrameStyle)");
      expect(text).toContain("structuredParagraphStyle(");
      expect(text).toContain("paragraphStyle.lineSpacingPercent = Math.round(");
      expect(text).toContain("paragraphStyle.bulletCharacter = style.bulletCharacter");
      const outcomeListAuthoring = text.slice(
        text.indexOf("function applyOutcomeListOperations"),
        text.indexOf("function metricById"),
      );
      const textFrameStyleAssignment =
        "target.text.style = artifactTextStyle(operation.textFrameStyle)";
      const outcomeListSet = outcomeListAuthoring.indexOf("target.text.set(\n      outcomes.map");
      expect(outcomeListSet).toBeGreaterThan(-1);
      expect(outcomeListAuthoring.match(/target\.text\.style = artifactTextStyle/g)).toHaveLength(
        1,
      );
      expect(outcomeListAuthoring.indexOf(textFrameStyleAssignment)).toBeLessThan(outcomeListSet);
      expect(outcomeListAuthoring.lastIndexOf(textFrameStyleAssignment)).toBeLessThan(
        outcomeListSet,
      );
      expect(text).toContain("function capabilityEpicReferenceText(item)");
      expect(text).toContain("function capabilityEpicRuns(\n  item,\n  textStyle,");
      expect(text).toContain("const topRow = contract.table.topRow");
      expect(text).toContain('table.cells.set(topRow, contract.table.areaLabelColumn, "")');
      expect(text).toContain("retainedOperations(contract.operations, deletedNames)");
      expect(text).not.toContain("capabilityFocusText(");
      expect(text).toContain("function replaceRoadmapFocusText(target, item)");
      expect(text).toContain("Roadmap focus target does not match the template label structure");
      expect(text).toContain("nextText = replaceRoadmapFocusText(target, focusItem)");
      expect(text).toContain("${item.title}`,");
      expect(text).toContain('const labelStyle = { ...textStyle, bold: true, underline: "none" }');
      expect(text).toContain(
        'const referenceStyle = { ...referenceTextStyle, bold: false, underline: "none" }',
      );
      expect(text).toContain("capabilityEpicReferenceText(item),");
      expect(text).not.toContain("addLink(nativeCell, item.title, item.url)");
      expect(text).toContain("...capabilityEpicRuns(item, warningTextStyle)");
      expect(text).toContain("referenceTextStyle = textStyle");
      expect(text).toContain("linkTextStyle = referenceTextStyle");
      expect(text).toContain("textStyle: linkedReferenceStyle");
      expect(text).toContain("contract.table.referenceTextStyle ?? contract.table.cellTextStyle");
      expect(text).toContain("contract.table.linkTextStyle ??");
      expect(text).toContain(
        "capabilityEpicRuns(item, cellTextStyle, referenceTextStyle, linkTextStyle)",
      );
      expect(text).toContain("`Capability item ${item.contentId}`,\n          linkTextStyle");
      expect(text).toContain("function weeklyEvidenceItems(row, kind)");
      expect(text).toContain("String(target.text).split(/\\s+\\|\\s+/u)");
      expect(text).toContain(
        "Runtime momentum target does not match the template metric structure",
      );
      expect(text).toContain("/^(\\d+ OPENED)(\\s+\\|\\s+)(\\d+ CLOSED)$/u.exec(source)");
      expect(text).toContain("replaceText(target, textValue(metric.value))");
      expect(text).toContain(
        'return row.risks.length > 0 ? row.risks : [{ label: "", text: "None" }]',
      );
      expect(text).toContain("function applyMilestoneRowOperations");
      expect(text).toContain("function replaceWeeklyMilestoneLabelText(target, title)");
      expect(text).toContain("replaceWeeklyMilestoneLabelText(target, row.title)");
      expect(text).toContain("paragraphStyle: { ...(operation.paragraphStyle ?? {}) }");
      expect(text).toContain(
        "...structuredParagraphStyle(paragraphContract, operation.textFrameStyle)",
      );
      expect(text).toContain("{ run: `${item.label}: `, textStyle: { ...style, bold: true } }");
      expect(text).toContain("function applyGeometryOperations");
      expect(text).toContain("target.position = runtimePositionFromEmu(operation.positionEmu)");
      expect(text).toContain("const sourceTitle = String(title.text)");
      expect(text).toContain("const outputTitle = textValue(model.title)");
      expect(text).toContain(
        "title.text.replace(sourceTitle.slice(emphasis.length), outputTitle.slice(emphasis.length))",
      );
      expect(text).toContain(
        "Markitecture title rewrite must preserve the template's emphasized title prefix",
      );
      expect(text).toContain("operation.linkTextStyle");
      expect(text).toContain("range.color = textStyle.color");
      expect(text).toContain("frames.connectorLabelTypeface ?? frames.nodeTypeface");
      expect(text).toContain("bold: frames.connectorLabelBold ?? false");
      expect(text).toContain("PresentationFile.exportPptx(");
      expect(text).not.toMatch(/\b(?:interface|enum|namespace)\s+[A-Za-z_$]/u);
      const syntax = spawnSync(process.execPath, ["--check", surface.modulePath], {
        encoding: "utf8",
      });
      expect(syntax.status, syntax.stderr).toBe(0);
    } finally {
      fs.rmSync(surface?.directory ?? temp, { recursive: true, force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs strict raw-layout validation before comparison normalization and the standard helper", () => {
    const source = fs.readFileSync(
      path.resolve(".agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts"),
      "utf8",
    );
    const workflow = source.slice(
      source.indexOf("async function runTemplateFidelityWorkflow"),
      source.indexOf("function sha256Bytes"),
    );
    const strictValidation = workflow.indexOf("await validateTemplateLayoutFidelity(");
    const standardWorkflow = workflow.indexOf("await runTemplateFidelityCheck(");
    expect(strictValidation).toBeGreaterThan(-1);
    expect(standardWorkflow).toBeGreaterThan(strictValidation);
    const standardCheck = source.slice(
      source.indexOf("async function runTemplateFidelityCheck"),
      source.indexOf("async function runTemplateFidelityWorkflow"),
    );
    expect(
      standardCheck.indexOf("await createTemplateFidelityStarterComparisonLayouts("),
    ).toBeLessThan(standardCheck.indexOf("await runRuntimeProcess("));
  });

  it("requires one native label, Updates, and Risks / Blockers target for each weekly row", () => {
    const milestoneRowOperations = [0, 1, 2].flatMap((rowIndex) =>
      ["label", "updates", "risks"].map((kind) => ({
        target: { name: `weekly-${rowIndex}-${kind}` },
        rowIndex,
        kind,
        ...(kind === "label"
          ? {
              placement: "left",
              fillColor: "#76B900",
              textStyle: { color: "#FFFFFF", bold: true },
              paragraphStyle: { bulletCharacter: "" },
            }
          : {
              nativeBullets: true,
              paragraphStyle: { bulletCharacter: "•" },
            }),
      })),
    );
    const roleMap = {
      roles: {
        "weekly-release": { milestoneRowOperations },
      },
    };

    expect(() => validateWeeklyMilestoneRowRoleMap(roleMap)).not.toThrow();

    [
      { milestoneRowOperations: milestoneRowOperations.slice(0, -1) },
      { milestoneRowOperations: [...milestoneRowOperations, milestoneRowOperations[0]] },
      {
        milestoneRowOperations: milestoneRowOperations.map((operation, index) =>
          index === 0 ? { ...operation, rowIndex: 3 } : operation,
        ),
      },
      {
        milestoneRowOperations: milestoneRowOperations.map((operation, index) =>
          index === 0 ? { ...operation, placement: "right" } : operation,
        ),
      },
      {
        milestoneRowOperations: milestoneRowOperations.map((operation, index) =>
          index === 1 ? { ...operation, nativeBullets: false } : operation,
        ),
      },
      { milestoneRowOperations, releaseOperations: [] },
    ].forEach((contract) => {
      expect(() =>
        validateWeeklyMilestoneRowRoleMap({ roles: { "weekly-release": contract } }),
      ).toThrow(/Runtime weekly/u);
    });
  });

  it("requires inspected green milestone labels to remain left of both weekly content columns", () => {
    const milestoneRowOperations = [0, 1, 2].flatMap((rowIndex) =>
      ["label", "updates", "risks"].map((kind) => ({
        target: { name: `weekly-${rowIndex}-${kind}` },
        rowIndex,
        kind,
        ...(kind === "label"
          ? {
              placement: "left",
              fillColor: "#76B900",
              textStyle: { color: "#FFFFFF", bold: true },
              paragraphStyle: { bulletCharacter: "" },
            }
          : {
              nativeBullets: true,
              paragraphStyle: { bulletCharacter: "•" },
            }),
      })),
    );
    const elements = [0, 1, 2].flatMap((rowIndex) => {
      const top = rowIndex * 100;
      return [
        {
          name: `weekly-${rowIndex}-label`,
          bbox: [0, top, 90, 80],
          fillColor: "#76B900",
        },
        { name: `weekly-${rowIndex}-updates`, bbox: [100, top, 300, 80] },
        { name: `weekly-${rowIndex}-risks`, bbox: [410, top, 250, 80] },
      ];
    });
    const contract = { milestoneRowOperations };

    expect(() =>
      validateWeeklyMilestoneRowLayout({ elements }, contract, "Synthetic weekly slide"),
    ).not.toThrow();
    const themeTokenFill = structuredClone(elements);
    themeTokenFill
      .filter((candidate) => candidate.name.endsWith("-label"))
      .forEach((element) => {
        element.fillColor = "accent1";
      });
    expect(() =>
      validateWeeklyMilestoneRowLayout(
        { elements: themeTokenFill },
        contract,
        "Synthetic weekly slide",
      ),
    ).not.toThrow();
    const wrongFill = structuredClone(elements);
    wrongFill[0].fillColor = "#9E9E9E";
    expect(() =>
      validateWeeklyMilestoneRowLayout({ elements: wrongFill }, contract, "Synthetic weekly slide"),
    ).toThrow(/green fill/u);
    const wrongSide = structuredClone(elements);
    wrongSide[0].bbox = [120, 0, 90, 80];
    expect(() =>
      validateWeeklyMilestoneRowLayout({ elements: wrongSide }, contract, "Synthetic weekly slide"),
    ).toThrow(/left of/u);
  });

  it("requires exact delete authorization for unused executive milestone slots", () => {
    const executiveContract = {
      operations: [
        { target: { name: "title-1" }, valuePath: "milestones.0.title" },
        { target: { name: "focus-1" }, valuePath: "milestones.0.focus" },
        { target: { name: "title-2" }, valuePath: "milestones.1.title" },
        { target: { name: "focus-2" }, valuePath: "milestones.1.focus" },
      ],
      outcomeListOperations: [
        { target: { name: "outcomes-1" }, outcomesPath: "milestones.0.outcomes" },
        { target: { name: "outcomes-2" }, outcomesPath: "milestones.1.outcomes" },
      ],
    };
    const modelSlide = {
      role: "roadmap-executive",
      instanceId: "roadmap-executive.2",
      milestones: [{ title: "Q1", focus: "First", outcomes: [{}] }],
    };
    const exactDeletes = ["title-2", "focus-2", "outcomes-2"];
    const executiveEntry = {
      editTargets: exactDeletes.map((sourceElementName) => ({
        action: "delete",
        sourceElementName,
      })),
    };
    expect(() =>
      validateRoadmapExecutiveDeleteAuthorization({
        executiveEntry,
        executiveContract,
        modelSlide,
      }),
    ).not.toThrow();
    expect(() =>
      validateRoadmapExecutiveDeleteAuthorization({
        executiveEntry: { editTargets: executiveEntry.editTargets.slice(0, -1) },
        executiveContract,
        modelSlide,
      }),
    ).toThrow(/deletes must equal its unused executive milestone targets/u);
    expect(() =>
      validateRoadmapExecutiveDeleteAuthorization({
        executiveEntry: {
          editTargets: [
            ...executiveEntry.editTargets,
            { action: "delete", sourceElementName: "title-1" },
          ],
        },
        executiveContract,
        modelSlide,
      }),
    ).toThrow(/deletes must equal its unused executive milestone targets/u);
  });

  it("requires exact delete authorization for unused capability HOME_PLATE slots", () => {
    const capabilityContract = {
      operations: [
        { target: { name: "milestone-target-1" }, valuePath: "columns.0.title" },
        { target: { name: "milestone-target-2" }, valuePath: "columns.1.title" },
        { target: { name: "milestone-target-3" }, valuePath: "columns.2.title" },
      ],
      table: { topRow: 0, milestoneColumnCount: 3 },
    };
    const modelSlide = {
      role: "roadmap-capability",
      instanceId: "roadmap-capability.2",
      columns: [{ title: "Only milestone" }],
    };
    const exactDeletes = ["milestone-target-2", "milestone-target-3"];
    const capabilityEntry = {
      editTargets: exactDeletes.map((sourceElementName) => ({
        action: "delete",
        sourceElementName,
      })),
    };

    expect(() =>
      validateRoadmapCapabilityDeleteAuthorization({
        capabilityEntry,
        capabilityContract,
        modelSlide,
      }),
    ).not.toThrow();
    expect(() =>
      validateRoadmapCapabilityDeleteAuthorization({
        capabilityEntry: { editTargets: capabilityEntry.editTargets.slice(0, -1) },
        capabilityContract,
        modelSlide,
      }),
    ).toThrow(/unused capability milestone HOME_PLATE targets/u);
    expect(() =>
      validateRoadmapCapabilityDeleteAuthorization({
        capabilityEntry: {
          editTargets: [
            ...capabilityEntry.editTargets,
            { action: "delete", sourceElementName: "milestone-target-1" },
          ],
        },
        capabilityContract,
        modelSlide,
      }),
    ).toThrow(/unused capability milestone HOME_PLATE targets/u);
    expect(() =>
      validateRoadmapCapabilityDeleteAuthorization({
        capabilityEntry,
        capabilityContract: {
          ...capabilityContract,
          table: { headerRow: 0, milestoneColumnCount: 3 },
        },
        modelSlide,
      }),
    ).toThrow(/blank topRow.*no native-table header text/u);
    expect(() =>
      validateRoadmapCapabilityDeleteAuthorization({
        capabilityEntry,
        capabilityContract: {
          ...capabilityContract,
          table: { topRow: 1, milestoneColumnCount: 3 },
        },
        modelSlide,
      }),
    ).toThrow(/blank topRow.*no native-table header text/u);
    const linkedOperations = structuredClone(capabilityContract.operations) as Array<
      Record<string, unknown>
    >;
    linkedOperations[0].linkPath = "columns.0.url";
    expect(() =>
      validateRoadmapCapabilityDeleteAuthorization({
        capabilityEntry,
        capabilityContract: { ...capabilityContract, operations: linkedOperations },
        modelSlide,
      }),
    ).toThrow(/one distinct named, unlinked HOME_PLATE target/u);
    const duplicateTargetOperations = structuredClone(capabilityContract.operations);
    duplicateTargetOperations[1].target.name = duplicateTargetOperations[0].target.name;
    expect(() =>
      validateRoadmapCapabilityDeleteAuthorization({
        capabilityEntry,
        capabilityContract: {
          ...capabilityContract,
          operations: duplicateTargetOperations,
        },
        modelSlide,
      }),
    ).toThrow(/one distinct named, unlinked HOME_PLATE target/u);
    [
      { literal: "Wrong" },
      { prefix: "Active " },
      { suffix: " fallback" },
      { search: "Template title" },
      { fallbackValue: "Wrong" },
      { transform: "uppercase" },
      { valuePath: "columns.00.title" },
    ].forEach((poisonedBinding) => {
      const operations = structuredClone(capabilityContract.operations);
      Object.assign(operations[0], poisonedBinding);
      expect(() =>
        validateRoadmapCapabilityDeleteAuthorization({
          capabilityEntry,
          capabilityContract: { ...capabilityContract, operations },
          modelSlide,
        }),
      ).toThrow(/one distinct named, unlinked HOME_PLATE target/u);
    });
    expect(() =>
      validateRoadmapCapabilityDeleteAuthorization({
        capabilityEntry,
        capabilityContract: {
          ...capabilityContract,
          richTextOperations: [{ target: { name: "extra-title" }, valuePath: "columns.0.title" }],
        },
        modelSlide,
      }),
    ).toThrow(/exactly three direct contract\.operations bindings/u);
  });

  it("derives all 49 white solid capability-table divider segments from native XML", () => {
    const line = (side: "L" | "R" | "T" | "B", color = "FFFFFF") =>
      `<a:ln${side} w="228600"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:prstDash val="solid"/></a:ln${side}>`;
    const cell = (color = "FFFFFF") =>
      `<a:tc><a:tcPr>${line("L", color)}${line("R")}${line("T")}${line("B")}</a:tcPr></a:tc>`;
    const table = `<a:tbl>${Array.from({ length: 5 }, () => `<a:tr>${Array.from({ length: 4 }, () => cell()).join("")}</a:tr>`).join("")}</a:tbl>`;

    expect(capabilityDividerInventoryFromSlideXml(`<p:sld>${table}</p:sld>`)).toEqual({
      segmentCount: 49,
      color: "#FFFFFF",
      lineStyle: "solid",
      widthEmu: 228_600,
    });
    expect(
      capabilityDividerInventoryFromSlideXml(
        `<p:sld>${table.replace(cell(), cell("000000"))}</p:sld>`,
      ),
    ).toMatchObject({ segmentCount: 49, color: "#MIXED", lineStyle: "mixed" });
  });

  it("requires real HOME_PLATE milestone targets centered in their blank top-row cells", async () => {
    const topCells = [
      { row: 1, column: 1, text: "", bbox: [0, 0, 100, 40] },
      { row: 1, column: 2, text: "", bbox: [100, 0, 200, 40] },
      { row: 1, column: 3, text: "", bbox: [300, 0, 200, 40] },
      { row: 1, column: 4, text: "", bbox: [500, 0, 200, 40] },
    ];
    const table = {
      order: 1,
      kind: "table",
      name: "capability-table",
      bbox: [0, 0, 700, 400],
      rows: 5,
      cols: 4,
      cells: topCells,
    };
    const targets = [
      {
        order: 2,
        kind: "shape",
        name: "target-1",
        geometry: "homePlate",
        bbox: [100, 0, 200, 40],
        text: "Q3",
      },
      {
        order: 3,
        kind: "shape",
        name: "target-2",
        geometry: "homePlate",
        bbox: [300, 0, 200, 40],
        text: "Window Three",
      },
      {
        order: 4,
        kind: "shape",
        name: "target-3",
        geometry: "homePlate",
        bbox: [500, 0, 200, 40],
        text: "Q4",
      },
    ];
    const roleContract = {
      operations: targets.map((target, index) => ({
        target: { name: target.name },
        valuePath: `columns.${String(index)}.title`,
      })),
      table: {
        target: { name: "capability-table" },
        topRow: 0,
        firstMilestoneColumn: 1,
        milestoneColumnCount: 3,
        areaLabelColumn: 0,
      },
    };
    const modelSlide = {
      role: "roadmap-capability",
      instanceId: "roadmap-capability.1",
      columns: [{ title: "Q3" }, { title: "Window Three" }, { title: "Q4" }],
      unclassified: [],
    };
    const options = {
      starter: [table, ...targets],
      final: [table, ...targets],
      editTargets: [],
      roleContract,
      modelSlide,
    };

    await expect(validateSingleSlideLayoutPair(options)).resolves.toBeUndefined();

    const rectangles = structuredClone(targets);
    rectangles[0].geometry = "rect";
    await expect(
      validateSingleSlideLayoutPair({
        ...options,
        starter: [table, ...rectangles],
        final: [table, ...rectangles],
      }),
    ).rejects.toThrow(/aligned used HOME_PLATE targets/u);

    const misaligned = structuredClone(targets);
    misaligned[1].bbox = [650, 100, 40, 40];
    await expect(
      validateSingleSlideLayoutPair({
        ...options,
        starter: [table, ...misaligned],
        final: [table, ...misaligned],
      }),
    ).rejects.toThrow(/aligned used HOME_PLATE targets/u);

    const partialOptions = {
      ...options,
      final: [table, targets[0]],
      editTargets: [
        { action: "delete", sourceElementName: "target-2" },
        { action: "delete", sourceElementName: "target-3" },
      ],
      modelSlide: { ...modelSlide, columns: [{ title: "Q3" }] },
    };
    await expect(validateSingleSlideLayoutPair(partialOptions)).resolves.toBeUndefined();
    await expect(
      validateSingleSlideLayoutPair({ ...partialOptions, final: [table, ...targets] }),
    ).rejects.toThrow(/no unused top-row targets/u);
    const extraTarget = {
      order: 5,
      kind: "shape",
      name: "extra-target",
      geometry: "homePlate",
      bbox: [300, 0, 200, 40],
      text: "Unexpected",
    };
    await expect(
      validateSingleSlideLayoutPair({
        ...partialOptions,
        final: [table, targets[0], extraTarget],
      }),
    ).rejects.toThrow(/no unused top-row targets/u);
    const staleBodyTable = structuredClone(table);
    staleBodyTable.cells.push({
      row: 2,
      column: 3,
      text: "Legacy unused-cell text",
      bbox: [300, 40, 200, 90],
    });
    await expect(
      validateSingleSlideLayoutPair({
        ...partialOptions,
        final: [staleBodyTable, targets[0]],
      }),
    ).rejects.toThrow(/empty unused body cells/u);
    await Promise.all(
      ["Milestone: Q3", "q3", "Q3 milestone", "Milestone: Window Three"].map(async (text) => {
        const bottomRectangle = {
          order: 5,
          kind: "shape",
          name: "legacy-bottom-label",
          geometry: "rect",
          bbox: [100, 410, 200, 40],
          text,
        };
        await expect(
          validateSingleSlideLayoutPair({
            ...options,
            starter: [table, ...targets, bottomRectangle],
            final: [table, ...targets, bottomRectangle],
          }),
        ).rejects.toThrow(/no bottom milestone labels/u);
      }),
    );
    const unrelatedFooter = {
      order: 5,
      kind: "shape",
      name: "unrelated-footer",
      geometry: "rect",
      bbox: [100, 410, 200, 40],
      text: "TEST ONLY · page 1/3",
    };
    await expect(
      validateSingleSlideLayoutPair({
        ...options,
        starter: [table, ...targets, unrelatedFooter],
        final: [table, ...targets, unrelatedFooter],
      }),
    ).resolves.toBeUndefined();
  });
});
