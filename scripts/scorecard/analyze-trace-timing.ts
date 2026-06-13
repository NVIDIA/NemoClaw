// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

const WORKFLOW_FILE = "nightly-e2e.yaml";
const TRACE_ARTIFACT_NAME = "cloud-onboard-traces";
const TRACE_SUMMARY_FILE = "cloud-onboard-trace-timing-summary.json";
const ONBOARD_PHASE_PREFIX = "nemoclaw.onboard.phase.";
// Keep this ordered list aligned with the trace span names emitted by
// src/lib/onboard/tracing.ts.
const ONBOARD_PHASE_ORDER = [
  "nemoclaw.onboard.phase.preflight",
  "nemoclaw.onboard.phase.gateway",
  "nemoclaw.onboard.phase.provider_selection",
  "nemoclaw.onboard.phase.inference",
  "nemoclaw.onboard.phase.sandbox",
] as const;
const ONBOARD_PHASE_NAMES = new Set<string>(ONBOARD_PHASE_ORDER);

type SemverTag = {
  name: string;
  major: number;
  minor: number;
  patch: number;
  sha?: string;
};

type TraceSpanLike = {
  name?: unknown;
  duration_ms?: unknown;
};

type TimingSummaryArtifact = {
  schema_version?: unknown;
  trace_id?: unknown;
  total_duration_ms?: unknown;
  phases?: unknown;
  slowest_spans?: unknown;
};

type OnboardTraceSummary = {
  artifact: unknown;
  totalMs: number;
  phases: Record<string, number>;
};

type PhaseRow = {
  name?: string;
  label: string;
  currentMs: number;
  priorMs: number;
  deltaMs?: number;
  deltaAbsMs: number;
};

type GitHubDeps = {
  github: any;
  context: any;
};

