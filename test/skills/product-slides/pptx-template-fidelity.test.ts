// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPLETED_EPIC_CONTEXT_COLOR,
  createTemplateFidelityStarterComparisonLayouts,
  createTemporaryPptxAuthoringSurface,
  freezePptxAuthoringInputs,
  templateSlideCountFromPptxBytes,
  validateTemplateSourceInventoryBinding,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts";
import { validateSingleSlideLayoutPair } from "./pptx-template-test-support";

describe("NemoClaw PowerPoint template authoring contracts", () => {
  it("freezes exact validated authoring inputs before any source path can change", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pptx-frozen-inputs-"));
    const runtimeNodeModules = path.join(temp, "runtime-node-modules");
    const templatePath = path.join(temp, "source-template.pptx");
    fs.mkdirSync(runtimeNodeModules);
    fs.writeFileSync(templatePath, "approved template bytes");
    let surface: Awaited<ReturnType<typeof createTemporaryPptxAuthoringSurface>> | undefined;
    try {
      const approvedTemplateBytes = fs.readFileSync(templatePath);
      surface = await createTemporaryPptxAuthoringSurface({ tmpDir: temp, runtimeNodeModules });
      const frozen = await freezePptxAuthoringInputs({
        surface,
        templateBytes: approvedTemplateBytes,
        modelBytes: Buffer.from('{"model":"approved"}'),
        roleMapBytes: Buffer.from('{"roleMap":"approved"}'),
        frameMapBytes: Buffer.from('{"frameMap":"approved"}'),
        inspectBytes: Buffer.from('{"kind":"slide","slide":1}\n'),
      });
      fs.writeFileSync(templatePath, "swapped template bytes");

      expect(fs.readFileSync(frozen.templatePath)).toEqual(approvedTemplateBytes);
      expect(fs.readFileSync(frozen.modelPath, "utf8")).toContain('"approved"');
      expect(fs.readFileSync(frozen.roleMapPath, "utf8")).toContain('"approved"');
      expect(fs.readFileSync(frozen.frameMapPath, "utf8")).toContain('"approved"');
      expect(fs.statSync(frozen.templatePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(surface?.directory ?? temp, { recursive: true, force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("binds the inspection inventory to the actual frozen PPTX slide parts", async () => {
    const fakeZip = {
      async loadAsync(bytes: Buffer) {
        expect(bytes.toString("utf8")).toBe("approved-pptx-bytes");
        return {
          files: Object.fromEntries(
            Array.from({ length: 8 }, (_value, index) => [`ppt/slides/slide${index + 1}.xml`, {}]),
          ),
        };
      },
    };
    const actualTemplateSlideCount = await templateSlideCountFromPptxBytes(
      fakeZip,
      Buffer.from("approved-pptx-bytes"),
    );
    expect(actualTemplateSlideCount).toBe(8);
    expect(() =>
      validateTemplateSourceInventoryBinding({
        manifest: {
          sourcePptx: "/tmp/template.pptx",
          slideCount: 7,
          packageParts: { slideXmlCount: 7 },
          slideArtifacts: Array.from({ length: 7 }, (_value, index) => ({ slide: index + 1 })),
        },
        actualTemplateSlideCount,
        templatePath: "/tmp/template.pptx",
      }),
    ).toThrow(/not bound to the exact approved template/u);
  });

  it("preserves rewrite typography and ordered rich-text style boundaries", async () => {
    const starter = {
      order: 1,
      kind: "shape",
      scope: "slide",
      aid: "sh/source",
      id: "1",
      name: "Managed title",
      bbox: [0, 0, 400, 80],
      geometry: "rect",
      text: "NemoClaw roadmap",
      textPreview: "NemoClaw roadmap",
      resolvedTextStyle: { fontSize: 80, color: "accent1", alignment: "left" },
      paragraphs: [
        {
          index: 1,
          text: "NemoClaw roadmap",
          resolvedTextStyle: { alignment: "left" },
          runs: [
            { index: 1, text: "NemoClaw", fontSize: 80, color: "#76B900" },
            { index: 2, text: " roadmap", fontSize: 80, color: "#141414" },
          ],
        },
      ],
      fillColor: "#FFFFFF",
      lineWidth: 0,
    };
    const final = structuredClone(starter);
    final.aid = "sh/exported";
    final.id = "77";
    final.text = "NemoClaw current roadmap";
    final.textPreview = "NemoClaw current roadmap";
    final.paragraphs[0].text = "NemoClaw current roadmap";
    final.paragraphs[0].runs[1].text = " current roadmap";
    Object.assign(final.paragraphs[0], { bulletCharacter: "" });
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final,
        editTargets: [{ action: "rewrite", sourceElementName: "Managed title" }],
      }),
    ).resolves.toBeUndefined();

    const lostStyle = structuredClone(final);
    Reflect.deleteProperty(lostStyle.paragraphs[0].runs[0], "fontSize");
    Reflect.deleteProperty(lostStyle.paragraphs[0].runs[0], "color");
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: lostStyle,
        editTargets: [{ action: "rewrite", sourceElementName: "Managed title" }],
      }),
    ).rejects.toThrow(/changes protected source object/u);

    const swappedStyles = structuredClone(final);
    const firstStyle = {
      fontSize: swappedStyles.paragraphs[0].runs[0].fontSize,
      color: swappedStyles.paragraphs[0].runs[0].color,
    };
    swappedStyles.paragraphs[0].runs[0].fontSize = swappedStyles.paragraphs[0].runs[1].fontSize;
    swappedStyles.paragraphs[0].runs[0].color = swappedStyles.paragraphs[0].runs[1].color;
    swappedStyles.paragraphs[0].runs[1].fontSize = firstStyle.fontSize;
    swappedStyles.paragraphs[0].runs[1].color = firstStyle.color;
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: swappedStyles,
        editTargets: [{ action: "rewrite", sourceElementName: "Managed title" }],
      }),
    ).rejects.toThrow(/changes protected source object/u);

    const nonemptyBullet = structuredClone(final);
    Object.assign(nonemptyBullet.paragraphs[0], { bulletCharacter: "•" });
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: nonemptyBullet,
        editTargets: [{ action: "rewrite", sourceElementName: "Managed title" }],
      }),
    ).rejects.toThrow(/changes protected source object/u);
  });

  it("allows repeated variable paragraphs without relaxing run or paragraph styles", async () => {
    const paragraph = {
      index: 1,
      text: "First outcome",
      lineSpacingPercent: 92_000,
      resolvedTextStyle: { alignment: "left" },
      bulletCharacter: "●",
      marginLeft: 355_600,
      indent: -406_400,
      spaceBefore: 1_800,
      spaceAfter: 0,
      runs: [
        { index: 1, text: "Prefix", fontSize: 24, color: "#76B900" },
        { index: 2, text: " continued", fontSize: 24, color: "#76B900" },
        { index: 3, text: " outcome", fontSize: 24, color: "#141414" },
      ],
    };
    const starter = {
      order: 1,
      kind: "shape",
      scope: "slide",
      name: "Managed outcomes",
      bbox: [0, 0, 400, 160],
      geometry: "rect",
      text: "First outcome",
      paragraphs: [paragraph],
    };
    const final = structuredClone(starter);
    final.text = "First outcome\nSecond outcome";
    final.paragraphs = [
      paragraph,
      {
        ...structuredClone(paragraph),
        index: 2,
        text: "Second outcome",
        runs: [
          { ...paragraph.runs[0], index: 1, text: "Second" },
          { ...paragraph.runs[2], index: 2, text: " outcome" },
        ],
      },
    ];
    const editTargets = [{ action: "rewrite", sourceElementName: "Managed outcomes" }];
    const variableRoleContract = {
      outcomeListOperations: [{ target: { name: "Managed outcomes" } }],
    };

    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final,
        editTargets,
        roleContract: variableRoleContract,
      }),
    ).resolves.toBeUndefined();
    await expect(validateSingleSlideLayoutPair({ starter, final, editTargets })).rejects.toThrow(
      /changes protected source object/u,
    );

    const swappedRunStyles = structuredClone(final);
    swappedRunStyles.paragraphs[1].runs[0].color = "#141414";
    swappedRunStyles.paragraphs[1].runs[1].color = "#76B900";
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: swappedRunStyles,
        editTargets,
        roleContract: variableRoleContract,
      }),
    ).rejects.toThrow(/changes protected source object/u);

    const missingBullet = structuredClone(final);
    delete (missingBullet.paragraphs[1] as Partial<typeof paragraph>).bulletCharacter;
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: missingBullet,
        editTargets,
        roleContract: variableRoleContract,
      }),
    ).rejects.toThrow(/changes protected source object/u);

    const changedSpacing = structuredClone(final);
    changedSpacing.paragraphs[1].spaceBefore = 0;
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: changedSpacing,
        editTargets,
        roleContract: variableRoleContract,
      }),
    ).rejects.toThrow(/changes protected source object/u);
  });

  it("allows only the declared muted context style for completed executive Epics", async () => {
    const paragraphStyle = {
      lineSpacingPercent: 92_000,
      bulletCharacter: "●",
      marginLeft: 355_600,
      indent: -406_400,
      spaceBefore: 1_800,
      spaceAfter: 0,
    };
    const paragraph = (label: string, context: string, contextColor: string) => ({
      ...paragraphStyle,
      text: `${label} ${context}`,
      runs: [
        { text: label, fontSize: 24, color: "#141414", bold: true },
        { text: ` ${context}`, fontSize: 24, color: contextColor },
      ],
    });
    const starter = {
      order: 1,
      kind: "shape",
      scope: "slide",
      name: "Managed outcomes",
      bbox: [0, 0, 400, 160],
      geometry: "rect",
      text: "Guided onboarding: Start agents in OpenShell sandboxes.",
      paragraphs: [
        paragraph("Guided onboarding:", "Start agents in OpenShell sandboxes.", "#141414"),
      ],
    };
    const final = structuredClone(starter);
    final.text =
      "Guided onboarding: Start agents in OpenShell sandboxes.\n✓ Agent routing: Route work through the selected model path.";
    final.paragraphs = [
      paragraph("Guided onboarding:", "Start agents in OpenShell sandboxes.", "#141414"),
      paragraph(
        "✓ Agent routing:",
        "Route work through the selected model path.",
        COMPLETED_EPIC_CONTEXT_COLOR,
      ),
    ];
    const editTargets = [{ action: "rewrite", sourceElementName: "Managed outcomes" }];
    const roleContract = {
      outcomeListOperations: [
        {
          target: { name: "Managed outcomes" },
          outcomesPath: "milestones.0.outcomes",
          textStyle: { fontSize: 24, color: "#141414" },
          textFrameStyle: { lineSpacing: 0.92 },
          paragraphStyles: [paragraphStyle],
        },
      ],
    };
    const modelSlide = {
      role: "roadmap-executive",
      milestones: [
        {
          outcomes: [{ state: "OPEN" }, { state: "CLOSED" }],
        },
      ],
    };

    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final,
        editTargets,
        roleContract,
        modelSlide,
      }),
    ).resolves.toBeUndefined();

    const unapprovedMutedColor = structuredClone(final);
    unapprovedMutedColor.paragraphs[1].runs[1].color = "#777777";
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: unapprovedMutedColor,
        editTargets,
        roleContract,
        modelSlide,
      }),
    ).rejects.toThrow(/changes protected source object/u);
  });

  it("allows momentum paragraphs to reuse only approved template style profiles", async () => {
    const starter = {
      order: 1,
      kind: "shape",
      scope: "slide",
      name: "Managed momentum",
      bbox: [0, 0, 400, 160],
      geometry: "rect",
      text: "Stars 100 | Forks 20",
      paragraphs: [
        {
          index: 1,
          text: "Stars 100 | Forks 20",
          lineSpacingPercent: 115000,
          resolvedTextStyle: { alignment: "left" },
          runs: [
            { index: 1, text: "Stars ", fontSize: 48, color: "#666666", bold: true },
            { index: 2, text: "100", fontSize: 56, color: "#4F7E00", bold: true },
            { index: 3, text: " | Forks ", fontSize: 48, color: "#666666", bold: true },
            { index: 4, text: "20", fontSize: 56, color: "#4F7E00", bold: true },
          ],
        },
      ],
    };
    const final = structuredClone(starter);
    final.text = "Stars 105\nForks 22";
    final.paragraphs = [
      {
        ...structuredClone(starter.paragraphs[0]),
        index: 1,
        text: "Stars 105",
        runs: [
          { ...starter.paragraphs[0].runs[0], index: 1, text: "Stars " },
          { ...starter.paragraphs[0].runs[1], index: 2, text: "105" },
        ],
      },
      {
        ...structuredClone(starter.paragraphs[0]),
        index: 2,
        text: "Forks 22",
        runs: [
          { ...starter.paragraphs[0].runs[0], index: 1, text: "Forks " },
          { ...starter.paragraphs[0].runs[1], index: 2, text: "22" },
        ],
      },
    ];
    const editTargets = [{ action: "rewrite", sourceElementName: "Managed momentum" }];
    const roleContract = {
      metricOperations: [{ kind: "momentum", target: { name: "Managed momentum" } }],
    };

    await expect(
      validateSingleSlideLayoutPair({ starter, final, editTargets, roleContract }),
    ).resolves.toBeUndefined();

    const changedStyle = structuredClone(final);
    changedStyle.paragraphs[1].runs[1].fontSize = 44;
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: changedStyle,
        editTargets,
        roleContract,
      }),
    ).rejects.toThrow(/changes protected source object/u);
  });

  it("ignores exporter metadata loss only for whitespace-only rewrite runs", async () => {
    const paragraphStyle = {
      lineSpacingPercent: 115000,
      resolvedTextStyle: { alignment: "left" },
    };
    const styledRun = {
      fontSize: 42.67,
      color: "#303030",
      alignment: "left",
    };
    const starter = {
      order: 1,
      kind: "shape",
      scope: "slide",
      name: "Managed context",
      bbox: [0, 0, 400, 120],
      geometry: "rect",
      text: "Stable release: v1\nAnnouncement: shipped",
      paragraphs: [
        {
          index: 1,
          text: "Stable release: v1",
          ...paragraphStyle,
          runs: [{ index: 1, text: "Stable release: v1", ...styledRun }],
        },
        {
          index: 2,
          text: "Announcement: shipped",
          ...paragraphStyle,
          runs: [{ index: 1, text: "Announcement: shipped", ...styledRun }],
        },
      ],
    };
    const final = structuredClone(starter);
    final.paragraphs = [
      {
        index: 1,
        text: "Stable release: v2\nAnnouncement: fixed",
        ...paragraphStyle,
        runs: [
          { index: 1, text: "Stable release: v2", ...styledRun },
          { index: 2, text: "\n", ...styledRun },
          { index: 3, text: "Announcement: fixed", ...styledRun },
        ],
      },
    ];
    Reflect.deleteProperty(final.paragraphs[0].runs[1], "fontSize");
    Reflect.deleteProperty(final.paragraphs[0].runs[1], "color");
    final.text = final.paragraphs[0].text;
    const editTargets = [{ action: "rewrite", sourceElementName: "Managed context" }];
    const roleContract = {
      milestoneRowOperations: [
        {
          target: { name: "Managed context" },
          rowIndex: 0,
          kind: "updates",
          textStyle: { fontSize: 42.67, color: "#303030" },
          textFrameStyle: { alignment: "left", lineSpacing: 1.15 },
        },
      ],
    };

    await expect(
      validateSingleSlideLayoutPair({ starter, final, editTargets, roleContract }),
    ).resolves.toBeUndefined();

    const unstyledVisibleRun = structuredClone(final);
    unstyledVisibleRun.paragraphs[0].runs[1].text = "visible";
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: unstyledVisibleRun,
        editTargets,
        roleContract,
      }),
    ).rejects.toThrow(/changes protected source object/u);
  });

  it("normalizes table anchors without hiding protected cell content, geometry, or style drift", async () => {
    const starter = {
      order: 1,
      kind: "table",
      scope: "slide",
      aid: "tb/source",
      id: "1",
      name: "Protected table",
      bbox: [0, 0, 400, 200],
      rows: 1,
      cols: 1,
      cells: [
        {
          index: 1,
          row: 1,
          column: 1,
          bbox: [0, 0, 400, 200],
          text: "Protected text",
          textPreview: "Protected text",
          fillColor: "#FFFFFF",
          ownedElementAids: ["sh/source-cell"],
          paragraphs: [
            {
              index: 1,
              text: "Protected text",
              runs: [{ index: 1, text: "Protected text", fontSize: 32, color: "#141414" }],
            },
          ],
          tableCell: { tableAid: "tb/source", cellIndex: 0 },
        },
      ],
    };
    const final = structuredClone(starter);
    final.aid = "tb/exported";
    final.id = "99";
    final.cells[0].ownedElementAids = ["sh/exported-cell"];
    final.cells[0].tableCell.tableAid = "tb/exported";
    Object.assign(final.cells[0].paragraphs[0], { bulletCharacter: "" });
    await expect(
      validateSingleSlideLayoutPair({ starter, final, editTargets: [] }),
    ).resolves.toBeUndefined();

    const changedText = structuredClone(final);
    changedText.cells[0].text = "Changed protected text";
    await expect(
      validateSingleSlideLayoutPair({ starter, final: changedText, editTargets: [] }),
    ).rejects.toThrow(/changes protected source object/u);

    const changedGeometry = structuredClone(final);
    changedGeometry.cells[0].bbox[2] = 399;
    await expect(
      validateSingleSlideLayoutPair({ starter, final: changedGeometry, editTargets: [] }),
    ).rejects.toThrow(/changes protected source object/u);

    const changedStyle = structuredClone(final);
    changedStyle.cells[0].paragraphs[0].runs[0].fontSize = 31;
    await expect(
      validateSingleSlideLayoutPair({ starter, final: changedStyle, editTargets: [] }),
    ).rejects.toThrow(/changes protected source object/u);
  });

  it("allows only exact frame-authorized integer-EMU repositioning", async () => {
    const starter = {
      order: 1,
      kind: "shape",
      name: "weekly-source",
      bbox: [80, 180, 200, 30],
      fillColor: "#FFFFFF",
      paragraphs: [{ text: "SOURCE", runs: [{ text: "SOURCE", color: "#666666" }] }],
    };
    const final = structuredClone(starter);
    final.bbox = [100, 200, 300, 40];
    const editTargets = [{ action: "rewrite-and-reposition", sourceElementName: "weekly-source" }];
    const roleContract = {
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
    };

    await expect(
      validateSingleSlideLayoutPair({ starter, final, editTargets, roleContract }),
    ).resolves.toBeUndefined();

    const wrongGeometry = structuredClone(final);
    wrongGeometry.bbox[0] = 101;
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: wrongGeometry,
        editTargets,
        roleContract,
      }),
    ).rejects.toThrow(/integer-EMU geometry contract/u);

    const nonnumericGeometry = structuredClone(final);
    Reflect.set(nonnumericGeometry.bbox, 0, "100");
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: nonnumericGeometry,
        editTargets,
        roleContract,
      }),
    ).rejects.toThrow(/lacks an exact integer-EMU geometry contract/u);

    const changedStyle = structuredClone(final);
    changedStyle.fillColor = "#EFEFEF";
    await expect(
      validateSingleSlideLayoutPair({ starter, final: changedStyle, editTargets, roleContract }),
    ).rejects.toThrow(/changes protected source object/u);
  });

  it("normalizes only authorized reposition geometry for the standard fidelity overlay scan", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fidelity-comparison-"));
    const starterLayoutDir = path.join(temp, "starter");
    const finalLayoutDir = path.join(temp, "final");
    const comparisonLayoutDir = path.join(temp, "comparison");
    fs.mkdirSync(starterLayoutDir);
    fs.mkdirSync(finalLayoutDir);
    const starter = {
      elements: [
        { name: "authorized-panel", bbox: [10, 10, 100, 40], fillColor: "#EFEFEF" },
        { name: "protected-heading", bbox: [20, 20, 60, 20], text: "Heading" },
      ],
    };
    const final = {
      elements: [
        { name: "authorized-panel", bbox: [10, 10, 100, 80], fillColor: "#EFEFEF" },
        { name: "protected-heading", bbox: [25, 25, 60, 20], text: "Heading" },
        { name: "unplanned-mask", bbox: [0, 0, 400, 200], fillColor: "#FFFFFF" },
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
      await createTemplateFidelityStarterComparisonLayouts({
        frameMap: {
          outputSlides: [
            {
              outputSlide: 1,
              editTargets: [
                {
                  action: "rewrite-and-reposition",
                  sourceElementName: "authorized-panel",
                },
                { action: "rewrite", sourceElementName: "protected-heading" },
              ],
            },
          ],
        },
        starterLayoutDir,
        finalLayoutDir,
        comparisonLayoutDir,
      });
      const comparison = JSON.parse(
        fs.readFileSync(path.join(comparisonLayoutDir, "starter-slide-01.layout.json"), "utf8"),
      );
      expect(comparison.elements).toEqual([
        { ...starter.elements[0], bbox: final.elements[0].bbox },
        starter.elements[1],
      ]);
      expect(comparison.elements).not.toContainEqual(final.elements[2]);
      expect(fs.statSync(comparisonLayoutDir).mode & 0o777).toBe(0o700);
      expect(
        fs.statSync(path.join(comparisonLayoutDir, "starter-slide-01.layout.json")).mode & 0o777,
      ).toBe(0o600);

      await expect(
        createTemplateFidelityStarterComparisonLayouts({
          frameMap: {
            outputSlides: [
              {
                outputSlide: 1,
                editTargets: [
                  {
                    action: "rewrite-and-reposition",
                    sourceElementName: "missing-panel",
                  },
                ],
              },
            ],
          },
          starterLayoutDir,
          finalLayoutDir,
          comparisonLayoutDir: path.join(temp, "missing-comparison"),
        }),
      ).rejects.toThrow(/cannot resolve authorized reposition target missing-panel/u);

      const malformedFinal = structuredClone(final);
      malformedFinal.elements[0].bbox = [10, 10, "wide", 80] as unknown as number[];
      fs.writeFileSync(
        path.join(finalLayoutDir, "final-slide-01.layout.json"),
        JSON.stringify(malformedFinal),
      );
      await expect(
        createTemplateFidelityStarterComparisonLayouts({
          frameMap: {
            outputSlides: [
              {
                outputSlide: 1,
                editTargets: [
                  {
                    action: "rewrite-and-reposition",
                    sourceElementName: "authorized-panel",
                  },
                ],
              },
            ],
          },
          starterLayoutDir,
          finalLayoutDir,
          comparisonLayoutDir: path.join(temp, "malformed-comparison"),
        }),
      ).rejects.toThrow(/cannot resolve authorized reposition target authorized-panel/u);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("accepts a declared no-bullet paragraph style on a rewritten milestone label", async () => {
    const starter = {
      order: 1,
      kind: "shape",
      name: "weekly-label",
      bbox: [0, 0, 300, 80],
      paragraphs: [
        {
          text: "Template milestone",
          lineSpacingPercent: 115_000,
          resolvedTextStyle: { alignment: "left" },
          runs: [{ text: "Template milestone", fontSize: 42.67, color: "#303030" }],
        },
      ],
    };
    const final = structuredClone(starter);
    Object.assign(final.paragraphs[0], {
      text: "Q3",
      bulletCharacter: "",
      runs: [{ text: "Q3", fontSize: 42.67, color: "#303030" }],
    });
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final,
        editTargets: [{ action: "rewrite", sourceElementName: "weekly-label" }],
        roleContract: {
          milestoneRowOperations: [
            {
              target: { name: "weekly-label" },
              rowIndex: 0,
              kind: "label",
              textStyle: { fontSize: 42.67, color: "#303030" },
              paragraphStyle: { bulletCharacter: "" },
              textFrameStyle: { alignment: "left", lineSpacing: 1.15 },
            },
          ],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts only the declared text-frame vertical alignment on a rewritten source rail", async () => {
    const starter = {
      order: 1,
      kind: "shape",
      name: "weekly-source",
      bbox: [0, 0, 300, 80],
      resolvedTextStyle: {
        anchor: 2,
        verticalAlignment: "middle",
        fontSize: 24,
        color: "#666666",
      },
      paragraphs: [
        {
          text: "Source: template",
          resolvedTextStyle: { alignment: "right" },
          runs: [{ text: "Source: template", fontSize: 24, color: "#666666" }],
        },
      ],
    };
    const final = structuredClone(starter);
    Object.assign(final.resolvedTextStyle, { anchor: 1, verticalAlignment: "top" });
    final.paragraphs[0].text = "Source: NVIDIA/NemoClaw";
    final.paragraphs[0].runs[0].text = "Source: NVIDIA/NemoClaw";
    const options = {
      starter,
      final,
      editTargets: [{ action: "rewrite", sourceElementName: "weekly-source" }],
      roleContract: {
        operations: [
          {
            target: { name: "weekly-source" },
            valuePath: "sourceLabel",
            textStyle: { fontSize: 24, color: "#666666" },
            textFrameStyle: { alignment: "right", verticalAlignment: "top" },
          },
        ],
      },
      modelSlide: { role: "weekly-release", sourceLabel: "Source: NVIDIA/NemoClaw" },
    };
    await expect(validateSingleSlideLayoutPair(options)).resolves.toBeUndefined();

    const wrongAnchor = structuredClone(final);
    wrongAnchor.resolvedTextStyle.anchor = 2;
    await expect(validateSingleSlideLayoutPair({ ...options, final: wrongAnchor })).rejects.toThrow(
      /declared text-frame anchor/u,
    );

    const unrelatedStyleDrift = structuredClone(final);
    unrelatedStyleDrift.resolvedTextStyle.fontSize = 30;
    await expect(
      validateSingleSlideLayoutPair({ ...options, final: unrelatedStyleDrift }),
    ).rejects.toThrow(/changes protected source object/u);
  });

  it("permits an exactly authorized unused final-page executive target to be deleted", async () => {
    const starter = {
      order: 1,
      kind: "shape",
      name: "third-outcome-list",
      bbox: [0, 0, 300, 200],
      geometry: "rect",
      resolvedFontSize: 36,
      paragraphs: [
        {
          text: "Template outcome",
          bulletCharacter: "●",
          runs: [{ text: "Template outcome", fontSize: 48, color: "#141414" }],
        },
      ],
    };
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: [],
        editTargets: [{ action: "delete", sourceElementName: "third-outcome-list" }],
      }),
    ).resolves.toBeUndefined();
  });

  it("requires an unused final-page capability HOME_PLATE shape to be deleted", async () => {
    const starter = {
      order: 1,
      kind: "shape",
      name: "second-capability-title",
      bbox: [0, 0, 300, 100],
      geometry: "homePlate",
      paragraphs: [
        {
          text: "GTC Berlin",
          runs: [{ text: "GTC Berlin", fontSize: 48, color: "#FFFFFF" }],
        },
      ],
    };
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: [],
        editTargets: [{ action: "delete", sourceElementName: "second-capability-title" }],
        modelSlide: {
          role: "roadmap-capability",
          instanceId: "roadmap-capability.2",
          columns: [{ title: "Only milestone" }],
          unclassified: [],
        },
      }),
    ).resolves.toBeUndefined();

    const { paragraphs: _paragraphs, ...emptyShape } = structuredClone(starter);
    await expect(
      validateSingleSlideLayoutPair({
        starter,
        final: emptyShape,
        editTargets: [{ action: "rewrite", sourceElementName: "second-capability-title" }],
        roleContract: {
          operations: [
            {
              target: { name: "second-capability-title" },
              valuePath: "columns.1.title",
            },
          ],
        },
        modelSlide: {
          role: "roadmap-capability",
          instanceId: "roadmap-capability.2",
          columns: [{ title: "Only milestone" }],
          unclassified: [],
        },
      }),
    ).rejects.toThrow(/changes protected source object/u);
  });

  it("allows table content density to change while preserving top-row, area, and body styles", async () => {
    const paragraph = (text: string, color: string, bold = false) => ({
      index: 1,
      text,
      lineSpacingPercent: 90000,
      resolvedTextStyle: { alignment: "left" },
      runs: [{ index: 1, text, fontSize: 32, color, ...(bold ? { bold: true } : {}) }],
    });
    const starter = {
      order: 1,
      kind: "table",
      scope: "slide",
      name: "Managed table",
      bbox: [0, 0, 400, 200],
      rows: 2,
      cols: 2,
      cells: [
        {
          index: 1,
          row: 1,
          column: 1,
          bbox: [0, 0, 100, 50],
          text: "",
          fillColor: "#9E9E9E",
          paragraphs: [paragraph("", "#FFFFFF", true)],
        },
        {
          index: 2,
          row: 1,
          column: 2,
          bbox: [100, 0, 300, 50],
          text: "",
          fillColor: "#9E9E9E",
          paragraphs: [paragraph("", "#FFFFFF", true)],
        },
        {
          index: 3,
          row: 2,
          column: 1,
          bbox: [0, 50, 100, 150],
          text: "Area\nlabel",
          fillColor: "#76B900",
          paragraphs: [paragraph("Area", "#FFFFFF"), paragraph("label", "#FFFFFF")],
        },
        {
          index: 4,
          row: 2,
          column: 2,
          bbox: [100, 50, 300, 150],
          text: "One\nTwo",
          fillColor: "#EFEFEF",
          paragraphs: [
            {
              ...paragraph("One", "#141414"),
              runs: [
                { index: 1, text: "O", fontSize: 32, color: "#141414" },
                { index: 2, text: "ne", fontSize: 32, color: "#141414" },
              ],
            },
            paragraph("Two", "#303030"),
          ],
        },
      ],
    };
    const final = structuredClone(starter);
    final.cells[2].text = "Current area";
    final.cells[2].paragraphs = [paragraph("Current area", "#FFFFFF")];
    final.cells[3].text = "Current outcome";
    final.cells[3].paragraphs = [paragraph("Current outcome", "#141414")];
    const editTargets = [{ action: "rewrite", sourceElementName: "Managed table" }];

    await expect(
      validateSingleSlideLayoutPair({ starter, final, editTargets }),
    ).resolves.toBeUndefined();

    const changedStyle = structuredClone(final);
    changedStyle.cells[3].paragraphs[0].runs[0].fontSize = 30;
    await expect(
      validateSingleSlideLayoutPair({ starter, final: changedStyle, editTargets }),
    ).rejects.toThrow(/changes protected source object/u);
  });
});
