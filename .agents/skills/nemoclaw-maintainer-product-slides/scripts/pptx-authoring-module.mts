// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// This checked-in TypeScript source intentionally contains plain JavaScript only.
// The validated launcher copies these exact bytes to an owner-only temporary .mjs
// file, where the bundled presentation runtime executes the artifact edits.

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const MANAGED_ROLES = ["roadmap-executive", "roadmap-capability", "markitecture", "weekly-release"];
const COMPLETED_EPIC_CONTEXT_COLOR = "#5B5B5B";

function getPath(value, dottedPath) {
  if (!dottedPath) return undefined;
  return dottedPath.split(".").reduce((current, segment) => {
    if (current === null || current === undefined) return undefined;
    const key = /^\d+$/u.test(segment) ? Number(segment) : segment;
    return current[key];
  }, value);
}

function textValue(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(textValue).join("\n");
  return String(value);
}

function artifactTextStyle(style = {}) {
  if (!style || typeof style !== "object") return style;
  return {
    ...style,
    ...(typeof style.fontSize === "number" ? { fontSize: `${style.fontSize}px` } : {}),
  };
}

function structuredParagraphStyle(style = {}, textFrameStyle = {}) {
  const paragraphStyle = { ...(style.paragraphStyle ?? {}) };
  if (style.bulletCharacter !== undefined && paragraphStyle.bulletCharacter === undefined) {
    paragraphStyle.bulletCharacter = style.bulletCharacter;
  }
  if (
    Number.isFinite(textFrameStyle.lineSpacing) &&
    paragraphStyle.lineSpacingPercent === undefined
  ) {
    paragraphStyle.lineSpacingPercent = Math.round(textFrameStyle.lineSpacing * 100_000);
  }
  return {
    ...style,
    ...(Object.keys(paragraphStyle).length > 0 ? { paragraphStyle } : {}),
  };
}

function elementName(element) {
  return element?.name ?? element?.data?.name ?? element?.toProto?.()?.name;
}

function resolveTarget(presentation, slide, target) {
  if (!target || typeof target !== "object") throw new Error("Runtime edit target is missing");
  if (target.anchorId) return presentation.resolve(target.anchorId);
  if (target.name) {
    const matches = slide.elements.items.filter((element) => elementName(element) === target.name);
    if (matches.length !== 1) {
      throw new Error(`Runtime target ${target.name} resolved to ${matches.length} elements`);
    }
    return matches[0];
  }
  if (Number.isInteger(target.elementIndex)) {
    const element = slide.elements.items[target.elementIndex];
    if (!element) throw new Error(`Runtime element index ${target.elementIndex} is missing`);
    return element;
  }
  throw new Error("Runtime target requires anchorId, name, or elementIndex");
}

function replaceText(target, replacement, search) {
  if (!target?.text) {
    throw new Error(`Target ${elementName(target) ?? "unknown"} is not text-editable`);
  }
  const next = textValue(replacement);
  const current = String(target.text);
  if (next === "") {
    target.text.set([{ runs: [{ run: "" }], bulletCharacter: "" }]);
  } else if (search !== undefined) {
    if (!current.includes(search)) throw new Error(`Expected source text was not found: ${search}`);
    target.text.replace(search, next);
  } else if (current.length > 0) {
    target.text.replace(current, next);
  } else {
    target.text.set([{ runs: [{ run: next }] }]);
  }
  return next;
}

function addLink(target, text, url, textStyle = {}) {
  if (!url || !text) return;
  const range = target.text.get(text);
  range.link = { uri: url, isExternal: true };
  if (textStyle.underline !== undefined) range.underline = textStyle.underline;
  if (textStyle.color !== undefined) range.color = textStyle.color;
}

function addUniqueLink(target, text, url, context, textStyle = {}) {
  const current = String(target?.text ?? "");
  const first = current.indexOf(text);
  if (
    !text ||
    first < 0 ||
    current.indexOf(text, first + text.length) >= 0 ||
    typeof url !== "string" ||
    url.length === 0
  ) {
    throw new Error(`${context} must have one exact linked text span and URL`);
  }
  addLink(target, text, url, textStyle);
}

function githubReferenceNumber(url, allowedKinds, context) {
  const match =
    /^https:\/\/github\.com\/NVIDIA\/NemoClaw\/(issues|discussions)\/([1-9][0-9]*)$/u.exec(url);
  if (!match || !allowedKinds.includes(match[1])) {
    throw new Error(
      `${context} must use an exact NVIDIA/NemoClaw ${allowedKinds.join(" or ")} URL`,
    );
  }
  return match[2];
}