function parseSemverTag(name: string): SemverTag | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!match) return null;
  return {
    name,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemverDesc(a: SemverTag, b: SemverTag): number {
  return b.major - a.major || b.minor - a.minor || b.patch - a.patch;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}m ${remaining.toFixed(1)}s`;
}

function formatTraceDelta(currentMs: number, priorMs: number): string {
  const deltaMs = currentMs - priorMs;
  const pct = priorMs > 0 ? (deltaMs / priorMs) * 100 : 0;
  if (Math.abs(deltaMs) < 1) return "unchanged";
  const direction = deltaMs > 0 ? "increased" : "decreased";
  const sign = deltaMs > 0 ? "+" : "-";
  return `${direction} ${sign}${formatDuration(Math.abs(deltaMs))} (${sign}${Math.abs(pct).toFixed(1)}%)`;
}

function phaseLabel(name: string): string {
  return name.replace(ONBOARD_PHASE_PREFIX, "").replace(/_/g, " ");
}

function formatPhaseDelta(currentMs: number, priorMs: number): string {
  const deltaMs = currentMs - priorMs;
  if (Math.abs(deltaMs) < 1) return "±0ms";
  const sign = deltaMs > 0 ? "+" : "-";
  return `${sign}${formatDuration(Math.abs(deltaMs))}`;
}

function extractPhaseDurations(spans: TraceSpanLike[]): Record<string, number> {
  const phases: Record<string, number> = {};
  for (const span of spans) {
    const name = span?.name;
    const durationMs = Number(span?.duration_ms);
    if (
      typeof name !== "string" ||
      !name.startsWith(ONBOARD_PHASE_PREFIX) ||
      !Number.isFinite(durationMs)
    ) {
      continue;
    }
    phases[name] = (phases[name] ?? 0) + durationMs;
  }
  return phases;
}

function traceTimingResult(
  traceTimingLine: string,
  traceSummaryLines: string[] = [],
): { traceTimingLine: string; traceSummaryLines: string[] } {
  return { traceTimingLine, traceSummaryLines };
}

function normalizePhaseDurations(value: unknown): Record<string, number> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const phases: Record<string, number> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!ONBOARD_PHASE_NAMES.has(name)) continue;
    const durationMs = Number(entry);
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;
    phases[name] = durationMs;
  }
  return phases;
}

function selectOnboardTrace(jsonTexts: string[]): OnboardTraceSummary | null {
  const candidates: OnboardTraceSummary[] = [];
  for (const text of jsonTexts) {
    try {
      const artifact = JSON.parse(text) as TimingSummaryArtifact;
      const totalMs = Number(artifact?.total_duration_ms);
      const phases = normalizePhaseDurations(artifact.phases);
      if (
        artifact?.schema_version === "nemoclaw.trace_timing.v1" &&
        Number.isFinite(totalMs) &&
        totalMs >= 0 &&
        phases !== null
      ) {
        candidates.push({ artifact, totalMs, phases });
      }
    } catch {
      // The trusted sanitizer emits a single timing-summary JSON file; keep
      // scorecard parsing best-effort so a missing/malformed summary does not
      // hide the E2E pass/fail signal.
    }
  }
  candidates.sort((a, b) => b.totalMs - a.totalMs);
  return candidates[0] ?? null;
}

function buildPhaseRows(
  currentPhases: Record<string, number>,
  priorPhases: Record<string, number>,
): PhaseRow[] {
  return ONBOARD_PHASE_ORDER.filter(
    (name) => currentPhases[name] !== undefined && priorPhases[name] !== undefined,
  ).map((name) => {
    const currentMs = currentPhases[name];
    const priorMs = priorPhases[name];
    const deltaMs = currentMs - priorMs;
    return {
      name,
      label: phaseLabel(name),
      currentMs,
      priorMs,
      deltaMs,
      deltaAbsMs: Math.abs(deltaMs),
    };
  });
}

function formatTopPhaseChanges(phaseRows: PhaseRow[]): string {
  return phaseRows
    .slice()
    .sort((a, b) => b.deltaAbsMs - a.deltaAbsMs || a.label.localeCompare(b.label))
    .slice(0, 3)
    .map((row) => `${row.label} ${formatPhaseDelta(row.currentMs, row.priorMs)}`)
    .join("; ");
}

function buildTraceSummaryLines(
  currentTrace: { totalMs: number },
  priorTrace: { totalMs: number },
  priorTag: { name: string },
  phaseRows: PhaseRow[],
): string[] {
  if (phaseRows.length === 0) return [];

  const lines = [
    "",
    "## Cloud Onboard Trace Timing",
    "",
    `Total: ${formatDuration(currentTrace.totalMs)}, ${formatTraceDelta(currentTrace.totalMs, priorTrace.totalMs)} vs ${priorTag.name}`,
    "",
  ];

  lines.push("| Phase | Current | Previous | Delta |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const row of phaseRows) {
    lines.push(
      `| ${row.label} | ${formatDuration(row.currentMs)} | ${formatDuration(row.priorMs)} | ${formatPhaseDelta(row.currentMs, row.priorMs)} |`,
    );
  }

  lines.push("");
  lines.push(`Trace artifact: \`${TRACE_ARTIFACT_NAME}\``);
  lines.push(
    `Baseline: latest completed \`${WORKFLOW_FILE}\` run for prior release tag \`${priorTag.name}\``,
  );
  return lines;
}

async function resolvePriorReleaseTag({ github, context }: GitHubDeps): Promise<SemverTag | null> {
  const tags = await github.paginate(github.rest.repos.listTags, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    per_page: 100,
  });
  const semverTags = tags
    .map((tag: any) => {
      const semverTag = parseSemverTag(tag.name);
      return semverTag && tag.commit?.sha ? { ...semverTag, sha: tag.commit.sha } : null;
    })
    .filter(Boolean)
    .sort(compareSemverDesc);
  if (semverTags.length === 0) return null;

  const currentTag = context.ref?.startsWith("refs/tags/")
    ? parseSemverTag(context.ref.replace("refs/tags/", ""))
    : null;
  if (!currentTag) return semverTags[0];

  const index = semverTags.findIndex((tag: SemverTag) => tag.name === currentTag.name);
  return index >= 0 ? (semverTags[index + 1] ?? null) : semverTags[0];
}

