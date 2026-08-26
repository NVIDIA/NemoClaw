// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Text } from "./validate-slide-model.mts";

export const NATIVE_KINDS = {
  "roadmap-executive": ["line", "shape", "text"],
  "roadmap-capability": ["shape", "table", "text"],
  markitecture: ["connector", "shape", "text"],
  "weekly-release": ["shape", "text"],
} as const;

type DynamicValue = ReturnType<typeof JSON.parse>;
export type ManagedRole = keyof typeof NATIVE_KINDS;
export type ProtectedTextSha256ByRole = Partial<Record<ManagedRole, readonly string[]>>;
export type ManagedVisibleTextByIdentity = Record<string, readonly string[]>;
type ModelSlide = Record<string, unknown> & {
  role: ManagedRole;
  instanceId?: string;
  managedNotes: unknown;
  sources: unknown;
};
type SlideModel = {
  modelSha256: string;
  snapshotSha256: string;
  templateFingerprint: string;
  slides: ModelSlide[];
};
type ReadbackSlide = {
  role: ManagedRole;
  instanceId?: string;
  nativeObjectKinds: string[];
  content: unknown;
  managedNotes: unknown;
  sources: unknown;
  hyperlinkInventory?: unknown;
  connectorInventory?: unknown;
  capabilityStructureInventory?: unknown;
  weeklyMilestoneStructureInventory?: unknown;
  visibleTextInventory?: unknown;
  managedVisibleTextInventory?: unknown;
  protectedVisibleTextInventory?: unknown;
  inheritedVisibleTextInventory?: unknown;
};
type SemanticReadback = {
  schemaVersion: number;
  modelSha256: string;
  snapshotSha256: string;
  templateFingerprint: string;
  slides: ReadbackSlide[];
};
type ParityFinding = {
  code: string;
  message: string;
  remediation: string;
};
type ParityCliOptions = {
  model?: string;
  google?: string;
  pptx?: string;
  roleMap?: string;
  output?: string;
};

export type HyperlinkInventoryEntry = {
  text: string;
  url: string;
};

export type ConnectorInventoryEntry = {
  contentId: string;
  from: string;
  to: string;
  direction: "from-to";
  lineStyle: "solid" | "dashed";
};

export type CapabilityStructureInventory = {
  table: {
    rowCount: number;
    columnCount: number;
    topRowText: string[];
    dividers: {
      segmentCount: number;
      color: string;
      lineStyle: string;
      widthEmu: number;
    };
  };
  milestoneTargets: Array<{
    tableColumnIndex: number;
    text: string;
    shapeType: string;
    inTopRowCell: boolean;
  }>;
  unusedTopRowMilestoneTargetCount: number;
  unusedBodyCellNonemptyCount: number;
  bottomMilestoneTargetCount: number;
};

export type WeeklyMilestoneStructureInventory = {
  rows: Array<{
    rowIndex: number;
    title: string;
    labelFillColor: string;
    labelTextColor: string;
    labelIsLeftOfContent: boolean;
    updates: Array<{ text: string; bulletCharacter: string }>;
    risks: Array<{ text: string; bulletCharacter: string }>;
  }>;
};

function slideIdentity(slide: { role: ManagedRole; instanceId?: unknown }): string {
  return typeof slide.instanceId === "string" && slide.instanceId.length > 0
    ? slide.instanceId
    : slide.role;
}

function slideIdentityFields(slide: { role: ManagedRole; instanceId?: unknown }): {
  role: ManagedRole;
  instanceId?: string;
} {
  return {
    role: slide.role,
    ...(typeof slide.instanceId === "string" && slide.instanceId.length > 0
      ? { instanceId: slide.instanceId }
      : {}),
  };
}

const EXPECTED_INHERITED_VISIBLE_TEXT_BY_ROLE: Record<ManagedRole, readonly string[]> = {
  "roadmap-executive": ["‹#›", "‹#›"],
  "roadmap-capability": ["‹#›"],
  markitecture: ["‹#›"],
  "weekly-release": ["‹#›"],
};

function asSlideModel(value: unknown): SlideModel {
  return value as SlideModel;
}

function asReadback(value: unknown): SemanticReadback {
  return value as SemanticReadback;
}

export function normalizeNativeKinds(role: string, nativeObjectKinds: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const kind of nativeObjectKinds) {
    if (kind === "group") continue;
    if (role === "roadmap-executive" && kind === "connector") normalized.add("line");
    else if (role === "markitecture" && kind === "line") normalized.add("connector");
    else normalized.add(kind);
  }
  return [...normalized].sort();
}

function slideContent(slide: ModelSlide): {
  content: Record<string, unknown>;
  managedNotes: unknown;
  sources: unknown;
} {
  const { managedNotes, sources, ...content } = slide;
  return { content, managedNotes, sources };
}

export function expectedSemanticProjection(model: unknown): DynamicValue {
  const typedModel = asSlideModel(model);
  return {
    schemaVersion: 1,
    modelSha256: typedModel.modelSha256,
    snapshotSha256: typedModel.snapshotSha256,
    templateFingerprint: typedModel.templateFingerprint,
    slides: typedModel.slides.map((slide) => ({
      ...slideIdentityFields(slide),
      nativeObjectKinds: NATIVE_KINDS[slide.role],
      ...slideContent(slide),
    })),
  };
}

export function normalizeReadback(readback: unknown): DynamicValue {
  const typedReadback = asReadback(readback);
  return {
    schemaVersion: typedReadback.schemaVersion,
    modelSha256: typedReadback.modelSha256,
    snapshotSha256: typedReadback.snapshotSha256,
    templateFingerprint: typedReadback.templateFingerprint,
    slides: typedReadback.slides.map((slide) => ({
      ...slideIdentityFields(slide),
      nativeObjectKinds: normalizeNativeKinds(slide.role, slide.nativeObjectKinds),
      content: slide.content,
      managedNotes: slide.managedNotes,
      sources: slide.sources,
    })),
  };
}

export function normalizeVisibleTextInventory(inventory: unknown): string[] | null {
  if (
    !Array.isArray(inventory) ||
    inventory.length === 0 ||
    inventory.some((value) => typeof value !== "string" || value.trim().length === 0)
  ) {
    return null;
  }
  return inventory.map((value) => value.replace(/\r\n?/gu, "\n")).sort();
}

function textParagraphs(value: unknown): string[] {
  if (typeof value !== "string" && typeof value !== "number") return [];
  return String(value)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .filter((part) => part.trim().length > 0);
}

function signedNumber(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? "");
  return `${numeric >= 0 ? "+" : ""}${numeric.toLocaleString("en-US")}`;
}

function normalizeHyperlinkText(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function compareHyperlinks(left: HyperlinkInventoryEntry, right: HyperlinkInventoryEntry): number {
  const textOrder = left.text < right.text ? -1 : left.text > right.text ? 1 : 0;
  return textOrder === 0 ? (left.url < right.url ? -1 : left.url > right.url ? 1 : 0) : textOrder;
}

function modelString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a nonempty string`);
  }
  return value;
}

function githubReferenceNumber(
  value: unknown,
  allowedKinds: readonly ("issues" | "discussions")[],
  context: string,
): string {
  const url = modelString(value, `${context} URL`);
  const match =
    /^https:\/\/github\.com\/NVIDIA\/NemoClaw\/(issues|discussions)\/([1-9][0-9]*)$/u.exec(url);
  if (!match || !allowedKinds.includes(match[1] as "issues" | "discussions")) {
    throw new Error(
      `${context} must use an exact NVIDIA/NemoClaw ${allowedKinds.join(" or ")} URL`,
    );
  }
  return match[2];
}

export function capabilityEpicReferenceText(item: Record<string, unknown>): string {
  return `#${githubReferenceNumber(item.url, ["issues"], `Capability item ${String(item.contentId)}`)}`;
}

function epicCompletionPrefix(item: Record<string, unknown>, context: string): string {
  const state = modelString(item.state, `${context} state`);
  if (state !== "OPEN" && state !== "CLOSED") {
    throw new Error(`${context} state must be OPEN or CLOSED`);
  }
  return state === "CLOSED" ? "✓ " : "";
}

export function roadmapEpicDisplayText(outcome: Record<string, unknown>): string {
  const context = `Roadmap outcome ${String(outcome.contentId)}`;
  const prefix = epicCompletionPrefix(outcome, context);
  const title = modelString(outcome.featureTitle, `${context} feature title`);
  const text = modelString(outcome.text, `${context} text`);
  return `${prefix}${title}: ${text}`;
}

export function capabilityEpicDisplayText(item: Record<string, unknown>): string {
  const context = `Capability item ${String(item.contentId)}`;
  const prefix = epicCompletionPrefix(item, context);
  const title = modelString(item.title, `${context} title`);
  return `${prefix}${title} (${capabilityEpicReferenceText(item)})`;
}

export function roadmapFocusLabel(_item: Record<string, unknown>): string {
  return "NemoClaw:";
}

