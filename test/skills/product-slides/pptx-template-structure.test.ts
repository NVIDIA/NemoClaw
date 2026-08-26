// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertForbiddenText,
  audienceStrings,
  capabilityDividerInventoryFromSlideXml,
  COMPLETED_EPIC_CONTEXT_COLOR,
  createTemporaryPptxAuthoringSurface,
  expectedMetricText,
  hyperlinkInventoryFromSlideXml,
  managedOperationTextByIdentity,
  runTemplateFidelityWorkflow,
  validateCapabilityClassificationWarningAuthorization,
  validateRoadmapCapabilityDeleteAuthorization,
  validateRoadmapExecutiveDeleteAuthorization,
  validateWeeklyMilestoneRowLayout,
  validateWeeklyMilestoneRowRoleMap,
  weeklyMilestoneLabelText,
  validateSingleSlideLayoutPair,
} from "./pptx-template-test-support";

type FakeParagraph = {
  runs?: Array<{ run?: unknown; textStyle?: Record<string, unknown> }>;
  [key: string]: unknown;
};

function createFakeText(initial = "") {
  let value = initial;
  let paragraphs: FakeParagraph[] = [];
  const ranges: Array<{
    text: string;
    link?: { uri: string; isExternal: boolean };
    underline?: unknown;
    color?: unknown;
  }> = [];
  return {
    style: {} as Record<string, unknown>,
    get value() {
      return value;
    },
    get paragraphs() {
      return paragraphs;
    },
    ranges,
    toString() {
      return value;
    },
    set(next: FakeParagraph[]) {
      paragraphs = structuredClone(next);
      value = next
        .map((paragraph) => (paragraph.runs ?? []).map((run) => String(run.run ?? "")).join(""))
        .join("\n");
    },
    replace(search: string, replacement: string) {
      value = value.replace(search, replacement);
    },
    get(text: string) {
      const range = { text } as (typeof ranges)[number];
      ranges.push(range);
      return range;
    },
  };
}

function createFakeShape(name: string, initialText = "") {
  const text = createFakeText(initialText);
  const shape = {
    id: `fake-${name}`,
    name,
    position: {} as Record<string, unknown>,
    deleted: false,
    text,
    delete() {
      shape.deleted = true;
    },
  };
  Object.defineProperty(shape, "text", {
    configurable: true,
    enumerable: true,
    get() {
      return text;
    },
    set(value: unknown) {
      text.set([{ runs: [{ run: String(value) }] }]);
    },
  });
  return shape;
}