async function findLatestCompletedNightlyRunForReleaseTag(
  { github, context }: GitHubDeps,
  tag: SemverTag,
): Promise<any | null> {
  for (let page = 1; page <= 10; page++) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      owner: context.repo.owner,
      repo: context.repo.repo,
      workflow_id: WORKFLOW_FILE,
      head_sha: tag.sha,
      status: "completed",
      per_page: 100,
      page,
    });
    const run = data.workflow_runs.find(
      (candidate: any) => candidate.id !== context.runId && candidate.status === "completed",
    );
    if (run) return run;
    if (data.workflow_runs.length < 100) break;
  }
  return null;
}

async function readTraceSummaryFromRun(
  { github, context }: GitHubDeps,
  runId: number,
): Promise<OnboardTraceSummary | null> {
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: runId,
    per_page: 100,
  });
  const artifact = artifacts.find((item: any) => item.name === TRACE_ARTIFACT_NAME);
  if (!artifact) return null;

  const download = await github.rest.actions.downloadArtifact({
    owner: context.repo.owner,
    repo: context.repo.repo,
    artifact_id: artifact.id,
    archive_format: "zip",
  });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-artifact-"));
  try {
    const zipPath = path.join(tempDir, `${TRACE_ARTIFACT_NAME}.zip`);
    fs.writeFileSync(zipPath, Buffer.from(download.data), { mode: 0o600 });

    const summaryText = execFileSync("unzip", ["-p", zipPath, TRACE_SUMMARY_FILE], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return selectOnboardTrace([summaryText]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function buildTraceTimingResult(
  deps: GitHubDeps,
): Promise<{ traceTimingLine: string; traceSummaryLines: string[] }> {
  const { context } = deps;
  try {
    const currentTrace = await readTraceSummaryFromRun(deps, context.runId);
    if (currentTrace === null) {
      return traceTimingResult(`Trace: ⊘ ${TRACE_ARTIFACT_NAME} artifact not found for this run`);
    }

    const priorTag = await resolvePriorReleaseTag(deps);
    if (!priorTag) {
      return traceTimingResult(
        `Trace: cloud-onboard total ${formatDuration(currentTrace.totalMs)} (no prior release tag found)`,
      );
    }

    const priorRun = await findLatestCompletedNightlyRunForReleaseTag(deps, priorTag);
    if (!priorRun) {
      return traceTimingResult(
        `Trace: cloud-onboard total ${formatDuration(currentTrace.totalMs)} (no nightly-e2e run found for ${priorTag.name})`,
      );
    }

    const priorTrace = await readTraceSummaryFromRun(deps, priorRun.id);
    if (priorTrace === null) {
      return traceTimingResult(
        `Trace: cloud-onboard total ${formatDuration(currentTrace.totalMs)} (no ${TRACE_ARTIFACT_NAME} artifact found for ${priorTag.name})`,
      );
    }

    const phaseRows = buildPhaseRows(currentTrace.phases, priorTrace.phases);
    const topPhaseChanges = formatTopPhaseChanges(phaseRows);
    const traceLine = `Trace: cloud-onboard total ${formatDuration(currentTrace.totalMs)}, ${formatTraceDelta(currentTrace.totalMs, priorTrace.totalMs)} vs ${priorTag.name}.`;
    if (phaseRows.length === 0) {
      return traceTimingResult(traceLine);
    }

    return traceTimingResult(
      [
        traceLine,
        `Top phase changes: ${topPhaseChanges}.`,
        "Full phase timing table is in the GitHub run summary.",
      ].join(" "),
      buildTraceSummaryLines(currentTrace, priorTrace, priorTag, phaseRows),
    );
  } catch (error) {
    return traceTimingResult("Trace: ⊘ comparison unavailable");
  }
}

module.exports = {
  ONBOARD_PHASE_ORDER,
  TRACE_SUMMARY_FILE,
  buildPhaseRows,
  buildTraceTimingResult,
  buildTraceSummaryLines,
  extractPhaseDurations,
  formatTraceDelta,
  formatTopPhaseChanges,
  readTraceSummaryFromRun,
  resolvePriorReleaseTag,
  selectOnboardTrace,
};