export function roadmapFocusText(item: Record<string, unknown>): string {
  return `${roadmapFocusLabel(item)}\n${modelString(item.focus, "Roadmap milestone focus")}`;
}

function expectedHyperlinkEntry(
  text: unknown,
  url: unknown,
  context: string,
): HyperlinkInventoryEntry {
  return {
    text: normalizeHyperlinkText(modelString(text, `${context} text`)),
    url: modelString(url, `${context} URL`),
  };
}

/**
 * Derive the hyperlink contract independently from the shared model. The
 * artifact adapters must inventory links from their native output; they must
 * not copy this projection into a readback.
 */
export function expectedHyperlinkInventory(model: unknown): Array<{
  role: ManagedRole;
  instanceId?: string;
  hyperlinkInventory: HyperlinkInventoryEntry[];
}> {
  const typedModel = asSlideModel(model);
  return typedModel.slides.map((modelSlide) => {
    const slide = modelSlide as Record<string, unknown>;
    const hyperlinkInventory: HyperlinkInventoryEntry[] = [];
    if (modelSlide.role === "roadmap-executive") {
      // The native roadmap exemplar has no visible text hyperlinks.
    } else if (modelSlide.role === "roadmap-capability") {
      for (const cell of slide.cells as Array<Record<string, unknown>>) {
        for (const item of cell.items as Array<Record<string, unknown>>) {
          hyperlinkInventory.push(
            expectedHyperlinkEntry(
              capabilityEpicReferenceText(item),
              item.url,
              `Capability item ${String(item.contentId)}`,
            ),
          );
        }
      }
      for (const item of slide.unclassified as Array<Record<string, unknown>>) {
        hyperlinkInventory.push(
          expectedHyperlinkEntry(
            capabilityEpicReferenceText(item),
            item.url,
            `Unclassified capability item ${String(item.contentId)}`,
          ),
        );
      }
    }
    return {
      ...slideIdentityFields(modelSlide),
      hyperlinkInventory: hyperlinkInventory.sort(compareHyperlinks),
    };
  });
}

export function normalizeHyperlinkInventory(inventory: unknown): HyperlinkInventoryEntry[] | null {
  if (!Array.isArray(inventory)) return null;
  const normalized: HyperlinkInventoryEntry[] = [];
  for (const entry of inventory) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { text, url } = entry as { text?: unknown; url?: unknown };
    if (typeof text !== "string" || typeof url !== "string" || url.length === 0) return null;
    const normalizedText = normalizeHyperlinkText(text);
    if (normalizedText.length === 0) return null;
    normalized.push({ text: normalizedText, url });
  }
  return normalized.sort(compareHyperlinks);
}

function compareConnectorInventoryEntries(
  left: ConnectorInventoryEntry,
  right: ConnectorInventoryEntry,
): number {
  for (const key of ["contentId", "from", "to", "direction", "lineStyle"] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

/**
 * Project the semantic connector direction and line treatment from the shared
 * model. Adapters must derive the same canonical form from native arrowheads,
 * dash properties, and connector geometry in each output artifact.
 */
export function expectedConnectorInventory(model: unknown): Array<{
  role: ManagedRole;
  instanceId?: string;
  connectorInventory: ConnectorInventoryEntry[];
}> {
  const typedModel = asSlideModel(model);
  return typedModel.slides.map((modelSlide) => {
    if (modelSlide.role !== "markitecture") {
      return { ...slideIdentityFields(modelSlide), connectorInventory: [] };
    }
    const connectors = (modelSlide as Record<string, unknown>).connectors;
    if (!Array.isArray(connectors)) {
      throw new Error("The shared model is missing markitecture connectors");
    }
    const connectorInventory: ConnectorInventoryEntry[] = connectors.map((connector, index) => {
      if (!connector || typeof connector !== "object" || Array.isArray(connector)) {
        throw new Error(`Markitecture connector ${index} must be an object`);
      }
      const typedConnector = connector as Record<string, unknown>;
      const lineStyle = typedConnector.lineStyle;
      if (lineStyle !== "solid" && lineStyle !== "dashed") {
        throw new Error(`Markitecture connector ${index} has an invalid lineStyle`);
      }
      return {
        contentId: modelString(
          typedConnector.contentId,
          `Markitecture connector ${index} contentId`,
        ),
        from: modelString(typedConnector.from, `Markitecture connector ${index} from`),
        to: modelString(typedConnector.to, `Markitecture connector ${index} to`),
        direction: "from-to" as const,
        lineStyle,
      };
    });
    return {
      ...slideIdentityFields(modelSlide),
      connectorInventory: connectorInventory.sort(compareConnectorInventoryEntries),
    };
  });
}

export function normalizeConnectorInventory(inventory: unknown): ConnectorInventoryEntry[] | null {
  if (!Array.isArray(inventory)) return null;
  const normalized: ConnectorInventoryEntry[] = [];
  for (const entry of inventory) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { contentId, from, to, direction, lineStyle } = entry as Record<string, unknown>;
    if (
      typeof contentId !== "string" ||
      contentId.length === 0 ||
      typeof from !== "string" ||
      from.length === 0 ||
      typeof to !== "string" ||
      to.length === 0 ||
      direction !== "from-to" ||
      (lineStyle !== "solid" && lineStyle !== "dashed")
    ) {
      return null;
    }
    normalized.push({ contentId, from, to, direction, lineStyle });
  }
  return normalized.sort(compareConnectorInventoryEntries);
}

/**
 * Describe only the native capability-matrix structure that must agree across
 * Google Slides and PowerPoint. The adapters derive this from their output
 * objects; they must not copy the expected projection into a readback.
 */
export function expectedCapabilityStructureInventory(model: unknown): Array<{
  role: "roadmap-capability";
  instanceId?: string;
  capabilityStructureInventory: CapabilityStructureInventory;
}> {
  const typedModel = asSlideModel(model);
  return typedModel.slides.flatMap((modelSlide) => {
    if (modelSlide.role !== "roadmap-capability") return [];
    const columns = (modelSlide as Record<string, unknown>).columns;
    if (!Array.isArray(columns) || columns.length < 1 || columns.length > 3) {
      throw new Error("The shared model has an invalid capability column count");
    }
    return [
      {
        role: "roadmap-capability" as const,
        ...(typeof modelSlide.instanceId === "string" ? { instanceId: modelSlide.instanceId } : {}),
        capabilityStructureInventory: {
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
          milestoneTargets: columns.map((column, index) => ({
            tableColumnIndex: index + 1,
            text: modelString(
              (column as Record<string, unknown>).title,
              `Capability column ${index} title`,
            ),
            shapeType: "HOME_PLATE",
            inTopRowCell: true,
          })),
          unusedTopRowMilestoneTargetCount: 0,
          unusedBodyCellNonemptyCount: 0,
          bottomMilestoneTargetCount: 0,
        },
      },
    ];
  });
}

export function normalizeCapabilityStructureInventory(
  inventory: unknown,
): CapabilityStructureInventory | null {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return null;
  const {
    table,
    milestoneTargets,
    unusedTopRowMilestoneTargetCount,
    unusedBodyCellNonemptyCount,
    bottomMilestoneTargetCount,
  } = inventory as Record<string, unknown>;
  if (!table || typeof table !== "object" || Array.isArray(table)) return null;
  const { rowCount, columnCount, topRowText, dividers } = table as Record<string, unknown>;
  if (!dividers || typeof dividers !== "object" || Array.isArray(dividers)) return null;
  const { segmentCount, color, lineStyle, widthEmu } = dividers as Record<string, unknown>;
  if (
    !Number.isInteger(rowCount) ||
    Number(rowCount) < 0 ||
    !Number.isInteger(columnCount) ||
    Number(columnCount) < 0 ||
    !Array.isArray(topRowText) ||
    topRowText.some((value) => typeof value !== "string") ||
    !Number.isInteger(segmentCount) ||
    Number(segmentCount) < 0 ||
    typeof color !== "string" ||
    color.length === 0 ||
    typeof lineStyle !== "string" ||
    lineStyle.length === 0 ||
    !Number.isInteger(widthEmu) ||
    Number(widthEmu) < 0 ||
    !Array.isArray(milestoneTargets) ||
    !Number.isInteger(unusedTopRowMilestoneTargetCount) ||
    Number(unusedTopRowMilestoneTargetCount) < 0 ||
    !Number.isInteger(unusedBodyCellNonemptyCount) ||
    Number(unusedBodyCellNonemptyCount) < 0 ||
    !Number.isInteger(bottomMilestoneTargetCount) ||
    Number(bottomMilestoneTargetCount) < 0
  ) {
    return null;
  }
  const normalizedTargets: CapabilityStructureInventory["milestoneTargets"] = [];
  for (const target of milestoneTargets) {
    if (!target || typeof target !== "object" || Array.isArray(target)) return null;
    const { tableColumnIndex, text, shapeType, inTopRowCell } = target as Record<string, unknown>;
    if (
      !Number.isInteger(tableColumnIndex) ||
      Number(tableColumnIndex) < 0 ||
      typeof text !== "string" ||
      text.length === 0 ||
      typeof shapeType !== "string" ||
      shapeType.length === 0 ||
      typeof inTopRowCell !== "boolean"
    ) {
      return null;
    }
    normalizedTargets.push({
      tableColumnIndex: Number(tableColumnIndex),
      text: text.replace(/\r\n?/gu, "\n"),
      shapeType: shapeType === "homePlate" ? "HOME_PLATE" : shapeType,
      inTopRowCell,
    });
  }
  return {
    table: {
      rowCount: Number(rowCount),
      columnCount: Number(columnCount),
      topRowText: topRowText.map((value) => String(value).replace(/\r\n?/gu, "\n")),
      dividers: {
        segmentCount: Number(segmentCount),
        color: color.startsWith("#") ? color.toUpperCase() : `#${color.toUpperCase()}`,
        lineStyle: lineStyle.toLowerCase(),
        widthEmu: Number(widthEmu),
      },
    },
    milestoneTargets: normalizedTargets,
    unusedTopRowMilestoneTargetCount: Number(unusedTopRowMilestoneTargetCount),
    unusedBodyCellNonemptyCount: Number(unusedBodyCellNonemptyCount),
    bottomMilestoneTargetCount: Number(bottomMilestoneTargetCount),
  };
}

/** Describes weekly row placement, label styling, and native paragraph bullets. */
export function expectedWeeklyMilestoneStructureInventory(model: unknown): Array<{
  role: "weekly-release";
  weeklyMilestoneStructureInventory: WeeklyMilestoneStructureInventory;
}> {
  const typedModel = asSlideModel(model);
  return typedModel.slides.flatMap((modelSlide) => {
    if (modelSlide.role !== "weekly-release") return [];
    const milestoneRows = (modelSlide as Record<string, unknown>).milestoneRows;
    if (!Array.isArray(milestoneRows) || milestoneRows.length < 1 || milestoneRows.length > 3) {
      throw new Error("The shared model has an invalid weekly milestone row count");
    }
    return [
      {
        role: "weekly-release" as const,
        weeklyMilestoneStructureInventory: {
          rows: milestoneRows.map((row, rowIndex) => {
            const typedRow = row as Record<string, unknown>;
            const updates = typedRow.updates as Array<Record<string, unknown>>;
            const risks = typedRow.risks as Array<Record<string, unknown>>;
            return {
              rowIndex,
              title: weeklyMilestoneLabelText(
                modelString(typedRow.title, `Weekly row ${rowIndex} title`),
              ),
              labelFillColor: "#76B900",
              labelTextColor: "#FFFFFF",
              labelIsLeftOfContent: true,
              updates: updates.map((item) => ({
                text: `${String(item.label)}: ${String(item.text)}`,
                bulletCharacter: "•",
              })),
              risks:
                risks.length > 0
                  ? risks.map((item) => ({
                      text: `${String(item.label)}: ${String(item.text)}`,
                      bulletCharacter: "•",
                    }))
                  : [{ text: "None", bulletCharacter: "•" }],
            };
          }),
        },
      },
    ];
  });
}

export function normalizeWeeklyMilestoneStructureInventory(
  inventory: unknown,
): WeeklyMilestoneStructureInventory | null {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return null;
  const rows = (inventory as Record<string, unknown>).rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 3) return null;
  const normalizedRows: WeeklyMilestoneStructureInventory["rows"] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const typedRow = row as Record<string, unknown>;
    const normalizeParagraphs = (
      value: unknown,
    ): Array<{ text: string; bulletCharacter: string }> | null => {
      if (!Array.isArray(value) || value.length === 0) return null;
      const paragraphs: Array<{ text: string; bulletCharacter: string }> = [];
      for (const paragraph of value) {
        if (!paragraph || typeof paragraph !== "object" || Array.isArray(paragraph)) return null;
        const typedParagraph = paragraph as Record<string, unknown>;
        if (
          typeof typedParagraph.text !== "string" ||
          typedParagraph.text.trim().length === 0 ||
          typeof typedParagraph.bulletCharacter !== "string"
        ) {
          return null;
        }
        paragraphs.push({
          text: typedParagraph.text,
          bulletCharacter: typedParagraph.bulletCharacter,
        });
      }
      return paragraphs;
    };
    const updates = normalizeParagraphs(typedRow.updates);
    const risks = normalizeParagraphs(typedRow.risks);
    if (
      !Number.isInteger(typedRow.rowIndex) ||
      typedRow.rowIndex !== normalizedRows.length ||
      typeof typedRow.title !== "string" ||
      typedRow.title.length === 0 ||
      !/^#?[0-9A-Fa-f]{6}$/u.test(String(typedRow.labelFillColor ?? "")) ||
      !/^#?[0-9A-Fa-f]{6}$/u.test(String(typedRow.labelTextColor ?? "")) ||
      typeof typedRow.labelIsLeftOfContent !== "boolean" ||
      !updates ||
      !risks
    ) {
      return null;
    }
    normalizedRows.push({
      rowIndex: Number(typedRow.rowIndex),
      title: typedRow.title,
      labelFillColor: String(typedRow.labelFillColor).startsWith("#")
        ? String(typedRow.labelFillColor).toUpperCase()
        : `#${String(typedRow.labelFillColor).toUpperCase()}`,
      labelTextColor: String(typedRow.labelTextColor).startsWith("#")
        ? String(typedRow.labelTextColor).toUpperCase()
        : `#${String(typedRow.labelTextColor).toUpperCase()}`,
      labelIsLeftOfContent: typedRow.labelIsLeftOfContent,
      updates,
      risks,
    });
  }
  return { rows: normalizedRows };
}

