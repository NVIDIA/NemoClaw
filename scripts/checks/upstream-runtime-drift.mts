// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_ISSUE_BODY_LENGTH = 65_536;
const MAX_ISSUE_TITLE_LENGTH = 256;
const NUMERIC_VERSION_RE = /^[0-9]+(?:\.[0-9]+){2}(?:-[0-9]+)?$/u;
const CALVER_TAG_RE = /^v[0-9]+(?:\.[0-9]+){2,3}$/u;
const NEMOCLAW_ISSUE_URL_RE = /^https:\/\/github\.com\/NVIDIA\/NemoClaw\/issues\/([1-9][0-9]*)$/u;
const UPGRADE_FIX_EVIDENCE_RE =
  /\b(?:fix(?:ed|es)?|resolv(?:ed|es)?|address(?:ed|es)?)\b.{0,100}\b(?:by|in|after|with)\b.{0,80}\b(?:upgrad(?:e|ing)|updat(?:e|ing)|v?[0-9]+\.[0-9]+\.[0-9]+)\b|\b(?:upgrad(?:e|ing)|updat(?:e|ing))\b.{0,100}\b(?:fix(?:ed|es)?|resolv(?:ed|es)?|address(?:ed|es)?)\b/isu;
const UPDATE_GATE_TITLE_RE = /\b(?:compatib\w*|pin|updat\w*|upgrad\w*|version)\b/iu;

const UPSTREAM_URLS = {
  deepAgentsCode: "https://pypi.org/pypi/deepagents-code/json",
  hermesPackage: "https://registry.npmjs.org/hermes-agent/latest",
  hermesReleases: "https://api.github.com/repos/NousResearch/hermes-agent/releases?per_page=100",
  nemoclawCompatibilityIssue: "https://api.github.com/repos/NVIDIA/NemoClaw/issues/6691",
  nemoclawRecommendedBlockers:
    "https://api.github.com/search/issues?q=repo%3ANVIDIA%2FNemoClaw+is%3Aissue+is%3Aopen+label%3A%22Recommended+Blocker%22&per_page=100",
  nemoclawUnblockers:
    "https://api.github.com/search/issues?q=repo%3ANVIDIA%2FNemoClaw+is%3Aissue+is%3Aopen+label%3A%22needs%3A+unblock%22&per_page=100",
  openclaw: "https://registry.npmjs.org/openclaw",
  openshell: "https://api.github.com/repos/NVIDIA/OpenShell/releases?per_page=100",
} as const;

export const DRIFT_BUDGETS = {
  deepAgentsCode: { maxDays: 14, maxReleases: 5 },
  hermes: { maxDays: 7, maxReleases: 1 },
  openclaw: { maxDays: 7, maxReleases: 1 },
  openshell: { maxDays: 7, maxReleases: 1 },
} as const;

export type RuntimePins = Readonly<{
  deepAgentsCode: string;
  hermes: Readonly<{ tag: string; version: string }>;
  openclaw: string;
  openshell: Readonly<{ maximum: string; minimum: string }>;
}>;

export type SourceResult = Readonly<{ data: unknown } | { error: string }>;

export type UpstreamResponses = Readonly<{
  deepAgentsCode: SourceResult;
  hermesPackage: SourceResult;
  hermesReleases: SourceResult;
  nemoclawCompatibilityIssue: SourceResult;
  nemoclawRecommendedBlockers: SourceResult;
  nemoclawUnblockers: SourceResult;
  openclaw: SourceResult;
  openshell: SourceResult;
}>;

export type DriftStatus = "current" | "overdue" | "review" | "unknown";

export type PriorityReason = "investigate" | "monitor" | "stability" | "updateness" | "validation";

export type BlockerRelationship = "related" | "update-fix" | "update-gate";

export type BlockerEvidence = Readonly<{
  issue: number;
  relationship: BlockerRelationship;
  title: string;
  url: string;
}>;

type ComponentSnapshot = Readonly<{
  caveat: string;
  component: string;
  daysBehind?: number;
  latestUpstream: string;
  nemoclawPin: string;
  releasesBehind?: number;
  status: DriftStatus;
}>;

export type ComponentDrift = ComponentSnapshot &
  Readonly<{
    blockers: readonly BlockerEvidence[];
    priority: PriorityReason;
    recommendation: string;
  }>;

type CompatibilityEvidence = Readonly<{
  issue: number;
  state: "closed" | "open" | "unknown";
  title: string;
  url: string;
}>;

export type RuntimeDriftReport = Readonly<{
  blockerEvidenceComplete: boolean;
  compatibilityEvidence: CompatibilityEvidence;
  components: readonly ComponentDrift[];
  evidenceNotes: readonly string[];
  generatedAt: string;
  nemoclawSha: string;
  priorityTotals: Readonly<Record<PriorityReason, number>>;
  schemaVersion: 2;
  totals: Readonly<Record<DriftStatus, number>>;
  verdict: string;
}>;

