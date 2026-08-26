// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";

import { writeProtectedOutput } from "./protected-output.mts";

export const MANAGED_ROLES = [
  "roadmap-executive",
  "roadmap-capability",
  "markitecture",
  "weekly-release",
] as const;

export const ROADMAP_AREAS = [
  "Usability and Onboarding",
  "Agent Features",
  "Acceleration and Optimization",
  "Integrations and Blueprints",
] as const;

export const ROADMAP_EXECUTIVE_ROW_MAX_CHARACTERS = 90;
export const ROADMAP_CAPABILITY_TITLE = "NemoClaw Feature Roadmap";

export function roadmapPresentationWordCount(value: string): number {
  return value
    .trim()
    .split(/\s+/u)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

const MARKITECTURE_CONNECTOR_GRAPH = [
  {
    contentId: "connector.operator-host",
    claimId: "claim.operator-host-operate",
    from: "node.operator",
    to: "node.host",
    label: "operate",
    lineStyle: "solid",
  },
  {
    contentId: "connector.host-gateway",
    claimId: "claim.host-gateway-configure",
    from: "node.host",
    to: "node.gateway",
    label: "configure resources",
    lineStyle: "solid",
  },
  {
    contentId: "connector.gateway-sandbox",
    claimId: "claim.gateway-sandbox-control",
    from: "node.gateway",
    to: "node.sandbox",
    label: "create and control",
    lineStyle: "solid",
  },
  {
    contentId: "connector.sandbox-gateway",
    claimId: "claim.sandbox-gateway-requests",
    from: "node.sandbox",
    to: "node.gateway",
    label: "managed requests",
    lineStyle: "solid",
  },
  {
    contentId: "connector.gateway-inference",
    claimId: "claim.gateway-inference-route",
    from: "node.gateway",
    to: "node.inference",
    label: "routed inference",
    lineStyle: "solid",
  },
  {
    contentId: "connector.gateway-integrations",
    claimId: "claim.gateway-integration-egress",
    from: "node.gateway",
    to: "node.integrations",
    label: "approved egress",
    lineStyle: "solid",
  },
  {
    contentId: "connector.sandbox-state",
    claimId: "claim.sandbox-state-lifecycle",
    from: "node.sandbox",
    to: "node.state",
    label: "preserve for rebuild, snapshot, restore",
    lineStyle: "dashed",
  },
] as const;

export type ValidationMode = "preview" | "publish";

export type ValidationFinding = {
  code: string;
  message: string;
  remediation: string;
  role?: (typeof MANAGED_ROLES)[number];
};

export type ValidationResult = {
  valid: boolean;
  mode: ValidationMode;
  modelSha256: string | null;
  errors: ValidationFinding[];
  publicationEligible: boolean;
};

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | number | string | null;

const MODEL_HASH_KEY = "modelSha256";

function normalizeString(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return normalizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort(compareUtf16CodeUnits)
        .map((key) => [key, canonicalize(object[key])]),
    );
  }
  throw new Error(`Canonical JSON cannot represent ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

export function sha256Text(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function withoutTopLevelKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a top-level JSON object");
  }
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

export function calculateModelSha256(model: unknown): string {
  const stripDerivedNotes = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripDerivedNotes);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "managedNotes")
        .map(([key, child]) => [key, stripDerivedNotes(child)]),
    );
  };
  return canonicalSha256(stripDerivedNotes(withoutTopLevelKey(model, MODEL_HASH_KEY)));
}

export type ManagedDeckSlide = {
  id: string;
  managedRole?: (typeof MANAGED_ROLES)[number];
  managedInstanceId?: string;
};

function assertManagedSlideSequence(slides: ManagedDeckSlide[], name: string): void {
  const managed = slides.filter((slide) => slide.managedRole !== undefined);
  if (managed.length === 0) return;
  const unknown = managed.find(
    (slide) => !MANAGED_ROLES.includes(slide.managedRole as (typeof MANAGED_ROLES)[number]),
  );
  if (unknown) throw new Error(`Unknown managed slide role: ${String(unknown.managedRole)}`);
  for (const singletonRole of ["markitecture", "weekly-release"] as const) {
    if (managed.filter((slide) => slide.managedRole === singletonRole).length > 1) {
      throw new Error(`Duplicate managed slide role: ${singletonRole}`);
    }
  }
  const explicitInstances = managed.flatMap((slide) =>
    slide.managedInstanceId ? [slide.managedInstanceId] : [],
  );
  const duplicateInstance = explicitInstances.find(
    (instanceId, index) => explicitInstances.indexOf(instanceId) !== index,
  );
  if (duplicateInstance) throw new Error(`Duplicate managed slide instance: ${duplicateInstance}`);
  const roadmapSlideCount = managed.length - 2;
  const pageCount = roadmapSlideCount / 2;
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error(`${name} must contain complete managed roadmap page pairs`);
  }
  const expectedRoles = [
    ...Array.from({ length: pageCount }, () => ["roadmap-executive", "roadmap-capability"]).flat(),
    "markitecture",
    "weekly-release",
  ];
  if (canonicalJson(managed.map((slide) => slide.managedRole)) !== canonicalJson(expectedRoles)) {
    throw new Error(`${name} has a malformed managed slide order`);
  }
  const roadmap = managed.slice(0, roadmapSlideCount);
  const noRoadmapInstanceIds = roadmap.every((slide) => slide.managedInstanceId === undefined);
  if (pageCount > 1 && noRoadmapInstanceIds) {
    throw new Error(`${name} must identify every repeated managed roadmap slide instance`);
  }
  for (let index = 0; index < roadmap.length; index += 1) {
    const pageIndex = Math.floor(index / 2) + 1;
    const role = roadmap[index].managedRole;
    const expectedInstanceId = `${String(role)}.${pageIndex}`;
    if (
      roadmap[index].managedInstanceId !== expectedInstanceId &&
      !(pageCount === 1 && noRoadmapInstanceIds)
    ) {
      throw new Error(`${name} has malformed managed slide instance ${String(role)}`);
    }
  }
  if (managed.slice(-2).some((slide) => slide.managedInstanceId !== undefined)) {
    throw new Error(`${name} assigns a page instance to a singleton managed role`);
  }
}

export function planManagedSlideRefresh(options: {
  slides: ManagedDeckSlide[];
  replacements: ManagedDeckSlide[];
  insertionIndex: number;
}): ManagedDeckSlide[] {
  if (!Number.isInteger(options.insertionIndex) || options.insertionIndex < 0) {
    throw new Error("Managed-slide insertion index must be a non-negative integer");
  }
  assertManagedSlideSequence(options.slides, "Existing deck");
  assertManagedSlideSequence(options.replacements, "Replacements");
  if (
    options.replacements.length === 0 ||
    options.replacements.some((slide) => slide.managedRole === undefined)
  ) {
    throw new Error("Replacements must contain only managed slides");
  }
  const unrelated = options.slides.filter((slide) => !slide.managedRole);
  const insertionIndex = Math.min(options.insertionIndex, unrelated.length);
  return [
    ...unrelated.slice(0, insertionIndex),
    ...options.replacements,
    ...unrelated.slice(insertionIndex),
  ];
}

export type PublicationBinding = {
  targetId: string;
  targetRevision: string;
  snapshotSha256: string;
  modelSha256: string;
  templateFingerprint: string;
};

export function validatePublicationBinding(
  approval: PublicationBinding | null,
  current: PublicationBinding,
): ValidationFinding[] {
  if (!approval) {
    return [
      finding(
        "PUBLICATION_APPROVAL_MISSING",
        "Publication approval is missing.",
        "Ask the user to approve the exact target, revision, snapshot, model, and template fingerprint.",
      ),
    ];
  }
  const mismatches = (Object.keys(current) as Array<keyof PublicationBinding>).filter(
    (key) => approval[key] !== current[key],
  );
  return mismatches.length === 0
    ? []
    : [
        finding(
          "PUBLICATION_BINDING_STALE",
          `Publication approval no longer matches: ${mismatches.join(", ")}.`,
          "Obtain fresh approval for the exact target ID, target revision, snapshot SHA-256, model SHA-256, and template fingerprint from the reviewed preview.",
        ),
      ];
}

export type SemanticTemplateContract = {
  slideSize: unknown;
  masters: unknown;
  layouts: unknown;
  theme: unknown;
  fontRoles: unknown;
  protectedRegions: unknown;
  roles: unknown;
  unrelatedSlides?: unknown;
  comments?: unknown;
  revision?: unknown;
};

export function semanticTemplateFingerprint(contract: SemanticTemplateContract): string {
  const {
    unrelatedSlides: _unrelatedSlides,
    comments: _comments,
    revision: _revision,
    ...semantic
  } = contract;
  return canonicalSha256(semantic);
}

export function classifyTemplateDrift(
  baseline: SemanticTemplateContract,
  current: SemanticTemplateContract,
): {
  material: boolean;
  baselineFingerprint: string;
  currentFingerprint: string;
} {
  const baselineFingerprint = semanticTemplateFingerprint(baseline);
  const currentFingerprint = semanticTemplateFingerprint(current);
  return {
    material: baselineFingerprint !== currentFingerprint,
    baselineFingerprint,
    currentFingerprint,
  };
}

function finding(
  code: string,
  message: string,
  remediation: string,
  role?: ValidationFinding["role"],
): ValidationFinding {
  return role ? { code, message, remediation, role } : { code, message, remediation };
}

function ajvFinding(error: ErrorObject): ValidationFinding {
  const location = error.instancePath || "/";
  return finding(
    "SCHEMA_INVALID",
    `${location} [${error.keyword}] ${error.message ?? "does not match the slide-model schema"}`,
    "Correct the source model and rebuild it before rendering.",
  );
}

function validDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!match) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7] ?? "000"}Z`;
  return new Date(parsed).toISOString() === normalized;
}

function validUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function collectContentIds(value: unknown, ids: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectContentIds(item, ids);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "contentId" && typeof child === "string") ids.push(child);
    collectContentIds(child, ids);
  }
}

function managedSourceLine(source: Record<string, unknown>): string {
  const location =
    typeof source.url === "string"
      ? source.url
      : `${String(source.path ?? "")}${source.heading ? `#${String(source.heading)}` : ""}`;
  return [
    String(source.sourceId ?? ""),
    String(source.kind ?? ""),
    location,
    String(source.commitSha ?? ""),
    String(source.digest ?? ""),
  ].join(" | ");
}

function expectedManagedNotes(options: {
  slide: Record<string, unknown>;
  modelSha256: string;
  snapshotSha256: string;
}): string {
  const { slide } = options;
  const pageBinding =
    typeof slide.instanceId === "string" &&
    typeof slide.pageIndex === "number" &&
    typeof slide.pageCount === "number"
      ? [`instance_id=${slide.instanceId}`, `page=${slide.pageIndex}/${slide.pageCount}`]
      : [];
  const sources = Array.isArray(slide.sources)
    ? (slide.sources as Array<Record<string, unknown>>)
    : [];
  const weeklyMetadata =
    slide.role === "weekly-release"
      ? (() => {
          const window = (slide.window ?? {}) as Record<string, unknown>;
          const reportSource = sources.find(
            (source) => source.sourceId === "mapping.weekly-milestone-report",
          );
          const milestoneRows = Array.isArray(slide.milestoneRows)
            ? (slide.milestoneRows as Array<Record<string, unknown>>)
            : [];
          return [
            `snapshot_as_of=${String(window.end ?? "")}`,
            `window_start=${String(window.start ?? "")}`,
            `window_end=${String(window.end ?? "")}`,
            `milestone_report_observed_at=${String(slide.reportObservedAt ?? "")}`,
            `milestone_report_sha256=${String(reportSource?.digest ?? "")}`,
            `milestone_rows=${milestoneRows.map((row) => String(row.title ?? "")).join(" | ")}`,
          ];
        })()
      : [];
  const lines = [
    "[NEMOCLAW-MANAGED-SLIDE v1]",
    `role=${String(slide.role ?? "")}`,
    ...pageBinding,
    ...weeklyMetadata,
    `model_sha256=${options.modelSha256}`,
    `snapshot_sha256=${options.snapshotSha256}`,
    "[Sources]",
    ...sources.map(managedSourceLine),
  ];
  if (slide.role === "markitecture") {
    const claims = Array.isArray(slide.claims)
      ? (slide.claims as Array<Record<string, unknown>>)
      : [];
    lines.push(
      "[Claims]",
      ...claims.map((claim) =>
        [claim.claimId, claim.path, claim.heading, claim.commitSha, claim.sectionSha256]
          .map((value) => String(value ?? ""))
          .join(" | "),
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function milestoneOutcomeFindings(
  pageMilestones: Array<Record<string, unknown>>,
  pageIndex: number,
  asOf: string,
): ValidationFinding[] {
  const errors: ValidationFinding[] = [];
  for (const milestone of pageMilestones) {
    const status = milestone.status as Record<string, unknown> | undefined;
    const validOpen = status?.state === "open" && status.label === "Active";
    const dueOn = milestone.dueOn;
    const validCurrentDueDate =
      typeof dueOn === "string" &&
      validDateTime(dueOn) &&
      validDateTime(asOf) &&
      dueOn.slice(0, 10) >= asOf.slice(0, 10);
    if (!validOpen || !validCurrentDueDate) {
      errors.push(
        finding(
          "MILESTONE_STATUS_INVALID",
          `Milestone ${String(milestone.milestoneNodeId)} is not an eligible active milestone.`,
          "Omit closed, past-due, and undated milestones; represent only an open milestone with a valid due date on or after asOf as Active.",
          "roadmap-executive",
        ),
      );
    }
    const outcomes = Array.isArray(milestone.outcomes)
      ? (milestone.outcomes as Array<Record<string, unknown>>)
      : [];
    for (const outcome of outcomes) {
      const featureTitle = outcome.featureTitle;
      const context = outcome.text;
      const validOpenEpic = outcome.state === "OPEN" && outcome.closedAt === null;
      const validCompletedEpic =
        outcome.state === "CLOSED" &&
        typeof outcome.closedAt === "string" &&
        validDateTime(outcome.closedAt);
      if (!validOpenEpic && !validCompletedEpic) {
        errors.push(
          finding(
            "EPIC_LIFECYCLE_INVALID",
            `Epic ${String(outcome.issueNumber)} on executive page ${pageIndex} has inconsistent state and closedAt evidence.`,
            "Derive OPEN with closedAt null, or CLOSED with the exact valid native closedAt value.",
            "roadmap-executive",
          ),
        );
      }
      const labelValid =
        typeof featureTitle === "string" &&
        featureTitle.replace(/\s+/gu, " ").trim() === featureTitle &&
        !featureTitle.includes(":") &&
        roadmapPresentationWordCount(featureTitle) >= 2 &&
        roadmapPresentationWordCount(featureTitle) <= 4;
      if (!labelValid) {
        errors.push(
          finding(
            "EXECUTIVE_LABEL_FORMAT_INVALID",
            `Epic ${String(outcome.issueNumber)} on executive page ${pageIndex} does not have a two-to-four-word short label.`,
            "Use the reviewed short label from the body-bound presentation mapping without a colon or line break.",
            "roadmap-executive",
          ),
        );
      }
      const contextValid =
        typeof context === "string" &&
        context.replace(/\s+/gu, " ").trim() === context &&
        roadmapPresentationWordCount(context) >= 3 &&
        roadmapPresentationWordCount(context) <= 10;
      if (!contextValid) {
        errors.push(
          finding(
            "EXECUTIVE_CONTEXT_FORMAT_INVALID",
            `Epic ${String(outcome.issueNumber)} on executive page ${pageIndex} does not have a three-to-ten-word short context.`,
            "Use the reviewed short context from the body-bound presentation mapping without a line break.",
            "roadmap-executive",
          ),
        );
      }
      if (
        typeof featureTitle !== "string" ||
        typeof context !== "string" ||
        `${outcome.state === "CLOSED" ? "✓ " : ""}${featureTitle}: ${context}`.length >
          ROADMAP_EXECUTIVE_ROW_MAX_CHARACTERS
      ) {
        errors.push(
          finding(
            "EXECUTIVE_ROW_LENGTH_INVALID",
            `Epic ${String(outcome.issueNumber)} on executive page ${pageIndex} exceeds the ${ROADMAP_EXECUTIVE_ROW_MAX_CHARACTERS}-character label-and-context limit.`,
            "Shorten the reviewed label or context without truncation or omitting the Epic.",
            "roadmap-executive",
          ),
        );
      }
      const progress = outcome.progress;
      if (!progress || progress === "Unknown" || typeof progress !== "object") continue;
      const values = progress as Record<string, unknown>;
      const completed = values.completed;
      const total = values.total;
      const percentage = values.percentage;
      const expected =
        typeof completed === "number" && typeof total === "number" && total > 0
          ? Math.round((completed / total) * 1000) / 10
          : Number.NaN;
      if (
        !Number.isInteger(completed) ||
        !Number.isInteger(total) ||
        Number(completed) > Number(total) ||
        typeof percentage !== "number" ||
        percentage !== expected
      ) {
        errors.push(
          finding(
            "PROGRESS_INVALID",
            `Outcome ${String(outcome.contentId)} has progress that does not match completed/total.`,
            "Recompute progress from the unique native and referenced child issue states.",
            "roadmap-executive",
          ),
        );
      }
    }
  }
  return errors;
}

function structuralFindings(
  model: Record<string, unknown>,
  calculatedHash: string,
): ValidationFinding[] {
  const errors: ValidationFinding[] = [];
  const slides = Array.isArray(model.slides)
    ? (model.slides as Array<Record<string, unknown>>)
    : [];
  const roles = slides.map((slide) => slide.role);
  const executiveSlides = slides.filter((slide) => slide.role === "roadmap-executive");
  const capabilitySlides = slides.filter((slide) => slide.role === "roadmap-capability");
  const roadmapPageCount = executiveSlides.length;
  const expectedRoles = [
    ...Array.from({ length: roadmapPageCount }, () => [
      "roadmap-executive",
      "roadmap-capability",
    ]).flat(),
    "markitecture",
    "weekly-release",
  ];
  if (
    roadmapPageCount === 0 ||
    capabilitySlides.length !== roadmapPageCount ||
    JSON.stringify(roles) !== JSON.stringify(expectedRoles)
  ) {
    errors.push(
      finding(
        "ROLE_ORDER_INVALID",
        "Managed roles must be alternating executive and capability roadmap page pairs, followed by markitecture and weekly release.",
        "Rebuild the model with one native roadmap slide pair for each group of up to three eligible milestones.",
      ),
    );
  }

  if (model.modelSha256 !== calculatedHash) {
    errors.push(
      finding(
        "MODEL_HASH_MISMATCH",
        "modelSha256 does not match the canonical model bytes.",
        "Recalculate the hash after every model change.",
      ),
    );
  }

  const ids: string[] = [];
  collectContentIds(model, ids);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
  if (duplicateIds.length > 0) {
    errors.push(
      finding(
        "CONTENT_ID_DUPLICATE",
        `Stable content IDs are duplicated: ${duplicateIds.join(", ")}.`,
        "Assign one stable content ID to each audience-facing model item.",
      ),
    );
  }

  const publication = model.publication as Record<string, unknown> | undefined;
  const blockers = Array.isArray(publication?.blockers) ? publication.blockers : [];
  if (publication?.eligible !== (blockers.length === 0)) {
    errors.push(
      finding(
        "PUBLICATION_STATE_INVALID",
        "publication.eligible must be true exactly when the blocker list is empty.",
        "Rebuild the publication verdict from the collected findings.",
      ),
    );
  }

  for (const slide of slides) {
    const role = MANAGED_ROLES.includes(slide.role as never)
      ? (slide.role as ValidationFinding["role"])
      : undefined;
    const notes = typeof slide.managedNotes === "string" ? normalizeString(slide.managedNotes) : "";
    const expectedNotes = expectedManagedNotes({
      slide,
      modelSha256: calculatedHash,
      snapshotSha256: String(model.snapshotSha256 ?? ""),
    });
    if (notes !== expectedNotes) {
      errors.push(
        finding(
          "MANAGED_NOTES_INVALID",
          `Managed notes for ${String(slide.role)} do not exactly match the role, model, snapshot, sources, and claims.`,
          "Generate the complete speaker notes from the final shared model after calculating its hash.",
          role,
        ),
      );
    }
    if (slide.role === "roadmap-capability" && slide.title !== ROADMAP_CAPABILITY_TITLE) {
      errors.push(
        finding(
          "CAPABILITY_TITLE_INVALID",
          `Capability roadmap title must be exactly ${ROADMAP_CAPABILITY_TITLE}.`,
          "Restore the exact public template title before rendering either output format.",
          "roadmap-capability",
        ),
      );
    }
  }

  const roadmapPairs = Array.from({ length: roadmapPageCount }, (_, index) => ({
    executive: slides[index * 2],
    matrix: slides[index * 2 + 1],
  }));
  const milestones: Array<Record<string, unknown>> = [];
  const columns: Array<Record<string, unknown>> = [];
  const cells: Array<Record<string, unknown>> = [];
  const unclassified: Array<Record<string, unknown>> = [];
  const executiveSources: Array<Record<string, unknown>> = [];
  const matrixSources: Array<Record<string, unknown>> = [];
  for (const [pageOffset, pair] of roadmapPairs.entries()) {
    const pageIndex = pageOffset + 1;
    const pageMilestones = Array.isArray(pair.executive?.milestones)
      ? (pair.executive.milestones as Array<Record<string, unknown>>)
      : [];
    const pageColumns = Array.isArray(pair.matrix?.columns)
      ? (pair.matrix.columns as Array<Record<string, unknown>>)
      : [];
    const rows = Array.isArray(pair.matrix?.rows) ? pair.matrix.rows : [];
    const pageCells = Array.isArray(pair.matrix?.cells)
      ? (pair.matrix.cells as Array<Record<string, unknown>>)
      : [];
    const pageUnclassified = Array.isArray(pair.matrix?.unclassified)
      ? (pair.matrix.unclassified as Array<Record<string, unknown>>)
      : [];
    const pageExecutiveSources = Array.isArray(pair.executive?.sources)
      ? (pair.executive.sources as Array<Record<string, unknown>>)
      : [];
    const pageMatrixSources = Array.isArray(pair.matrix?.sources)
      ? (pair.matrix.sources as Array<Record<string, unknown>>)
      : [];
    milestones.push(...pageMilestones);
    columns.push(...pageColumns);
    cells.push(...pageCells);
    unclassified.push(...pageUnclassified);
    executiveSources.push(...pageExecutiveSources);
    matrixSources.push(...pageMatrixSources);
    if (
      pair.executive?.instanceId !== `roadmap-executive.${pageIndex}` ||
      pair.matrix?.instanceId !== `roadmap-capability.${pageIndex}` ||
      pair.executive?.pageIndex !== pageIndex ||
      pair.matrix?.pageIndex !== pageIndex ||
      pair.executive?.pageCount !== roadmapPageCount ||
      pair.matrix?.pageCount !== roadmapPageCount
    ) {
      errors.push(
        finding(
          "ROADMAP_PAGE_BINDING_INVALID",
          `Roadmap page pair ${pageIndex} does not have matching stable page and instance bindings.`,
          "Rebuild every roadmap pair with 1-based pageIndex, total pageCount, and exact roadmap-executive.N and roadmap-capability.N instance IDs.",
        ),
      );
    }
    if (
      pageMilestones.length < 1 ||
      pageMilestones.length > 3 ||
      pageColumns.length !== pageMilestones.length ||
      (pageIndex < roadmapPageCount && pageMilestones.length !== 3)
    ) {
      errors.push(
        finding(
          "TEMPLATE_COLUMN_COUNT_INVALID",
          `Roadmap page ${pageIndex} has ${pageMilestones.length} milestones and ${pageColumns.length} capability columns.`,
          "Chunk eligible milestones in order into full three-column pages, with one to three columns only on the last page.",
        ),
      );
    }
    if (JSON.stringify(rows) !== JSON.stringify(ROADMAP_AREAS)) {
      errors.push(
        finding(
          "MATRIX_TAXONOMY_INVALID",
          `Matrix page ${pageIndex} must use exactly ${ROADMAP_AREAS.join(", ")} in that order.`,
          "Use the reviewable roadmap presentation taxonomy on every capability page.",
          "roadmap-capability",
        ),
      );
    }
    const columnMismatch = pageMilestones.some((milestone, index) => {
      const column = pageColumns[index];
      return (
        !column ||
        column.milestoneNodeId !== milestone.milestoneNodeId ||
        column.title !== milestone.title ||
        column.dueOn !== milestone.dueOn ||
        column.focus !== milestone.focus ||
        canonicalJson(column.status) !== canonicalJson(milestone.status)
      );
    });
    if (columnMismatch) {
      errors.push(
        finding(
          "MATRIX_COLUMN_ALIGNMENT_INVALID",
          `Capability page ${pageIndex} does not match its executive milestone identity, order, title, due date, focus, and status.`,
          "Rebuild each roadmap pair from the same ordered milestone chunk.",
          "roadmap-capability",
        ),
      );
    }
    errors.push(...milestoneOutcomeFindings(pageMilestones, pageIndex, String(model.asOf ?? "")));
    const expectedCellKeys = new Set(
      rows.flatMap((row) =>
        pageColumns.map((column) => `${String(row)}\u0000${String(column.milestoneNodeId)}`),
      ),
    );
    const actualCellKeys = pageCells.map(
      (cell) => `${String(cell.roadmapArea)}\u0000${String(cell.milestoneNodeId)}`,
    );
    if (
      actualCellKeys.length !== expectedCellKeys.size ||
      new Set(actualCellKeys).size !== expectedCellKeys.size ||
      actualCellKeys.some((key) => !expectedCellKeys.has(key))
    ) {
      errors.push(
        finding(
          "MATRIX_CELL_COVERAGE_INVALID",
          `Capability page ${pageIndex} does not contain one cell for every area and milestone pair.`,
          "Rebuild the table from that page's milestone columns and four approved areas.",
          "roadmap-capability",
        ),
      );
    }
  }
  const epicSourceInventory = (
    sources: Array<Record<string, unknown>>,
  ): Array<{ issueNumber: number; url: string }> =>
    sources.flatMap((source) => {
      if (typeof source.sourceId !== "string") return [];
      const match = /^github\.epic\.([1-9]\d*)$/u.exec(source.sourceId);
      if (!match) return [];
      return [{ issueNumber: Number(match[1]), url: String(source.url ?? "") }];
    });
  const milestoneSourceInventory = (
    sources: Array<Record<string, unknown>>,
  ): Array<{ number: number; url: string }> =>
    sources.flatMap((source) => {
      if (typeof source.sourceId !== "string") return [];
      const match = /^github\.milestone\.([1-9]\d*)$/u.exec(source.sourceId);
      if (!match) return [];
      return [{ number: Number(match[1]), url: String(source.url ?? "") }];
    });
  const executiveSourceEpics = epicSourceInventory(executiveSources);
  const matrixSourceEpics = epicSourceInventory(matrixSources);
  const sourceKey = (epic: { issueNumber: number; url: string }): string =>
    `${String(epic.issueNumber)}\u0000${epic.url}`;
  const milestoneKey = (milestone: { number: number; url: string }): string =>
    `${String(milestone.number)}\u0000${milestone.url}`;
  const assignmentKey = (epic: {
    issueNumber: number;
    url: string;
    milestoneNodeId: string;
  }): string => `${sourceKey(epic)}\u0000${epic.milestoneNodeId}`;
  for (const [pageOffset, pair] of roadmapPairs.entries()) {
    const pageIndex = pageOffset + 1;
    const pageMilestones = Array.isArray(pair.executive?.milestones)
      ? (pair.executive.milestones as Array<Record<string, unknown>>)
      : [];
    const pageColumns = Array.isArray(pair.matrix?.columns)
      ? (pair.matrix.columns as Array<Record<string, unknown>>)
      : [];
    const pageUnclassified = Array.isArray(pair.matrix?.unclassified)
      ? (pair.matrix.unclassified as Array<Record<string, unknown>>)
      : [];
    const pageExecutiveSources = Array.isArray(pair.executive?.sources)
      ? (pair.executive.sources as Array<Record<string, unknown>>)
      : [];
    const pageMatrixSources = Array.isArray(pair.matrix?.sources)
      ? (pair.matrix.sources as Array<Record<string, unknown>>)
      : [];
    const pageExecutiveEpics = pageMilestones.flatMap((milestone) =>
      (Array.isArray(milestone.outcomes)
        ? (milestone.outcomes as Array<Record<string, unknown>>)
        : []
      ).map((outcome) => ({
        issueNumber: Number(outcome.issueNumber),
        url: String(outcome.url ?? ""),
      })),
    );
    const pageSourceKeys = epicSourceInventory(pageExecutiveSources).map(sourceKey).sort();
    const pageMatrixSourceKeys = epicSourceInventory(pageMatrixSources).map(sourceKey).sort();
    const pageEpicKeys = pageExecutiveEpics.map(sourceKey).sort();
    const pageMilestoneKeys = pageMilestones
      .flatMap((milestone) => {
        const url = String(milestone.url ?? "");
        const match = /^https:\/\/github\.com\/NVIDIA\/NemoClaw\/milestone\/([1-9]\d*)$/u.exec(url);
        return match ? [{ number: Number(match[1]), url }] : [];
      })
      .map(milestoneKey)
      .sort();
    const pageExecutiveMilestoneKeys = milestoneSourceInventory(pageExecutiveSources)
      .map(milestoneKey)
      .sort();
    const pageMatrixMilestoneKeys = milestoneSourceInventory(pageMatrixSources)
      .map(milestoneKey)
      .sort();
    const expectedExecutiveSourceIds = [
      ...pageMilestoneKeys.map((key) => `github.milestone.${key.split("\u0000")[0]}`),
      ...pageEpicKeys.map((key) => `github.epic.${key.split("\u0000")[0]}`),
    ].sort();
    const expectedMatrixSourceIds = [
      ...expectedExecutiveSourceIds,
      "mapping.roadmap-presentation",
    ].sort();
    const actualExecutiveSourceIds = pageExecutiveSources
      .map((source) => String(source.sourceId ?? ""))
      .sort();
    const actualMatrixSourceIds = pageMatrixSources
      .map((source) => String(source.sourceId ?? ""))
      .sort();
    const mappingSource = pageMatrixSources.find(
      (source) => source.sourceId === "mapping.roadmap-presentation",
    );
    const invalidSourceKinds =
      pageExecutiveSources.some((source) => source.kind !== "github") ||
      pageMatrixSources.some(
        (source) =>
          source.kind !==
          (source.sourceId === "mapping.roadmap-presentation" ? "mapping" : "github"),
      ) ||
      mappingSource?.path !== "runtime/presentation-map.json";
    if (
      JSON.stringify(pageSourceKeys) !== JSON.stringify(pageMatrixSourceKeys) ||
      JSON.stringify(pageSourceKeys) !== JSON.stringify(pageEpicKeys) ||
      pageMilestoneKeys.length !== pageMilestones.length ||
      JSON.stringify(pageMilestoneKeys) !== JSON.stringify(pageExecutiveMilestoneKeys) ||
      JSON.stringify(pageMilestoneKeys) !== JSON.stringify(pageMatrixMilestoneKeys) ||
      JSON.stringify(actualExecutiveSourceIds) !== JSON.stringify(expectedExecutiveSourceIds) ||
      JSON.stringify(actualMatrixSourceIds) !== JSON.stringify(expectedMatrixSourceIds) ||
      invalidSourceKinds ||
      pageUnclassified.some(
        (item) => !pageColumns.some((column) => column.milestoneNodeId === item.milestoneNodeId),
      )
    ) {
      errors.push(
        finding(
          "ROADMAP_PAGE_SOURCE_SCOPE_INVALID",
          `Roadmap page ${pageIndex} sources or classification warnings do not match only that page's Epic set.`,
          "Scope every roadmap page pair to the milestones and Epics in its own chunk.",
          "roadmap-capability",
        ),
      );
    }
    const pageEpicCount = pageExecutiveEpics.length;
    const summary = `${pageEpicCount} native GitHub ${pageEpicCount === 1 ? "Epic" : "Epics"} shown across ${pageMilestones.length} eligible milestone delivery ${pageMilestones.length === 1 ? "window" : "windows"}.`;
    const expectedSummary =
      roadmapPageCount === 1 ? summary : `${summary} Page ${pageIndex} of ${roadmapPageCount}.`;
    if (pair.executive?.summary !== expectedSummary) {
      errors.push(
        finding(
          "EXECUTIVE_SUMMARY_INVALID",
          `Executive roadmap page ${pageIndex} summary does not count its complete visible Epic set.`,
          "Rebuild the page summary from every included native Epic in that milestone chunk.",
          "roadmap-executive",
        ),
      );
    }
  }
  const representedMilestones = milestones.flatMap((milestone) => {
    const url = String(milestone.url ?? "");
    const match = /^https:\/\/github\.com\/NVIDIA\/NemoClaw\/milestone\/([1-9]\d*)$/u.exec(url);
    return match
      ? [
          {
            number: Number(match[1]),
            url,
            nodeId: String(milestone.milestoneNodeId ?? ""),
          },
        ]
      : [];
  });
  const representedMilestoneKeys = representedMilestones.map(milestoneKey).sort();
  const executiveSourceMilestoneKeys = milestoneSourceInventory(executiveSources)
    .map(milestoneKey)
    .sort();
  const matrixSourceMilestoneKeys = milestoneSourceInventory(matrixSources)
    .map(milestoneKey)
    .sort();
  if (
    representedMilestones.length !== milestones.length ||
    representedMilestones.some((milestone) => milestone.nodeId.length === 0) ||
    new Set(representedMilestoneKeys).size !== representedMilestoneKeys.length ||
    new Set(representedMilestones.map((milestone) => milestone.nodeId)).size !==
      representedMilestones.length ||
    new Set(executiveSourceMilestoneKeys).size !== executiveSourceMilestoneKeys.length ||
    new Set(matrixSourceMilestoneKeys).size !== matrixSourceMilestoneKeys.length ||
    JSON.stringify(representedMilestoneKeys) !== JSON.stringify(executiveSourceMilestoneKeys) ||
    JSON.stringify(representedMilestoneKeys) !== JSON.stringify(matrixSourceMilestoneKeys)
  ) {
    errors.push(
      finding(
        "ROADMAP_MILESTONE_COVERAGE_INVALID",
        "Every eligible native milestone must appear once in the executive roadmap, matching capability column, and each page's native source inventory.",
        "Rebuild all roadmap page pairs from the complete ordered native milestone selection without omission or duplication.",
        "roadmap-capability",
      ),
    );
  }
  const canonicalSourceKeys = executiveSourceEpics.map(sourceKey).sort();
  const matrixSourceKeys = matrixSourceEpics.map(sourceKey).sort();
  const invalidSourceInventory = [...executiveSourceEpics, ...matrixSourceEpics].some(
    (epic) =>
      !Number.isSafeInteger(epic.issueNumber) ||
      epic.url !== `https://github.com/NVIDIA/NemoClaw/issues/${String(epic.issueNumber)}`,
  );
  const executiveEpics = milestones.flatMap((milestone) =>
    (Array.isArray(milestone.outcomes)
      ? (milestone.outcomes as Array<Record<string, unknown>>)
      : []
    ).map((outcome) => ({
      issueNumber: Number(outcome.issueNumber),
      url: String(outcome.url ?? ""),
      epicNodeId: String(outcome.epicNodeId ?? ""),
      milestoneNodeId: String(milestone.milestoneNodeId ?? ""),
      title: String(outcome.featureTitle ?? ""),
      state: outcome.state,
      closedAt: outcome.closedAt,
    })),
  );
  const classifiedEpics = cells.flatMap((cell) =>
    (Array.isArray(cell.items) ? (cell.items as Array<Record<string, unknown>>) : []).map(
      (item) => ({
        issueNumber: Number(item.issueNumber),
        url: String(item.url ?? ""),
        milestoneNodeId: String(cell.milestoneNodeId ?? ""),
        title: String(item.title ?? ""),
        state: item.state,
        closedAt: item.closedAt,
      }),
    ),
  );
  const representedEpics = [
    ...classifiedEpics,
    ...unclassified.map((item) => ({
      issueNumber: Number(item.issueNumber),
      url: String(item.url ?? ""),
      milestoneNodeId: String(item.milestoneNodeId ?? ""),
      title: String(item.title ?? ""),
      state: item.state,
      closedAt: item.closedAt,
    })),
  ];
  const executiveEpicKeys = executiveEpics.map(sourceKey).sort();
  const representedEpicKeys = representedEpics.map(sourceKey).sort();
  const executiveAssignments = executiveEpics.map(assignmentKey).sort();
  const representedAssignments = representedEpics.map(assignmentKey).sort();
  const executiveLabelByAssignment = new Map(
    executiveEpics.map((epic) => [assignmentKey(epic), epic.title]),
  );
  const executiveLifecycleByAssignment = new Map(
    executiveEpics.map((epic) => [
      assignmentKey(epic),
      canonicalJson({ state: epic.state, closedAt: epic.closedAt }),
    ]),
  );
  if (
    representedEpics.some(
      (epic) => executiveLabelByAssignment.get(assignmentKey(epic)) !== epic.title,
    )
  ) {
    errors.push(
      finding(
        "MATRIX_EPIC_LABEL_MISMATCH",
        "A capability Epic does not use the exact short label from its matching executive outcome.",
        "Rebuild both roadmap slides from the same body-bound presentation label and keep context off the capability slide.",
        "roadmap-capability",
      ),
    );
  }
  if (
    representedEpics.some(
      (epic) =>
        executiveLifecycleByAssignment.get(assignmentKey(epic)) !==
        canonicalJson({ state: epic.state, closedAt: epic.closedAt }),
    )
  ) {
    errors.push(
      finding(
        "MATRIX_EPIC_LIFECYCLE_MISMATCH",
        "A capability Epic does not use the exact state and closedAt evidence from its matching executive outcome.",
        "Rebuild both roadmap slides from the same native Epic lifecycle evidence.",
        "roadmap-capability",
      ),
    );
  }
  if (
    invalidSourceInventory ||
    new Set(canonicalSourceKeys).size !== canonicalSourceKeys.length ||
    new Set(matrixSourceKeys).size !== matrixSourceKeys.length ||
    JSON.stringify(canonicalSourceKeys) !== JSON.stringify(matrixSourceKeys) ||
    new Set(executiveEpicKeys).size !== executiveEpicKeys.length ||
    new Set(representedEpicKeys).size !== representedEpicKeys.length ||
    new Set(executiveEpics.map((epic) => epic.epicNodeId)).size !== executiveEpics.length ||
    new Set(milestones.map((milestone) => milestone.milestoneNodeId)).size !== milestones.length ||
    new Set(columns.map((column) => column.milestoneNodeId)).size !== columns.length ||
    unclassified.some(
      (item) => !columns.some((column) => column.milestoneNodeId === item.milestoneNodeId),
    ) ||
    JSON.stringify(canonicalSourceKeys) !== JSON.stringify(executiveEpicKeys) ||
    JSON.stringify(canonicalSourceKeys) !== JSON.stringify(representedEpicKeys) ||
    JSON.stringify(executiveAssignments) !== JSON.stringify(representedAssignments)
  ) {
    errors.push(
      finding(
        "MATRIX_EPIC_COVERAGE_INVALID",
        "Every selected Epic must appear exactly once in the executive roadmap and exactly once in the capability matrix or its classification warning.",
        "Rebuild both roadmap slides from the complete included native Epic set without omission or duplication.",
        "roadmap-capability",
      ),
    );
  }
  const markitecture = slides.find((slide) => slide.role === "markitecture");
  const nodes = Array.isArray(markitecture?.nodes)
    ? (markitecture.nodes as Array<Record<string, unknown>>)
    : [];
  const connectors = Array.isArray(markitecture?.connectors)
    ? (markitecture.connectors as Array<Record<string, unknown>>)
    : [];
  const claims = Array.isArray(markitecture?.claims)
    ? (markitecture.claims as Array<Record<string, unknown>>)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.contentId));
  const claimIds = new Set(claims.map((claim) => claim.claimId));
  const connectorGraph = connectors.map((connector) => ({
    contentId: connector.contentId,
    claimId: connector.claimId,
    from: connector.from,
    to: connector.to,
    label: connector.label,
    lineStyle: connector.lineStyle,
  }));
  if (
    nodes.some((node) => !claimIds.has(node.claimId)) ||
    connectors.some(
      (connector) =>
        !claimIds.has(connector.claimId) ||
        !nodeIds.has(connector.from) ||
        !nodeIds.has(connector.to),
    ) ||
    canonicalJson(connectorGraph) !== canonicalJson(MARKITECTURE_CONNECTOR_GRAPH)
  ) {
    errors.push(
      finding(
        "MARKITECTURE_GRAPH_INVALID",
        "The markitecture must use the documentation-bound gateway flow, and every visible node and connector must reference a collected claim.",
        "Reconcile the native-shape graph and its connector directions with the claim ledger and the canonical architecture flow.",
        "markitecture",
      ),
    );
  }

  const weekly = slides.find((slide) => slide.role === "weekly-release");
  const milestoneRows = Array.isArray(weekly?.milestoneRows)
    ? (weekly.milestoneRows as Array<Record<string, unknown>>)
    : [];
  const weeklySources = Array.isArray(weekly?.sources)
    ? (weekly.sources as Array<Record<string, unknown>>)
    : [];
  const reportSources = weeklySources.filter(
    (source) => source.sourceId === "mapping.weekly-milestone-report",
  );
  const reportSource = reportSources[0];
  const reportSourceValid =
    reportSources.length === 1 &&
    reportSource.kind === "mapping" &&
    reportSource.path === "runtime/narrative-input.json" &&
    typeof reportSource.digest === "string" &&
    /^[0-9a-f]{64}$/u.test(reportSource.digest);
  if (!reportSourceValid) {
    errors.push(
      finding(
        "WEEKLY_REPORT_SOURCE_INVALID",
        "The weekly scorecard does not contain one exact self-hash-bound milestone report source.",
        "Rebuild the weekly rows from the verified runtime narrative input and its canonical reportSha256.",
        "weekly-release",
      ),
    );
  }
  if (milestoneRows.length < 1 || milestoneRows.length > 3) {
    errors.push(
      finding(
        "WEEKLY_MILESTONE_DENSITY_INVALID",
        `The weekly scorecard has ${milestoneRows.length} milestone rows; the approved layout requires one to three.`,
        "Select one to three weekly milestone rows without changing roadmap pagination.",
        "weekly-release",
      ),
    );
  }
  const milestoneById = new Map(
    milestones.map((milestone) => [String(milestone.milestoneNodeId ?? ""), milestone]),
  );
  const milestoneIndexById = new Map(
    milestones.map((milestone, index) => [String(milestone.milestoneNodeId ?? ""), index]),
  );
  const executiveSourceById = new Map(
    executiveSources.map((source) => [String(source.sourceId ?? ""), source]),
  );
  const weeklySourceById = new Map(
    weeklySources.map((source) => [String(source.sourceId ?? ""), source]),
  );
  const seenWeeklyMilestoneIds = new Set<string>();
  const weeklyMilestoneIndexes: number[] = [];
  for (const row of milestoneRows) {
    const milestoneNodeId = String(row.milestoneNodeId ?? "");
    const expectedMilestone = milestoneById.get(milestoneNodeId);
    const milestoneIndex = milestoneIndexById.get(milestoneNodeId);
    const duplicate = seenWeeklyMilestoneIds.has(milestoneNodeId);
    seenWeeklyMilestoneIds.add(milestoneNodeId);
    if (milestoneIndex !== undefined) weeklyMilestoneIndexes.push(milestoneIndex);
    if (
      duplicate ||
      !expectedMilestone ||
      milestoneIndex === undefined ||
      row.title !== expectedMilestone.title ||
      row.url !== expectedMilestone.url
    ) {
      errors.push(
        finding(
          "WEEKLY_MILESTONE_IDENTITY_INVALID",
          `Weekly row ${milestoneNodeId || "<missing>"} is duplicated or does not match one eligible roadmap milestone identity, title, and URL.`,
          "Rebuild each weekly row from one unique eligible roadmap milestone.",
          "weekly-release",
        ),
      );
      continue;
    }
    const milestoneSourceId = `github.${String(expectedMilestone.contentId)}`;
    const weeklyMilestoneSource = weeklySourceById.get(milestoneSourceId);
    const executiveMilestoneSource = executiveSourceById.get(milestoneSourceId);
    if (
      !weeklyMilestoneSource ||
      !executiveMilestoneSource ||
      canonicalJson(weeklyMilestoneSource) !== canonicalJson(executiveMilestoneSource)
    ) {
      errors.push(
        finding(
          "WEEKLY_MILESTONE_SOURCE_INVALID",
          `Weekly row ${String(row.title)} does not retain its exact frozen roadmap milestone source.`,
          "Include the same milestone source ID, URL, and digest from the frozen snapshot evidence used by the executive roadmap.",
          "weekly-release",
        ),
      );
    }

    const outcomes = Array.isArray(expectedMilestone.outcomes)
      ? (expectedMilestone.outcomes as Array<Record<string, unknown>>)
      : [];
    const outcomeByEpicId = new Map(
      outcomes.map((outcome) => [String(outcome.epicNodeId ?? ""), outcome]),
    );
    const updates = Array.isArray(row.updates)
      ? (row.updates as Array<Record<string, unknown>>)
      : [];
    const updateEpicIds = updates.map((update) => String(update.epicNodeId ?? ""));
    const expectedEpicIds = [...outcomeByEpicId.keys()];
    if (canonicalJson([...updateEpicIds].sort()) !== canonicalJson([...expectedEpicIds].sort())) {
      errors.push(
        finding(
          "WEEKLY_UPDATE_COVERAGE_INVALID",
          `Weekly row ${String(row.title)} does not retain every roadmap Epic exactly once.`,
          "Add one report update for each Epic in that milestone and remove duplicates or unrelated updates.",
          "weekly-release",
        ),
      );
    }
    for (const update of updates) {
      const epicNodeId = String(update.epicNodeId ?? "");
      const outcome = outcomeByEpicId.get(epicNodeId);
      const epicSourceId = outcome ? `github.epic.${String(outcome.issueNumber)}` : "";
      const executiveEpicSource = executiveSourceById.get(epicSourceId);
      const weeklyEpicSource = weeklySourceById.get(epicSourceId);
      if (
        !outcome ||
        update.label !== outcome.featureTitle ||
        update.epicBodySha256 !== executiveEpicSource?.digest ||
        !weeklyEpicSource ||
        !executiveEpicSource ||
        canonicalJson(weeklyEpicSource) !== canonicalJson(executiveEpicSource)
      ) {
        errors.push(
          finding(
            "WEEKLY_UPDATE_EVIDENCE_INVALID",
            `A weekly update in ${String(row.title)} does not match its Epic identity, body SHA-256 from the frozen snapshot evidence, and reviewed short label.`,
            "Bind the update to one Epic in the row, retain its exact short label, and use its body SHA-256 from the frozen snapshot evidence.",
            "weekly-release",
          ),
        );
      }
      if (
        !reportSourceValid ||
        update.sourceId !== reportSource?.sourceId ||
        update.sourceDigest !== reportSource?.digest
      ) {
        errors.push(
          finding(
            "WEEKLY_REPORT_BINDING_INVALID",
            `A weekly update in ${String(row.title)} is not bound to the exact reviewed milestone report.`,
            "Rebuild the update from the self-hash-bound runtime narrative input.",
            "weekly-release",
          ),
        );
      }
    }
    const risks = Array.isArray(row.risks) ? (row.risks as Array<Record<string, unknown>>) : [];
    if (
      risks.some(
        (risk) =>
          !reportSourceValid ||
          risk.sourceId !== reportSource?.sourceId ||
          risk.sourceDigest !== reportSource?.digest,
      )
    ) {
      errors.push(
        finding(
          "WEEKLY_REPORT_BINDING_INVALID",
          `A weekly risk in ${String(row.title)} is not bound to the exact reviewed milestone report.`,
          "Rebuild the risk from the self-hash-bound runtime narrative input; do not invent risk prose.",
          "weekly-release",
        ),
      );
    }
  }
  if (
    weeklyMilestoneIndexes.some(
      (milestoneIndex, index) => index > 0 && milestoneIndex <= weeklyMilestoneIndexes[index - 1],
    )
  ) {
    errors.push(
      finding(
        "WEEKLY_MILESTONE_ORDER_INVALID",
        "Weekly milestone rows do not preserve the roadmap milestone order.",
        "Keep the selected weekly rows in the same relative order as the roadmap.",
        "weekly-release",
      ),
    );
  }

  const weeklyMetrics = Array.isArray(weekly?.metrics)
    ? (weekly.metrics as Array<Record<string, unknown>>)
    : [];
  const expectedMetricIds = [
    "metric.forks",
    "metric.latest-release",
    "metric.merged-prs",
    "metric.stars",
    "metric.vdr-uat",
  ];
  const actualMetricIds = weeklyMetrics.map((metric) => String(metric.contentId ?? "")).sort();
  if (canonicalJson(actualMetricIds) !== canonicalJson(expectedMetricIds)) {
    errors.push(
      finding(
        "WEEKLY_METRIC_SET_INVALID",
        "The weekly scorecard does not retain the exact five top metrics.",
        "Restore Stars, Forks, Merged PRs, VDR/UAT issues, and Latest stable release exactly once.",
        "weekly-release",
      ),
    );
  }
  const latestReleaseMetric = weeklyMetrics.find(
    (metric) => metric.contentId === "metric.latest-release",
  );
  if (
    latestReleaseMetric?.label !== "Latest stable release" ||
    typeof latestReleaseMetric.value !== "string" ||
    !/^v\d+\.\d+\.\d+$/u.test(latestReleaseMetric.value)
  ) {
    errors.push(
      finding(
        "WEEKLY_LATEST_RELEASE_INVALID",
        "The weekly scorecard does not retain one exact latest stable release metric.",
        "Restore the Latest stable release label and exact stable-semver tag.",
        "weekly-release",
      ),
    );
  }
  const announcementSourceCount = weeklySources.filter((source) =>
    /^github\.announcement\./u.test(String(source.sourceId ?? "")),
  ).length;
  const exactReleaseContext =
    announcementSourceCount === 0
      ? `No stable release this window. Latest: ${String(latestReleaseMetric?.value ?? "")}.`
      : `${announcementSourceCount} stable ${announcementSourceCount === 1 ? "release" : "releases"} this window.`;
  const partialReleaseContext =
    typeof weekly?.releaseContext === "string"
      ? /^(\d+) stable; (\d+) validated Announcements\.$/u.exec(weekly.releaseContext)
      : null;
  const partialReleaseContextValid =
    partialReleaseContext !== null &&
    Number(partialReleaseContext[1]) > announcementSourceCount &&
    Number(partialReleaseContext[2]) === announcementSourceCount;
  if (weekly?.releaseContext !== exactReleaseContext && !partialReleaseContextValid) {
    errors.push(
      finding(
        "RELEASE_CONTEXT_INVALID",
        "The weekly release context does not match its retained in-window Announcement evidence.",
        "Rebuild the release context from the frozen release and Announcement sources.",
        "weekly-release",
      ),
    );
  }

  return errors;
}

function publicationInvariantFindings(model: Record<string, unknown>): ValidationFinding[] {
  const slides = Array.isArray(model.slides)
    ? (model.slides as Array<Record<string, unknown>>)
    : [];
  const unclassified = slides
    .filter((slide) => slide.role === "roadmap-capability")
    .flatMap((slide) => (Array.isArray(slide.unclassified) ? slide.unclassified : []));
  return unclassified.length === 0
    ? []
    : [
        finding(
          "UNCLASSIFIED_EPICS_PRESENT",
          "Publication requires every selected Epic to have an approved presentation classification.",
          "Add each missing roadmap area to the owner-only runtime presentation map, then rebuild the model.",
          "roadmap-capability",
        ),
      ];
}

export function validateSlideModel(
  value: unknown,
  schema: unknown,
  mode: ValidationMode = "preview",
): ValidationResult {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: {
      "date-time": { type: "string", validate: validDateTime },
      uri: { type: "string", validate: validUri },
    },
  });
  const validate = ajv.compile(schema as object);
  const schemaValid = validate(value);
  const schemaErrors = schemaValid ? [] : (validate.errors ?? []).map(ajvFinding);
  let calculatedHash: string | null = null;
  let invariantErrors: ValidationFinding[] = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    try {
      calculatedHash = calculateModelSha256(value);
      invariantErrors = structuralFindings(value as Record<string, unknown>, calculatedHash);
      if (mode === "publish") {
        invariantErrors.push(...publicationInvariantFindings(value as Record<string, unknown>));
      }
    } catch (error) {
      if (schemaValid) throw error;
      calculatedHash = null;
      invariantErrors = [];
    }
  }
  const errors = [...schemaErrors, ...invariantErrors];
  const publication =
    value && typeof value === "object" && !Array.isArray(value)
      ? ((value as Record<string, unknown>).publication as Record<string, unknown> | undefined)
      : undefined;
  const publicationEligible = errors.length === 0 && publication?.eligible === true;
  if (mode === "publish" && !publicationEligible) {
    const alreadyReported = errors.some((error) => error.code === "PUBLICATION_BLOCKED");
    if (!alreadyReported) {
      errors.push(
        finding(
          "PUBLICATION_BLOCKED",
          "The model is not eligible for publication.",
          "Resolve every source, density, template, and parity blocker, then rebuild the model.",
        ),
      );
    }
  }
  return {
    valid: errors.length === 0,
    mode,
    modelSha256: calculatedHash,
    errors,
    publicationEligible,
  };
}

type CliOptions = {
  model?: string;
  schema?: string;
  mode: ValidationMode;
  output?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mode: "preview" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--model" && next) {
      options.model = next;
      index += 1;
    } else if (argument === "--schema" && next) {
      options.schema = next;
      index += 1;
    } else if (argument === "--mode" && (next === "preview" || next === "publish")) {
      options.mode = next;
      index += 1;
    } else if (argument === "--output" && next) {
      options.output = next;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node --import tsx validate-slide-model.mts --model PATH --schema PATH [--mode preview|publish] [--output PATH]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.model || !options.schema) {
    throw new Error("--model and --schema are required");
  }
  const model = JSON.parse(readFileSync(path.resolve(options.model), "utf8"));
  const schema = JSON.parse(readFileSync(path.resolve(options.schema), "utf8"));
  const result = validateSlideModel(model, schema, options.mode);
  const output = canonicalJson(result);
  if (options.output) {
    writeProtectedOutput(options.output, output, {
      artifactName: "Slide model validation evidence",
    });
  } else {
    process.stdout.write(output);
  }
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