function metricByContentId(
  slide: Record<string, unknown>,
  contentId: string,
): Record<string, unknown> | undefined {
  return (slide.metrics as Array<Record<string, unknown>> | undefined)?.find(
    (metric) => metric.contentId === contentId,
  );
}

function runtimeTextValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(runtimeTextValue).join("\n");
  return String(value);
}

function weeklyMilestoneLabelText(title: unknown): string {
  return runtimeTextValue(title).trim().split(/\s+/u).join("\n").toUpperCase();
}

function expectedRoleMapMetricText(
  slide: Record<string, unknown>,
  operation: Record<string, unknown>,
): string {
  if (operation.kind === "momentum") {
    if (!Array.isArray(operation.metricContentIds)) {
      throw new Error("Runtime momentum metric operation must name metric content IDs");
    }
    return operation.metricContentIds
      .map((contentId) => metricByContentId(slide, String(contentId)))
      .filter((metric): metric is Record<string, unknown> => Boolean(metric))
      .map(
        (metric) =>
          `${String(metric.label)} ${Number(metric.value).toLocaleString("en-US")} (${signedNumber(metric.detailValue)})`,
      )
      .join("  |  ");
  }
  if (operation.kind === "opened-closed") {
    const metric = metricByContentId(slide, String(operation.metricContentId));
    if (!metric) throw new Error("Runtime opened/closed operation names an unknown metric");
    const opened =
      /(-?\d+)/u.exec(runtimeTextValue(metric.value))?.[1] ?? runtimeTextValue(metric.value);
    return `${opened} OPENED  |  ${runtimeTextValue(metric.detailValue)} CLOSED`;
  }
  if (operation.kind === "single") {
    const metric = metricByContentId(slide, String(operation.metricContentId));
    if (!metric) throw new Error("Runtime single-value operation names an unknown metric");
    return runtimeTextValue(metric.value);
  }
  throw new Error(`Unknown runtime metric operation: ${String(operation.kind)}`);
}

/**
 * Return slide-local strings introduced by the runtime role map rather than
 * by the shared semantic model. These remain managed output, but the role map
 * is the only source that can name template-specific labels and renderings.
 */