type ReleasePoint = Readonly<{ publishedAt: Date; version: string }>;
type ReleaseHistory = Readonly<{ latest: string; releases: readonly ReleasePoint[] }>;
type DriftBudget = Readonly<{ maxDays: number; maxReleases: number }>;
type NemoClawIssue = Readonly<{
  body: string;
  labels: readonly string[];
  number: number;
  title: string;
  url: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 180);
}

function readText(rootDir: string, relativePath: string): string {
  try {
    return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  } catch (error) {
    throw new Error(`${relativePath}: failed to read (${safeError(error)})`);
  }
}

function extractSingle(source: string, pattern: RegExp, label: string): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`${label}: expected exactly one version`);
  }
  return matches[0][1];
}

function requireNumericVersion(version: string, label: string): string {
  if (!NUMERIC_VERSION_RE.test(version)) {
    throw new Error(`${label}: expected a numeric stable version`);
  }
  return version;
}

function requireCalverTag(tag: string, label: string): string {
  if (!CALVER_TAG_RE.test(tag)) {
    throw new Error(`${label}: expected a numeric CalVer release tag`);
  }
  return tag;
}

export function readRuntimePins(rootDir: string = REPO_ROOT): RuntimePins {
  const blueprint = readText(rootDir, "nemoclaw-blueprint/blueprint.yaml");
  const openclawDockerfile = readText(rootDir, "Dockerfile.base");
  const hermesDockerfile = readText(rootDir, "agents/hermes/Dockerfile.base");
  const deepAgentsRequirements = readText(
    rootDir,
    "agents/langchain-deepagents-code/requirements.in",
  );

  return {
    openshell: {
      minimum: requireNumericVersion(
        extractSingle(
          blueprint,
          /^min_openshell_version:\s*["']?([^"'#\s]+)["']?\s*$/gmu,
          "nemoclaw-blueprint/blueprint.yaml min_openshell_version",
        ),
        "OpenShell minimum version",
      ),
      maximum: requireNumericVersion(
        extractSingle(
          blueprint,
          /^max_openshell_version:\s*["']?([^"'#\s]+)["']?\s*$/gmu,
          "nemoclaw-blueprint/blueprint.yaml max_openshell_version",
        ),
        "OpenShell maximum version",
      ),
    },
    openclaw: requireNumericVersion(
      extractSingle(
        openclawDockerfile,
        /^ARG\s+OPENCLAW_VERSION=([^\s]+)\s*$/gmu,
        "Dockerfile.base OPENCLAW_VERSION",
      ),
      "OpenClaw version",
    ),
    hermes: {
      tag: requireCalverTag(
        extractSingle(
          hermesDockerfile,
          /^ARG\s+HERMES_VERSION=([^\s]+)\s*$/gmu,
          "agents/hermes/Dockerfile.base HERMES_VERSION",
        ),
        "Hermes release tag",
      ),
      version: requireNumericVersion(
        extractSingle(
          hermesDockerfile,
          /^ARG\s+HERMES_SEMVER=([^\s]+)\s*$/gmu,
          "agents/hermes/Dockerfile.base HERMES_SEMVER",
        ),
        "Hermes package version",
      ),
    },
    deepAgentsCode: requireNumericVersion(
      extractSingle(
        deepAgentsRequirements,
        /^deepagents-code(?:\[[^\]]+\])?==([^\s]+)\s*$/gmu,
        "agents/langchain-deepagents-code/requirements.in deepagents-code",
      ),
      "Deep Agents Code version",
    ),
  };
}

function recordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`${label}: expected ${key} mapping`);
  return value;
}

function stringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}: expected ${key} string`);
  }
  return value;
}

function parsePublishedAt(value: unknown, label: string): Date {
  if (typeof value !== "string") throw new Error(`${label}: expected publication timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}: invalid publication timestamp`);
  return date;
}

function numericParts(version: string): number[] {
  const normalized = version.startsWith("v") ? version.slice(1) : version;
  return normalized.split(/[.-]/u).map((part) => Number.parseInt(part, 10));
}

function compareNumericVersions(left: string, right: string): number {
  const leftParts = numericParts(left);
  const rightParts = numericParts(right);
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function githubReleaseHistory(data: unknown, label: string, tagPattern: RegExp): ReleaseHistory {
  if (!Array.isArray(data)) throw new Error(`${label}: expected release array`);
  const releases = data
    .filter(isRecord)
    .filter((release) => release.draft === false && release.prerelease === false)
    .map((release, index) => {
      const tag = stringField(release, "tag_name", label);
      if (!tagPattern.test(tag)) throw new Error(`${label}: release ${index} has invalid tag`);
      return {
        version: tag,
        publishedAt: parsePublishedAt(release.published_at, `${label} ${tag}`),
      };
    })
    .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime());
  if (releases.length === 0) throw new Error(`${label}: no stable releases`);
  return { latest: releases[0].version, releases };
}

function npmReleaseHistory(data: unknown): ReleaseHistory {
  if (!isRecord(data)) throw new Error("OpenClaw registry: expected package mapping");
  const latest = requireNumericVersion(
    stringField(recordField(data, "dist-tags", "OpenClaw registry"), "latest", "OpenClaw registry"),
    "OpenClaw latest version",
  );
  const times = recordField(data, "time", "OpenClaw registry");
  const releases = Object.entries(times)
    .filter(([version]) => NUMERIC_VERSION_RE.test(version))
    .map(([version, publishedAt]) => ({
      version,
      publishedAt: parsePublishedAt(publishedAt, `OpenClaw ${version}`),
    }));
  if (!releases.some((release) => release.version === latest)) {
    throw new Error("OpenClaw registry: latest version has no publication timestamp");
  }
  return { latest, releases };
}

function pypiReleaseHistory(data: unknown): ReleaseHistory {
  if (!isRecord(data)) throw new Error("Deep Agents Code registry: expected package mapping");
  const latest = requireNumericVersion(
    stringField(
      recordField(data, "info", "Deep Agents Code registry"),
      "version",
      "Deep Agents Code registry",
    ),
    "Deep Agents Code latest version",
  );
  const releaseMapping = recordField(data, "releases", "Deep Agents Code registry");
  const releases = Object.entries(releaseMapping)
    .filter(([version]) => NUMERIC_VERSION_RE.test(version))
    .flatMap(([version, files]) => {
      if (!Array.isArray(files) || files.length === 0) return [];
      const dates = files
        .filter(isRecord)
        .map((file) => parsePublishedAt(file.upload_time_iso_8601, `Deep Agents Code ${version}`))
        .sort((left, right) => left.getTime() - right.getTime());
      return dates[0] ? [{ version, publishedAt: dates[0] }] : [];
    });
  if (!releases.some((release) => release.version === latest)) {
    throw new Error("Deep Agents Code registry: latest version has no publication timestamp");
  }
  return { latest, releases };
}

function sourceData(source: SourceResult, label: string): unknown {
  if ("error" in source) throw new Error(`${label}: ${source.error}`);
  return source.data;
}

function assessDrift(
  pin: string,
  history: ReleaseHistory,
  budget: DriftBudget,
  now: Date,
): Pick<ComponentSnapshot, "daysBehind" | "releasesBehind" | "status"> {
  if (pin === history.latest) return { status: "current" };
  if (compareNumericVersions(history.latest, pin) <= 0) return { status: "unknown" };
  const pinRelease = history.releases.find((release) => release.version === pin);
  if (!pinRelease) return { status: "unknown" };

  const newerReleases = history.releases.filter(
    (release) =>
      compareNumericVersions(release.version, pin) > 0 &&
      compareNumericVersions(release.version, history.latest) <= 0,
  );
  if (newerReleases.length === 0) return { status: "unknown" };
  const firstNewerAt = Math.min(...newerReleases.map((release) => release.publishedAt.getTime()));
  const daysBehind = Math.max(0, Math.floor((now.getTime() - firstNewerAt) / DAY_MS));
  const status =
    newerReleases.length > budget.maxReleases || daysBehind > budget.maxDays ? "overdue" : "review";
  return { daysBehind, releasesBehind: newerReleases.length, status };
}

function statusText(
  assessment: Pick<ComponentSnapshot, "daysBehind" | "releasesBehind" | "status">,
  budget: DriftBudget,
): string {
  if (assessment.status === "current") return "NemoClaw matches the latest stable release.";
  if (assessment.status === "unknown") return "The advisory drift threshold could not be assessed.";
  const releases = assessment.releasesBehind ?? 0;
  const days = assessment.daysBehind ?? 0;
  return (
    `${releases} stable ${releases === 1 ? "release" : "releases"} and ` +
    `${days} ${days === 1 ? "day" : "days"} behind. ` +
    `The advisory threshold is more than ${budget.maxReleases} ` +
    `${budget.maxReleases === 1 ? "release" : "releases"} or ${budget.maxDays} days.`
  );
}

function unknownComponent(
  component: string,
  nemoclawPin: string,
  baseCaveat: string,
  error: unknown,
): ComponentSnapshot {
  return {
    component,
    latestUpstream: "unknown",
    nemoclawPin,
    status: "unknown",
    caveat: `${baseCaveat} Upstream metadata was unavailable: ${safeError(error)}`,
  };
}

function componentFromHistory(options: {
  baseCaveat: string;
  budget: DriftBudget;
  component: string;
  history: ReleaseHistory;
  now: Date;
  pin: string;
}): ComponentSnapshot {
  const assessment = assessDrift(options.pin, options.history, options.budget, options.now);
  return {
    component: options.component,
    latestUpstream: options.history.latest.replace(/^v/u, ""),
    nemoclawPin: options.pin.replace(/^v/u, ""),
    ...assessment,
    caveat: `${options.baseCaveat} ${statusText(assessment, options.budget)}`,
  };
}

function buildOpenShell(
  pins: RuntimePins,
  responses: UpstreamResponses,
  now: Date,
): ComponentSnapshot {
  const pin = pins.openshell.maximum;
  const rangeCaveat =
    pins.openshell.minimum === pins.openshell.maximum
      ? `The compatibility range deliberately sets min=max=${pin}.`
      : `The compatibility range is ${pins.openshell.minimum} through ${pin}.`;
  try {
    return componentFromHistory({
      baseCaveat: `${rangeCaveat} A newer release requires compatibility review.`,
      budget: DRIFT_BUDGETS.openshell,
      component: "OpenShell",
      history: githubReleaseHistory(
        sourceData(responses.openshell, "OpenShell releases"),
        "OpenShell releases",
        /^v[0-9]+(?:\.[0-9]+){2}$/u,
      ),
      now,
      pin: `v${pin}`,
    });
  } catch (error) {
    return unknownComponent("OpenShell", pin, rangeCaveat, error);
  }
}

function buildOpenClaw(
  pins: RuntimePins,
  responses: UpstreamResponses,
  now: Date,
): ComponentSnapshot {
  const caveat =
    "The exact npm package and integrity are reviewed; the latest release is only an upgrade signal.";
  try {
    return componentFromHistory({
      baseCaveat: caveat,
      budget: DRIFT_BUDGETS.openclaw,
      component: "OpenClaw",
      history: npmReleaseHistory(sourceData(responses.openclaw, "OpenClaw registry")),
      now,
      pin: pins.openclaw,
    });
  } catch (error) {
    return unknownComponent("OpenClaw", pins.openclaw, caveat, error);
  }
}

function buildHermes(
  pins: RuntimePins,
  responses: UpstreamResponses,
  now: Date,
): ComponentSnapshot {
  const caveat = "The CalVer release tag and package version are reviewed as one mapping.";
  const nemoclawPin = `${pins.hermes.version} (${pins.hermes.tag})`;
  try {
    const history = githubReleaseHistory(
      sourceData(responses.hermesReleases, "Hermes releases"),
      "Hermes releases",
      CALVER_TAG_RE,
    );
    const packageData = sourceData(responses.hermesPackage, "Hermes registry");
    if (!isRecord(packageData)) throw new Error("Hermes registry: expected package mapping");
    const latestPackage = requireNumericVersion(
      stringField(packageData, "version", "Hermes registry"),
      "Hermes latest package version",
    );
    const assessment = assessDrift(pins.hermes.tag, history, DRIFT_BUDGETS.hermes, now);
    const mappingMatches =
      (assessment.status === "current") === (latestPackage === pins.hermes.version);
    const finalAssessment = mappingMatches ? assessment : { status: "unknown" as const };
    return {
      component: "Hermes",
      latestUpstream: `${latestPackage} (${history.latest})`,
      nemoclawPin,
      ...finalAssessment,
      caveat: `${caveat} ${statusText(finalAssessment, DRIFT_BUDGETS.hermes)}`,
    };
  } catch (error) {
    return unknownComponent("Hermes", nemoclawPin, caveat, error);
  }
}

function buildDeepAgentsCode(
  pins: RuntimePins,
  responses: UpstreamResponses,
  now: Date,
): ComponentSnapshot {
  const caveat =
    "The exact package is hash-locked; an upgrade requires dependency and compatibility review.";
  try {
    return componentFromHistory({
      baseCaveat: caveat,
      budget: DRIFT_BUDGETS.deepAgentsCode,
      component: "LangChain Deep Agents Code",
      history: pypiReleaseHistory(
        sourceData(responses.deepAgentsCode, "Deep Agents Code registry"),
      ),
      now,
      pin: pins.deepAgentsCode,
    });
  } catch (error) {
    return unknownComponent("LangChain Deep Agents Code", pins.deepAgentsCode, caveat, error);
  }
}

function parseNemoClawIssue(value: unknown, label: string): NemoClawIssue {
  if (!isRecord(value)) throw new Error(`${label}: expected issue mapping`);
  const number = value.number;
  const title = value.title;
  const url = value.html_url;
  const body = value.body;
  const labels = value.labels;
  if (!Number.isSafeInteger(number) || (number as number) <= 0) {
    throw new Error(`${label}: expected positive issue number`);
  }
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    title.length > MAX_ISSUE_TITLE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(title)
  ) {
    throw new Error(`${label}: invalid issue title`);
  }
  if (typeof url !== "string") throw new Error(`${label}: invalid issue URL`);
  const urlMatch = NEMOCLAW_ISSUE_URL_RE.exec(url);
  if (!urlMatch || Number.parseInt(urlMatch[1] ?? "", 10) !== number) {
    throw new Error(`${label}: invalid issue URL`);
  }
  if (body !== null && (typeof body !== "string" || body.length > MAX_ISSUE_BODY_LENGTH)) {
    throw new Error(`${label}: invalid issue body`);
  }
  if (!Array.isArray(labels)) throw new Error(`${label}: expected labels array`);
  const labelNames = labels.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${label}: label ${index} must be a mapping`);
    const name = entry.name;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(name)
    ) {
      throw new Error(`${label}: invalid label ${index}`);
    }
    return name;
  });
  return {
    body: typeof body === "string" ? body : "",
    labels: labelNames,
    number: number as number,
    title,
    url,
  };
}

