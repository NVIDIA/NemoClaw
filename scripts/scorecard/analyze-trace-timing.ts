// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

type SemverTag = { name: string; major: number; minor: number; patch: number; sha?: string };
type Threshold = { minDeltaMs: number; minPercent: number };
type OnboardPerformanceBudget = {
  schemaVersion: 1;
  mode: "advisory";
  scope: string;
  totalBudgetMs: number;
  regressionWarning: Threshold;
  phaseRegressionWarning: Threshold;
};
type BudgetLoadResult =
  | { status: "loaded"; budget: OnboardPerformanceBudget }
  | { status: "unavailable"; reason: "missing" | "invalid" | "path_traversal" };
type PhaseDurations = Record<string, number>;
type OnboardTrace = { artifact?: unknown; totalMs: number; phases: PhaseDurations };
type PhaseRow = {
  name: string;
  label: string;
  currentMs: number;
  priorMs: number;
  deltaMs: number;
  deltaAbsMs: number;
};
type BudgetEvaluation = {
  exceeded: boolean;
  status: "config_unavailable" | "exceeded" | "ok";
  mode: string;
  scope: string;
  statusLabel: string;
  summary: string;
  summaryLines: string[];
  warningMessage: string | null;
};
type TraceTimingResult = {
  traceTimingLine: string;
  traceSummaryLines: string[];
  budgetExceeded: boolean;
  budgetWarningMessage: string | null;
  budgetStatus: string;
};
type GitHubDeps = { github: any; context: any; core?: { warning?: (message: string) => void } };
type TraceTimingServices = {
  findLatestCompletedE2eRunForReleaseTag: (
    deps: GitHubDeps,
    tag: SemverTag,
  ) => Promise<any | null>;
  readTraceSummaryFromRun: (deps: GitHubDeps, runId: number) => Promise<OnboardTrace | null>;
  resolvePriorReleaseTag: (deps: GitHubDeps) => Promise<SemverTag | null>;
};

const WORKFLOW_FILE = "e2e.yaml";
const TRACE_ARTIFACT_NAME = "e2e-cloud-onboard";
const TRACE_SUMMARY_FILE = "cloud-onboard-trace-timing-summary.json";
const ONBOARD_PERFORMANCE_BUDGET_FILE = "ci/onboard-performance-budget.json";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ONBOARD_PHASE_PREFIX = "nemoclaw.onboard.phase.";
// Keep this ordered list aligned with the trace span names emitted by
// src/lib/onboard/tracing.ts.
const ONBOARD_PHASE_ORDER = [
  "nemoclaw.onboard.phase.preflight",
  "nemoclaw.onboard.phase.gateway",
  "nemoclaw.onboard.phase.provider_selection",
  "nemoclaw.onboard.phase.inference",
  "nemoclaw.onboard.phase.sandbox",
];
const ONBOARD_PHASE_NAMES = new Set(ONBOARD_PHASE_ORDER);

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
  if (Math.abs(deltaMs) < 1) return "unchanged";
  const direction = deltaMs > 0 ? "increased" : "decreased";
  const sign = deltaMs > 0 ? "+" : "-";
  if (priorMs <= 0) {
    return `${direction} ${sign}${formatDuration(Math.abs(deltaMs))} (n/a)`;
  }
  const pct = (deltaMs / priorMs) * 100;
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

function extractPhaseDurations(spans: unknown[]): PhaseDurations {
  const phases: PhaseDurations = {};
  for (const span of spans) {
    const record = span as Record<string, unknown> | null | undefined;
    const name = record?.name;
    const durationMs = Number(record?.duration_ms);
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
  budgetExceeded = false,
  budgetWarningMessage: string | null = null,
  budgetStatus = "not_evaluated",
): TraceTimingResult {
  return { traceTimingLine, traceSummaryLines, budgetExceeded, budgetWarningMessage, budgetStatus };
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeThreshold(value: unknown): Threshold | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (
    !isFiniteNonNegativeNumber(object.minDeltaMs) ||
    !isFiniteNonNegativeNumber(object.minPercent)
  ) {
    return null;
  }
  return {
    minDeltaMs: object.minDeltaMs,
    minPercent: object.minPercent,
  };
}

function normalizeOnboardPerformanceBudget(value: unknown): OnboardPerformanceBudget | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const regressionWarning = normalizeThreshold(object.regressionWarning);
  const phaseRegressionWarning = normalizeThreshold(object.phaseRegressionWarning);
  if (
    object.schemaVersion !== 1 ||
    object.mode !== "advisory" ||
    typeof object.scope !== "string" ||
    object.scope.trim() === "" ||
    !isFiniteNonNegativeNumber(object.totalBudgetMs) ||
    regressionWarning === null ||
    phaseRegressionWarning === null
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    mode: "advisory",
    scope: object.scope as string,
    totalBudgetMs: object.totalBudgetMs,
    regressionWarning,
    phaseRegressionWarning,
  };
}