export function managedOperationTextByIdentity(
  model: unknown,
  roleMap: unknown,
): ManagedVisibleTextByIdentity {
  const typedModel = asSlideModel(model);
  const roles =
    roleMap && typeof roleMap === "object" && !Array.isArray(roleMap)
      ? ((roleMap as Record<string, unknown>).roles as Record<string, unknown> | undefined)
      : undefined;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    throw new Error("Runtime PowerPoint role map must declare roles");
  }
  return Object.fromEntries(
    typedModel.slides.map((modelSlide) => {
      const slide = modelSlide as Record<string, unknown>;
      const rawContract = roles[modelSlide.role];
      const contract =
        rawContract && typeof rawContract === "object" && !Array.isArray(rawContract)
          ? (rawContract as Record<string, unknown>)
          : {};
      const operationGroups = [
        contract.operations,
        contract.richTextOperations,
        contract.outcomeOperations,
        contract.outcomeListOperations,
        contract.metricOperations,
        contract.milestoneRowOperations,
      ];
      const literals = operationGroups
        .flatMap((operations) => (Array.isArray(operations) ? operations : []))
        .filter(
          (operation): operation is Record<string, unknown> =>
            Boolean(operation) &&
            typeof operation === "object" &&
            !Array.isArray(operation) &&
            Object.hasOwn(operation, "literal"),
        )
        .map(
          (operation) =>
            `${runtimeTextValue(operation.prefix)}${runtimeTextValue(operation.literal)}${runtimeTextValue(operation.suffix)}`,
        )
        .filter((value) => value.length > 0);
      const renderedOperationText = [...literals];
      if (modelSlide.role === "weekly-release") {
        const metricOperations = Array.isArray(contract.metricOperations)
          ? contract.metricOperations
          : [];
        for (const operation of metricOperations) {
          if (!operation || typeof operation !== "object" || Array.isArray(operation)) continue;
          renderedOperationText.push(
            expectedRoleMapMetricText(slide, operation as Record<string, unknown>),
          );
        }
        const milestoneRowOperations = Array.isArray(contract.milestoneRowOperations)
          ? contract.milestoneRowOperations
          : [];
        for (const operation of milestoneRowOperations) {
          if (!operation || typeof operation !== "object" || Array.isArray(operation)) continue;
          const typedOperation = operation as Record<string, unknown>;
          if (typedOperation.kind !== "label" || !Number.isInteger(typedOperation.rowIndex)) {
            continue;
          }
          const rows = slide.milestoneRows;
          const row = Array.isArray(rows) ? rows[Number(typedOperation.rowIndex)] : undefined;
          if (!row || typeof row !== "object" || Array.isArray(row)) continue;
          renderedOperationText.push(
            ...weeklyMilestoneLabelText((row as Record<string, unknown>).title).split("\n"),
          );
        }
      }
      return [slideIdentity(modelSlide), renderedOperationText] as const;
    }),
  );
}

/**
 * Return every slide-local audience string that the shared model and the
 * renderer contract permit. Inherited master/layout text is intentionally not
 * included: adapters must report it separately so shared stale slide-local
 * wording cannot be hidden as cross-format parity.
 */
export function expectedManagedVisibleTextInventory(model: unknown): Array<{
  role: ManagedRole;
  instanceId?: string;
  visibleTextInventory: string[];
}> {
  const typedModel = asSlideModel(model);
  return typedModel.slides.map((modelSlide) => {
    const slide = modelSlide as Record<string, unknown>;
    const values: string[] = [];
    if (slide.role === "roadmap-executive") {
      values.push(...textParagraphs(slide.title), ...textParagraphs(slide.summary));
      for (const milestone of slide.milestones as Array<Record<string, unknown>>) {
        values.push(
          ...textParagraphs(milestone.title),
          roadmapFocusLabel(milestone),
          ...textParagraphs(milestone.focus),
        );
        for (const outcome of milestone.outcomes as Array<Record<string, unknown>>) {
          values.push(roadmapEpicDisplayText(outcome));
        }
      }
    } else if (slide.role === "roadmap-capability") {
      values.push(...textParagraphs(slide.title));
      for (const column of slide.columns as Array<Record<string, unknown>>) {
        values.push(...textParagraphs(column.title));
      }
      for (const row of slide.rows as unknown[]) values.push(...textParagraphs(row));
      for (const cell of slide.cells as Array<Record<string, unknown>>) {
        for (const item of cell.items as Array<Record<string, unknown>>) {
          values.push(capabilityEpicDisplayText(item));
        }
      }
      const unclassified = slide.unclassified as Array<Record<string, unknown>>;
      if (unclassified.length > 0) {
        values.push(unclassified.map(capabilityEpicDisplayText).join("; "));
      }
    } else if (slide.role === "markitecture") {
      values.push(...textParagraphs(slide.title));
      for (const node of slide.nodes as Array<Record<string, unknown>>) {
        values.push(...textParagraphs(node.text));
      }
      for (const connector of slide.connectors as Array<Record<string, unknown>>) {
        values.push(...textParagraphs(connector.label));
      }
    } else {
      values.push(
        ...textParagraphs(slide.title),
        "REPO MOMENTUM  |  TOTAL (+WOW)",
        "VDR / UAT ISSUES  |  LAST 7 DAYS",
        "LATEST RELEASE",
        "UPDATES",
        "RISKS / BLOCKERS",
      );
      const momentum = ["metric.stars", "metric.forks", "metric.merged-prs"]
        .map((contentId) => metricByContentId(slide, contentId))
        .filter((metric): metric is Record<string, unknown> => Boolean(metric))
        .map(
          (metric) =>
            `${String(metric.label)} ${Number(metric.value).toLocaleString("en-US")} (${signedNumber(metric.detailValue)})`,
        );
      if (momentum.length > 0) values.push(momentum.join("  |  "));
      const vdr = metricByContentId(slide, "metric.vdr-uat");
      if (vdr) {
        const opened = /(-?\d+)/u.exec(String(vdr.value))?.[1] ?? String(vdr.value);
        values.push(`${opened} OPENED  |  ${String(vdr.detailValue)} CLOSED`);
      }
      const latest = metricByContentId(slide, "metric.latest-release");
      if (latest) values.push(...textParagraphs(latest.value));
      for (const row of slide.milestoneRows as Array<Record<string, unknown>>) {
        values.push(...weeklyMilestoneLabelText(row.title).split("\n"));
        for (const item of row.updates as Array<Record<string, unknown>>) {
          values.push(`${String(item.label)}: ${String(item.text)}`);
        }
        const risks = row.risks as Array<Record<string, unknown>>;
        if (risks.length === 0) values.push("None");
        for (const item of risks) values.push(`${String(item.label)}: ${String(item.text)}`);
      }
    }
    return {
      ...slideIdentityFields(modelSlide),
      visibleTextInventory: values.sort(),
    };
  });
}

export function expectedManagedVisibleTextInventoryWithExtras(
  model: unknown,
  extraManagedTextByIdentity: ManagedVisibleTextByIdentity = {},
): ReturnType<typeof expectedManagedVisibleTextInventory> {
  return expectedManagedVisibleTextInventory(model).map((slide) => {
    const baseCounts = new Map<string, number>();
    const extraCounts = new Map<string, number>();
    for (const value of slide.visibleTextInventory) {
      const normalized = value.replace(/\r\n?/gu, "\n");
      baseCounts.set(normalized, (baseCounts.get(normalized) ?? 0) + 1);
    }
    for (const value of extraManagedTextByIdentity[slideIdentity(slide)] ?? []) {
      const normalized = value.replace(/\r\n?/gu, "\n");
      extraCounts.set(normalized, (extraCounts.get(normalized) ?? 0) + 1);
    }
    const values: string[] = [];
    for (const value of new Set([...baseCounts.keys(), ...extraCounts.keys()])) {
      const count = Math.max(baseCounts.get(value) ?? 0, extraCounts.get(value) ?? 0);
      for (let index = 0; index < count; index += 1) values.push(value);
    }
    return { ...slideIdentityFields(slide), visibleTextInventory: values.sort() };
  });
}

export type ArtifactTextLayers = {
  role: ManagedRole;
  instanceId?: string;
  slideLocalText: string[];
  inheritedText: string[];
};

export type ClassifiedArtifactText = {
  role: ManagedRole;
  instanceId?: string;
  visibleTextInventory: string[];
  managedVisibleTextInventory: string[];
  protectedVisibleTextInventory: string[];
  inheritedVisibleTextInventory: string[];
  unexpectedVisibleTextInventory: string[];
};

type CapabilityForbiddenText = {
  focus: string[];
};

function capabilityForbiddenTextByIdentity(
  model: SlideModel,
): Map<string, CapabilityForbiddenText> {
  return new Map(
    model.slides.flatMap((slide) => {
      if (slide.role !== "roadmap-capability") return [];
      const focus: string[] = [];
      const columns = (slide as Record<string, unknown>).columns;
      if (Array.isArray(columns)) {
        for (const column of columns) {
          if (!column || typeof column !== "object" || Array.isArray(column)) continue;
          const typedColumn = column as Record<string, unknown>;
          if (typeof typedColumn.focus === "string") {
            focus.push(typedColumn.focus);
          }
        }
      }
      return [[slideIdentity(slide), { focus }] as const];
    }),
  );
}

function containsCapabilityForbiddenText(
  value: string,
  forbidden: CapabilityForbiddenText,
): boolean {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .some((line) => {
      const normalizedLine = line.toLocaleLowerCase("en-US");
      return (
        /\b(?:focus|active|completed|shipped)\b/iu.test(line) ||
        forbidden.focus.some((focus) => {
          const normalizedFocus = focus.trim().toLocaleLowerCase("en-US");
          return normalizedFocus.length > 0 && normalizedLine.includes(normalizedFocus);
        })
      );
    });
}