function parseIssueSearch(source: SourceResult, label: string): NemoClawIssue[] {
  const data = sourceData(source, label);
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new Error(`${label}: expected search result items`);
  }
  return data.items.map((issue, index) => parseNemoClawIssue(issue, `${label} item ${index}`));
}

function issueMatchesComponent(issue: NemoClawIssue, component: string): boolean {
  const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
  if (component === "OpenShell") return /\bopenshell\b/iu.test(issue.title);
  if (component === "OpenClaw") {
    return labels.has("integration: openclaw") || /\bopenclaw\b/iu.test(issue.title);
  }
  if (component === "Hermes") {
    return labels.has("integration: hermes") || /\bhermes\b/iu.test(issue.title);
  }
  return (
    labels.has("integration: dcode") ||
    /\b(?:dcode|deep agents(?: code)?|deepagents-code)\b/iu.test(issue.title)
  );
}

function blockerRelationship(issue: NemoClawIssue): BlockerRelationship {
  const searchable = `${issue.title}\n${issue.body}`;
  if (UPGRADE_FIX_EVIDENCE_RE.test(searchable)) return "update-fix";
  if (UPDATE_GATE_TITLE_RE.test(issue.title)) return "update-gate";
  return "related";
}

function relationshipRank(relationship: BlockerRelationship): number {
  if (relationship === "update-fix") return 0;
  if (relationship === "update-gate") return 1;
  return 2;
}