function createFakeSlide(elements: Array<Record<string, unknown>>) {
  const addedShapes: Array<ReturnType<typeof createFakeShape> & Record<string, unknown>> = [];
  const connectors: Array<Record<string, unknown>> = [];
  const notes = { text: "", visible: true };
  return {
    elements: { items: elements },
    addedShapes,
    connectors,
    shapes: {
      add(options: Record<string, unknown>) {
        const shape = Object.assign(createFakeShape(String(options.name ?? "added")), options);
        addedShapes.push(shape);
        return shape;
      },
      connect(
        from: ReturnType<typeof createFakeShape>,
        to: ReturnType<typeof createFakeShape>,
        options: Record<string, unknown>,
      ) {
        const connector = {
          id: `fake-connector-${connectors.length + 1}`,
          name: "",
          connector: { fromIdx: 0, toIdx: 1 },
          from,
          to,
          options,
          reboundFrom: null as null | { id: string; index: number },
          reboundTo: null as null | { id: string; index: number },
          setConnectorFrom(node: { id: string }, index: number) {
            connector.reboundFrom = { id: node.id, index };
          },
          setConnectorTo(id: string, index: number) {
            connector.reboundTo = { id, index };
          },
        };
        connectors.push(connector);
        return connector;
      },
    },
    speakerNotes: {
      textFrame: {
        setText(value: string) {
          notes.text = value;
        },
      },
      setVisible(value: boolean) {
        notes.visible = value;
      },
    },
    notes,
  };
}

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

  it("copies the owner-only authoring surface and applies every managed slide role", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pptx-authoring-surface-"));
    const runtimeNodeModules = path.join(temp, "runtime-node-modules");
    fs.mkdirSync(runtimeNodeModules);
    const artifactToolDir = path.join(runtimeNodeModules, "@oai", "artifact-tool");
    fs.mkdirSync(artifactToolDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactToolDir, "package.json"),
      JSON.stringify({ name: "@oai/artifact-tool", type: "module", exports: "./index.js" }),
    );
    fs.writeFileSync(
      path.join(artifactToolDir, "index.js"),
      "export const FileBlob = {}; export const PresentationFile = {};\n",
    );
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
      const syntax = spawnSync(process.execPath, ["--check", surface.modulePath], {
        encoding: "utf8",
      });
      expect(syntax.status, syntax.stderr).toBe(0);
      const actualEntrypoint = spawnSync(process.execPath, [surface.modulePath], {
        encoding: "utf8",
      });
      expect(actualEntrypoint.status).toBe(1);
      expect(actualEntrypoint.stderr).toMatch(/Missing authoring option: model/u);
      const unknownArgument = spawnSync(
        process.execPath,
        [surface.modulePath, "--unsupported", "value"],
        { encoding: "utf8" },
      );
      expect(unknownArgument.status).toBe(1);
      expect(unknownArgument.stderr).toMatch(/Unknown authoring argument: --unsupported/u);

      const executiveTitle = createFakeShape("executive-title", "Old roadmap");
      const executiveOutcomes = createFakeShape("executive-outcomes", "Old outcomes");
      const executiveSlide = createFakeSlide([
        executiveTitle as unknown as Record<string, unknown>,
        executiveOutcomes as unknown as Record<string, unknown>,
      ]);

      const capabilityTitle = createFakeShape("capability-title", "Old capability");
      const capabilityCell = createFakeShape("capability-cell");
      const capabilityCells = new Map([["1:1", capabilityCell]]);
      const tableWrites = new Map<string, unknown>();
      const capabilityTable = {
        name: "capability-table",
        cells: {
          set(row: number, column: number, value: unknown) {
            tableWrites.set(`${row}:${column}`, value);
            capabilityCells.get(`${row}:${column}`)?.text.set([{ runs: [{ run: String(value) }] }]);
          },
        },
        getCell(row: number, column: number) {
          return capabilityCells.get(`${row}:${column}`) ?? createFakeShape("unused-cell");
        },
      };
      const capabilitySlide = createFakeSlide([
        capabilityTitle as unknown as Record<string, unknown>,
        capabilityTable as unknown as Record<string, unknown>,
      ]);

      const markitectureTitle = createFakeShape("markitecture-title", "NemoClaw old flow");
      const markitectureSlide = createFakeSlide([
        markitectureTitle as unknown as Record<string, unknown>,
      ]);

      const weeklyTitle = createFakeShape("weekly-title", "Old weekly title");
      const latestRelease = createFakeShape("latest-release", "v0.0.1");
      const weeklyLabel = createFakeShape("weekly-label", "OLD\nLABEL");
      const weeklyUpdates = createFakeShape("weekly-updates", "Old updates");
      const weeklyRisks = createFakeShape("weekly-risks", "Old risks");
      const weeklySlide = createFakeSlide([
        weeklyTitle as unknown as Record<string, unknown>,
        latestRelease as unknown as Record<string, unknown>,
        weeklyLabel as unknown as Record<string, unknown>,
        weeklyUpdates as unknown as Record<string, unknown>,
        weeklyRisks as unknown as Record<string, unknown>,
      ]);

      const slides = [executiveSlide, capabilitySlide, markitectureSlide, weeklySlide];
      const presentation = {
        slides: {
          getItem(index: number) {
            return slides[index];
          },
        },
        resolve() {
          throw new Error("The fake runtime does not use anchor IDs");
        },
      };
      const closedExecutiveOutcome = {
        contentId: "roadmap.outcome.9816",
        state: "CLOSED",
        featureTitle: "Kubernetes In-Cluster",
        text: "Qualify one external gateway workflow",
      };
      const model = {
        slides: [
          {
            role: "roadmap-executive",
            title: "NemoClaw Feature Roadmap",
            milestones: [{ outcomes: [closedExecutiveOutcome] }],
            managedNotes: "executive notes",
          },
          {
            role: "roadmap-capability",
            title: "NemoClaw Feature Roadmap",
            rows: ["Usability and Onboarding"],
            columns: [{ milestoneNodeId: "M_Q3", title: "Q3" }],
            cells: [
              {
                roadmapArea: "Usability and Onboarding",
                milestoneNodeId: "M_Q3",
                items: [
                  {
                    contentId: "capability.epic.9816",
                    title: "Kubernetes In-Cluster",
                    state: "CLOSED",
                    url: "https://github.com/NVIDIA/NemoClaw/issues/9816",
                  },
                ],
              },
            ],
            unclassified: [],
            managedNotes: "capability notes",
          },
          {
            role: "markitecture",
            title: "NemoClaw system flow",
            nodes: [
              { contentId: "node.operator", text: "Operator" },
              { contentId: "node.sandbox", text: "Sandbox" },
            ],
            connectors: [
              {
                contentId: "connector.operator-sandbox",
                from: "node.operator",
                to: "node.sandbox",
                lineStyle: "solid",
                label: "launches",
              },
            ],
            managedNotes: "markitecture notes",
          },
          {
            role: "weekly-release",
            title: "NemoClaw Weekly Executive Scorecard",
            metrics: [{ contentId: "metric.latest-release", value: "v1.2.3" }],
            milestoneRows: [
              {
                title: "GTC Berlin",
                updates: [{ label: "Kubernetes", text: "Qualification completed" }],
                risks: [],
              },
            ],
            managedNotes: "weekly notes",
          },
        ],
      };
      const markitectureZone = { left: 0, top: 0, width: 100, height: 100 };
      const roleMap = {
        roles: {
          "roadmap-executive": {
            operations: [{ target: { name: "executive-title" }, valuePath: "title" }],
            outcomeListOperations: [
              {
                target: { name: "executive-outcomes" },
                outcomesPath: "milestones.0.outcomes",
                textStyle: { fontSize: 18, color: "#141414" },
                paragraphStyle: { bulletCharacter: "•" },
              },
            ],
            geometryOperations: [
              {
                target: { name: "executive-title" },
                positionEmu: { left: 95_250, top: 190_500, width: 952_500, height: 381_000 },
              },
            ],
          },
          "roadmap-capability": {
            operations: [{ target: { name: "capability-title" }, valuePath: "title" }],
            table: {
              target: { name: "capability-table" },
              topRow: 0,
              areaLabelColumn: 0,
              firstMilestoneColumn: 1,
              milestoneColumnCount: 1,
              areaRows: { "Usability and Onboarding": 1 },
              cellTextStyle: { fontSize: 16, color: "#141414" },
              referenceTextStyle: { fontSize: 14, color: "#5B5B5B" },
              linkTextStyle: { fontSize: 14, color: "#76B900", underline: "none" },
            },
          },
          markitecture: {
            title: {
              target: { name: "markitecture-title" },
              emphasis: "NemoClaw",
            },
            geometry: {
              nodeFill: "#EEEEEE",
              nodeLine: "#76B900",
              nodeFontSize: 18,
              nodeTypeface: "Arial",
              nodeTextColor: "#141414",
              nodeInsets: { top: 2, right: 2, bottom: 2, left: 2 },
              connectorColor: "#76B900",
              connectorWidth: 2,
              connectorLabelFontSize: 12,
              secondaryTextColor: "#5B5B5B",
              nodeFrames: {
                "node.operator": {
                  position: { left: 10, top: 10, width: 20, height: 10 },
                },
                "node.sandbox": {
                  position: { left: 60, top: 10, width: 20, height: 10 },
                },
              },
              connectorFrames: {
                "connector.operator-sandbox": {
                  line: { left: 30, top: 10, width: 30, height: 10 },
                  label: { left: 38, top: 22, width: 14, height: 6 },
                },
              },
            },
          },
          "weekly-release": {
            operations: [{ target: { name: "weekly-title" }, valuePath: "title" }],
            metricOperations: [
              {
                target: { name: "latest-release" },
                kind: "single",
                metricContentId: "metric.latest-release",
              },
            ],
            milestoneRowOperations: [
              { target: { name: "weekly-label" }, rowIndex: 0, kind: "label" },
              {
                target: { name: "weekly-updates" },
                rowIndex: 0,
                kind: "updates",
                nativeBullets: true,
                textStyle: { fontSize: 14, color: "#141414" },
                paragraphStyle: { bulletCharacter: "•" },
              },
              {
                target: { name: "weekly-risks" },
                rowIndex: 0,
                kind: "risks",
                nativeBullets: true,
                textStyle: { fontSize: 14, color: "#141414" },
                paragraphStyle: { bulletCharacter: "•" },
              },
            ],
          },
        },
      };
      const frameMap = {
        outputSlides: [
          { outputSlide: 1, narrativeRole: "roadmap-executive", editTargets: [] },
          { outputSlide: 2, narrativeRole: "roadmap-capability", editTargets: [] },
          {
            outputSlide: 3,
            narrativeRole: "markitecture",
            editTargets: [
              {
                action: "rewrite",
                sourceElementName: "markitecture-title",
              },
              ...[
                "node.operator",
                "node.sandbox",
                "connector.operator-sandbox",
                "connector.operator-sandbox:label",
              ].map((contentId) => ({
                action: "add",
                contentId,
                newPrimitiveAllowed: true,
                mustNotOverlapInherited: true,
                zone: markitectureZone,
              })),
            ],
          },
          { outputSlide: 4, narrativeRole: "weekly-release", editTargets: [] },
        ],
      };
      const authoring = (await import(pathToFileURL(surface.modulePath).href)) as {
        applyManagedSlides(
          presentationValue: unknown,
          modelValue: unknown,
          roleMapValue: unknown,
          frameMapValue: unknown,
        ): void;
      };

      authoring.applyManagedSlides(presentation, model, roleMap, frameMap);

      expect(executiveTitle.text.value).toBe("NemoClaw Feature Roadmap");
      expect(executiveTitle.position).toEqual({ left: 10, top: 20, width: 100, height: 40 });
      expect(executiveOutcomes.text.value).toBe(
        "✓ Kubernetes In-Cluster: Qualify one external gateway workflow",
      );
      expect(executiveOutcomes.text.paragraphs[0].runs).toEqual([
        expect.objectContaining({
          run: "✓ Kubernetes In-Cluster:",
          textStyle: expect.objectContaining({ bold: true, underline: "none" }),
        }),
        expect.objectContaining({
          run: " Qualify one external gateway workflow",
          textStyle: expect.objectContaining({ color: "#5B5B5B", underline: "none" }),
        }),
      ]);
      expect(capabilityTitle.text.value).toBe("NemoClaw Feature Roadmap");
      expect(tableWrites.get("1:0")).toBe("Usability and Onboarding");
      expect(capabilityCell.text.value).toBe("✓ Kubernetes In-Cluster (#9816)");
      expect(capabilityCell.text.ranges).toEqual([
        expect.objectContaining({
          text: "#9816",
          link: {
            uri: "https://github.com/NVIDIA/NemoClaw/issues/9816",
            isExternal: true,
          },
          underline: "none",
          color: "#76B900",
        }),
      ]);
      expect(markitectureTitle.text.value).toBe("NemoClaw system flow");
      expect(
        markitectureSlide.addedShapes.filter((shape) =>
          String(shape.name).startsWith("nemoclaw:node."),
        ),
      ).toHaveLength(2);
      expect(markitectureSlide.addedShapes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "nemoclaw:connector.operator-sandbox:label",
          }),
        ]),
      );
      expect(markitectureSlide.connectors).toEqual([
        expect.objectContaining({
          name: "nemoclaw:connector.operator-sandbox",
          options: expect.objectContaining({
            tail: { type: "triangle", width: "med", length: "med" },
          }),
          reboundFrom: expect.objectContaining({ index: 0 }),
          reboundTo: expect.objectContaining({ index: 1 }),
        }),
      ]);
      expect(
        markitectureSlide.addedShapes
          .filter((shape) => String(shape.name).startsWith("nemoclaw-staging:"))
          .every((shape) => shape.deleted),
      ).toBe(true);
      expect(weeklyTitle.text.value).toBe("NemoClaw Weekly Executive Scorecard");
      expect(latestRelease.text.value).toBe("v1.2.3");
      expect(weeklyLabel.text.value).toBe("GTC\nBERLIN");
      expect(weeklyUpdates.text.value).toBe("Kubernetes: Qualification completed");
      expect(weeklyUpdates.text.paragraphs[0]).toMatchObject({
        paragraphStyle: { bulletCharacter: "•" },
      });
      expect(weeklyRisks.text.value).toBe("None");
      expect(slides.map((slide) => slide.notes)).toEqual([
        { text: "executive notes", visible: false },
        { text: "capability notes", visible: false },
        { text: "markitecture notes", visible: false },
        { text: "weekly notes", visible: false },
      ]);
    } finally {
      fs.rmSync(surface?.directory ?? temp, { recursive: true, force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects invalid raw geometry before comparison normalization can conceal it", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-raw-layout-fidelity-"));
    const workflowWorkspace = path.join(temp, "workflow");
    const starterLayoutDir = path.join(temp, "starter");
    const finalLayoutDir = path.join(temp, "final");
    const comparisonLayoutDir = path.join(workflowWorkspace, "template-fidelity-starter-layout");
    const mustNotRun = path.join(temp, "must-not-run");
    fs.mkdirSync(workflowWorkspace);
    fs.mkdirSync(starterLayoutDir);
    fs.mkdirSync(finalLayoutDir);
    const starterElement = {
      order: 1,
      kind: "shape",
      name: "weekly-source",
      bbox: [80, 180, 200, 30],
      fillColor: "#FFFFFF",
      paragraphs: [{ text: "SOURCE", runs: [{ text: "SOURCE", color: "#666666" }] }],
    };
    const finalElement = structuredClone(starterElement);
    finalElement.bbox = [101, 200, 300, 40];
    const starter = { inheritedLayers: [], elements: [starterElement] };
    const final = { inheritedLayers: [], elements: [finalElement] };
    const frameMap = {
      outputSlides: [
        {
          outputSlide: 1,
          narrativeRole: "weekly-release",
          editTargets: [{ action: "rewrite-and-reposition", sourceElementName: "weekly-source" }],
        },
      ],
    };
    fs.writeFileSync(
      path.join(starterLayoutDir, "starter-slide-01.layout.json"),
      JSON.stringify(starter),
    );
    fs.writeFileSync(
      path.join(finalLayoutDir, "final-slide-01.layout.json"),
      JSON.stringify(final),
    );
    try {
      await expect(
        runTemplateFidelityWorkflow({
          runtime: {
            runtimeNode: mustNotRun,
            runtimeNodeModules: mustNotRun,
            runtimeBinDir: mustNotRun,
            skillDir: mustNotRun,
            tmpDir: mustNotRun,
          },
          workflow: {
            workspace: workflowWorkspace,
            frameMap: mustNotRun,
            inspect: mustNotRun,
            inspectManifest: mustNotRun,
            audit: mustNotRun,
            deviationLog: mustNotRun,
            starterPptx: mustNotRun,
            starterPreviewDir: mustNotRun,
            starterLayoutDir,
            finalLayoutDir,
          },
          frozenInputs: {
            templatePath: mustNotRun,
            modelPath: mustNotRun,
            roleMapPath: mustNotRun,
            frameMapPath: mustNotRun,
            inspectPath: mustNotRun,
          },
          frameMap,
          model: { slides: [{ role: "weekly-release" }] },
          roleMap: {
            roles: {
              "weekly-release": {
                geometryOperations: [
                  {
                    target: { name: "weekly-source" },
                    positionEmu: {
                      left: 952_500,
                      top: 1_905_000,
                      width: 2_857_500,
                      height: 381_000,
                    },
                  },
                ],
              },
            },
          },
          finalPptx: mustNotRun,
          authoringSurface: { directory: mustNotRun, modulePath: mustNotRun },
        }),
      ).rejects.toThrow(/integer-EMU geometry contract/u);
      expect(fs.existsSync(comparisonLayoutDir)).toBe(false);
      expect(fs.existsSync(mustNotRun)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
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
