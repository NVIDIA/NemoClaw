// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertForbiddenText,
  audienceStrings,
  capabilityDividerInventoryFromSlideXml,
  COMPLETED_EPIC_CONTEXT_COLOR,
  connectorInventoryFromSlideXml,
  createTemplateFidelityStarterComparisonLayouts,
  createTemporaryPptxAuthoringSurface,
  expectedMetricText,
  formatSignedMetricDetail,
  freezePptxAuthoringInputs,
  hyperlinkInventoryFromSlideXml,
  managedOperationTextByIdentity,
  runTemplateFidelityWorkflow,
  templateSlideCountFromPptxBytes,
  validateNativeConnectorInventory,
  validateCapabilityEpicCompletionFromSlideXml,
  validateRoadmapEpicCompletionFromSlideXml,
  validateRoadmapOutcomeParagraphsFromSlideXml,
  validateCapabilityClassificationWarningAuthorization,
  validateRoadmapCapabilityDeleteAuthorization,
  validateRoadmapExecutiveDeleteAuthorization,
  validateTemplateLayoutFidelity,
  validateTemplateSourceInventoryBinding,
  validateTemplateThemePackageContract,
  validateWeeklyMilestoneParagraphsFromSlideXml,
  validateWeeklyMilestoneRowLayout,
  validateWeeklyMilestoneRowRoleMap,
  weeklyMilestoneLabelText,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts";

export async function validateSingleSlideLayoutPair({
  starter,
  final,
  editTargets,
  roleContract = {},
  modelSlide = { role: "roadmap-capability", unclassified: [] },
}: {
  starter: Record<string, unknown> | Array<Record<string, unknown>>;
  final: Record<string, unknown> | Array<Record<string, unknown>>;
  editTargets: Array<Record<string, unknown>>;
  roleContract?: Record<string, unknown>;
  modelSlide?: Record<string, unknown>;
}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-layout-fidelity-"));
  const starterLayoutDir = path.join(temp, "starter");
  const finalLayoutDir = path.join(temp, "final");
  fs.mkdirSync(starterLayoutDir);
  fs.mkdirSync(finalLayoutDir);
  fs.writeFileSync(
    path.join(starterLayoutDir, "starter-slide-01.layout.json"),
    JSON.stringify({ inheritedLayers: [], elements: Array.isArray(starter) ? starter : [starter] }),
  );
  fs.writeFileSync(
    path.join(finalLayoutDir, "final-slide-01.layout.json"),
    JSON.stringify({ inheritedLayers: [], elements: Array.isArray(final) ? final : [final] }),
  );
  try {
    await validateTemplateLayoutFidelity({
      frameMap: {
        outputSlides: [
          {
            outputSlide: 1,
            narrativeRole: modelSlide.role,
            ...(typeof modelSlide.instanceId === "string"
              ? { instanceId: modelSlide.instanceId }
              : {}),
            editTargets,
          },
        ],
      },
      model: { slides: [modelSlide] },
      roleMap: { roles: { [String(modelSlide.role)]: roleContract } },
      starterLayoutDir,
      finalLayoutDir,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function nativeNode(name: string, id: number): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="nemoclaw:${name}"/></p:nvSpPr><p:spPr><a:prstGeom prst="roundRect"/></p:spPr></p:sp>`;
}

export function nativeConnector(options: {
  contentId: string;
  id: number;
  fromId: number;
  toId: number;
  arrowEnd?: "headEnd" | "tailEnd" | "none";
  lineStyle?: "solid" | "dash";
}): string {
  const arrow =
    options.arrowEnd && options.arrowEnd !== "none"
      ? `<a:${options.arrowEnd} type="triangle" w="med" len="med"/>`
      : "";
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${options.id}" name="nemoclaw:${options.contentId}"/><p:cNvCxnSpPr><a:stCxn id="${options.fromId}" idx="1"/><a:endCxn id="${options.toId}" idx="3"/></p:cNvCxnSpPr></p:nvCxnSpPr><p:spPr><a:prstGeom prst="straightConnector1"/><a:ln><a:prstDash val="${options.lineStyle ?? "solid"}"/>${arrow}</a:ln></p:spPr></p:cxnSp>`;
}

export function nativeConnectorSlide(
  options: {
    operatorArrow?: "headEnd" | "tailEnd" | "none";
    sandboxGatewayArrow?: "headEnd" | "tailEnd" | "none";
    stateArrow?: "headEnd" | "tailEnd" | "none";
    stateLineStyle?: "solid" | "dash";
    operatorReversed?: boolean;
  } = {},
): string {
  const operatorFrom = options.operatorReversed ? 2 : 1;
  const operatorTo = options.operatorReversed ? 1 : 2;
  return `<p:sld><p:cSld><p:spTree>
    ${nativeConnector({ contentId: "connector.operator-host", id: 11, fromId: operatorFrom, toId: operatorTo, arrowEnd: options.operatorArrow ?? "tailEnd" })}
    ${nativeConnector({ contentId: "connector.sandbox-gateway", id: 12, fromId: 4, toId: 3, arrowEnd: options.sandboxGatewayArrow ?? "tailEnd" })}
    ${nativeConnector({ contentId: "connector.sandbox-state", id: 13, fromId: 4, toId: 5, arrowEnd: options.stateArrow ?? "tailEnd", lineStyle: options.stateLineStyle ?? "dash" })}
    ${nativeNode("node.operator", 1)}
    ${nativeNode("node.host", 2)}
    ${nativeNode("node.gateway", 3)}
    ${nativeNode("node.sandbox", 4)}
    ${nativeNode("node.state", 5)}
  </p:spTree></p:cSld></p:sld>`;
}

export const expectedNativeConnectors = [
  {
    contentId: "connector.operator-host",
    from: "node.operator",
    to: "node.host",
    direction: "from-to" as const,
    lineStyle: "solid" as const,
  },
  {
    contentId: "connector.sandbox-gateway",
    from: "node.sandbox",
    to: "node.gateway",
    direction: "from-to" as const,
    lineStyle: "solid" as const,
  },
  {
    contentId: "connector.sandbox-state",
    from: "node.sandbox",
    to: "node.state",
    direction: "from-to" as const,
    lineStyle: "dashed" as const,
  },
];

export {
  assertForbiddenText,
  audienceStrings,
  capabilityDividerInventoryFromSlideXml,
  COMPLETED_EPIC_CONTEXT_COLOR,
  connectorInventoryFromSlideXml,
  createTemplateFidelityStarterComparisonLayouts,
  createTemporaryPptxAuthoringSurface,
  expectedMetricText,
  formatSignedMetricDetail,
  freezePptxAuthoringInputs,
  hyperlinkInventoryFromSlideXml,
  managedOperationTextByIdentity,
  runTemplateFidelityWorkflow,
  templateSlideCountFromPptxBytes,
  validateNativeConnectorInventory,
  validateCapabilityEpicCompletionFromSlideXml,
  validateRoadmapEpicCompletionFromSlideXml,
  validateRoadmapOutcomeParagraphsFromSlideXml,
  validateCapabilityClassificationWarningAuthorization,
  validateRoadmapCapabilityDeleteAuthorization,
  validateRoadmapExecutiveDeleteAuthorization,
  validateTemplateLayoutFidelity,
  validateTemplateSourceInventoryBinding,
  validateTemplateThemePackageContract,
  validateWeeklyMilestoneParagraphsFromSlideXml,
  validateWeeklyMilestoneRowLayout,
  validateWeeklyMilestoneRowRoleMap,
  weeklyMilestoneLabelText,
};