function capabilityEpicReferenceText(item) {
  return `#${githubReferenceNumber(item.url, ["issues"], `Capability item ${item.contentId}`)}`;
}

function epicCompletionPrefix(item, context) {
  if (item?.state !== "OPEN" && item?.state !== "CLOSED") {
    throw new Error(`${context} state must be OPEN or CLOSED`);
  }
  return item.state === "CLOSED" ? "✓ " : "";
}

function capabilityEpicRuns(
  item,
  textStyle,
  referenceTextStyle = textStyle,
  linkTextStyle = referenceTextStyle,
) {
  const labelStyle = { ...textStyle, bold: true, underline: "none" };
  const referenceStyle = { ...referenceTextStyle, bold: false, underline: "none" };
  const linkedReferenceStyle = { ...linkTextStyle, bold: false, underline: "none" };
  return [
    {
      run: `${epicCompletionPrefix(item, `Capability item ${item.contentId}`)}${item.title}`,
      textStyle: labelStyle,
    },
    { run: " (", textStyle: referenceStyle },
    { run: capabilityEpicReferenceText(item), textStyle: linkedReferenceStyle },
    { run: ")", textStyle: referenceStyle },
  ];
}

function roadmapFocusText(item) {
  return textValue(item?.focus);
}

function replaceRoadmapFocusText(target, item) {
  if (!target?.text) throw new Error("Roadmap focus target is not text-editable");
  const current = String(target.text);
  if (current.length === 0) throw new Error("Roadmap focus target is empty");
  target.text.replace(current, textValue(item.focus));
  return roadmapFocusText(item);
}

function roadmapFocusIndex(operation) {
  const match = /^milestones\.(\d+)\.focus$/u.exec(operation.valuePath ?? "");
  return match ? Number(match[1]) : undefined;
}

function roadmapFocusItem(slideModel, operation) {
  const index = roadmapFocusIndex(operation);
  return index === undefined ? undefined : slideModel.milestones?.[index];
}

function bindingValue(slideModel, operation) {
  if (Object.hasOwn(operation, "literal")) return operation.literal;
  if (roadmapFocusIndex(operation) !== undefined && !roadmapFocusItem(slideModel, operation)) {
    return "";
  }
  const focusItem = roadmapFocusItem(slideModel, operation);
  if (focusItem) return roadmapFocusText(focusItem);
  return getPath(slideModel, operation.valuePath);
}

function applyTextOperations(presentation, slide, slideModel, operations = []) {
  for (const operation of operations) {
    const target = resolveTarget(presentation, slide, operation.target);
    const value = bindingValue(slideModel, operation);
    const focusItem = roadmapFocusItem(slideModel, operation);
    const prefix = roadmapFocusIndex(operation) !== undefined ? "" : (operation.prefix ?? "");
    const rendered = `${prefix}${textValue(value)}${operation.suffix ?? ""}`;
    let nextText = "";
    if (focusItem && operation.search === undefined && !operation.textStyle) {
      nextText = replaceRoadmapFocusText(target, focusItem);
    } else if (operation.search === undefined && operation.textStyle) {
      if (operation.textFrameStyle) {
        target.text.style = artifactTextStyle(operation.textFrameStyle);
      }
      const renderedParagraphs = operation.splitParagraphs ? rendered.split("\n") : [rendered];
      target.text.set(
        renderedParagraphs.map((paragraph) => ({
          runs: [
            {
              run: paragraph,
              textStyle: artifactTextStyle(operation.textStyle),
            },
          ],
          ...(operation.paragraphStyle ?? {}),
        })),
      );
      nextText = rendered;
    } else {
      nextText = replaceText(target, rendered, operation.search);
      if (operation.textFrameStyle) {
        target.text.style = artifactTextStyle(operation.textFrameStyle);
      }
    }
    const link = operation.linkPath ? getPath(slideModel, operation.linkPath) : operation.link;
    addLink(target, nextText, link, operation.linkTextStyle);
  }
}

function applyRichTextOperations(presentation, slide, slideModel, operations = []) {
  for (const operation of operations) {
    const target = resolveTarget(presentation, slide, operation.target);
    if (!target?.text) throw new Error("Runtime rich-text target is not text-editable");
    const value = textValue(bindingValue(slideModel, operation));
    const prefix = operation.prefix ?? "";
    const splitAt = prefix && value.startsWith(prefix) ? prefix.length : 0;
    const runs = splitAt
      ? [
          {
            run: value.slice(0, splitAt),
            textStyle: artifactTextStyle(operation.prefixStyle),
          },
          {
            run: value.slice(splitAt),
            textStyle: artifactTextStyle(operation.suffixStyle),
          },
        ]
      : [
          {
            run: value,
            textStyle: artifactTextStyle(operation.suffixStyle ?? operation.prefixStyle),
          },
        ];
    target.text.set([{ runs, ...(operation.paragraphStyle ?? {}) }]);
    if (operation.textFrameStyle) {
      target.text.style = artifactTextStyle(operation.textFrameStyle);
    }
  }
}