/**
 * Classify actual artifact text without embedding private template wording in
 * the model. Model-derived strings are managed. Slide-local text is protected
 * only when the same text is observed in an inherited approved template layer
 * elsewhere in the artifact; everything else is unexpected.
 */
export function classifyArtifactTextInventories(
  model: unknown,
  layers: ArtifactTextLayers[],
  protectedTextSha256ByRole: ProtectedTextSha256ByRole = {},
  extraManagedTextByIdentity: ManagedVisibleTextByIdentity = {},
): ClassifiedArtifactText[] {
  const expectedByIdentity = new Map(
    expectedManagedVisibleTextInventoryWithExtras(model, extraManagedTextByIdentity).map(
      (slide) => [slideIdentity(slide), slide.visibleTextInventory],
    ),
  );
  const forbiddenByIdentity = capabilityForbiddenTextByIdentity(asSlideModel(model));
  const inheritedTemplateText = new Set(
    layers.flatMap((layer) => layer.inheritedText.map((value) => value.replace(/\r\n?/gu, "\n"))),
  );
  return layers.map((layer) => {
    const protectedHashes = new Set(
      (protectedTextSha256ByRole[layer.role] ?? []).map((digest) => {
        if (!/^[0-9a-f]{64}$/u.test(digest)) {
          throw new Error(`${layer.role} protected template text digest is not a SHA-256`);
        }
        return digest;
      }),
    );
    const expectedCounts = new Map<string, number>();
    const identity = slideIdentity(layer);
    for (const value of expectedByIdentity.get(identity) ?? []) {
      const normalized = value.replace(/\r\n?/gu, "\n");
      expectedCounts.set(normalized, (expectedCounts.get(normalized) ?? 0) + 1);
    }
    const managed: string[] = [];
    const protectedText: string[] = [];
    const unexpected: string[] = [];
    const slideLocal = layer.slideLocalText.map((value) => value.replace(/\r\n?/gu, "\n"));
    const inherited = layer.inheritedText.map((value) => value.replace(/\r\n?/gu, "\n"));
    const forbidden = forbiddenByIdentity.get(slideIdentity(layer));
    for (const value of slideLocal) {
      const remaining = expectedCounts.get(value) ?? 0;
      if (remaining > 0) {
        managed.push(value);
        expectedCounts.set(value, remaining - 1);
      } else if (forbidden && containsCapabilityForbiddenText(value, forbidden)) {
        unexpected.push(value);
      } else if (inheritedTemplateText.has(value) || protectedHashes.has(sha256Text(value))) {
        protectedText.push(value);
      } else unexpected.push(value);
    }
    return {
      ...slideIdentityFields(layer),
      visibleTextInventory: [...slideLocal, ...inherited].sort(),
      managedVisibleTextInventory: managed.sort(),
      protectedVisibleTextInventory: protectedText.sort(),
      inheritedVisibleTextInventory: inherited.sort(),
      unexpectedVisibleTextInventory: unexpected.sort(),
    };
  });
}

function forbiddenCapabilityProtectedText(
  model: SlideModel,
  readback: unknown,
): Array<{ identity: string; text: string }> | null {
  if (
    !readback ||
    typeof readback !== "object" ||
    !Array.isArray((readback as { slides?: unknown }).slides)
  ) {
    return null;
  }
  const forbiddenByIdentity = capabilityForbiddenTextByIdentity(model);
  const violations: Array<{ identity: string; text: string }> = [];
  for (const slide of (readback as SemanticReadback).slides) {
    if (slide.role !== "roadmap-capability") continue;
    if (!Array.isArray(slide.protectedVisibleTextInventory)) return null;
    const identity = slideIdentity(slide);
    const forbidden = forbiddenByIdentity.get(identity);
    if (!forbidden) return null;
    for (const value of slide.protectedVisibleTextInventory) {
      if (typeof value !== "string") return null;
      if (containsCapabilityForbiddenText(value, forbidden)) {
        violations.push({ identity, text: value.replace(/\r\n?/gu, "\n") });
      }
    }
  }
  return violations;
}

function visibleTextProjection(readback: unknown): DynamicValue | null {
  if (
    !readback ||
    typeof readback !== "object" ||
    !Array.isArray((readback as { slides?: unknown }).slides)
  )
    return null;
  const slides: Array<{ role: ManagedRole; visibleTextInventory: string[] }> = [];
  for (const slide of (readback as SemanticReadback).slides) {
    const visibleTextInventory = normalizeVisibleTextInventory(slide.visibleTextInventory);
    if (!visibleTextInventory) return null;
    slides.push({ ...slideIdentityFields(slide), visibleTextInventory });
  }
  return { schemaVersion: 1, slides };
}

function hyperlinkProjection(readback: unknown): DynamicValue | null {
  if (
    !readback ||
    typeof readback !== "object" ||
    !Array.isArray((readback as { slides?: unknown }).slides)
  )
    return null;
  const slides: Array<{
    role: ManagedRole;
    hyperlinkInventory: HyperlinkInventoryEntry[];
  }> = [];
  for (const slide of (readback as SemanticReadback).slides) {
    const hyperlinkInventory = normalizeHyperlinkInventory(slide.hyperlinkInventory);
    if (!hyperlinkInventory) return null;
    slides.push({ ...slideIdentityFields(slide), hyperlinkInventory });
  }
  return { schemaVersion: 1, slides };
}

function connectorProjection(readback: unknown): DynamicValue | null {
  if (
    !readback ||
    typeof readback !== "object" ||
    !Array.isArray((readback as { slides?: unknown }).slides)
  )
    return null;
  const slides: Array<{
    role: ManagedRole;
    connectorInventory: ConnectorInventoryEntry[];
  }> = [];
  for (const slide of (readback as SemanticReadback).slides) {
    const connectorInventory = normalizeConnectorInventory(slide.connectorInventory);
    if (!connectorInventory) return null;
    slides.push({ ...slideIdentityFields(slide), connectorInventory });
  }
  return { schemaVersion: 1, slides };
}

function capabilityStructureProjection(readback: unknown): DynamicValue | null {
  if (
    !readback ||
    typeof readback !== "object" ||
    !Array.isArray((readback as { slides?: unknown }).slides)
  ) {
    return null;
  }
  const slides: Array<{
    role: "roadmap-capability";
    instanceId?: string;
    capabilityStructureInventory: CapabilityStructureInventory;
  }> = [];
  for (const slide of (readback as SemanticReadback).slides) {
    if (slide.role !== "roadmap-capability") continue;
    const capabilityStructureInventory = normalizeCapabilityStructureInventory(
      slide.capabilityStructureInventory,
    );
    if (!capabilityStructureInventory) return null;
    slides.push({
      role: "roadmap-capability",
      ...(typeof slide.instanceId === "string" ? { instanceId: slide.instanceId } : {}),
      capabilityStructureInventory,
    });
  }
  return slides.length > 0 ? { schemaVersion: 1, slides } : null;
}

function weeklyMilestoneStructureProjection(readback: unknown): DynamicValue | null {
  if (
    !readback ||
    typeof readback !== "object" ||
    !Array.isArray((readback as { slides?: unknown }).slides)
  ) {
    return null;
  }
  const weeklySlides = (readback as SemanticReadback).slides.filter(
    (slide) => slide.role === "weekly-release",
  );
  if (weeklySlides.length !== 1) return null;
  const inventory = normalizeWeeklyMilestoneStructureInventory(
    weeklySlides[0].weeklyMilestoneStructureInventory,
  );
  return inventory
    ? {
        schemaVersion: 1,
        slides: [
          {
            role: "weekly-release",
            weeklyMilestoneStructureInventory: inventory,
          },
        ],
      }
    : null;
}

function scopedVisibleTextProjection(
  readback: unknown,
  key:
    | "managedVisibleTextInventory"
    | "protectedVisibleTextInventory"
    | "inheritedVisibleTextInventory",
): DynamicValue | null {
  if (
    !readback ||
    typeof readback !== "object" ||
    !Array.isArray((readback as { slides?: unknown }).slides)
  )
    return null;
  const slides: Array<{ role: ManagedRole; visibleTextInventory: string[] }> = [];
  for (const slide of (readback as SemanticReadback).slides) {
    const raw = slide[key];
    if (
      !Array.isArray(raw) ||
      raw.some((value) => typeof value !== "string" || value.trim().length === 0)
    )
      return null;
    if (key === "managedVisibleTextInventory" && raw.length === 0) return null;
    const visibleTextInventory = raw.map((value) => value.replace(/\r\n?/gu, "\n")).sort();
    slides.push({ ...slideIdentityFields(slide), visibleTextInventory });
  }
  return { schemaVersion: 1, slides };
}

function expectedInheritedVisibleTextProjection(model: SlideModel): DynamicValue {
  return {
    schemaVersion: 1,
    slides: model.slides.map((slide) => ({
      ...slideIdentityFields(slide),
      visibleTextInventory: [...EXPECTED_INHERITED_VISIBLE_TEXT_BY_ROLE[slide.role]].sort(),
    })),
  };
}

