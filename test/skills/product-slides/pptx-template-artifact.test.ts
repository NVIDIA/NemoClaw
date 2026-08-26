// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  COMPLETED_EPIC_CONTEXT_COLOR,
  connectorInventoryFromSlideXml,
  formatSignedMetricDetail,
  validateCapabilityEpicCompletionFromSlideXml,
  validateNativeConnectorInventory,
  validateRoadmapEpicCompletionFromSlideXml,
  validateRoadmapOutcomeParagraphsFromSlideXml,
  validateTemplateThemePackageContract,
  validateWeeklyMilestoneParagraphsFromSlideXml,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts";
import {
  expectedNativeConnectors,
  nativeConnectorSlide,
  validateSingleSlideLayoutPair,
} from "./pptx-template-test-support";

describe("NemoClaw PowerPoint template authoring contracts", () => {
  it("requires exported markitecture connectors to remain behind entity nodes", async () => {
    const protectedTitle = {
      order: 1,
      kind: "shape",
      scope: "slide",
      aid: "sh/title",
      id: "1",
      name: "Protected title",
      bbox: [0, 0, 400, 80],
      geometry: "rect",
      text: "Title",
      paragraphs: [{ index: 1, text: "Title", runs: [{ index: 1, text: "Title" }] }],
    };
    const connector = {
      order: 1,
      kind: "connector",
      scope: "slide",
      name: "nemoclaw:connector.operator-host",
    };
    const node = {
      order: 2,
      kind: "shape",
      scope: "slide",
      name: "nemoclaw:node.operator",
    };
    const editTargets = [
      { action: "add", contentIds: ["connector.operator-host", "node.operator"] },
    ];
    await expect(
      validateSingleSlideLayoutPair({
        starter: [protectedTitle],
        final: [{ ...protectedTitle, order: 3 }, connector, node],
        editTargets,
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateSingleSlideLayoutPair({
        starter: [protectedTitle],
        final: [
          { ...protectedTitle, order: 3 },
          { ...connector, order: 2 },
          { ...node, order: 1 },
        ],
        editTargets,
      }),
    ).rejects.toThrow(/places connectors above entity nodes/u);
  });

  it.each([
    [0, "+0"],
    [1_000, "+1,000"],
    [-1_000, "-1,000"],
  ])("formats signed metric detail %s as %s", (value, expected) => {
    expect(formatSignedMetricDetail(value)).toBe(expected);
  });

  it("requires native roadmap bullets, indents, spacing, and line height in the exported PPTX", () => {
    const paragraph = (spaceBefore: number) =>
      `<a:p><a:pPr marL="355600" indent="-406400" algn="l"><a:lnSpc><a:spcPct val="92000" /></a:lnSpc><a:spcBef><a:spcPts val="${spaceBefore}" /></a:spcBef><a:spcAft><a:spcPts val="0" /></a:spcAft><a:buChar char="●" /></a:pPr><a:r><a:t>Outcome</a:t></a:r></a:p>`;
    const slideXml = `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Managed outcomes" /></p:nvSpPr><p:txBody>${paragraph(1800)}${paragraph(1000)}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const operations = [
      {
        target: { name: "Managed outcomes" },
        outcomesPath: "milestones.0.outcomes",
        textFrameStyle: { lineSpacing: 0.92 },
        paragraphStyles: [
          {
            bulletCharacter: "●",
            marginLeft: 355_600,
            indent: -406_400,
            spaceBefore: 1_800,
            spaceAfter: 0,
          },
          {
            bulletCharacter: "●",
            marginLeft: 355_600,
            indent: -406_400,
            spaceBefore: 1_000,
            spaceAfter: 0,
          },
        ],
      },
    ];
    const slideModel = { milestones: [{ outcomes: [{}, {}] }] };

    expect(() =>
      validateRoadmapOutcomeParagraphsFromSlideXml(slideXml, operations, slideModel),
    ).not.toThrow();
    expect(() =>
      validateRoadmapOutcomeParagraphsFromSlideXml(
        slideXml.replace('<a:buChar char="●" />', "<a:buNone />"),
        operations,
        slideModel,
      ),
    ).toThrow(/changes its native bullet/u);
    expect(() =>
      validateRoadmapOutcomeParagraphsFromSlideXml(
        slideXml.replace('val="1800"', 'val="0"'),
        operations,
        slideModel,
      ),
    ).toThrow(/changes spaceBefore/u);
  });

  it("requires native weekly bullets for updates and the synthesized None risk", () => {
    const paragraph = (text: string) =>
      `<a:p><a:pPr><a:buChar char="•" /></a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`;
    const shape = (name: string, body: string) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="1" name="${name}" /></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;
    const slideXml = `<p:sld><p:cSld><p:spTree>${shape("weekly-updates", paragraph("Installer: Ready for validation"))}${shape("weekly-risks", paragraph("None"))}</p:spTree></p:cSld></p:sld>`;
    const operations = [
      {
        target: { name: "weekly-updates" },
        rowIndex: 0,
        kind: "updates",
        nativeBullets: true,
        paragraphStyle: { bulletCharacter: "•" },
      },
      {
        target: { name: "weekly-risks" },
        rowIndex: 0,
        kind: "risks",
        nativeBullets: true,
        paragraphStyle: { bulletCharacter: "•" },
      },
    ];
    const slideModel = {
      milestoneRows: [
        {
          updates: [{ label: "Installer", text: "Ready for validation" }],
          risks: [],
        },
      ],
    };

    expect(() =>
      validateWeeklyMilestoneParagraphsFromSlideXml(slideXml, operations, slideModel),
    ).not.toThrow();
    expect(() =>
      validateWeeklyMilestoneParagraphsFromSlideXml(
        slideXml.replace('<a:buChar char="•" />', "<a:buNone />"),
        operations,
        slideModel,
      ),
    ).toThrow(/not a native bullet/u);
    expect(() =>
      validateWeeklyMilestoneParagraphsFromSlideXml(
        slideXml.replace("Installer: Ready", "• Installer: Ready"),
        operations,
        slideModel,
      ),
    ).toThrow(/typed bullet text/u);
    expect(() =>
      validateWeeklyMilestoneParagraphsFromSlideXml(
        slideXml.replace("<a:t>None</a:t>", "<a:t>• None</a:t>"),
        operations,
        slideModel,
      ),
    ).toThrow(/typed bullet text/u);
  });

  it("requires native completed-Epic labels and muted regular executive context", () => {
    const run = (text: string, color: string, bold = false) =>
      `<a:r><a:rPr${bold ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${color}" /></a:solidFill></a:rPr><a:t>${text}</a:t></a:r>`;
    const paragraph = (label: string, context: string, contextColor: string) =>
      `<a:p>${run(label, "141414", true)}${run(` ${context}`, contextColor)}</a:p>`;
    const openParagraph = paragraph(
      "Guided onboarding:",
      "Start agents in OpenShell sandboxes with fewer manual steps.",
      "141414",
    );
    const completedParagraph = paragraph(
      "✓ Agent routing:",
      "Route work to the selected model path.",
      "5B5B5B",
    );
    const slideXml = [
      '<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Managed outcomes" /></p:nvSpPr><p:txBody>',
      openParagraph,
      completedParagraph,
      "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
    ].join("");
    const operations = [
      {
        target: { name: "Managed outcomes" },
        outcomesPath: "milestones.0.outcomes",
        textStyle: { color: "#141414" },
      },
    ];
    const slideModel = {
      milestones: [
        {
          outcomes: [
            {
              contentId: "epic.101",
              state: "OPEN",
              featureTitle: "Guided onboarding",
              text: "Start agents in OpenShell sandboxes with fewer manual steps.",
            },
            {
              contentId: "epic.103",
              state: "CLOSED",
              featureTitle: "Agent routing",
              text: "Route work to the selected model path.",
            },
          ],
        },
      ],
    };

    expect(COMPLETED_EPIC_CONTEXT_COLOR).toBe("#5B5B5B");
    expect(() =>
      validateRoadmapEpicCompletionFromSlideXml(slideXml, operations, slideModel),
    ).not.toThrow();
    expect(() =>
      validateRoadmapEpicCompletionFromSlideXml(
        slideXml.replace("✓ Agent routing:", "Agent routing:"),
        operations,
        slideModel,
      ),
    ).toThrow(/changes its label state/u);
    expect(() =>
      validateRoadmapEpicCompletionFromSlideXml(
        slideXml.replace('val="5B5B5B"', 'val="141414"'),
        operations,
        slideModel,
      ),
    ).toThrow(/changes its context state/u);
    expect(() =>
      validateRoadmapEpicCompletionFromSlideXml(
        slideXml.replace(
          '<a:rPr><a:solidFill><a:srgbClr val="5B5B5B"',
          '<a:rPr b="1"><a:solidFill><a:srgbClr val="5B5B5B"',
        ),
        operations,
        slideModel,
      ),
    ).toThrow(/changes its context state/u);
    expect(() =>
      validateRoadmapEpicCompletionFromSlideXml(
        slideXml.replace("Guided onboarding:", "✓ Guided onboarding:"),
        operations,
        slideModel,
      ),
    ).toThrow(/changes its label state/u);
  });

  it("requires bold completed labels and number-only links in native capability cells", () => {
    const run = (text: string, options: { bold?: boolean; hyperlinkId?: string } = {}) =>
      `<a:r><a:rPr${options.bold ? ' b="1"' : ""}>${options.hyperlinkId ? `<a:hlinkClick r:id="${options.hyperlinkId}" />` : ""}</a:rPr><a:t>${text}</a:t></a:r>`;
    const completedParagraph = `<a:p>${run("✓ Agent routing", { bold: true })}${run(" (")}${run("#103", { hyperlinkId: "r103" })}${run(")")}</a:p>`;
    const cell = (body: string) => `<a:tc><a:txBody>${body}</a:txBody><a:tcPr /></a:tc>`;
    const slideXml = [
      "<p:sld><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl>",
      `<a:tr>${cell("<a:p />")}${cell("<a:p />")}</a:tr>`,
      `<a:tr>${cell(`<a:p>${run("Acceleration and Optimization")}</a:p>`)}${cell(completedParagraph)}</a:tr>`,
      "</a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>",
    ].join("");
    const relationshipsXml =
      '<Relationships><Relationship Id="r103" Target="https://github.com/NVIDIA/NemoClaw/issues/103" TargetMode="External" /></Relationships>';
    const tableContract = {
      firstMilestoneColumn: 1,
      areaRows: { "Acceleration and Optimization": 1 },
    };
    const slideModel = {
      rows: ["Acceleration and Optimization"],
      columns: [{ milestoneNodeId: "M1", title: "Window One" }],
      cells: [
        {
          roadmapArea: "Acceleration and Optimization",
          milestoneNodeId: "M1",
          items: [
            {
              contentId: "matrix.epic.103",
              issueNumber: 103,
              state: "CLOSED",
              title: "Agent routing",
              url: "https://github.com/NVIDIA/NemoClaw/issues/103",
            },
          ],
        },
      ],
    };

    expect(() =>
      validateCapabilityEpicCompletionFromSlideXml(
        slideXml,
        relationshipsXml,
        tableContract,
        slideModel,
      ),
    ).not.toThrow();
    expect(() =>
      validateCapabilityEpicCompletionFromSlideXml(
        slideXml.replace(' b="1"', ""),
        relationshipsXml,
        tableContract,
        slideModel,
      ),
    ).toThrow(/completed-label or number-only link state/u);
    expect(() =>
      validateCapabilityEpicCompletionFromSlideXml(
        slideXml.replace("✓ Agent routing", "Agent routing"),
        relationshipsXml,
        tableContract,
        slideModel,
      ),
    ).toThrow(/completed-label or number-only link state/u);
    expect(() =>
      validateCapabilityEpicCompletionFromSlideXml(
        slideXml.replace(
          '<a:rPr><a:hlinkClick r:id="r103"',
          '<a:rPr b="1"><a:hlinkClick r:id="r103"',
        ),
        relationshipsXml,
        tableContract,
        slideModel,
      ),
    ).toThrow(/completed-label or number-only link state/u);
    expect(() =>
      validateCapabilityEpicCompletionFromSlideXml(
        slideXml.replace('<a:rPr b="1">', '<a:rPr b="1"><a:hlinkClick r:id="r103" />'),
        relationshipsXml,
        tableContract,
        slideModel,
      ),
    ).toThrow(/completed-label or number-only link state/u);
    expect(() =>
      validateCapabilityEpicCompletionFromSlideXml(
        slideXml.replace('<a:hlinkClick r:id="r103" />', ""),
        relationshipsXml,
        tableContract,
        slideModel,
      ),
    ).toThrow(/completed-label or number-only link state/u);
    expect(() =>
      validateCapabilityEpicCompletionFromSlideXml(
        slideXml,
        relationshipsXml.replace("issues/103", "issues/999"),
        tableContract,
        slideModel,
      ),
    ).toThrow(/links to the wrong issue/u);

    const openModel = structuredClone(slideModel);
    openModel.cells[0].items[0].state = "OPEN";
    expect(() =>
      validateCapabilityEpicCompletionFromSlideXml(
        slideXml.replace("✓ Agent routing", "Agent routing"),
        relationshipsXml,
        tableContract,
        openModel,
      ),
    ).not.toThrow();
  });

  it("validates native roadmap paragraphs against a shorter final-page model", () => {
    const paragraph = `<a:p><a:pPr marL="355600" indent="-406400"><a:lnSpc><a:spcPct val="92000" /></a:lnSpc><a:spcBef><a:spcPts val="1800" /></a:spcBef><a:spcAft><a:spcPts val="1000" /></a:spcAft><a:buChar char="●" /></a:pPr><a:r><a:t>Only outcome</a:t></a:r></a:p>`;
    const slideXml = `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="first-outcomes" /></p:nvSpPr><p:txBody>${paragraph}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const paragraphStyles = [
      {
        bulletCharacter: "●",
        marginLeft: 355_600,
        indent: -406_400,
        spaceBefore: 1_800,
        spaceAfter: 0,
      },
      {
        bulletCharacter: "●",
        marginLeft: 355_600,
        indent: -406_400,
        spaceBefore: 1_000,
        spaceAfter: 0,
      },
      {
        bulletCharacter: "●",
        marginLeft: 355_600,
        indent: -406_400,
        spaceBefore: 1_000,
        spaceAfter: 1_000,
      },
    ];
    const operations = [
      {
        target: { name: "first-outcomes" },
        outcomesPath: "milestones.0.outcomes",
        textFrameStyle: { lineSpacing: 0.92 },
        paragraphStyles,
      },
      {
        target: { name: "deleted-outcomes" },
        outcomesPath: "milestones.1.outcomes",
        textFrameStyle: { lineSpacing: 0.92 },
        paragraphStyles,
      },
    ];
    const slideModel = { milestones: [{ outcomes: [{}] }] };
    expect(() =>
      validateRoadmapOutcomeParagraphsFromSlideXml(slideXml, operations, slideModel),
    ).not.toThrow();
    expect(() =>
      validateRoadmapOutcomeParagraphsFromSlideXml(
        slideXml.replace(
          "</p:spTree>",
          '<p:sp><p:nvSpPr><p:cNvPr id="2" name="deleted-outcomes" /></p:nvSpPr><p:txBody></p:txBody></p:sp></p:spTree>',
        ),
        operations,
        slideModel,
      ),
    ).toThrow(/Unused roadmap outcome target deleted-outcomes remains/u);
  });

  it("reads artifact-tool native PowerPoint connector direction and line style", () => {
    expect(connectorInventoryFromSlideXml(nativeConnectorSlide())).toEqual(
      expectedNativeConnectors,
    );
  });

  it.each([
    ["missing", "none"],
    ["on the source end", "headEnd"],
  ] as const)("rejects a native PowerPoint connector with a %s target arrow", (_case, arrowEnd) => {
    expect(() =>
      connectorInventoryFromSlideXml(nativeConnectorSlide({ operatorArrow: arrowEnd })),
    ).toThrow(/must have one target tail arrow/u);
  });

  it.each([
    ["reversed direction", nativeConnectorSlide({ operatorReversed: true })],
    ["lost dashed style", nativeConnectorSlide({ stateLineStyle: "solid" })],
  ])("rejects native PowerPoint connector inventory with %s", (_case, slideXml) => {
    expect(() =>
      validateNativeConnectorInventory(
        expectedNativeConnectors,
        connectorInventoryFromSlideXml(slideXml),
      ),
    ).toThrow(/connector semantics differ/u);
  });

  it.each([
    [
      "changed theme bytes",
      {
        themeSha256ByPath: { "ppt/theme/theme1.xml": "b".repeat(64) },
        themeRelationshipTargetByPath: {
          "ppt/slideMasters/_rels/slideMaster1.xml.rels": "../theme/theme1.xml",
        },
        themeContentTypeParts: ["/ppt/theme/theme1.xml"],
      },
    ],
    [
      "extra theme part",
      {
        themeSha256ByPath: {
          "ppt/theme/theme1.xml": "a".repeat(64),
          "ppt/theme/theme2.xml": "b".repeat(64),
        },
        themeRelationshipTargetByPath: {
          "ppt/slideMasters/_rels/slideMaster1.xml.rels": "../theme/theme1.xml",
        },
        themeContentTypeParts: ["/ppt/theme/theme1.xml"],
      },
    ],
    [
      "missing theme part",
      {
        themeSha256ByPath: {},
        themeRelationshipTargetByPath: {
          "ppt/slideMasters/_rels/slideMaster1.xml.rels": "../theme/theme1.xml",
        },
        themeContentTypeParts: ["/ppt/theme/theme1.xml"],
      },
    ],
    [
      "retargeted theme relationship",
      {
        themeSha256ByPath: { "ppt/theme/theme1.xml": "a".repeat(64) },
        themeRelationshipTargetByPath: {
          "ppt/slideMasters/_rels/slideMaster1.xml.rels": "theme/theme1.xml",
        },
        themeContentTypeParts: ["/ppt/theme/theme1.xml"],
      },
    ],
    [
      "missing theme content type",
      {
        themeSha256ByPath: { "ppt/theme/theme1.xml": "a".repeat(64) },
        themeRelationshipTargetByPath: {
          "ppt/slideMasters/_rels/slideMaster1.xml.rels": "../theme/theme1.xml",
        },
        themeContentTypeParts: [],
      },
    ],
  ])("rejects a PowerPoint artifact with %s", (_case, artifact) => {
    const template = {
      themeSha256ByPath: { "ppt/theme/theme1.xml": "a".repeat(64) },
      themeRelationshipTargetByPath: {
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": "../theme/theme1.xml",
      },
      themeContentTypeParts: ["/ppt/theme/theme1.xml"],
    };
    expect(() => validateTemplateThemePackageContract(template, artifact)).toThrow(
      /does not preserve/u,
    );
  });
});