function applyOutcomeOperations(presentation, slide, slideModel, operations = []) {
  for (const operation of operations) {
    const target = resolveTarget(presentation, slide, operation.target);
    const outcome = getPath(slideModel, operation.outcomePath);
    if (!outcome) {
      replaceText(target, "");
      continue;
    }
    const baseStyle = artifactTextStyle(operation.textStyle);
    const label = `${epicCompletionPrefix(
      outcome,
      `Roadmap outcome ${outcome.contentId}`,
    )}${outcome.featureTitle}:`;
    const contextStyle = {
      ...baseStyle,
      ...(outcome.state === "CLOSED" ? { color: COMPLETED_EPIC_CONTEXT_COLOR } : {}),
      underline: "none",
    };
    if (operation.textFrameStyle) {
      target.text.style = artifactTextStyle(operation.textFrameStyle);
    }
    target.text.set([
      {
        ...structuredParagraphStyle(operation.paragraphStyle, operation.textFrameStyle),
        runs: [
          {
            run: label,
            textStyle: { ...baseStyle, bold: true, underline: "none" },
          },
          { run: ` ${outcome.text}`, textStyle: contextStyle },
        ],
      },
    ]);
  }
}

function applyOutcomeListOperations(presentation, slide, slideModel, operations = []) {
  for (const operation of operations) {
    const target = resolveTarget(presentation, slide, operation.target);
    const outcomes = getPath(slideModel, operation.outcomesPath);
    if (outcomes === undefined) {
      throw new Error(
        `Unused runtime outcome target was not deleted by its frame map: ${operation.outcomesPath}`,
      );
    }
    if (!Array.isArray(outcomes)) {
      throw new Error(`Runtime outcome list is invalid: ${operation.outcomesPath}`);
    }
    if (
      operation.paragraphStyles !== undefined &&
      (!Array.isArray(operation.paragraphStyles) ||
        operation.paragraphStyles.length === 0 ||
        operation.paragraphStyles.some(
          (style) => !style || typeof style !== "object" || Array.isArray(style),
        ))
    ) {
      throw new Error(
        `Runtime outcome paragraph styles must match the outcome count: ${operation.outcomesPath}`,
      );
    }
    const baseStyle = artifactTextStyle(operation.textStyle);
    if (operation.textFrameStyle) {
      target.text.style = artifactTextStyle(operation.textFrameStyle);
    }
    target.text.set(
      outcomes.map((outcome, index) => {
        const label = `${epicCompletionPrefix(
          outcome,
          `Roadmap outcome ${outcome.contentId}`,
        )}${outcome.featureTitle}:`;
        const contextStyle = {
          ...baseStyle,
          ...(outcome.state === "CLOSED" ? { color: COMPLETED_EPIC_CONTEXT_COLOR } : {}),
          underline: "none",
        };
        return {
          ...structuredParagraphStyle(
            outcomeParagraphStyle(operation, index, outcomes.length),
            operation.textFrameStyle,
          ),
          runs: [
            {
              run: label,
              textStyle: { ...baseStyle, bold: true, underline: "none" },
            },
            { run: ` ${outcome.text}`, textStyle: contextStyle },
          ],
        };
      }),
    );
  }
}

function outcomeParagraphStyle(operation, index, outcomeCount) {
  const styles = operation.paragraphStyles;
  if (!Array.isArray(styles) || styles.length === 0) return operation.paragraphStyle;
  if (outcomeCount === styles.length) return styles[index];
  if (outcomeCount === 1) {
    return {
      ...styles[0],
      spaceAfter: styles.at(-1)?.spaceAfter ?? styles[0].spaceAfter,
    };
  }
  if (index === 0) return styles[0];
  if (index === outcomeCount - 1) return styles.at(-1);
  return styles[Math.min(index, Math.max(1, styles.length - 2))];
}

function metricById(slideModel, contentId) {
  const metric = slideModel.metrics.find((candidate) => candidate.contentId === contentId);
  if (!metric) throw new Error(`Shared model lacks metric ${contentId}`);
  return metric;
}

function signedDetail(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return textValue(value);
  return `${number >= 0 ? "+" : ""}${number.toLocaleString("en-US")}`;
}

