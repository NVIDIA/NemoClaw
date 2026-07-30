// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const NUMERIC_VERSION_RE = /^[0-9]+(?:\.[0-9]+){2}(?:-[0-9]+)?$/u;
const CALVER_TAG_RE = /^v[0-9]+(?:\.[0-9]+){2,3}$/u;

const UPSTREAM_URLS = {
  deepAgentsCode: "https://pypi.org/pypi/deepagents-code/json",
  hermesPackage: "https://registry.npmjs.org/hermes-agent/latest",
  hermesReleases: "https://api.github.com/repos/NousResearch/hermes-agent/releases?per_page=100",
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
  openclaw: SourceResult;
  openshell: SourceResult;
}>;

export type DriftStatus = "current" | "overdue" | "review" | "unknown";

export type ComponentDrift = Readonly<{
  caveat: string;
  component: string;
  daysBehind?: number;
  latestUpstream: string;
  nemoclawPin: string;
  releasesBehind?: number;
  status: DriftStatus;
}>;

export type RuntimeDriftReport = Readonly<{
  components: readonly ComponentDrift[];
  generatedAt: string;
  schemaVersion: 1;
  totals: Readonly<Record<DriftStatus, number>>;
}>;

type ReleasePoint = Readonly<{ publishedAt: Date; version: string }>;
type ReleaseHistory = Readonly<{ latest: string; releases: readonly ReleasePoint[] }>;
type DriftBudget = Readonly<{ maxDays: number; maxReleases: number }>;

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
): Pick<ComponentDrift, "daysBehind" | "releasesBehind" | "status"> {
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
  assessment: Pick<ComponentDrift, "daysBehind" | "releasesBehind" | "status">,
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
): ComponentDrift {
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
}): ComponentDrift {
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
): ComponentDrift {
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

function buildOpenClaw(pins: RuntimePins, responses: UpstreamResponses, now: Date): ComponentDrift {
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

function buildHermes(pins: RuntimePins, responses: UpstreamResponses, now: Date): ComponentDrift {
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
): ComponentDrift {
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

export function createRuntimeDriftReport(options: {
  generatedAt: Date;
  pins: RuntimePins;
  responses: UpstreamResponses;
}): RuntimeDriftReport {
  const components = [
    buildOpenShell(options.pins, options.responses, options.generatedAt),
    buildOpenClaw(options.pins, options.responses, options.generatedAt),
    buildHermes(options.pins, options.responses, options.generatedAt),
    buildDeepAgentsCode(options.pins, options.responses, options.generatedAt),
  ];
  const totals: Record<DriftStatus, number> = {
    current: 0,
    overdue: 0,
    review: 0,
    unknown: 0,
  };
  for (const component of components) totals[component.status] += 1;
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt.toISOString(),
    components,
    totals,
  };
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").trim();
}

function statusIcon(status: DriftStatus): string {
  if (status === "current") return "✅";
  if (status === "review") return "🟡";
  if (status === "overdue") return "🔴";
  return "⚠️";
}

export function renderMarkdownReport(report: RuntimeDriftReport): string {
  const rows = report.components.map(
    (component) =>
      `| ${component.component} | ${component.latestUpstream} | ${component.nemoclawPin} | ` +
      `${statusIcon(component.status)} ${escapeMarkdownCell(component.caveat)} |`,
  );
  return [
    "# Weekly upstream runtime drift",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "| Component | Latest upstream | NemoClaw pin | Caveats |",
    "|---|---:|---:|---|",
    ...rows,
    "",
    "This report is advisory. It does not change dependency pins or establish compatibility.",
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
    `*${component.component}* ${statusIcon(component.status)} ` +
    `\`${component.nemoclawPin}\` → \`${component.latestUpstream}\`${lag}${exactRange}`
  );
}

export function createSlackPayload(report: RuntimeDriftReport, runUrl?: string): object {
  const headline =
    report.totals.overdue > 0
      ? `${report.totals.overdue} threshold ${report.totals.overdue === 1 ? "breach" : "breaches"}`
      : report.totals.review > 0 || report.totals.unknown > 0
        ? `${report.totals.review} review ${
            report.totals.review === 1 ? "item" : "items"
          }, ${report.totals.unknown} unknown`
        : "all tracked runtimes are current";
  const color =
    report.totals.overdue > 0
      ? "#E01E5A"
      : report.totals.review > 0 || report.totals.unknown > 0
        ? "#ECB22E"
        : "#2EB67D";
  const blocks: object[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*NemoClaw weekly upstream drift* — ${headline}\n${report.components
          .map(slackStatusLine)
          .join("\n")}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Advisory only: review upstream changes before updating exact pins.",
        },
      ],
    },
  ];
  if (runUrl) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "View report" }, url: runUrl },
      ],
    });
  }
  return {
    text: `NemoClaw weekly upstream drift: ${headline}.`,
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
  const [openshell, openclaw, hermesReleases, hermesPackage, deepAgentsCode] = await Promise.all([
    fetchSource(UPSTREAM_URLS.openshell, githubHeaders),
    fetchSource(UPSTREAM_URLS.openclaw, jsonHeaders),
    fetchSource(UPSTREAM_URLS.hermesReleases, githubHeaders),
    fetchSource(UPSTREAM_URLS.hermesPackage, jsonHeaders),
    fetchSource(UPSTREAM_URLS.deepAgentsCode, jsonHeaders),
  ]);
  return { openshell, openclaw, hermesReleases, hermesPackage, deepAgentsCode };
}

function outputArguments(argv: readonly string[]): {
  jsonOutput: string;
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
  const slackOutput = values.get("--slack-output");
  const summaryOutput = values.get("--summary-output");
  if (!jsonOutput || !slackOutput || !summaryOutput) {
    throw new Error("--json-output, --slack-output, and --summary-output are required");
  }
  const runUrl = values.get("--run-url");
  if (runUrl && !/^https:\/\/github\.com\/NVIDIA\/NemoClaw\/actions\/runs\/[0-9]+$/u.test(runUrl)) {
    throw new Error("--run-url must identify a NemoClaw GitHub Actions run");
  }
  return { jsonOutput, runUrl, slackOutput, summaryOutput };
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
    pins: readRuntimePins(),
    responses: await fetchUpstreamResponses(),
  });
  const markdown = renderMarkdownReport(report);
  writeOutput(outputs.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
  writeOutput(
    outputs.slackOutput,
    `${JSON.stringify(createSlackPayload(report, outputs.runUrl), null, 2)}\n`,
  );
  writeOutput(outputs.summaryOutput, markdown);
  process.stdout.write(markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`upstream runtime drift report failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