function collectBlockerIssues(responses: UpstreamResponses): {
  complete: boolean;
  issues: readonly NemoClawIssue[];
  notes: readonly string[];
} {
  const notes: string[] = [];
  const issues = new Map<number, NemoClawIssue>();
  for (const [label, source] of [
    ["Recommended Blocker issues", responses.nemoclawRecommendedBlockers],
    ["needs: unblock issues", responses.nemoclawUnblockers],
  ] as const) {
    try {
      for (const issue of parseIssueSearch(source, label)) issues.set(issue.number, issue);
    } catch (error) {
      notes.push(`${label} were unavailable: ${safeError(error)}`);
    }
  }
  return {
    complete: notes.length === 0,
    issues: [...issues.values()],
    notes,
  };
}

function compatibilityEvidence(source: SourceResult): {
  evidence: CompatibilityEvidence;
  note?: string;
} {
  const fallback: CompatibilityEvidence = {
    issue: 6691,
    state: "unknown",
    title: "Candidate compatibility evidence path",
    url: "https://github.com/NVIDIA/NemoClaw/issues/6691",
  };
  try {
    const data = sourceData(source, "Candidate compatibility issue");
    const issue = parseNemoClawIssue(data, "Candidate compatibility issue");
    if (issue.number !== 6691) throw new Error("Candidate compatibility issue: wrong issue number");
    if (!isRecord(data) || (data.state !== "open" && data.state !== "closed")) {
      throw new Error("Candidate compatibility issue: invalid state");
    }
    return {
      evidence: {
        issue: issue.number,
        state: data.state,
        title: issue.title,
        url: issue.url,
      },
    };
  } catch (error) {
    return {
      evidence: fallback,
      note: `Candidate compatibility status was unavailable: ${safeError(error)}`,
    };
  }
}

function priorityRecommendation(
  snapshot: ComponentSnapshot,
  blockers: readonly BlockerEvidence[],
  priority: PriorityReason,
): string {
  const issueNumbers = blockers.map((blocker) => `#${blocker.issue}`).join(", ");
  if (priority === "stability") {
    return (
      `${issueNumbers} reports that an upstream update fixes a blocker. ` +
      "Confirm the exact target release, then run the semantic dependency review and candidate tests."
    );
  }
  if (priority === "validation") {
    return (
      `${issueNumbers} is an update-specific compatibility or version gate. ` +
      "Resolve it or record an explicit maintainer disposition before changing the pin."
    );
  }
  if (priority === "updateness") {
    const blockerContext =
      blockers.length > 0
        ? `${issueNumbers} are component blockers, but none says a dependency update fixes them. `
        : "No open labeled blocker says a dependency update fixes a NemoClaw blocker. ";
    return (
      blockerContext +
      "Treat this as updateness: review release notes and validate the candidate after stability work."
    );
  }
  if (priority === "monitor") {
    return "The tracked pin is current; monitor upstream and open blocker evidence.";
  }
  return snapshot.status === "unknown"
    ? "Fetch upstream metadata again before making a version decision."
    : "Collect complete blocker evidence before deciding whether this is stability or updateness.";
}

function prioritizeComponent(
  snapshot: ComponentSnapshot,
  issues: readonly NemoClawIssue[],
  evidenceComplete: boolean,
): ComponentDrift {
  const blockers = issues
    .filter((issue) => issueMatchesComponent(issue, snapshot.component))
    .map(
      (issue): BlockerEvidence => ({
        issue: issue.number,
        relationship: blockerRelationship(issue),
        title: issue.title,
        url: issue.url,
      }),
    )
    .sort(
      (left, right) =>
        relationshipRank(left.relationship) - relationshipRank(right.relationship) ||
        right.issue - left.issue,
    )
    .slice(0, 3);

  let priority: PriorityReason;
  if (snapshot.status === "current") priority = "monitor";
  else if (snapshot.status === "unknown") priority = "investigate";
  else if (blockers.some((blocker) => blocker.relationship === "update-fix")) {
    priority = "stability";
  } else if (blockers.some((blocker) => blocker.relationship === "update-gate")) {
    priority = "validation";
  } else if (!evidenceComplete) priority = "investigate";
  else priority = "updateness";

  return {
    ...snapshot,
    blockers,
    priority,
    recommendation: priorityRecommendation(snapshot, blockers, priority),
  };
}