function applyMetricOperations(presentation, slide, slideModel, operations = []) {
  for (const operation of operations) {
    const target = resolveTarget(presentation, slide, operation.target);
    if (operation.kind === "momentum") {
      const metrics = operation.metricContentIds.map((contentId) =>
        metricById(slideModel, contentId),
      );
      const sourceSegments = String(target.text).split(/\s+\|\s+/u);
      if (sourceSegments.length !== metrics.length) {
        throw new Error("Runtime momentum target does not match the template metric structure");
      }
      for (const [index, metric] of metrics.entries()) {
        const label = `${metric.label} `;
        const sourceSegment = sourceSegments[index];
        if (!sourceSegment.startsWith(label) || sourceSegment.length === label.length) {
          throw new Error(`Runtime momentum target lacks template label ${metric.label}`);
        }
        target.text.replace(
          sourceSegment.slice(label.length),
          `${Number(metric.value).toLocaleString("en-US")} (${signedDetail(metric.detailValue)})`,
        );
      }
      continue;
    }
    if (operation.kind === "opened-closed") {
      const metric = metricById(slideModel, operation.metricContentId);
      const opened = /(-?\d+)/u.exec(textValue(metric.value))?.[1] ?? textValue(metric.value);
      const source = String(target.text);
      const match = /^(\d+ OPENED)(\s+\|\s+)(\d+ CLOSED)$/u.exec(source);
      if (!match) {
        throw new Error(
          "Runtime opened/closed target does not match the template metric structure",
        );
      }
      target.text.replace(match[1], `${opened} OPENED`);
      target.text.replace(match[3], `${textValue(metric.detailValue)} CLOSED`);
      continue;
    }
    if (operation.kind === "single") {
      const metric = metricById(slideModel, operation.metricContentId);
      replaceText(target, textValue(metric.value));
      continue;
    }
    throw new Error(`Unknown runtime metric operation: ${operation.kind}`);
  }
}

function applyMatrix(presentation, slide, model, contract, frameEntry, deletedNames = new Set()) {
  applyTextOperations(
    presentation,
    slide,
    model,
    retainedOperations(contract.operations, deletedNames),
  );
  applyRichTextOperations(
    presentation,
    slide,
    model,
    retainedOperations(contract.richTextOperations, deletedNames),
  );
  const table = resolveTarget(presentation, slide, contract.table.target);
  if (!table?.getCell || !table?.cells) {
    throw new Error("Capability matrix target is not a native table");
  }
  const topRow = contract.table.topRow;
  const firstColumn = contract.table.firstMilestoneColumn;
  const milestoneColumnCount = contract.table.milestoneColumnCount ?? 3;
  table.cells.set(topRow, contract.table.areaLabelColumn, "");
  for (let columnIndex = 0; columnIndex < milestoneColumnCount; columnIndex += 1) {
    table.cells.set(topRow, firstColumn + columnIndex, "");
    for (const area of model.rows) {
      const row = contract.table.areaRows[area];
      if (!Number.isInteger(row)) throw new Error(`Runtime table map lacks area ${area}`);
      table.cells.set(row, firstColumn + columnIndex, "");
    }
  }
  model.rows.forEach((area) => {
    const row = contract.table.areaRows[area];
    if (!Number.isInteger(row)) throw new Error(`Runtime table map lacks area ${area}`);
    table.cells.set(row, contract.table.areaLabelColumn, area);
    model.columns.forEach((column, columnIndex) => {
      const cell = model.cells.find(
        (candidate) =>
          candidate.roadmapArea === area && candidate.milestoneNodeId === column.milestoneNodeId,
      );
      if (!cell) throw new Error(`Shared model lacks matrix cell ${area} / ${column.title}`);
      const nativeCell = table.getCell(row, firstColumn + columnIndex);
      if (!nativeCell?.text) {
        throw new Error(`Capability matrix cell is not text-editable: ${area} / ${column.title}`);
      }
      if (cell.items.length === 0) {
        table.cells.set(row, firstColumn + columnIndex, "");
        return;
      }
      const cellTextStyle = artifactTextStyle(contract.table.cellTextStyle);
      const referenceTextStyle = artifactTextStyle(
        contract.table.referenceTextStyle ?? contract.table.cellTextStyle,
      );
      const linkTextStyle = artifactTextStyle(
        contract.table.linkTextStyle ??
          contract.table.referenceTextStyle ??
          contract.table.cellTextStyle,
      );
      const paragraphs = [];
      for (const [itemIndex, item] of cell.items.entries()) {
        if (itemIndex > 0) {
          paragraphs.push({
            ...(contract.table.cellParagraphStyle ?? {}),
            runs: [{ run: "", textStyle: cellTextStyle }],
          });
        }
        paragraphs.push({
          ...(contract.table.cellParagraphStyle ?? {}),
          runs: capabilityEpicRuns(item, cellTextStyle, referenceTextStyle, linkTextStyle),
        });
      }
      nativeCell.text.set(paragraphs);
      if (contract.table.cellTextFrameStyle) {
        nativeCell.text.style = artifactTextStyle(contract.table.cellTextFrameStyle);
      }
      for (const item of cell.items) {
        addUniqueLink(
          nativeCell,
          capabilityEpicReferenceText(item),
          item.url,
          `Capability item ${item.contentId}`,
          linkTextStyle,
        );
      }
    });
  });
  let unclassifiedTarget = null;
  if (contract.unclassifiedTarget) {
    unclassifiedTarget = resolveTarget(presentation, slide, contract.unclassifiedTarget);
  } else if (model.unclassified.length > 0) {
    const contentId = "matrix-needs-classification";
    const authorized = authorizedNewContent(frameEntry);
    const authorization = requireNewPrimitive(authorized, contentId);
    const warningContract = contract.unclassifiedWarning;
    if (!warningContract?.position) {
      throw new Error("Preview has unclassified Epics but no native warning contract");
    }
    assertPositionWithinAuthorizedZone(warningContract.position, authorization, contentId);
    unclassifiedTarget = slide.shapes.add({
      geometry: warningContract.geometry ?? "rect",
      name: `nemoclaw:${contentId}`,
      position: warningContract.position,
      fill: warningContract.fill,
      line: {
        style: "solid",
        fill: warningContract.lineFill,
        width: warningContract.lineWidth,
      },
    });
  }
  if (unclassifiedTarget) {
    const warningTextStyle = artifactTextStyle(contract.unclassifiedWarning?.textStyle);
    const runs = model.unclassified.flatMap((item, index) => [
      ...(index > 0 ? [{ run: "; ", textStyle: { ...warningTextStyle, bold: false } }] : []),
      ...capabilityEpicRuns(item, warningTextStyle),
    ]);
    unclassifiedTarget.text.set([
      {
        runs: runs.length > 0 ? runs : [{ run: "" }],
        bulletCharacter: "",
      },
    ]);
    if (contract.unclassifiedWarning?.textStyle) {
      unclassifiedTarget.text.style = warningTextStyle;
    }
    for (const item of model.unclassified) {
      addUniqueLink(
        unclassifiedTarget,
        capabilityEpicReferenceText(item),
        item.url,
        `Unclassified capability item ${item.contentId}`,
      );
    }
  }
}