function readOnboardPerformanceBudget(): BudgetLoadResult {
  const filePath = path.resolve(REPO_ROOT, ONBOARD_PERFORMANCE_BUDGET_FILE);
  if (!fs.existsSync(filePath)) {
    return { status: "unavailable", reason: "missing" };
  }
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const budget = normalizeOnboardPerformanceBudget(JSON.parse(text));
    return budget === null
      ? { status: "unavailable", reason: "invalid" }
      : { status: "loaded", budget };
  } catch {
    return { status: "unavailable", reason: "invalid" };
  }
}

function normalizePhaseDurations(value: unknown): PhaseDurations | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const phases: PhaseDurations = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!ONBOARD_PHASE_NAMES.has(name)) continue;
    const durationMs = Number(entry);
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;
    phases[name] = durationMs;
  }
  return phases;
}

function selectOnboardTrace(jsonTexts: string[]): OnboardTrace | null {
  const candidates: OnboardTrace[] = [];
  for (const text of jsonTexts) {
    try {
      const artifact = JSON.parse(text) as Record<string, any>;
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

function buildPhaseRows(currentPhases: PhaseDurations, priorPhases: PhaseDurations): PhaseRow[] {
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

function currentPhaseRows(phases?: PhaseDurations): Array<{ label: string; ms: number }> {
  return ONBOARD_PHASE_ORDER.filter((name) => phases?.[name] !== undefined)
    .map((name) => ({ label: phaseLabel(name), ms: phases?.[name] ?? 0 }))
    .sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label));
}

function percentDelta(currentMs: number, priorMs: number): number {
  return priorMs > 0 ? ((currentMs - priorMs) / priorMs) * 100 : 0;
}

// Require both an absolute and percentage delta so tiny fast-phase noise does not page maintainers; percentage-only changes are too small to affect warm-onboard UX unless they also clear the millisecond floor.
function exceedsThreshold(currentMs: number, priorMs: number, threshold: Threshold): boolean {
  const deltaMs = currentMs - priorMs;
  return (
    deltaMs >= threshold.minDeltaMs && percentDelta(currentMs, priorMs) >= threshold.minPercent
  );
}

function redactSensitiveTraceText(value: string): string {
  return value
    .replace(/Authorization:\s*(Bearer|Basic)\s+\S+/gi, "Authorization: $1 [redacted]")
    .replace(/https?:\/\/([^:\s/@]+):([^@\s]+)@/gi, "https://$1:[redacted]@")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]+\b/g, "github_token_[redacted]")
    .replace(
      /(["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      "$1[redacted]",
    );
}

function sanitizeTraceTimingError(error: unknown): string {
  const errorName = error instanceof Error ? error.name || error.constructor.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactSensitiveTraceText(rawMessage).slice(0, 200);
  return `${errorName}: ${message}`;
}

function evaluateOnboardPerformanceBudget({
  budget,
  currentTrace,
  priorTrace = null,
  phaseRows = [],
}: {
  budget: BudgetLoadResult | OnboardPerformanceBudget | null;
  currentTrace: OnboardTrace;
  priorTrace?: OnboardTrace | null;
  phaseRows?: PhaseRow[];
}): BudgetEvaluation | null {
  if (budget === null) return null;
  if ("status" in budget) {
    if (budget.status === "unavailable") {
      const reason =
        budget.reason === "missing"
          ? "the budget config was not found"
          : budget.reason === "path_traversal"
            ? "the budget config path resolved outside the repository"
            : "the budget config is invalid or unreadable";
      return {
        exceeded: false,
        status: "config_unavailable",
        mode: "advisory",
        scope: "cloud-onboard-e2e warm-system",
        statusLabel: "config_unavailable",
        summary: `Budget: config unavailable - ${reason}.`,
        warningMessage: `Cloud onboard advisory performance budget config unavailable; check ${ONBOARD_PERFORMANCE_BUDGET_FILE} and the scorecard summary for details.`,
        summaryLines: [
          "",
          "### Onboard Performance Budget",
          "",
          "Status: **Config unavailable**",
          `Config: \`${ONBOARD_PERFORMANCE_BUDGET_FILE}\``,
          `Finding: ${reason}.`,
          "",
          "This signal is advisory: it surfaces warm-onboard timing regressions without failing the scorecard job.",
        ],
      };
    }
    budget = budget.budget;
  }

  const warnings = [];
  const totalBudgetExceeded = currentTrace.totalMs > budget.totalBudgetMs;
  if (totalBudgetExceeded) {
    warnings.push(
      `total ${formatDuration(currentTrace.totalMs)} exceeds warm budget ${formatDuration(
        budget.totalBudgetMs,
      )}`,
    );
  }

  if (
    priorTrace &&
    exceedsThreshold(currentTrace.totalMs, priorTrace.totalMs, budget.regressionWarning)
  ) {
    warnings.push(
      `total regression ${formatPhaseDelta(currentTrace.totalMs, priorTrace.totalMs)} (${percentDelta(
        currentTrace.totalMs,
        priorTrace.totalMs,
      ).toFixed(1)}%) exceeds advisory threshold`,
    );
  }

  const phaseWarnings = (phaseRows ?? [])
    .filter((row) => exceedsThreshold(row.currentMs, row.priorMs, budget.phaseRegressionWarning))
    // Phase warnings only include positive regressions, so signed delta keeps the largest slowdown first.
    .sort((a, b) => (b.deltaMs ?? 0) - (a.deltaMs ?? 0) || a.label.localeCompare(b.label))
    .slice(0, 3);

  if (phaseWarnings.length > 0) {
    warnings.push(
      `phase regressions: ${phaseWarnings
        .map(
          (row) =>
            `${row.label} ${formatPhaseDelta(row.currentMs, row.priorMs)} (${percentDelta(
              row.currentMs,
              row.priorMs,
            ).toFixed(1)}%)`,
        )
        .join("; ")}`,
    );
  }

  const exceeded = warnings.length > 0;
  const summary = exceeded
    ? `Budget: advisory warning - ${warnings[0]}.`
    : `Budget: advisory OK for ${budget.scope} (${formatDuration(budget.totalBudgetMs)} cap).`;
  const warningMessage = exceeded
    ? "Cloud onboard advisory performance budget exceeded; see scorecard summary for timing details."
    : null;
  const summaryLines = [
    "",
    "### Onboard Performance Budget",
    "",
    `Status: **${exceeded ? "Advisory warning" : "OK"}**`,
    `Scope: \`${budget.scope}\``,
    `Mode: \`${budget.mode}\``,
    `Warm total budget: ${formatDuration(budget.totalBudgetMs)}`,
  ];
  if (warnings.length > 0) {
    summaryLines.push("");
    summaryLines.push("Advisory findings:");
    for (const warning of warnings) {
      summaryLines.push(`- ${warning}`);
    }
  }
  if (exceeded) {
    const slowestPhases = currentPhaseRows(currentTrace.phases).slice(0, 3);
    if (slowestPhases.length > 0) {
      summaryLines.push("");
      summaryLines.push("Current slowest phases:");
      for (const phase of slowestPhases) {
        summaryLines.push(`- ${phase.label}: ${formatDuration(phase.ms)}`);
      }
    }
  }
  summaryLines.push("");
  summaryLines.push(
    "This signal is advisory: it surfaces warm-onboard timing regressions without failing the scorecard job.",
  );

  return {
    exceeded,
    status: exceeded ? "exceeded" : "ok",
    mode: budget.mode,
    scope: budget.scope,
    statusLabel: exceeded ? "warning" : "ok",
    summary,
    summaryLines,
    warningMessage,
  };
}

function buildTraceSummaryLines(
  currentTrace: OnboardTrace,
  priorTrace: OnboardTrace,
  priorTag: SemverTag,
  phaseRows: PhaseRow[],
  budgetEvaluation: BudgetEvaluation | null = null,
): string[] {
  if (phaseRows.length === 0 && budgetEvaluation === null) return [];

  const lines = [
    "",
    "## Cloud Onboard Trace Timing",
    "",
    `Total: ${formatDuration(currentTrace.totalMs)}, ${formatTraceDelta(currentTrace.totalMs, priorTrace.totalMs)} vs ${priorTag.name}`,
    "",
  ];

  if (phaseRows.length > 0) {
    lines.push("| Phase | Current | Previous | Delta |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const row of phaseRows) {
      lines.push(
        `| ${row.label} | ${formatDuration(row.currentMs)} | ${formatDuration(row.priorMs)} | ${formatPhaseDelta(row.currentMs, row.priorMs)} |`,
      );
    }
  }

  if (budgetEvaluation) lines.push(...budgetEvaluation.summaryLines);

  lines.push("");
  lines.push(`Trace artifact: \`${TRACE_ARTIFACT_NAME}\``);
  lines.push(
    `Baseline: latest completed \`${WORKFLOW_FILE}\` run for prior release tag \`${priorTag.name}\``,
  );
  return lines;
}

async function resolvePriorReleaseTag({ github, context }: GitHubDeps): Promise<SemverTag | null> {
  const tags = (await github.paginate(github.rest.repos.listTags, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    per_page: 100,
  })) as Array<{ name: string; commit?: { sha?: string } }>;
  const semverTags = tags
    .map((tag: { name: string; commit?: { sha?: string } }) => {
      const semverTag = parseSemverTag(tag.name);
      return semverTag && tag.commit?.sha ? { ...semverTag, sha: tag.commit.sha } : null;
    })
    .filter((tag): tag is SemverTag & { sha: string } => Boolean(tag))
    .sort(compareSemverDesc);
  if (semverTags.length === 0) return null;

  const currentTag = context.ref?.startsWith("refs/tags/")
    ? parseSemverTag(context.ref.replace("refs/tags/", ""))
    : null;
  if (!currentTag) return semverTags[0];

  const index = semverTags.findIndex((tag) => tag.name === currentTag.name);
  return index >= 0 ? (semverTags[index + 1] ?? null) : semverTags[0];
}

async function findLatestCompletedE2eRunForReleaseTag(
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
    const workflowRuns = data.workflow_runs as Array<{ id: number; status: string }>;
    const run = workflowRuns.find(
      (candidate: { id: number; status: string }) =>
        candidate.id !== context.runId && candidate.status === "completed",
    );
    if (run) return run;
    if (workflowRuns.length < 100) break;
  }
  return null;
}