function protectedVisibleTextDigestProjection(readback: unknown): DynamicValue | null {
  const projection = scopedVisibleTextProjection(readback, "protectedVisibleTextInventory");
  if (!projection) return null;
  return {
    schemaVersion: 1,
    slides: projection.slides.map(
      (slide: { role: ManagedRole; visibleTextInventory: string[] }) => ({
        ...slideIdentityFields(slide),
        visibleTextSha256: slide.visibleTextInventory.map(sha256Text).sort(),
      }),
    ),
  };
}

function expectedProtectedVisibleTextDigestProjection(
  model: SlideModel,
  protectedTextSha256ByRole: ProtectedTextSha256ByRole,
): DynamicValue {
  return {
    schemaVersion: 1,
    slides: model.slides.map((slide) => {
      const digests = protectedTextSha256ByRole[slide.role] ?? [];
      for (const digest of digests) {
        if (!/^[0-9a-f]{64}$/u.test(digest)) {
          throw new Error(
            `${slide.role} protected template text digest is not a lowercase SHA-256`,
          );
        }
      }
      return {
        ...slideIdentityFields(slide),
        visibleTextSha256: [...digests].sort(),
      };
    }),
  };
}

export function compareParity(
  model: unknown,
  googleReadback: unknown,
  pptxReadback: unknown,
  protectedTextSha256ByRole: ProtectedTextSha256ByRole = {},
  extraManagedTextByIdentity: ManagedVisibleTextByIdentity = {},
): {
  schemaVersion: 1;
  equal: boolean;
  modelSha256: string;
  expectedProjectionSha256: string;
  googleProjectionSha256: string;
  pptxProjectionSha256: string;
  googleVisibleTextSha256: string | null;
  pptxVisibleTextSha256: string | null;
  expectedHyperlinkSha256: string;
  googleHyperlinkSha256: string | null;
  pptxHyperlinkSha256: string | null;
  expectedConnectorSha256: string;
  googleConnectorSha256: string | null;
  pptxConnectorSha256: string | null;
  expectedCapabilityStructureSha256: string;
  googleCapabilityStructureSha256: string | null;
  pptxCapabilityStructureSha256: string | null;
  expectedWeeklyMilestoneStructureSha256: string;
  googleWeeklyMilestoneStructureSha256: string | null;
  pptxWeeklyMilestoneStructureSha256: string | null;
  errors: ParityFinding[];
} {
  const typedModel = asSlideModel(model);
  const expected = expectedSemanticProjection(model);
  const google = normalizeReadback(googleReadback);
  const pptx = normalizeReadback(pptxReadback);
  const expectedBytes = canonicalJson(expected);
  const googleBytes = canonicalJson(google);
  const pptxBytes = canonicalJson(pptx);
  const googleVisibleText = visibleTextProjection(googleReadback);
  const pptxVisibleText = visibleTextProjection(pptxReadback);
  const expectedHyperlinks = {
    schemaVersion: 1,
    slides: expectedHyperlinkInventory(model),
  };
  const googleHyperlinks = hyperlinkProjection(googleReadback);
  const pptxHyperlinks = hyperlinkProjection(pptxReadback);
  const expectedConnectors = {
    schemaVersion: 1,
    slides: expectedConnectorInventory(model),
  };
  const googleConnectors = connectorProjection(googleReadback);
  const pptxConnectors = connectorProjection(pptxReadback);
  const expectedCapabilityStructure = {
    schemaVersion: 1,
    slides: expectedCapabilityStructureInventory(model),
  };
  const googleCapabilityStructure = capabilityStructureProjection(googleReadback);
  const pptxCapabilityStructure = capabilityStructureProjection(pptxReadback);
  const expectedWeeklyMilestoneStructure = {
    schemaVersion: 1,
    slides: expectedWeeklyMilestoneStructureInventory(model),
  };
  const googleWeeklyMilestoneStructure = weeklyMilestoneStructureProjection(googleReadback);
  const pptxWeeklyMilestoneStructure = weeklyMilestoneStructureProjection(pptxReadback);
  const expectedManagedVisibleText = {
    schemaVersion: 1,
    slides: expectedManagedVisibleTextInventoryWithExtras(model, extraManagedTextByIdentity),
  };
  const expectedInheritedVisibleText = expectedInheritedVisibleTextProjection(typedModel);
  const expectedProtectedVisibleTextDigests = expectedProtectedVisibleTextDigestProjection(
    typedModel,
    protectedTextSha256ByRole,
  );
  const googleManagedVisibleText = scopedVisibleTextProjection(
    googleReadback,
    "managedVisibleTextInventory",
  );
  const pptxManagedVisibleText = scopedVisibleTextProjection(
    pptxReadback,
    "managedVisibleTextInventory",
  );
  const googleInheritedVisibleText = scopedVisibleTextProjection(
    googleReadback,
    "inheritedVisibleTextInventory",
  );
  const pptxInheritedVisibleText = scopedVisibleTextProjection(
    pptxReadback,
    "inheritedVisibleTextInventory",
  );
  const googleProtectedVisibleText = scopedVisibleTextProjection(
    googleReadback,
    "protectedVisibleTextInventory",
  );
  const pptxProtectedVisibleText = scopedVisibleTextProjection(
    pptxReadback,
    "protectedVisibleTextInventory",
  );
  const googleProtectedVisibleTextDigests = protectedVisibleTextDigestProjection(googleReadback);
  const pptxProtectedVisibleTextDigests = protectedVisibleTextDigestProjection(pptxReadback);
  const googleVisibleTextBytes = googleVisibleText ? canonicalJson(googleVisibleText) : null;
  const pptxVisibleTextBytes = pptxVisibleText ? canonicalJson(pptxVisibleText) : null;
  const expectedHyperlinkBytes = canonicalJson(expectedHyperlinks);
  const googleHyperlinkBytes = googleHyperlinks ? canonicalJson(googleHyperlinks) : null;
  const pptxHyperlinkBytes = pptxHyperlinks ? canonicalJson(pptxHyperlinks) : null;
  const expectedConnectorBytes = canonicalJson(expectedConnectors);
  const googleConnectorBytes = googleConnectors ? canonicalJson(googleConnectors) : null;
  const pptxConnectorBytes = pptxConnectors ? canonicalJson(pptxConnectors) : null;
  const expectedCapabilityStructureBytes = canonicalJson(expectedCapabilityStructure);
  const googleCapabilityStructureBytes = googleCapabilityStructure
    ? canonicalJson(googleCapabilityStructure)
    : null;
  const pptxCapabilityStructureBytes = pptxCapabilityStructure
    ? canonicalJson(pptxCapabilityStructure)
    : null;
  const expectedWeeklyMilestoneStructureBytes = canonicalJson(expectedWeeklyMilestoneStructure);
  const googleWeeklyMilestoneStructureBytes = googleWeeklyMilestoneStructure
    ? canonicalJson(googleWeeklyMilestoneStructure)
    : null;
  const pptxWeeklyMilestoneStructureBytes = pptxWeeklyMilestoneStructure
    ? canonicalJson(pptxWeeklyMilestoneStructure)
    : null;
  const expectedManagedVisibleTextBytes = canonicalJson(expectedManagedVisibleText);
  const expectedInheritedVisibleTextBytes = canonicalJson(expectedInheritedVisibleText);
  const expectedProtectedVisibleTextDigestBytes = canonicalJson(
    expectedProtectedVisibleTextDigests,
  );
  const googleManagedVisibleTextBytes = googleManagedVisibleText
    ? canonicalJson(googleManagedVisibleText)
    : null;
  const pptxManagedVisibleTextBytes = pptxManagedVisibleText
    ? canonicalJson(pptxManagedVisibleText)
    : null;
  const googleInheritedVisibleTextBytes = googleInheritedVisibleText
    ? canonicalJson(googleInheritedVisibleText)
    : null;
  const pptxInheritedVisibleTextBytes = pptxInheritedVisibleText
    ? canonicalJson(pptxInheritedVisibleText)
    : null;
  const googleProtectedVisibleTextBytes = googleProtectedVisibleText
    ? canonicalJson(googleProtectedVisibleText)
    : null;
  const pptxProtectedVisibleTextBytes = pptxProtectedVisibleText
    ? canonicalJson(pptxProtectedVisibleText)
    : null;
  const googleProtectedVisibleTextDigestBytes = googleProtectedVisibleTextDigests
    ? canonicalJson(googleProtectedVisibleTextDigests)
    : null;
  const pptxProtectedVisibleTextDigestBytes = pptxProtectedVisibleTextDigests
    ? canonicalJson(pptxProtectedVisibleTextDigests)
    : null;
  const errors: ParityFinding[] = [];
  if (expectedBytes !== googleBytes) {
    errors.push({
      code: "GOOGLE_MODEL_MISMATCH",
      message: "The native Google Slides semantic readback differs from the shared model.",
      remediation:
        "Reapply the Google edits from the same model and read every managed object back.",
    });
  }
  if (expectedBytes !== pptxBytes) {
    errors.push({
      code: "PPTX_MODEL_MISMATCH",
      message: "The PowerPoint semantic readback differs from the shared model.",
      remediation:
        "Reapply the PowerPoint edits from the same model and read every managed object back.",
    });
  }
  if (googleBytes !== pptxBytes) {
    errors.push({
      code: "CROSS_FORMAT_MISMATCH",
      message: "The Google Slides and PowerPoint semantic readbacks differ.",
      remediation:
        "Resolve wording, ordering, links, notes, source, or object-kind differences before publication.",
    });
  }
  if (!googleVisibleTextBytes) {
    errors.push({
      code: "GOOGLE_VISIBLE_TEXT_INVENTORY_MISSING",
      message: "The Google Slides readback lacks a complete actual visible-text inventory.",
      remediation:
        "Read every managed slide, table cell, and inherited visible text object from Google Slides.",
    });
  }
  if (!pptxVisibleTextBytes) {
    errors.push({
      code: "PPTX_VISIBLE_TEXT_INVENTORY_MISSING",
      message: "The PowerPoint readback lacks a complete actual visible-text inventory.",
      remediation:
        "Reimport the PPTX and inventory every managed-slide and inherited layout text object.",
    });
  }
  for (const [backend, bytes] of [
    ["GOOGLE", googleHyperlinkBytes],
    ["PPTX", pptxHyperlinkBytes],
  ] as const) {
    if (!bytes) {
      errors.push({
        code: `${backend}_HYPERLINK_INVENTORY_MISSING`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} lacks a complete artifact-derived hyperlink inventory.`,
        remediation:
          "Read every linked native text run from the output artifact, coalesce only adjacent same-URL runs in one object, and rerun parity.",
      });
    } else if (bytes !== expectedHyperlinkBytes) {
      errors.push({
        code: `${backend}_HYPERLINK_MISMATCH`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} hyperlink text, URL, or multiplicity differs from the shared model.`,
        remediation:
          "Restore every managed hyperlink from the shared model and regenerate the inventory from the native artifact.",
      });
    }
  }
  if (googleHyperlinkBytes && pptxHyperlinkBytes && googleHyperlinkBytes !== pptxHyperlinkBytes) {
    errors.push({
      code: "CROSS_FORMAT_HYPERLINK_MISMATCH",
      message: "The Google Slides and PowerPoint artifact-derived hyperlink inventories differ.",
      remediation:
        "Reconcile linked text, destinations, and duplicate counts across both native outputs.",
    });
  }
  for (const [backend, bytes] of [
    ["GOOGLE", googleConnectorBytes],
    ["PPTX", pptxConnectorBytes],
  ] as const) {
    if (!bytes) {
      errors.push({
        code: `${backend}_CONNECTOR_INVENTORY_MISSING`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} lacks a complete artifact-derived connector inventory.`,
        remediation:
          "Read native arrowheads, dash properties, and connector geometry from every managed slide and rerun parity.",
      });
    } else if (bytes !== expectedConnectorBytes) {
      errors.push({
        code: `${backend}_CONNECTOR_MISMATCH`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} connector direction or line treatment differs from the shared model.`,
        remediation:
          "Restore the modeled connector direction and solid or dashed treatment, then regenerate the inventory from the native artifact.",
      });
    }
  }
  if (googleConnectorBytes && pptxConnectorBytes && googleConnectorBytes !== pptxConnectorBytes) {
    errors.push({
      code: "CROSS_FORMAT_CONNECTOR_MISMATCH",
      message: "The Google Slides and PowerPoint artifact-derived connector inventories differ.",
      remediation:
        "Reconcile native arrow direction and solid or dashed connector treatment across both outputs.",
    });
  }
  for (const [backend, bytes] of [
    ["GOOGLE", googleCapabilityStructureBytes],
    ["PPTX", pptxCapabilityStructureBytes],
  ] as const) {
    if (!bytes) {
      errors.push({
        code: `${backend}_CAPABILITY_STRUCTURE_INVENTORY_MISSING`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} lacks a complete artifact-derived capability structure inventory.`,
        remediation:
          "Read the native table dimensions, top-row cells, white dividers, HOME_PLATE geometry, unused top-row targets, unused body cells, cell alignment, and bottom milestone targets from the output artifact.",
      });
    } else if (bytes !== expectedCapabilityStructureBytes) {
      errors.push({
        code: `${backend}_CAPABILITY_STRUCTURE_MISMATCH`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} capability table or milestone-target structure differs from the public template contract.`,
        remediation:
          "Restore the native 5×4 table, four blank top-row cells, 49 white solid dividers, ordered used top-row HOME_PLATE targets, zero unused top-row targets, empty unused body cells, and zero bottom milestone labels.",
      });
    }
  }
  if (
    googleCapabilityStructureBytes &&
    pptxCapabilityStructureBytes &&
    googleCapabilityStructureBytes !== pptxCapabilityStructureBytes
  ) {
    errors.push({
      code: "CROSS_FORMAT_CAPABILITY_STRUCTURE_MISMATCH",
      message: "The Google Slides and PowerPoint capability structure inventories differ.",
      remediation:
        "Reconcile the native table, divider, and milestone-target structure across both outputs.",
    });
  }
  for (const [backend, bytes] of [
    ["GOOGLE", googleWeeklyMilestoneStructureBytes],
    ["PPTX", pptxWeeklyMilestoneStructureBytes],
  ] as const) {
    if (!bytes) {
      errors.push({
        code: `${backend}_WEEKLY_MILESTONE_STRUCTURE_INVENTORY_MISSING`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} lacks an artifact-derived weekly milestone-row structure inventory.`,
        remediation:
          "Read each green left milestone label and every native Updates and Risks / Blockers paragraph, including None, from the output artifact.",
      });
    } else if (bytes !== expectedWeeklyMilestoneStructureBytes) {
      errors.push({
        code: `${backend}_WEEKLY_MILESTONE_STRUCTURE_MISMATCH`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} weekly label placement, label styling, or native bullet semantics differ from the shared contract.`,
        remediation:
          "Restore NVIDIA-green left labels with bold white text and native bullet paragraphs without typed glyphs.",
      });
    }
  }
  if (
    googleWeeklyMilestoneStructureBytes &&
    pptxWeeklyMilestoneStructureBytes &&
    googleWeeklyMilestoneStructureBytes !== pptxWeeklyMilestoneStructureBytes
  ) {
    errors.push({
      code: "CROSS_FORMAT_WEEKLY_MILESTONE_STRUCTURE_MISMATCH",
      message:
        "The Google Slides and PowerPoint weekly milestone-row structure inventories differ.",
      remediation:
        "Reconcile left-label styling and native update/risk bullet paragraphs across both outputs.",
    });
  }
  for (const [backend, readback] of [
    ["GOOGLE", googleReadback],
    ["PPTX", pptxReadback],
  ] as const) {
    const violations = forbiddenCapabilityProtectedText(typedModel, readback);
    if (violations && violations.length > 0) {
      errors.push({
        code: `${backend}_CAPABILITY_FORBIDDEN_TEXT`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} contains forbidden capability focus or milestone status text in the protected-text scope.`,
        remediation:
          "Remove Focus, Active, and column-focus text from every capability slide; keep milestone focus on the executive roadmap and keep Active as model-only status.",
      });
    }
  }
  for (const [backend, bytes] of [
    ["GOOGLE", googleManagedVisibleTextBytes],
    ["PPTX", pptxManagedVisibleTextBytes],
  ] as const) {
    if (!bytes) {
      errors.push({
        code: `${backend}_MANAGED_VISIBLE_TEXT_INVENTORY_MISSING`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} lacks an artifact-derived slide-local text inventory.`,
        remediation:
          "Read slide-local text separately from inherited template text and rerun parity.",
      });
    } else if (bytes !== expectedManagedVisibleTextBytes) {
      errors.push({
        code: `${backend}_MANAGED_VISIBLE_TEXT_MISMATCH`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} contains missing, stale, or unmodeled slide-local text.`,
        remediation:
          "Rebuild every managed object from the shared model and remove stale slide-local text.",
      });
    }
  }
  for (const [backend, bytes] of [
    ["GOOGLE", googleInheritedVisibleTextBytes],
    ["PPTX", pptxInheritedVisibleTextBytes],
  ] as const) {
    if (!bytes) {
      errors.push({
        code: `${backend}_INHERITED_VISIBLE_TEXT_INVENTORY_MISSING`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} lacks an inherited template-text inventory.`,
        remediation: "Read the inherited layout and master text separately and rerun parity.",
      });
    } else if (bytes !== expectedInheritedVisibleTextBytes) {
      errors.push({
        code: `${backend}_INHERITED_VISIBLE_TEXT_MISMATCH`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} inherited text differs from the inspected template contract.`,
        remediation:
          "Restore the approved master and layout auto-text with its exact per-role multiplicity.",
      });
    }
  }
  if (
    googleInheritedVisibleTextBytes &&
    pptxInheritedVisibleTextBytes &&
    googleInheritedVisibleTextBytes !== pptxInheritedVisibleTextBytes
  ) {
    errors.push({
      code: "CROSS_FORMAT_INHERITED_TEXT_MISMATCH",
      message: "The Google Slides and PowerPoint inherited template text differs.",
      remediation: "Restore both outputs to the same approved master and layout treatment.",
    });
  }
  for (const [backend, bytes, digestBytes] of [
    ["GOOGLE", googleProtectedVisibleTextBytes, googleProtectedVisibleTextDigestBytes],
    ["PPTX", pptxProtectedVisibleTextBytes, pptxProtectedVisibleTextDigestBytes],
  ] as const) {
    if (!bytes || !digestBytes) {
      errors.push({
        code: `${backend}_PROTECTED_VISIBLE_TEXT_INVENTORY_MISSING`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} lacks an approved slide-local template-text inventory.`,
        remediation:
          "Report approved slide-local template text separately, using the runtime template role map.",
      });
    } else if (digestBytes !== expectedProtectedVisibleTextDigestBytes) {
      errors.push({
        code: `${backend}_PROTECTED_VISIBLE_TEXT_MISMATCH`,
        message: `${backend === "GOOGLE" ? "Google Slides" : "PowerPoint"} protected text differs from the reviewed runtime allowlist.`,
        remediation:
          "Restore the approved template-owned text or re-review the template and create a new runtime role map.",
      });
    }
  }
  if (
    googleProtectedVisibleTextBytes &&
    pptxProtectedVisibleTextBytes &&
    googleProtectedVisibleTextBytes !== pptxProtectedVisibleTextBytes
  ) {
    errors.push({
      code: "CROSS_FORMAT_PROTECTED_TEXT_MISMATCH",
      message: "The Google Slides and PowerPoint approved slide-local template text differs.",
      remediation: "Restore both outputs to the same approved template-owned text treatment.",
    });
  }
  for (const [backend, readback, managed, protectedText, inherited] of [
    [
      "GOOGLE",
      googleVisibleText,
      googleManagedVisibleText,
      googleProtectedVisibleText,
      googleInheritedVisibleText,
    ],
    [
      "PPTX",
      pptxVisibleText,
      pptxManagedVisibleText,
      pptxProtectedVisibleText,
      pptxInheritedVisibleText,
    ],
  ] as const) {
    if (!readback || !managed || !protectedText || !inherited) continue;
    const combined = {
      schemaVersion: 1,
      slides: managed.slides.map(
        (slide: { role: ManagedRole; visibleTextInventory: string[] }, index: number) => ({
          ...slideIdentityFields(slide),
          visibleTextInventory: [
            ...slide.visibleTextInventory,
            ...protectedText.slides[index].visibleTextInventory,
            ...inherited.slides[index].visibleTextInventory,
          ].sort(),
        }),
      ),
    };
    if (canonicalJson(combined) !== canonicalJson(readback)) {
      errors.push({
        code: `${backend}_VISIBLE_TEXT_SCOPE_MISMATCH`,
        message:
          "The complete visible-text inventory does not equal its managed, protected, and inherited inventories.",
        remediation: "Regenerate all scoped inventories from the same artifact readback.",
      });
    }
  }
  if (
    googleVisibleTextBytes &&
    pptxVisibleTextBytes &&
    googleVisibleTextBytes !== pptxVisibleTextBytes
  ) {
    errors.push({
      code: "CROSS_FORMAT_VISIBLE_TEXT_MISMATCH",
      message: "The Google Slides and PowerPoint actual visible-text inventories differ.",
      remediation:
        "Remove stale or unmodeled visible text and reconcile protected template text across both backends.",
    });
  }
  return {
    schemaVersion: 1,
    equal: errors.length === 0,
    modelSha256: typedModel.modelSha256,
    expectedProjectionSha256: sha256Text(expectedBytes),
    googleProjectionSha256: sha256Text(googleBytes),
    pptxProjectionSha256: sha256Text(pptxBytes),
    googleVisibleTextSha256: googleVisibleTextBytes ? sha256Text(googleVisibleTextBytes) : null,
    pptxVisibleTextSha256: pptxVisibleTextBytes ? sha256Text(pptxVisibleTextBytes) : null,
    expectedHyperlinkSha256: sha256Text(expectedHyperlinkBytes),
    googleHyperlinkSha256: googleHyperlinkBytes ? sha256Text(googleHyperlinkBytes) : null,
    pptxHyperlinkSha256: pptxHyperlinkBytes ? sha256Text(pptxHyperlinkBytes) : null,
    expectedConnectorSha256: sha256Text(expectedConnectorBytes),
    googleConnectorSha256: googleConnectorBytes ? sha256Text(googleConnectorBytes) : null,
    pptxConnectorSha256: pptxConnectorBytes ? sha256Text(pptxConnectorBytes) : null,
    expectedCapabilityStructureSha256: sha256Text(expectedCapabilityStructureBytes),
    googleCapabilityStructureSha256: googleCapabilityStructureBytes
      ? sha256Text(googleCapabilityStructureBytes)
      : null,
    pptxCapabilityStructureSha256: pptxCapabilityStructureBytes
      ? sha256Text(pptxCapabilityStructureBytes)
      : null,
    expectedWeeklyMilestoneStructureSha256: sha256Text(expectedWeeklyMilestoneStructureBytes),
    googleWeeklyMilestoneStructureSha256: googleWeeklyMilestoneStructureBytes
      ? sha256Text(googleWeeklyMilestoneStructureBytes)
      : null,
    pptxWeeklyMilestoneStructureSha256: pptxWeeklyMilestoneStructureBytes
      ? sha256Text(pptxWeeklyMilestoneStructureBytes)
      : null,
    errors,
  };
}