function reportVerdict(
  totals: Readonly<Record<DriftStatus, number>>,
  priorityTotals: Readonly<Record<PriorityReason, number>>,
): string {
  if (priorityTotals.stability > 0) {
    return "🚨 Vibe check: upstream brought receipts—stability upgrades cut the line tonight.";
  }
  if (priorityTotals.validation > 0) {
    return "🛡️ Vibe check: the pins are giving vintage, but a safety gate says “not so fast.”";
  }
  if (totals.overdue > 0) {
    return "🧯 Vibe check: the pins are giving vintage; no blocker has upgrade receipts, so this is maintenance—not a fire drill.";
  }
  if (priorityTotals.investigate > 0) {
    return "🕵️ Vibe check: the signal is being mysterious; verify the receipts before touching pins.";
  }
  if (totals.review > 0) {
    return "👀 Vibe check: tiny drift, big main-character energy—review it before it snowballs.";
  }
  return "✨ Vibe check: immaculate pin energy—everything tracked is current.";
}

export function createRuntimeDriftReport(options: {
  generatedAt: Date;
  nemoclawSha: string;
  pins: RuntimePins;
  responses: UpstreamResponses;
}): RuntimeDriftReport {
  if (!/^[0-9a-f]{40}$/u.test(options.nemoclawSha)) {
    throw new Error("NemoClaw SHA must be a full lowercase commit SHA");
  }
  const snapshots = [
    buildOpenShell(options.pins, options.responses, options.generatedAt),
    buildOpenClaw(options.pins, options.responses, options.generatedAt),
    buildHermes(options.pins, options.responses, options.generatedAt),
    buildDeepAgentsCode(options.pins, options.responses, options.generatedAt),
  ];
  const blockerCollection = collectBlockerIssues(options.responses);
  const compatibility = compatibilityEvidence(options.responses.nemoclawCompatibilityIssue);
  const evidenceNotes = [...blockerCollection.notes];
  if (compatibility.note) evidenceNotes.push(compatibility.note);
  const components = snapshots.map((snapshot) =>
    prioritizeComponent(snapshot, blockerCollection.issues, blockerCollection.complete),
  );
  const totals: Record<DriftStatus, number> = {
    current: 0,
    overdue: 0,
    review: 0,
    unknown: 0,
  };
  const priorityTotals: Record<PriorityReason, number> = {
    investigate: 0,
    monitor: 0,
    stability: 0,
    updateness: 0,
    validation: 0,
  };
  for (const component of components) {
    totals[component.status] += 1;
    priorityTotals[component.priority] += 1;
  }
  return {
    schemaVersion: 2,
    generatedAt: options.generatedAt.toISOString(),
    blockerEvidenceComplete: blockerCollection.complete,
    compatibilityEvidence: compatibility.evidence,
    components,
    evidenceNotes,
    nemoclawSha: options.nemoclawSha,
    priorityTotals,
    totals,
    verdict: reportVerdict(totals, priorityTotals),
  };
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").trim();
}

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll(/([\\[\]*_`])/gu, "\\$1")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function statusIcon(status: DriftStatus): string {
  if (status === "current") return "✅";
  if (status === "review") return "🟡";
  if (status === "overdue") return "🔴";
  return "⚠️";
}

function priorityIcon(priority: PriorityReason): string {
  if (priority === "stability") return "🚨";
  if (priority === "validation") return "🛡️";
  if (priority === "updateness") return "🆕";
  if (priority === "monitor") return "✅";
  return "🕵️";
}

function priorityLabel(priority: PriorityReason): string {
  if (priority === "stability") return "Stability required";
  if (priority === "validation") return "Validation gate";
  if (priority === "updateness") return "Updateness";
  if (priority === "monitor") return "Monitor";
  return "Investigate";
}

function priorityRank(priority: PriorityReason): number {
  if (priority === "stability") return 0;
  if (priority === "validation") return 1;
  if (priority === "investigate") return 2;
  if (priority === "updateness") return 3;
  return 4;
}

function priorityWhy(component: ComponentDrift): string {
  if (component.priority === "stability") {
    return "An open blocker explicitly reports an upstream update as its fix.";
  }
  if (component.priority === "validation") {
    return "An open blocker describes a version or compatibility gate for this update.";
  }
  if (component.priority === "updateness") {
    return "The pin has drifted, but no labeled blocker says this update fixes it.";
  }
  if (component.priority === "monitor") return "The tracked pin is current.";
  return component.status === "unknown"
    ? "Upstream version metadata is incomplete."
    : "GitHub blocker evidence is incomplete.";
}

function relationshipText(relationship: BlockerRelationship): string {
  if (relationship === "update-fix") return "issue-reported update fix";
  if (relationship === "update-gate") return "update validation gate";
  return "component blocker; no update-fix evidence";
}

export function renderMarkdownReport(report: RuntimeDriftReport): string {
  const inventoryRows = report.components.map(
    (component) =>
      `| ${component.component} | ${component.latestUpstream} | ${component.nemoclawPin} | ` +
      `${statusIcon(component.status)} ${escapeMarkdownCell(component.caveat)} |`,
  );
  const priorityRows = [...report.components]
    .sort(
      (left, right) =>
        priorityRank(left.priority) - priorityRank(right.priority) ||
        left.component.localeCompare(right.component),
    )
    .map(
      (component) =>
        `| ${priorityIcon(component.priority)} ${priorityLabel(component.priority)} | ` +
        `${component.component} | ${escapeMarkdownCell(priorityWhy(component))} | ` +
        `${escapeMarkdownCell(component.recommendation)} |`,
    );
  const blockerLines = report.components.flatMap((component) =>
    component.blockers.map(
      (blocker) =>
        `- **${component.component}:** ` +
        `[#${blocker.issue} — ${escapeMarkdownText(blocker.title)}](${blocker.url}) — ` +
        `${relationshipText(blocker.relationship)}.`,
    ),
  );
  const compatibility = report.compatibilityEvidence;
  const compatibilityText =
    compatibility.state === "open"
      ? `The candidate compatibility path [#${compatibility.issue} — ${escapeMarkdownText(
          compatibility.title,
        )}](${compatibility.url}) is still open. While issue #${compatibility.issue} remains open, use the component dependency-update ` +
        "review and existing focused/live test lanes; drift alone is not compatibility evidence."
      : compatibility.state === "closed"
        ? `Use the delivered candidate compatibility path from [#${compatibility.issue} — ` +
          `${escapeMarkdownText(compatibility.title)}](${compatibility.url}) before changing pins.`
        : `The status of candidate compatibility issue [#${compatibility.issue}](${compatibility.url}) ` +
          "could not be verified. Do not treat drift as compatibility evidence.";
  const emptyBlockerLines = report.blockerEvidenceComplete
    ? [
        "No open public GitHub issues with `Recommended Blocker` or `needs: unblock` labels match these components.",
      ]
    : [
        "Pin Diesel could not collect complete public GitHub blocker evidence. Use the evidence collection warnings below before assigning a priority.",
      ];
  const evidenceNotes =
    report.evidenceNotes.length === 0
      ? []
      : [
          "",
          "Evidence collection warnings:",
          ...report.evidenceNotes.map((note) => `- ${escapeMarkdownText(note)}`),
        ];
  return [
    `> **${report.verdict}**`,
    "",
    "# NemoClaw Pin Diesel — nightly dependency report",
    "",
    `Generated: ${report.generatedAt} from NemoClaw \`${report.nemoclawSha}\``,
    "",
    "## Tonight's priority order",
    "",
    "| Priority | Component | Why | Team action |",
    "|---|---|---|---|",
    ...priorityRows,
    "",
    "## Pin inventory",
    "",
    "| Component | Latest upstream | NemoClaw pin | Caveats |",
    "|---|---:|---:|---|",
    ...inventoryRows,
    "",
    "## Open blocker evidence",
    "",
    ...(blockerLines.length > 0 ? blockerLines : emptyBlockerLines),
    "",
    "## Compatibility evidence",
    "",
    compatibilityText,
    ...evidenceNotes,
    "",
    "## Decision limits",
    "",
    "Pin Diesel is a deterministic reporter, not an autonomous release decision-maker. Blocker matching uses open public GitHub issue labels and explicit issue text. It does not read internal NVBug state, infer that correlation is causation, change pins, or establish release readiness.",
    "",
  ].join("\n");
}

function slackStatusLine(component: ComponentDrift): string {
  const lag =
    component.releasesBehind === undefined || component.daysBehind === undefined
      ? ""
      : ` · ${component.releasesBehind} ${
          component.releasesBehind === 1 ? "release" : "releases"
        }, ${component.daysBehind} ${component.daysBehind === 1 ? "day" : "days"} behind`;
  const exactRange =
    component.component === "OpenShell" && component.nemoclawPin !== "unknown"
      ? ` · min=max=${component.nemoclawPin}`
      : "";
  return (
    `${priorityIcon(component.priority)} *${component.component}* · ` +
    `${priorityLabel(component.priority)} · \`${component.nemoclawPin}\` → ` +
    `\`${component.latestUpstream}\`${lag}${exactRange}`
  );
}

export function createSlackPayload(report: RuntimeDriftReport, runUrl?: string): object {
  const headline =
    `${report.priorityTotals.stability} stability · ` +
    `${report.priorityTotals.validation} validation · ` +
    `${report.priorityTotals.updateness} updateness`;
  const color =
    report.priorityTotals.stability > 0
      ? "#E01E5A"
      : report.priorityTotals.validation > 0 ||
          report.priorityTotals.investigate > 0 ||
          report.totals.overdue > 0
        ? "#ECB22E"
        : "#2EB67D";
  const reportDate = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(report.generatedAt));
  const blocks: object[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `${report.verdict}\n` +
          `:pushpin: *NemoClaw Pin Diesel — Nightly Dependency Vibe Check · ${reportDate} · ` +
          `\`${report.nemoclawSha.slice(0, 8)}\`*\n` +
          `:traffic_light: *Priority:* ${headline}\n${report.components
            .map(slackStatusLine)
            .join("\n")}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            "Advisory only. Open the run and download `pin-diesel-nightly-report`; " +
            "blocker links are evidence, not causal proof.",
        },
      ],
    },
  ];
  if (runUrl) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Open deep report" }, url: runUrl },
      ],
    });
  }
  return {
    text: `${report.verdict} NemoClaw Pin Diesel: ${headline}.`,
    attachments: [{ color, blocks }],
  };
}

async function fetchBoundedJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declaredSize = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (declaredSize > MAX_JSON_BYTES) throw new Error("response exceeded the size limit");
  if (!response.body) throw new Error("response body was empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new Error("response exceeded the size limit");
    }
    chunks.push(chunk.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } catch {
    throw new Error("response was not valid JSON");
  }
}

async function fetchSource(url: string, headers: Record<string, string>): Promise<SourceResult> {
  try {
    return { data: await fetchBoundedJson(url, headers) };
  } catch (error) {
    return { error: safeError(error) };
  }
}

export async function fetchUpstreamResponses(
  githubToken: string | undefined = process.env.GITHUB_TOKEN,
): Promise<UpstreamResponses> {
  const baseHeaders = { "User-Agent": "NVIDIA-NemoClaw-upstream-runtime-drift" };
  const githubHeaders = {
    ...baseHeaders,
    Accept: "application/vnd.github+json",
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const jsonHeaders = { ...baseHeaders, Accept: "application/json" };
  const [
    openshell,
    openclaw,
    hermesReleases,
    hermesPackage,
    deepAgentsCode,
    nemoclawCompatibilityIssue,
    nemoclawRecommendedBlockers,
    nemoclawUnblockers,
  ] = await Promise.all([
    fetchSource(UPSTREAM_URLS.openshell, githubHeaders),
    fetchSource(UPSTREAM_URLS.openclaw, jsonHeaders),
    fetchSource(UPSTREAM_URLS.hermesReleases, githubHeaders),
    fetchSource(UPSTREAM_URLS.hermesPackage, jsonHeaders),
    fetchSource(UPSTREAM_URLS.deepAgentsCode, jsonHeaders),
    fetchSource(UPSTREAM_URLS.nemoclawCompatibilityIssue, githubHeaders),
    fetchSource(UPSTREAM_URLS.nemoclawRecommendedBlockers, githubHeaders),
    fetchSource(UPSTREAM_URLS.nemoclawUnblockers, githubHeaders),
  ]);
  return {
    openshell,
    openclaw,
    hermesReleases,
    hermesPackage,
    deepAgentsCode,
    nemoclawCompatibilityIssue,
    nemoclawRecommendedBlockers,
    nemoclawUnblockers,
  };
}

function outputArguments(argv: readonly string[]): {
  jsonOutput: string;
  nemoclawSha: string;
  reportOutput: string;
  runUrl?: string;
  slackOutput: string;
  summaryOutput: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value)
      throw new Error("output arguments require name/value pairs");
    values.set(name, value);
  }
  const jsonOutput = values.get("--json-output");
  const nemoclawSha = values.get("--nemoclaw-sha");
  const reportOutput = values.get("--report-output");
  const slackOutput = values.get("--slack-output");
  const summaryOutput = values.get("--summary-output");
  if (!jsonOutput || !nemoclawSha || !reportOutput || !slackOutput || !summaryOutput) {
    throw new Error(
      "--json-output, --nemoclaw-sha, --report-output, --slack-output, and --summary-output are required",
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(nemoclawSha)) {
    throw new Error("--nemoclaw-sha must be a full lowercase commit SHA");
  }
  const runUrl = values.get("--run-url");
  if (runUrl && !/^https:\/\/github\.com\/NVIDIA\/NemoClaw\/actions\/runs\/[0-9]+$/u.test(runUrl)) {
    throw new Error("--run-url must identify a NemoClaw GitHub Actions run");
  }
  return { jsonOutput, nemoclawSha, reportOutput, runUrl, slackOutput, summaryOutput };
}

function writeOutput(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, contents, { encoding: "utf8", mode: 0o600 });
}

async function main(): Promise<void> {
  const outputs = outputArguments(process.argv.slice(2));
  const generatedAt = new Date();
  const report = createRuntimeDriftReport({
    generatedAt,
    nemoclawSha: outputs.nemoclawSha,
    pins: readRuntimePins(),
    responses: await fetchUpstreamResponses(),
  });
  const markdown = renderMarkdownReport(report);
  writeOutput(outputs.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
  writeOutput(
    outputs.slackOutput,
    `${JSON.stringify(createSlackPayload(report, outputs.runUrl), null, 2)}\n`,
  );
  writeOutput(outputs.reportOutput, markdown);
  writeOutput(outputs.summaryOutput, markdown);
  process.stdout.write(markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`upstream runtime drift report failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
