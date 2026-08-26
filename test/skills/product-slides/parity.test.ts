// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { visibleTextInventoryFromLayout } from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts";
import {
  classifyArtifactTextInventories,
  compareParity,
  expectedCapabilityStructureInventory,
  expectedConnectorInventory,
  expectedHyperlinkInventory,
  expectedManagedVisibleTextInventory,
  expectedWeeklyMilestoneStructureInventory,
  expectedSemanticProjection,
  protectedTextPolicyFromRoleMap,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/compare-output-parity.mts";
import { validateSlideModel } from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/validate-slide-model.mts";
import {
  buildSyntheticModel,
  semanticReadback,
  slideModelSchemaPath,
} from "../../helpers/nemoclaw-product-slides-fixture";
import { independentlyAuthoredParityReadbacks } from "./parity-fixture";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("NemoClaw product slide backend parity", () => {
  it("formats zero and four-digit weekly changes like the PowerPoint adapter", () => {
    const model = buildSyntheticModel();
    const weekly = (model.slides as Array<Record<string, unknown>>).find(
      (slide) => slide.role === "weekly-release",
    );
    expect(weekly).toBeDefined();
    const metrics = weekly?.metrics as Array<Record<string, unknown>>;
    const stars = metrics.find((metric) => metric.contentId === "metric.stars");
    const forks = metrics.find((metric) => metric.contentId === "metric.forks");
    expect(stars).toBeDefined();
    expect(forks).toBeDefined();
    stars!.detailValue = 0;
    forks!.detailValue = 1000;

    const visible = expectedManagedVisibleTextInventory(model).find(
      (slide) => slide.role === "weekly-release",
    );

    expect(visible?.visibleTextInventory).toEqual(
      expect.arrayContaining([expect.stringContaining("+0"), expect.stringContaining("+1,000")]),
    );
  });

  it("accepts independently authored Google Slides and PowerPoint readbacks", () => {
    const model = buildSyntheticModel();
    const { google, pptx } = independentlyAuthoredParityReadbacks(model);
    const result = compareParity(model, google, pptx);

    expect(result.equal).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.googleProjectionSha256).toBe(result.pptxProjectionSha256);
    expect(result.googleHyperlinkSha256).toBe(result.expectedHyperlinkSha256);
    expect(result.pptxHyperlinkSha256).toBe(result.expectedHyperlinkSha256);
    expect(result.googleConnectorSha256).toBe(result.expectedConnectorSha256);
    expect(result.pptxConnectorSha256).toBe(result.expectedConnectorSha256);
    expect(result.googleCapabilityStructureSha256).toBe(result.expectedCapabilityStructureSha256);
    expect(result.pptxCapabilityStructureSha256).toBe(result.expectedCapabilityStructureSha256);
    expect(result.googleWeeklyMilestoneStructureSha256).toBe(
      result.expectedWeeklyMilestoneStructureSha256,
    );
    expect(result.pptxWeeklyMilestoneStructureSha256).toBe(
      result.expectedWeeklyMilestoneStructureSha256,
    );
  });

  it("rejects focused connector drift from an independently authored PowerPoint readback", () => {
    const model = buildSyntheticModel();
    const { google, pptx } = independentlyAuthoredParityReadbacks(model);
    const markitecture = (pptx.slides as Array<Record<string, unknown>>).find(
      (slide) => slide.role === "markitecture",
    );
    const connector = (markitecture?.connectorInventory as Array<Record<string, unknown>>).find(
      (entry) => entry.contentId === "connector.sandbox-state",
    );
    expect(connector).toBeDefined();
    connector!.lineStyle = "solid";

    expect(compareParity(model, google, pptx).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PPTX_CONNECTOR_MISMATCH" }),
        expect.objectContaining({ code: "CROSS_FORMAT_CONNECTOR_MISMATCH" }),
      ]),
    );
  });

  it("rejects plain-text and typed-glyph weekly bullets in artifact readbacks", () => {
    const model = buildSyntheticModel();
    const expected =
      expectedWeeklyMilestoneStructureInventory(model)[0].weeklyMilestoneStructureInventory;
    const weeklyModel = (model.slides as Array<Record<string, unknown>>).find(
      (slide) => slide.role === "weekly-release",
    );
    const firstRowTitle = String(
      (weeklyModel?.milestoneRows as Array<Record<string, unknown>>)[0].title,
    );
    expect(expected.rows[0].title).toBe(firstRowTitle.toUpperCase().split(/\s+/u).join("\n"));
    const noneRowIndex = expected.rows.findIndex((row) => row.risks[0]?.text === "None");
    expect(noneRowIndex).toBeGreaterThanOrEqual(0);
    expect(expected.rows[noneRowIndex].risks).toEqual([{ text: "None", bulletCharacter: "•" }]);

    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const weeklyGoogle = (google.slides as Array<Record<string, unknown>>).find(
      (slide) => slide.role === "weekly-release",
    );
    const weeklyPptx = (pptx.slides as Array<Record<string, unknown>>).find(
      (slide) => slide.role === "weekly-release",
    );
    const googleRows = (weeklyGoogle?.weeklyMilestoneStructureInventory as Record<string, unknown>)
      .rows as Array<Record<string, unknown>>;
    const pptxRows = (weeklyPptx?.weeklyMilestoneStructureInventory as Record<string, unknown>)
      .rows as Array<Record<string, unknown>>;
    const googleNone = (googleRows[noneRowIndex].risks as Array<Record<string, unknown>>)[0];
    const pptxNone = (pptxRows[noneRowIndex].risks as Array<Record<string, unknown>>)[0];
    googleNone.bulletCharacter = "";
    pptxNone.bulletCharacter = "";
    pptxNone.text = "• None";

    expect(compareParity(model, google, pptx).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GOOGLE_WEEKLY_MILESTONE_STRUCTURE_MISMATCH" }),
        expect.objectContaining({ code: "PPTX_WEEKLY_MILESTONE_STRUCTURE_MISMATCH" }),
        expect.objectContaining({ code: "CROSS_FORMAT_WEEKLY_MILESTONE_STRUCTURE_MISMATCH" }),
      ]),
    );
  });

  it("derives the capability matrix structure independently from the shared model", () => {
    const model = buildSyntheticModel();
    const [inventory] = expectedCapabilityStructureInventory(model);

    expect(inventory.capabilityStructureInventory).toEqual({
      table: {
        rowCount: 5,
        columnCount: 4,
        topRowText: ["", "", "", ""],
        dividers: {
          segmentCount: 49,
          color: "#FFFFFF",
          lineStyle: "solid",
          widthEmu: 228_600,
        },
      },
      milestoneTargets: [
        { tableColumnIndex: 1, text: "Window Three", shapeType: "HOME_PLATE", inTopRowCell: true },
        { tableColumnIndex: 2, text: "Window One", shapeType: "HOME_PLATE", inTopRowCell: true },
        { tableColumnIndex: 3, text: "Window Two", shapeType: "HOME_PLATE", inTopRowCell: true },
      ],
      unusedTopRowMilestoneTargetCount: 0,
      unusedBodyCellNonemptyCount: 0,
      bottomMilestoneTargetCount: 0,
    });
  });

  it("fails closed when a backend omits its capability structure inventory", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    delete (google.slides as Array<Record<string, unknown>>)[1].capabilityStructureInventory;

    const result = compareParity(model, google, pptx);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GOOGLE_CAPABILITY_STRUCTURE_INVENTORY_MISSING" }),
      ]),
    );
    expect(result.googleCapabilityStructureSha256).toBeNull();
  });

  it("rejects a rectangle, nonblank top row, gray dividers, or bottom milestone target", () => {
    const mutations: Array<(inventory: Record<string, unknown>) => void> = [
      (inventory) => {
        const targets = inventory.milestoneTargets as Array<Record<string, unknown>>;
        targets[0].shapeType = "RECT";
      },
      (inventory) => {
        const table = inventory.table as Record<string, unknown>;
        (table.topRowText as string[])[0] = "Focus";
      },
      (inventory) => {
        const table = inventory.table as Record<string, unknown>;
        (table.dividers as Record<string, unknown>).color = "#9E9E9E";
      },
      (inventory) => {
        inventory.bottomMilestoneTargetCount = 1;
      },
    ];
    mutations.forEach((mutate) => {
      const model = buildSyntheticModel();
      const google = semanticReadback(model);
      const pptx = semanticReadback(model);
      mutate(
        (pptx.slides as Array<Record<string, unknown>>)[1].capabilityStructureInventory as Record<
          string,
          unknown
        >,
      );

      expect(compareParity(model, google, pptx).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "PPTX_CAPABILITY_STRUCTURE_MISMATCH" }),
          expect.objectContaining({ code: "CROSS_FORMAT_CAPABILITY_STRUCTURE_MISMATCH" }),
        ]),
      );
    });
  });

  it("rejects retained top-row slots, an extra HOME_PLATE, or stale body text on a one-column page", () => {
    [
      { unusedTopRowMilestoneTargetCount: 2 },
      { unusedTopRowMilestoneTargetCount: 1 },
      { unusedBodyCellNonemptyCount: 1 },
    ].forEach((mutation) => {
      const model = buildSyntheticModel();
      const capability = (model.slides as Array<Record<string, unknown>>)[1];
      const columns = capability.columns as Array<Record<string, unknown>>;
      const firstMilestoneNodeId = columns[0].milestoneNodeId;
      capability.columns = [columns[0]];
      capability.cells = (capability.cells as Array<Record<string, unknown>>).filter(
        (cell) => cell.milestoneNodeId === firstMilestoneNodeId,
      );
      const google = semanticReadback(model);
      const pptx = semanticReadback(model);
      Object.assign(
        (pptx.slides as Array<Record<string, unknown>>)[1].capabilityStructureInventory as Record<
          string,
          unknown
        >,
        mutation,
      );

      expect(compareParity(model, google, pptx).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "PPTX_CAPABILITY_STRUCTURE_MISMATCH" }),
          expect.objectContaining({ code: "CROSS_FORMAT_CAPABILITY_STRUCTURE_MISMATCH" }),
        ]),
      );
    });
  });

  it("does not let protected text hide a nonempty unused body cell", () => {
    const model = buildSyntheticModel();
    const capability = (model.slides as Array<Record<string, unknown>>)[1];
    const columns = capability.columns as Array<Record<string, unknown>>;
    const firstMilestoneNodeId = columns[0].milestoneNodeId;
    capability.columns = [columns[0]];
    capability.cells = (capability.cells as Array<Record<string, unknown>>).filter(
      (cell) => cell.milestoneNodeId === firstMilestoneNodeId,
    );
    const staleText = "Legacy unused-cell text";
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    [google, pptx].forEach((readback) => {
      const capabilityReadback = (readback.slides as Array<Record<string, unknown>>)[1];
      (capabilityReadback.protectedVisibleTextInventory as string[]).push(staleText);
      (capabilityReadback.visibleTextInventory as string[]).push(staleText);
      (
        capabilityReadback.capabilityStructureInventory as Record<string, unknown>
      ).unusedBodyCellNonemptyCount = 1;
    });

    const result = compareParity(model, google, pptx, {
      "roadmap-capability": [sha256(staleText)],
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GOOGLE_CAPABILITY_STRUCTURE_MISMATCH" }),
        expect.objectContaining({ code: "PPTX_CAPABILITY_STRUCTURE_MISMATCH" }),
      ]),
    );
    expect(result.errors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GOOGLE_PROTECTED_VISIBLE_TEXT_MISMATCH" }),
        expect.objectContaining({ code: "PPTX_PROTECTED_VISIBLE_TEXT_MISMATCH" }),
      ]),
    );
  });

  it("derives exact semantic direction and line treatment for the markitecture connectors", () => {
    const model = buildSyntheticModel();
    const projection = expectedConnectorInventory(model);
    const executive = projection.find((slide) => slide.role === "roadmap-executive");
    const markitecture = projection.find((slide) => slide.role === "markitecture");

    expect(executive?.connectorInventory).toEqual([]);
    expect(markitecture?.connectorInventory).toHaveLength(7);
    expect(markitecture?.connectorInventory).toEqual(
      expect.arrayContaining([
        {
          contentId: "connector.sandbox-state",
          from: "node.sandbox",
          to: "node.state",
          direction: "from-to",
          lineStyle: "dashed",
        },
        {
          contentId: "connector.sandbox-gateway",
          from: "node.sandbox",
          to: "node.gateway",
          direction: "from-to",
          lineStyle: "solid",
        },
      ]),
    );
  });

  it("rejects a native connector inventory without an arrow direction", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const markitecture = (pptx.slides as Array<Record<string, unknown>>)[2];
    const connector = (markitecture.connectorInventory as Array<Record<string, unknown>>)[0];
    connector.direction = "none";

    const result = compareParity(model, google, pptx);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PPTX_CONNECTOR_INVENTORY_MISSING" }),
      ]),
    );
    expect(result.pptxConnectorSha256).toBeNull();
  });

  it("rejects a shared solid state connector against the independently modeled dash style", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const googleState = (
      (google.slides as Array<Record<string, unknown>>)[2].connectorInventory as Array<
        Record<string, unknown>
      >
    ).find((connector) => connector.contentId === "connector.sandbox-state");
    const pptxState = (
      (pptx.slides as Array<Record<string, unknown>>)[2].connectorInventory as Array<
        Record<string, unknown>
      >
    ).find((connector) => connector.contentId === "connector.sandbox-state");
    (googleState as Record<string, unknown>).lineStyle = "solid";
    (pptxState as Record<string, unknown>).lineStyle = "solid";

    const result = compareParity(model, google, pptx);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GOOGLE_CONNECTOR_MISMATCH" }),
        expect.objectContaining({ code: "PPTX_CONNECTOR_MISMATCH" }),
      ]),
    );
    expect(result.errors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CROSS_FORMAT_CONNECTOR_MISMATCH" }),
      ]),
    );
  });

  it("rejects a reversed connector relationship in one format", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const markitecture = (pptx.slides as Array<Record<string, unknown>>)[2];
    const connector = (markitecture.connectorInventory as Array<Record<string, unknown>>).find(
      (entry) => entry.contentId === "connector.sandbox-gateway",
    ) as Record<string, unknown>;
    connector.from = "node.gateway";
    connector.to = "node.sandbox";

    expect(compareParity(model, google, pptx).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PPTX_CONNECTOR_MISMATCH" }),
        expect.objectContaining({ code: "CROSS_FORMAT_CONNECTOR_MISMATCH" }),
      ]),
    );
  });

  it("links only capability Epic numbers and keeps weekly evidence in notes", () => {
    const model = buildSyntheticModel();
    const projection = expectedHyperlinkInventory(model);
    const executive = projection.find((slide) => slide.role === "roadmap-executive");
    const matrix = projection.find((slide) => slide.role === "roadmap-capability");
    const markitecture = projection.find((slide) => slide.role === "markitecture");
    const weekly = projection.find((slide) => slide.role === "weekly-release");

    expect(executive?.hyperlinkInventory).toEqual([]);
    expect(matrix?.hyperlinkInventory).toHaveLength(6);
    expect(matrix?.hyperlinkInventory).toEqual(
      expect.arrayContaining([
        {
          text: "#101",
          url: "https://github.com/NVIDIA/NemoClaw/issues/101",
        },
        {
          text: "#103",
          url: "https://github.com/NVIDIA/NemoClaw/issues/103",
        },
      ]),
    );
    expect(matrix?.hyperlinkInventory.some((entry) => entry.text === "Guided onboarding")).toBe(
      false,
    );
    expect(
      matrix?.hyperlinkInventory.some(
        (entry) => entry.text.includes("✓") || entry.text.includes("Agent routing"),
      ),
    ).toBe(false);
    expect(markitecture?.hyperlinkInventory).toEqual([]);
    expect(weekly?.hyperlinkInventory).toEqual([]);
    const visible = expectedManagedVisibleTextInventory(model);
    expect(
      visible.find((slide) => slide.role === "roadmap-capability")?.visibleTextInventory,
    ).toEqual(expect.arrayContaining(["Guided onboarding (#101)", "✓ Agent routing (#103)"]));
    expect(
      visible.find((slide) => slide.role === "roadmap-executive")?.visibleTextInventory,
    ).toEqual(
      expect.arrayContaining([
        "Guided onboarding: Start agents in OpenShell sandboxes with fewer manual steps.",
        "✓ Agent routing: Route work to the selected model path.",
      ]),
    );
    const weeklyModel = (model.slides as Array<Record<string, unknown>>).find(
      (slide) => slide.role === "weekly-release",
    );
    const firstRow = (weeklyModel?.milestoneRows as Array<Record<string, unknown>>)[0];
    const firstUpdate = (firstRow.updates as Array<Record<string, unknown>>)[0];
    expect(visible.find((slide) => slide.role === "weekly-release")?.visibleTextInventory).toEqual(
      expect.arrayContaining([
        ...String(firstRow.title).toUpperCase().split(/\s+/u),
        `${String(firstUpdate.label)}: ${String(firstUpdate.text)}`,
        "UPDATES",
        "RISKS / BLOCKERS",
      ]),
    );
  });

  it.each(["roadmap-executive", "roadmap-capability"])(
    "rejects artifacts that omit completed-Epic checkmarks from %s",
    (role) => {
      const model = buildSyntheticModel();
      const google = semanticReadback(model);
      const pptx = semanticReadback(model);
      [google, pptx].forEach((readback) => {
        const slide = (readback.slides as Array<Record<string, unknown>>).find(
          (candidate) => candidate.role === role,
        );
        expect(slide).toBeDefined();
        ["managedVisibleTextInventory", "visibleTextInventory"].forEach((inventoryName) => {
          const inventory = slide?.[inventoryName] as string[];
          const completedIndex = inventory.findIndex((value) =>
            value.startsWith("✓ Agent routing"),
          );
          expect(completedIndex).toBeGreaterThanOrEqual(0);
          inventory[completedIndex] = inventory[completedIndex].replace("✓ ", "");
        });
      });

      const result = compareParity(model, google, pptx);

      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "GOOGLE_MANAGED_VISIBLE_TEXT_MISMATCH" }),
          expect.objectContaining({ code: "PPTX_MANAGED_VISIBLE_TEXT_MISMATCH" }),
        ]),
      );
      expect(result.errors).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "CROSS_FORMAT_VISIBLE_TEXT_MISMATCH" }),
        ]),
      );
    },
  );

  it("keeps capability focus and active milestone status out of the visible matrix contract", () => {
    const model = buildSyntheticModel();
    const capability = (model.slides as Array<Record<string, unknown>>).find(
      (slide) => slide.role === "roadmap-capability",
    );
    expect(capability).toBeDefined();
    const columns = capability?.columns as Array<Record<string, unknown>>;
    columns[0].focus = "Model-only capability focus";
    columns[0].status = {
      state: "open",
      label: "Active",
    };

    const visible = expectedManagedVisibleTextInventory(model).find(
      (slide) => slide.role === "roadmap-capability",
    )?.visibleTextInventory;
    expect(visible).toEqual(expect.arrayContaining(columns.map((column) => column.title)));
    expect(visible).not.toContain("Focus");
    expect(visible).not.toContain("Model-only capability focus");
    expect(visible).not.toContain("Active");
  });

  it("does not expose Announcement links as weekly milestone-row links", () => {
    const model = buildSyntheticModel();
    const weekly = (model.slides as Array<Record<string, unknown>>).find(
      (slide) => slide.role === "weekly-release",
    );
    expect(weekly?.releaseContext).toBeDefined();
    expect(
      expectedHyperlinkInventory(model).find((slide) => slide.role === "weekly-release"),
    ).toMatchObject({ hyperlinkInventory: [] });
  });

  it("rejects incorrect linked text even when both artifacts use the expected URL", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const googleFirst = (
      (google.slides as Array<Record<string, unknown>>)[1].hyperlinkInventory as Array<
        Record<string, unknown>
      >
    )[0];
    const pptxFirst = (
      (pptx.slides as Array<Record<string, unknown>>)[1].hyperlinkInventory as Array<
        Record<string, unknown>
      >
    )[0];
    googleFirst.text = `${String(googleFirst.text)} stale`;
    pptxFirst.text = `${String(pptxFirst.text)} stale`;

    const result = compareParity(model, google, pptx);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GOOGLE_HYPERLINK_MISMATCH" }),
        expect.objectContaining({ code: "PPTX_HYPERLINK_MISMATCH" }),
      ]),
    );
    expect(result.errors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CROSS_FORMAT_HYPERLINK_MISMATCH" }),
      ]),
    );
  });

  it("rejects a hyperlink inventory entry with a missing URL", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const first = (
      (google.slides as Array<Record<string, unknown>>)[1].hyperlinkInventory as Array<
        Record<string, unknown>
      >
    )[0];
    first.url = "";

    const result = compareParity(model, google, pptx);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GOOGLE_HYPERLINK_INVENTORY_MISSING" }),
      ]),
    );
    expect(result.googleHyperlinkSha256).toBeNull();
  });

  it("rejects a URL difference between formats", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const first = (
      (pptx.slides as Array<Record<string, unknown>>)[1].hyperlinkInventory as Array<
        Record<string, unknown>
      >
    )[0];
    first.url = "https://github.com/NVIDIA/NemoClaw/issues/999999";

    expect(compareParity(model, google, pptx).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PPTX_HYPERLINK_MISMATCH" }),
        expect.objectContaining({ code: "CROSS_FORMAT_HYPERLINK_MISMATCH" }),
      ]),
    );
  });

  it("normalizes one provider terminal newline but preserves meaningful spaces", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const googleFirst = (
      (google.slides as Array<Record<string, unknown>>)[1].hyperlinkInventory as Array<
        Record<string, unknown>
      >
    )[0];
    const pptxFirst = (
      (pptx.slides as Array<Record<string, unknown>>)[1].hyperlinkInventory as Array<
        Record<string, unknown>
      >
    )[0];
    googleFirst.text = `${String(googleFirst.text)}\r\n`;
    pptxFirst.text = `${String(pptxFirst.text)}\n`;

    expect(compareParity(model, google, pptx)).toMatchObject({ equal: true, errors: [] });

    googleFirst.text = `${String(googleFirst.text).replace(/\r\n$/u, "")} `;
    expect(compareParity(model, google, pptx).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GOOGLE_HYPERLINK_MISMATCH" }),
        expect.objectContaining({ code: "CROSS_FORMAT_HYPERLINK_MISMATCH" }),
      ]),
    );
  });

  it("detects a wording change in one backend", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = clone(google);
    const slides = pptx.slides as Array<Record<string, unknown>>;
    const weekly = slides[3].content as Record<string, unknown>;
    const firstRow = (weekly.milestoneRows as Array<Record<string, unknown>>)[0];
    const firstUpdate = (firstRow.updates as Array<Record<string, unknown>>)[0];
    firstUpdate.text = "Stale weekly update.";
    const result = compareParity(model, google, pptx);

    expect(result.equal).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PPTX_MODEL_MISMATCH" }),
        expect.objectContaining({ code: "CROSS_FORMAT_MISMATCH" }),
      ]),
    );
  });

  it("detects a capability matrix without its native table", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = clone(google);
    const slides = pptx.slides as Array<Record<string, unknown>>;
    slides[1].nativeObjectKinds = ["image", "shape", "text"];

    expect(compareParity(model, google, pptx).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PPTX_MODEL_MISMATCH" })]),
    );
  });

  it("detects unmodeled visible text in one backend", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = clone(google);
    const slides = pptx.slides as Array<Record<string, unknown>>;
    (slides[2].visibleTextInventory as string[]).push("Stale private-template wording");

    const result = compareParity(model, google, pptx);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CROSS_FORMAT_VISIBLE_TEXT_MISMATCH" }),
      ]),
    );
    expect(result.googleProjectionSha256).toBe(result.pptxProjectionSha256);
    expect(result.googleVisibleTextSha256).not.toBe(result.pptxVisibleTextSha256);
  });

  it("rejects shared stale slide-local text in both backends", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const googleSlide = (google.slides as Array<Record<string, unknown>>)[0];
    const pptxSlide = (pptx.slides as Array<Record<string, unknown>>)[0];
    (googleSlide.managedVisibleTextInventory as string[]).push("NVIDIA INTERNAL PRIVATE ROADMAP");
    (googleSlide.visibleTextInventory as string[]).push("NVIDIA INTERNAL PRIVATE ROADMAP");
    (pptxSlide.managedVisibleTextInventory as string[]).push("NVIDIA INTERNAL PRIVATE ROADMAP");
    (pptxSlide.visibleTextInventory as string[]).push("NVIDIA INTERNAL PRIVATE ROADMAP");

    const result = compareParity(model, google, pptx);

    expect(result.equal).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "GOOGLE_MANAGED_VISIBLE_TEXT_MISMATCH",
        }),
        expect.objectContaining({
          code: "PPTX_MANAGED_VISIBLE_TEXT_MISMATCH",
        }),
      ]),
    );
  });

  it("rejects the same unapproved inherited text in both backends", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const googleSlide = (google.slides as Array<Record<string, unknown>>)[2];
    const pptxSlide = (pptx.slides as Array<Record<string, unknown>>)[2];
    (googleSlide.inheritedVisibleTextInventory as string[]).push(
      "Synthetic unapproved inherited text",
    );
    (googleSlide.visibleTextInventory as string[]).push("Synthetic unapproved inherited text");
    (pptxSlide.inheritedVisibleTextInventory as string[]).push(
      "Synthetic unapproved inherited text",
    );
    (pptxSlide.visibleTextInventory as string[]).push("Synthetic unapproved inherited text");

    const result = compareParity(model, google, pptx);

    expect(result.equal).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "GOOGLE_INHERITED_VISIBLE_TEXT_MISMATCH",
        }),
        expect.objectContaining({
          code: "PPTX_INHERITED_VISIBLE_TEXT_MISMATCH",
        }),
      ]),
    );
  });

  it("rejects an extra inherited slide-number placeholder in both backends", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const googleSlide = (google.slides as Array<Record<string, unknown>>)[1];
    const pptxSlide = (pptx.slides as Array<Record<string, unknown>>)[1];
    (googleSlide.inheritedVisibleTextInventory as string[]).push("‹#›");
    (googleSlide.visibleTextInventory as string[]).push("‹#›");
    (pptxSlide.inheritedVisibleTextInventory as string[]).push("‹#›");
    (pptxSlide.visibleTextInventory as string[]).push("‹#›");

    const result = compareParity(model, google, pptx);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "GOOGLE_INHERITED_VISIBLE_TEXT_MISMATCH",
        }),
        expect.objectContaining({
          code: "PPTX_INHERITED_VISIBLE_TEXT_MISMATCH",
        }),
      ]),
    );
  });

  it("requires shared protected text to match the runtime role-map allowlist", () => {
    const model = buildSyntheticModel();
    const protectedText = "Synthetic approved protected text";
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    const googleSlide = (google.slides as Array<Record<string, unknown>>)[2];
    const pptxSlide = (pptx.slides as Array<Record<string, unknown>>)[2];
    (googleSlide.protectedVisibleTextInventory as string[]).push(protectedText);
    (googleSlide.visibleTextInventory as string[]).push(protectedText);
    (pptxSlide.protectedVisibleTextInventory as string[]).push(protectedText);
    (pptxSlide.visibleTextInventory as string[]).push(protectedText);

    expect(compareParity(model, google, pptx).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "GOOGLE_PROTECTED_VISIBLE_TEXT_MISMATCH",
        }),
        expect.objectContaining({
          code: "PPTX_PROTECTED_VISIBLE_TEXT_MISMATCH",
        }),
      ]),
    );
    expect(
      compareParity(model, google, pptx, {
        markitecture: [sha256(protectedText)],
      }),
    ).toMatchObject({ equal: true, errors: [] });
  });

  it("does not let a protected-text digest hide capability focus or forbidden status text", () => {
    const model = buildSyntheticModel();
    const capabilityModel = (model.slides as Array<Record<string, unknown>>)[1];
    const focus = String(
      ((capabilityModel.columns as Array<Record<string, unknown>>)[0] as Record<string, unknown>)
        .focus,
    );
    [
      "Status: Active",
      "status: active",
      `Focus: ${focus}`,
      "Status: Completed · 2026-08-21",
      "Status: Shipped",
      "Milestone status: Active",
      "state: Completed · 2026-08-21",
      "rOaDmAp: Shipped",
      `Current focus: ${focus}`,
    ].forEach((protectedText) => {
      const google = semanticReadback(model);
      const pptx = semanticReadback(model);
      [google, pptx].forEach((readback) => {
        const capability = (readback.slides as Array<Record<string, unknown>>)[1];
        (capability.protectedVisibleTextInventory as string[]).push(protectedText);
        (capability.visibleTextInventory as string[]).push(protectedText);
      });

      const result = compareParity(model, google, pptx, {
        "roadmap-capability": [sha256(protectedText)],
      });

      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "GOOGLE_CAPABILITY_FORBIDDEN_TEXT" }),
          expect.objectContaining({ code: "PPTX_CAPABILITY_FORBIDDEN_TEXT" }),
        ]),
      );
    });
  });

  it("does not let protected text hide the obsolete executive focus prefix", () => {
    const model = buildSyntheticModel();
    const protectedText = "NemoClaw:\nUsability and Onboarding";
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    [google, pptx].forEach((readback) => {
      const executive = (readback.slides as Array<Record<string, unknown>>)[0];
      (executive.protectedVisibleTextInventory as string[]).push(protectedText);
      (executive.visibleTextInventory as string[]).push(protectedText);
    });

    const result = compareParity(model, google, pptx, {
      "roadmap-executive": [sha256(protectedText)],
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GOOGLE_ROADMAP_FOCUS_PREFIX_FORBIDDEN" }),
        expect.objectContaining({ code: "PPTX_ROADMAP_FOCUS_PREFIX_FORBIDDEN" }),
      ]),
    );
  });

  it("classifies capability status as unexpected even when its digest is approved", () => {
    const model = buildSyntheticModel();
    const readback = semanticReadback(model);
    const layers = (readback.slides as Array<Record<string, unknown>>).map((slide) => ({
      role: slide.role as
        | "roadmap-executive"
        | "roadmap-capability"
        | "markitecture"
        | "weekly-release",
      ...(typeof slide.instanceId === "string" ? { instanceId: slide.instanceId } : {}),
      slideLocalText: [
        ...(slide.managedVisibleTextInventory as string[]),
        ...(slide.role === "roadmap-capability" ? ["Active"] : []),
      ],
      inheritedText: slide.inheritedVisibleTextInventory as string[],
    }));

    const classified = classifyArtifactTextInventories(model, layers, {
      "roadmap-capability": [sha256("Active")],
    });
    const capability = classified.find((slide) => slide.role === "roadmap-capability");

    expect(capability?.unexpectedVisibleTextInventory).toContain("Active");
    expect(capability?.protectedVisibleTextInventory).not.toContain("Active");
  });

  it("loads the protected-text policy only from the matching runtime role map", () => {
    const model = buildSyntheticModel();
    const digest = sha256("Synthetic approved protected text");
    const roleMap = {
      schemaVersion: 1,
      templateFingerprint: model.templateFingerprint,
      roles: {
        "roadmap-executive": { protectedTextSha256: [digest] },
        "roadmap-capability": {},
        markitecture: {},
        "weekly-release": {},
      },
    };

    expect(protectedTextPolicyFromRoleMap(model, roleMap)).toEqual({
      "roadmap-executive": [digest],
      "roadmap-capability": [],
      markitecture: [],
      "weekly-release": [],
    });
    expect(() =>
      protectedTextPolicyFromRoleMap(model, {
        ...roleMap,
        templateFingerprint: "0".repeat(64),
      }),
    ).toThrow(/does not match/u);
  });

  it("classifies only model text and template-inherited duplicates as allowed", () => {
    const model = buildSyntheticModel();
    const readback = semanticReadback(model);
    const layers = (readback.slides as Array<Record<string, unknown>>).map((slide, index) => ({
      role: slide.role as
        | "roadmap-executive"
        | "roadmap-capability"
        | "markitecture"
        | "weekly-release",
      slideLocalText: [
        ...(slide.managedVisibleTextInventory as string[]),
        ...(index === 2 ? ["Approved inherited footer", "Unmodeled stale wording"] : []),
      ],
      inheritedText: ["Approved inherited footer", "‹#›"],
    }));

    const classified = classifyArtifactTextInventories(model, layers);
    const markitecture = classified[2];

    expect(markitecture.protectedVisibleTextInventory).toEqual(["Approved inherited footer"]);
    expect(markitecture.unexpectedVisibleTextInventory).toEqual(["Unmodeled stale wording"]);
    expect(markitecture.managedVisibleTextInventory).toEqual(
      (readback.slides as Array<Record<string, unknown>>)[2].managedVisibleTextInventory,
    );
  });

  it("classifies explicitly managed role-map literals as managed text", () => {
    const model = buildSyntheticModel();
    const readback = semanticReadback(model);
    const executive = (readback.slides as Array<Record<string, unknown>>)[0];
    const identity = String(executive.instanceId ?? executive.role);
    const literal = "PREVIEW • GITHUB SNAPSHOT 2026-08-25";
    const layers = (readback.slides as Array<Record<string, unknown>>).map((slide, index) => ({
      role: slide.role as
        | "roadmap-executive"
        | "roadmap-capability"
        | "markitecture"
        | "weekly-release",
      ...(typeof slide.instanceId === "string" ? { instanceId: slide.instanceId } : {}),
      slideLocalText: [
        ...(slide.managedVisibleTextInventory as string[]),
        ...(index === 0 ? [literal] : []),
      ],
      inheritedText: slide.inheritedVisibleTextInventory as string[],
    }));

    const classified = classifyArtifactTextInventories(
      model,
      layers,
      {},
      { [identity]: [literal] },
    );

    expect(classified[0].managedVisibleTextInventory).toContain(literal);
    expect(classified[0].unexpectedVisibleTextInventory).toEqual([]);
  });

  it("rejects readbacks that omit the actual visible-text inventory", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    delete (google.slides as Array<Record<string, unknown>>)[0].visibleTextInventory;

    expect(compareParity(model, google, pptx).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "GOOGLE_VISIBLE_TEXT_INVENTORY_MISSING",
        }),
      ]),
    );
  });

  it("rejects readbacks that do not separate slide-local and inherited text", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = semanticReadback(model);
    delete (google.slides as Array<Record<string, unknown>>)[0].managedVisibleTextInventory;
    delete (google.slides as Array<Record<string, unknown>>)[1].protectedVisibleTextInventory;
    delete (pptx.slides as Array<Record<string, unknown>>)[0].inheritedVisibleTextInventory;

    expect(compareParity(model, google, pptx).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "GOOGLE_MANAGED_VISIBLE_TEXT_INVENTORY_MISSING",
        }),
        expect.objectContaining({
          code: "PPTX_INHERITED_VISIBLE_TEXT_INVENTORY_MISSING",
        }),
        expect.objectContaining({
          code: "GOOGLE_PROTECTED_VISIBLE_TEXT_INVENTORY_MISSING",
        }),
      ]),
    );
  });

  it("extracts paragraph, table-cell, and inherited protected text from a PPTX layout", () => {
    const inventory = visibleTextInventoryFromLayout({
      schema: "openai.presentation.layout/v4",
      elements: [
        {
          paragraphs: [{ text: "First\r\nline" }, { text: "Second paragraph" }],
        },
        { cells: [{ text: "Cell A" }, { paragraphs: [{ text: "Cell B" }] }] },
      ],
      inheritedLayers: [{ elements: [{ text: "Synthetic protected template footer" }] }],
    });

    expect(inventory).toEqual([
      "Cell A",
      "Cell B",
      "First\nline",
      "Second paragraph",
      "Synthetic protected template footer",
    ]);
  });

  it("requires native table, connector, shape, and text object families", () => {
    const model = buildSyntheticModel();
    const expected = expectedSemanticProjection(model);
    const slides = expected.slides as Array<Record<string, unknown>>;

    expect(slides[1].nativeObjectKinds).toContain("table");
    expect(slides[2].nativeObjectKinds).toEqual(["connector", "shape", "text"]);
    expect(slides[3].nativeObjectKinds).not.toContain("image");
  });

  it("normalizes backend-equivalent groups, lines, and connectors", () => {
    const model = buildSyntheticModel();
    const google = semanticReadback(model);
    const pptx = clone(google);
    const slides = pptx.slides as Array<Record<string, unknown>>;
    slides[0].nativeObjectKinds = ["connector", "shape", "text"];
    slides[2].nativeObjectKinds = ["line", "shape", "text"];

    expect(compareParity(model, google, pptx)).toMatchObject({
      equal: true,
      errors: [],
    });
  });

  it("preserves ordered roadmap page instances in semantic and native parity", () => {
    const model = buildSyntheticModel();
    const slides = model.slides as Array<Record<string, unknown>>;
    const executiveOne = clone(slides[0]);
    const capabilityOne = clone(slides[1]);
    executiveOne.pageCount = 2;
    capabilityOne.pageCount = 2;
    const executiveTwo = clone(executiveOne);
    const capabilityTwo = clone(capabilityOne);
    executiveTwo.instanceId = "roadmap-executive.2";
    executiveTwo.pageIndex = 2;
    capabilityTwo.instanceId = "roadmap-capability.2";
    capabilityTwo.pageIndex = 2;
    model.slides = [executiveOne, capabilityOne, executiveTwo, capabilityTwo, ...slides.slice(2)];

    const google = semanticReadback(model);
    const pptx = clone(google);
    expect(compareParity(model, google, pptx)).toMatchObject({ equal: true, errors: [] });
    expect(
      (google.slides as Array<Record<string, unknown>>).map(
        (slide) => slide.instanceId ?? slide.role,
      ),
    ).toEqual([
      "roadmap-executive.1",
      "roadmap-capability.1",
      "roadmap-executive.2",
      "roadmap-capability.2",
      "markitecture",
      "weekly-release",
    ]);
  });

  it("keeps active milestone focus on the executive roadmap only", () => {
    const model = buildSyntheticModel();
    const [executive, capability] = model.slides as Array<Record<string, unknown>>;
    const executiveMilestone = (executive.milestones as Array<Record<string, unknown>>)[0];
    const capabilityColumn = (capability.columns as Array<Record<string, unknown>>)[0];
    const modelOnlyFocus = "Model-only milestone focus";
    executiveMilestone.focus = modelOnlyFocus;
    capabilityColumn.focus = modelOnlyFocus;
    const readback = semanticReadback(model);
    const executiveText = (readback.slides as Array<Record<string, unknown>>)[0]
      .managedVisibleTextInventory as string[];
    const capabilityText = (readback.slides as Array<Record<string, unknown>>)[1]
      .managedVisibleTextInventory as string[];
    expect(executiveText).not.toContain("NemoClaw:");
    expect(executiveText).toContain(modelOnlyFocus);
    expect(capabilityText).toContain(capabilityColumn.title);
    expect(capabilityText).not.toContain("Focus");
    expect(capabilityText).not.toContain(modelOnlyFocus);
    expect(capabilityText).not.toContain("Active");
    expect([...executiveText, ...capabilityText].join("\n")).not.toContain("Shipped");
  });

  it("blocks weekly updates bound to the wrong milestone report", () => {
    const model = buildSyntheticModel();
    const weekly = (model.slides as Array<Record<string, unknown>>)[3];
    const row = (weekly.milestoneRows as Array<Record<string, unknown>>)[0];
    const update = (row.updates as Array<Record<string, unknown>>)[0];
    update.sourceDigest = "0".repeat(64);
    const schema = JSON.parse(fs.readFileSync(slideModelSchemaPath, "utf8"));
    const result = validateSlideModel(model, schema, "publish");

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PUBLICATION_BLOCKED" })]),
    );
  });
});