export function protectedTextPolicyFromRoleMap(
  model: unknown,
  roleMap: unknown,
): ProtectedTextSha256ByRole {
  const typedModel = asSlideModel(model);
  if (!roleMap || typeof roleMap !== "object") {
    throw new Error("Runtime PowerPoint role map must be an object");
  }
  const typedRoleMap = roleMap as {
    schemaVersion?: unknown;
    templateFingerprint?: unknown;
    roles?: unknown;
  };
  if (
    typedRoleMap.schemaVersion !== 1 ||
    typedRoleMap.templateFingerprint !== typedModel.templateFingerprint ||
    !typedRoleMap.roles ||
    typeof typedRoleMap.roles !== "object" ||
    Array.isArray(typedRoleMap.roles)
  ) {
    throw new Error(
      "Runtime PowerPoint role map does not match the shared model template fingerprint",
    );
  }
  const roles = typedRoleMap.roles as Record<string, unknown>;
  const policy: ProtectedTextSha256ByRole = {};
  for (const role of Object.keys(NATIVE_KINDS) as ManagedRole[]) {
    const contract = roles[role];
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new Error(`Runtime PowerPoint role map is missing ${role}`);
    }
    const raw = (contract as { protectedTextSha256?: unknown }).protectedTextSha256;
    if (raw === undefined) {
      policy[role] = [];
      continue;
    }
    if (
      !Array.isArray(raw) ||
      raw.some((digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest))
    ) {
      throw new Error(`${role} protectedTextSha256 must contain lowercase SHA-256 digests`);
    }
    policy[role] = [...raw];
  }
  return policy;
}