function weeklyEvidenceItems(row, kind) {
  if (kind === "updates") return row.updates;
  if (kind === "risks") {
    return row.risks.length > 0 ? row.risks : [{ label: "", text: "None" }];
  }
  throw new Error(`Unknown runtime milestone row operation: ${kind}`);
}

function weeklyMilestoneLabelText(title) {
  return textValue(title).trim().split(/\s+/u).join("\n").toUpperCase();
}

function replaceWeeklyMilestoneLabelText(target, title) {
  if (!target?.text) throw new Error("Weekly milestone label target is not text-editable");
  const sourceParts = String(target.text).split("\n");
  const outputParts = weeklyMilestoneLabelText(title).split("\n");
  if (sourceParts.length !== outputParts.length || sourceParts.some((part) => part.length === 0)) {
    throw new Error("Weekly milestone label does not match the template line structure");
  }
  sourceParts.forEach((part, index) => target.text.replace(part, outputParts[index]));
  return outputParts.join("\n");
}

function assertWeeklyEvidenceUsesNativeBullets(items, kind) {
  for (const item of items) {
    if (/^[•●▪◦]\s*/u.test(String(item.label ?? "")) || /^[•●▪◦]\s*/u.test(String(item.text))) {
      throw new Error(`Weekly ${kind} evidence must not contain a typed bullet glyph`);
    }
  }
}