function listZipEntries(zipPath: string): string[] {
  return execFileSync("unzip", ["-Z1", zipPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  })
    .split(/\r?\n/)
    .map((entry: string) => entry.trim())
    .filter(Boolean);
}

function isExpectedTraceZipEntry(entry: string): boolean {
  return entry === TRACE_SUMMARY_FILE && !entry.includes("\\") && !path.isAbsolute(entry);
}

function readValidatedTraceSummaryZip(zipPath: string): string | null {
  const entries = listZipEntries(zipPath);
  if (entries.length !== 1 || !isExpectedTraceZipEntry(entries[0])) return null;
  return execFileSync("unzip", ["-p", zipPath, TRACE_SUMMARY_FILE], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

async function readTraceSummaryFromRun(
  { github, context }: GitHubDeps,
  runId: number,
): Promise<OnboardTrace | null> {
  const artifacts = (await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: runId,
    per_page: 100,
  })) as Array<{ id: number; name: string }>;
  const artifact = artifacts.find(
    (item: { id: number; name: string }) => item.name === TRACE_ARTIFACT_NAME,
  );
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

    const summaryText = readValidatedTraceSummaryZip(zipPath);
    return summaryText === null ? null : selectOnboardTrace([summaryText]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function buildTraceTimingResult(
  deps: GitHubDeps,
  services: TraceTimingServices = {
    findLatestCompletedE2eRunForReleaseTag,
    readTraceSummaryFromRun,
    resolvePriorReleaseTag,
  },
): Promise<TraceTimingResult> {
  const { context } = deps;
  try {
    const currentTrace = await services.readTraceSummaryFromRun(deps, context.runId);
    if (currentTrace === null) {
      return traceTimingResult(`Trace: ⊘ ${TRACE_ARTIFACT_NAME} timing summary not found`);
    }
    const budget = readOnboardPerformanceBudget();

    const priorTag = await services.resolvePriorReleaseTag(deps);
    if (!priorTag) {
      const budgetEvaluation = evaluateOnboardPerformanceBudget({ budget, currentTrace });
      return traceTimingResult(
        [
          `Trace: cloud-onboard total ${formatDuration(
            currentTrace.totalMs,
          )} (no prior release tag found)`,
          budgetEvaluation?.summary,
        ]
          .filter(Boolean)
          .join(" "),
        budgetEvaluation?.summaryLines ?? [],
        budgetEvaluation?.exceeded ?? false,
        budgetEvaluation?.warningMessage ?? null,
        budgetEvaluation?.status ?? "not_evaluated",
      );
    }

    const priorRun = await services.findLatestCompletedE2eRunForReleaseTag(deps, priorTag);
    if (!priorRun) {
      const budgetEvaluation = evaluateOnboardPerformanceBudget({ budget, currentTrace });
      return traceTimingResult(
        [
          `Trace: cloud-onboard total ${formatDuration(
            currentTrace.totalMs,
          )} (no e2e.yaml run found for ${priorTag.name})`,
          budgetEvaluation?.summary,
        ]
          .filter(Boolean)
          .join(" "),
        budgetEvaluation?.summaryLines ?? [],
        budgetEvaluation?.exceeded ?? false,
        budgetEvaluation?.warningMessage ?? null,
        budgetEvaluation?.status ?? "not_evaluated",
      );
    }

    const priorTrace = await services.readTraceSummaryFromRun(deps, priorRun.id);
    if (priorTrace === null) {
      const budgetEvaluation = evaluateOnboardPerformanceBudget({ budget, currentTrace });
      return traceTimingResult(
        [
          `Trace: cloud-onboard total ${formatDuration(
            currentTrace.totalMs,
          )} (no timing summary found for ${priorTag.name})`,
          budgetEvaluation?.summary,
        ]
          .filter(Boolean)
          .join(" "),
        budgetEvaluation?.summaryLines ?? [],
        budgetEvaluation?.exceeded ?? false,
        budgetEvaluation?.warningMessage ?? null,
        budgetEvaluation?.status ?? "not_evaluated",
      );
    }

    const phaseRows = buildPhaseRows(currentTrace.phases, priorTrace.phases);
    const topPhaseChanges = formatTopPhaseChanges(phaseRows);
    const budgetEvaluation = evaluateOnboardPerformanceBudget({
      budget,
      currentTrace,
      priorTrace,
      phaseRows,
    });
    const traceLine = `Trace: cloud-onboard total ${formatDuration(currentTrace.totalMs)}, ${formatTraceDelta(currentTrace.totalMs, priorTrace.totalMs)} vs ${priorTag.name}.`;
    if (phaseRows.length === 0) {
      return traceTimingResult(
        [traceLine, budgetEvaluation?.summary].filter(Boolean).join(" "),
        budgetEvaluation?.summaryLines ?? [],
        budgetEvaluation?.exceeded ?? false,
        budgetEvaluation?.warningMessage ?? null,
        budgetEvaluation?.status ?? "not_evaluated",
      );
    }

    return traceTimingResult(
      [
        traceLine,
        budgetEvaluation?.summary,
        `Top phase changes: ${topPhaseChanges}.`,
        "Full phase timing table is in the GitHub run summary.",
      ]
        .filter(Boolean)
        .join(" "),
      buildTraceSummaryLines(currentTrace, priorTrace, priorTag, phaseRows, budgetEvaluation),
      budgetEvaluation?.exceeded ?? false,
      budgetEvaluation?.warningMessage ?? null,
      budgetEvaluation?.status ?? "not_evaluated",
    );
  } catch (error) {
    deps.core?.warning?.(`Trace timing failed: ${sanitizeTraceTimingError(error)}`);
    return traceTimingResult("Trace: ⊘ comparison unavailable");
  }
}

module.exports = {
  ONBOARD_PHASE_ORDER,
  ONBOARD_PERFORMANCE_BUDGET_FILE,
  TRACE_ARTIFACT_NAME,
  TRACE_SUMMARY_FILE,
  buildPhaseRows,
  buildTraceTimingResult,
  buildTraceSummaryLines,
  evaluateOnboardPerformanceBudget,
  exceedsThreshold,
  extractPhaseDurations,
  findLatestCompletedE2eRunForReleaseTag,
  formatTraceDelta,
  formatTopPhaseChanges,
  readOnboardPerformanceBudget,
  readTraceSummaryFromRun,
  readValidatedTraceSummaryZip,
  redactSensitiveTraceText,
  resolvePriorReleaseTag,
  sanitizeTraceTimingError,
  selectOnboardTrace,
};