function parseArgs(argv: string[]): ParityCliOptions {
  const options: ParityCliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (!next && argument !== "--help" && argument !== "-h")
      throw new Error(`Missing value for ${argument}`);
    if (argument === "--model") options.model = next;
    else if (argument === "--google-readback") options.google = next;
    else if (argument === "--pptx-readback") options.pptx = next;
    else if (argument === "--role-map") options.roleMap = next;
    else if (argument === "--output") options.output = next;
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node --import tsx compare-output-parity.mts --model PATH --google-readback PATH --pptx-readback PATH --role-map PATH [--output PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.model || !options.google || !options.pptx || !options.roleMap) {
    throw new Error("--model, --google-readback, --pptx-readback, and --role-map are required");
  }
  const [model, google, pptx, roleMap] = await Promise.all(
    [options.model, options.google, options.pptx, options.roleMap].map(async (file) =>
      JSON.parse(await readFile(path.resolve(file), "utf8")),
    ),
  );
  const result = compareParity(
    model,
    google,
    pptx,
    protectedTextPolicyFromRoleMap(model, roleMap),
    managedOperationTextByIdentity(model, roleMap),
  );
  const output = canonicalJson(result);
  if (options.output) {
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, "utf8");
  } else process.stdout.write(output);
  if (!result.equal) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