function applyMilestoneRowOperations(presentation, slide, slideModel, operations = []) {
  for (const operation of operations) {
    const target = resolveTarget(presentation, slide, operation.target);
    const row = slideModel.milestoneRows[operation.rowIndex];
    if (!row) {
      replaceText(target, "");
      continue;
    }
    const style = artifactTextStyle(operation.textStyle);
    if (operation.kind === "label") {
      replaceWeeklyMilestoneLabelText(target, row.title);
      continue;
    }
    if (operation.kind === "updates" || operation.kind === "risks") {
      const items = weeklyEvidenceItems(row, operation.kind);
      if (
        operation.nativeBullets !== true ||
        typeof operation.paragraphStyle?.bulletCharacter !== "string" ||
        operation.paragraphStyle.bulletCharacter.length === 0
      ) {
        throw new Error(`Weekly ${operation.kind} operation must declare native bullets`);
      }
      assertWeeklyEvidenceUsesNativeBullets(items, operation.kind);
      const paragraphContract = {
        ...(operation.paragraphStyle ?? {}),
        paragraphStyle: { ...(operation.paragraphStyle ?? {}) },
      };
      target.text.set(
        items.map((item) => ({
          ...structuredParagraphStyle(paragraphContract, operation.textFrameStyle),
          runs: item.label
            ? [
                { run: `${item.label}: `, textStyle: { ...style, bold: true } },
                { run: item.text, textStyle: style },
              ]
            : [{ run: item.text, textStyle: style }],
        })),
      );
      if (operation.textFrameStyle) {
        target.text.style = artifactTextStyle(operation.textFrameStyle);
      }
      continue;
    }
    throw new Error(`Unknown runtime milestone row operation: ${operation.kind}`);
  }
}

function runtimePositionFromEmu(positionEmu) {
  if (
    !positionEmu ||
    !["left", "top", "width", "height"].every(
      (key) => Number.isInteger(positionEmu[key]) && positionEmu[key] >= 0,
    )
  ) {
    throw new Error("Runtime geometry positionEmu must contain nonnegative integer EMU values");
  }
  return Object.fromEntries(
    ["left", "top", "width", "height"].map((key) => [key, positionEmu[key] / 9525]),
  );
}

function applyGeometryOperations(presentation, slide, operations = []) {
  for (const operation of operations) {
    const target = resolveTarget(presentation, slide, operation.target);
    target.position = runtimePositionFromEmu(operation.positionEmu);
  }
}

function targetNames(target) {
  return [
    target.name,
    target.sourceElementName,
    ...(Array.isArray(target.names) ? target.names : []),
    ...(Array.isArray(target.sourceElementNames) ? target.sourceElementNames : []),
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function applyAuthorizedDeletes(presentation, slide, frameEntry) {
  const deletedNames = new Set();
  for (const target of frameEntry.editTargets.filter(
    (candidate) => candidate.action === "delete",
  )) {
    const names = targetNames(target);
    if (names.length === 0) {
      throw new Error(
        `Frame-map delete on output slide ${frameEntry.outputSlide} requires sourceElementName`,
      );
    }
    for (const name of names) {
      const element = resolveTarget(presentation, slide, { name });
      element.delete();
      deletedNames.add(name);
    }
  }
  return deletedNames;
}

function retainedOperations(operations = [], deletedNames = new Set()) {
  return operations.filter(
    (operation) => !targetNames(operation.target).some((name) => deletedNames.has(name)),
  );
}

function authorizedNewContent(frameEntry) {
  const authorized = new Map();
  for (const target of frameEntry.editTargets.filter(
    (candidate) =>
      candidate.action === "add" &&
      candidate.newPrimitiveAllowed === true &&
      candidate.mustNotOverlapInherited === true,
  )) {
    for (const contentId of [target.contentId, ...(target.contentIds ?? [])]) {
      if (typeof contentId !== "string" || contentId.length === 0) continue;
      if (authorized.has(contentId)) {
        throw new Error(`Frame map authorizes new native object ${contentId} more than once`);
      }
      authorized.set(contentId, target);
    }
  }
  return authorized;
}

function requireNewPrimitive(authorized, contentId) {
  const target = authorized.get(contentId);
  if (!target) {
    throw new Error(`Frame map does not authorize new native object ${contentId}`);
  }
  return target;
}

function assertPositionWithinAuthorizedZone(position, target, contentId) {
  const zone = target.zone;
  if (
    !position ||
    !zone ||
    !["left", "top", "width", "height"].every(
      (key) => Number.isFinite(position[key]) && Number.isFinite(zone[key]),
    ) ||
    position.left < zone.left ||
    position.top < zone.top ||
    position.left + position.width > zone.left + zone.width ||
    position.top + position.height > zone.top + zone.height
  ) {
    throw new Error(`New native object ${contentId} is outside its frame-map add zone`);
  }
}

function applyMarkitecture(presentation, slide, model, contract, frameEntry) {
  const authorized = authorizedNewContent(frameEntry);
  if (contract.title) {
    const rewriteNames = frameEntry.editTargets
      .filter((target) => target.action === "rewrite")
      .flatMap(targetNames);
    if (rewriteNames.length !== 1) {
      throw new Error("Markitecture title requires exactly one named frame-map rewrite target");
    }
    if (contract.title.target?.name && contract.title.target.name !== rewriteNames[0]) {
      throw new Error("Markitecture title target differs from its frame-map rewrite target");
    }
    const title = resolveTarget(
      presentation,
      slide,
      contract.title.target ?? { name: rewriteNames[0] },
    );
    if (!title?.text) throw new Error("Markitecture title rewrite target is not text-editable");
    const emphasis = contract.title.emphasis ?? contract.title.prefix ?? "";
    const sourceTitle = String(title.text);
    const outputTitle = textValue(model.title);
    if (sourceTitle !== outputTitle) {
      if (
        !emphasis ||
        !sourceTitle.startsWith(emphasis) ||
        !outputTitle.startsWith(emphasis) ||
        sourceTitle.length === emphasis.length ||
        outputTitle.length === emphasis.length
      ) {
        throw new Error(
          "Markitecture title rewrite must preserve the template's emphasized title prefix",
        );
      }
      title.text.replace(sourceTitle.slice(emphasis.length), outputTitle.slice(emphasis.length));
    }
  } else {
    applyTextOperations(presentation, slide, model, contract.operations);
  }

  const frames = contract.geometry;
  const addNodeShape = (node, frame, name, includeText) => {
    const shape = slide.shapes.add({
      geometry: frame.geometry ?? "roundRect",
      name,
      position: frame.position,
      fill: frame.fill ?? frames.nodeFill,
      line: {
        style: "solid",
        fill: frame.lineFill ?? frames.nodeLine,
        width: frame.lineWidth ?? 2,
      },
      borderRadius: frame.borderRadius ?? "rounded-lg",
    });
    if (includeText) {
      shape.text = node.text;
      shape.text.style = {
        fontSize: `${frame.fontSize ?? frames.nodeFontSize}px`,
        typeface: frame.typeface ?? frames.nodeTypeface,
        bold: frame.bold ?? true,
        color: frame.textColor ?? frames.nodeTextColor,
        alignment: "center",
        verticalAlignment: "middle",
        insets: frame.insets ?? frames.nodeInsets,
      };
    }
    return shape;
  };

  const stagingNodes = new Map();
  for (const node of model.nodes) {
    const frame = frames.nodeFrames[node.contentId];
    if (!frame) throw new Error(`Runtime map lacks node frame ${node.contentId}`);
    const authorization = requireNewPrimitive(authorized, node.contentId);
    assertPositionWithinAuthorizedZone(frame.position, authorization, node.contentId);
    stagingNodes.set(
      node.contentId,
      addNodeShape(node, frame, `nemoclaw-staging:${node.contentId}`, false),
    );
  }

  const connectorLabels = [];
  const connectorShapes = [];
  for (const connector of model.connectors) {
    const frame = frames.connectorFrames[connector.contentId];
    if (!frame) throw new Error(`Runtime map lacks connector frame ${connector.contentId}`);
    const authorization = requireNewPrimitive(authorized, connector.contentId);
    assertPositionWithinAuthorizedZone(frame.line, authorization, connector.contentId);
    const fromNode = stagingNodes.get(connector.from);
    const toNode = stagingNodes.get(connector.to);
    if (!fromNode || !toNode) {
      throw new Error(`Runtime connector references an unknown node: ${connector.contentId}`);
    }
    const connectorShape = slide.shapes.connect(fromNode, toNode, {
      kind: "straight",
      ...(frame.fromSide ? { fromSide: frame.fromSide } : {}),
      ...(frame.toSide ? { toSide: frame.toSide } : {}),
      line: {
        style: connector.lineStyle,
        fill: frames.connectorColor,
        width: frames.connectorWidth,
      },
      tail: { type: "triangle", width: "med", length: "med" },
    });
    connectorShape.name = `nemoclaw:${connector.contentId}`;
    connectorShapes.push({ connector, connectorShape });
    if (frame.label) connectorLabels.push({ connector, frame });
  }

  const nodes = new Map();
  for (const node of model.nodes) {
    const frame = frames.nodeFrames[node.contentId];
    nodes.set(node.contentId, addNodeShape(node, frame, `nemoclaw:${node.contentId}`, true));
  }
  for (const { connector, connectorShape } of connectorShapes) {
    const fromNode = nodes.get(connector.from);
    const toNode = nodes.get(connector.to);
    const fromIdx = connectorShape.connector?.fromIdx;
    const toIdx = connectorShape.connector?.toIdx;
    if (!fromNode || !toNode || !Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) {
      throw new Error(`Runtime connector cannot be rebound: ${connector.contentId}`);
    }
    connectorShape.setConnectorFrom(fromNode, fromIdx);
    connectorShape.setConnectorTo(toNode.id, toIdx);
  }
  for (const node of stagingNodes.values()) node.delete();

  for (const { connector, frame } of connectorLabels) {
    const labelContentId = `${connector.contentId}:label`;
    const authorization = requireNewPrimitive(authorized, labelContentId);
    assertPositionWithinAuthorizedZone(frame.label, authorization, labelContentId);
    const label = slide.shapes.add({
      geometry: "textbox",
      name: `nemoclaw:${connector.contentId}:label`,
      position: frame.label,
      fill: "none",
      line: { style: "solid", fill: "none", width: 0 },
    });
    label.text = connector.label;
    label.text.style = {
      fontSize: `${frames.connectorLabelFontSize}px`,
      typeface: frames.connectorLabelTypeface ?? frames.nodeTypeface,
      bold: frames.connectorLabelBold ?? false,
      color: frames.secondaryTextColor,
      alignment: "center",
      verticalAlignment: "middle",
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    };
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--model") options.model = next;
    else if (argument === "--role-map") options.roleMap = next;
    else if (argument === "--template-frame-map") options.templateFrameMap = next;
    else if (argument === "--template-starter-pptx") options.templateStarter = next;
    else if (argument === "--output") options.output = next;
    else throw new Error(`Unknown authoring argument: ${argument}`);
    index += 1;
  }
  for (const key of ["model", "roleMap", "templateFrameMap", "templateStarter", "output"]) {
    if (!options[key]) throw new Error(`Missing authoring option: ${key}`);
  }
  return options;
}

export function applyManagedSlides(presentation, model, roleMap, frameMap) {
  for (const slideModel of model.slides) {
    const role = slideModel.role;
    if (!MANAGED_ROLES.includes(role)) throw new Error(`Unknown managed role: ${role}`);
    const contract = roleMap.roles[role];
    const matchingEntries = frameMap.outputSlides.filter(
      (candidate) =>
        candidate.narrativeRole === role &&
        (slideModel.instanceId
          ? candidate.instanceId === slideModel.instanceId
          : candidate.instanceId === undefined),
    );
    if (matchingEntries.length !== 1) {
      throw new Error(
        `Template frame map resolved ${matchingEntries.length} outputs for ${slideModel.instanceId ?? role}`,
      );
    }
    const frameEntry = matchingEntries[0];
    const slide = presentation.slides.getItem(frameEntry.outputSlide - 1);
    if (!slide) throw new Error(`Template starter lacks target slide for ${role}`);
    const deletedNames = applyAuthorizedDeletes(presentation, slide, frameEntry);
    if (role === "roadmap-capability") {
      applyMatrix(presentation, slide, slideModel, contract, frameEntry, deletedNames);
    } else if (role === "markitecture") {
      applyMarkitecture(presentation, slide, slideModel, contract, frameEntry);
    } else {
      applyTextOperations(
        presentation,
        slide,
        slideModel,
        retainedOperations(contract.operations, deletedNames),
      );
      applyRichTextOperations(
        presentation,
        slide,
        slideModel,
        retainedOperations(contract.richTextOperations, deletedNames),
      );
      applyOutcomeOperations(
        presentation,
        slide,
        slideModel,
        retainedOperations(contract.outcomeOperations, deletedNames),
      );
      applyOutcomeListOperations(
        presentation,
        slide,
        slideModel,
        retainedOperations(contract.outcomeListOperations, deletedNames),
      );
      applyMetricOperations(
        presentation,
        slide,
        slideModel,
        retainedOperations(contract.metricOperations, deletedNames),
      );
      applyMilestoneRowOperations(
        presentation,
        slide,
        slideModel,
        retainedOperations(contract.milestoneRowOperations, deletedNames),
      );
    }
    applyGeometryOperations(
      presentation,
      slide,
      retainedOperations(contract.geometryOperations, deletedNames),
    );
    slide.speakerNotes.textFrame.setText(slideModel.managedNotes);
    slide.speakerNotes.setVisible(false);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [model, roleMap, frameMap] = await Promise.all([
    fs.readFile(path.resolve(options.model), "utf8").then(JSON.parse),
    fs.readFile(path.resolve(options.roleMap), "utf8").then(JSON.parse),
    fs.readFile(path.resolve(options.templateFrameMap), "utf8").then(JSON.parse),
  ]);
  const starterPptxPath = path.resolve(options.templateStarter);
  const presentation = await PresentationFile.importPptx(await FileBlob.load(starterPptxPath));

  applyManagedSlides(presentation, model, roleMap, frameMap);

  await fs.mkdir(path.dirname(path.resolve(options.output)), {
    recursive: true,
  });
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(path.resolve(options.output));
}

if (
  process.argv[1] &&
  realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
