// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const WORKFLOW_FILE = "nightly-e2e.yaml";
const TRACE_ARTIFACT_NAME = "cloud-onboard-traces";
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

function parseSemverTag(name) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!match) return null;
  return {
    name,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemverDesc(a, b) {
  return b.major - a.major || b.minor - a.minor || b.patch - a.patch;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}m ${remaining.toFixed(1)}s`;
}

function formatTraceDelta(currentMs, priorMs) {
  const deltaMs = currentMs - priorMs;
  const pct = priorMs > 0 ? (deltaMs / priorMs) * 100 : 0;
  if (Math.abs(deltaMs) < 1) return "unchanged";
  const direction = deltaMs > 0 ? "increased" : "decreased";
  const sign = deltaMs > 0 ? "+" : "-";
  return `${direction} ${sign}${formatDuration(Math.abs(deltaMs))} (${sign}${Math.abs(pct).toFixed(1)}%)`;
}

function phaseLabel(name) {
  return name.replace(ONBOARD_PHASE_PREFIX, "").replace(/_/g, " ");
}

function formatPhaseDelta(currentMs, priorMs) {
  const deltaMs = currentMs - priorMs;
  if (Math.abs(deltaMs) < 1) return "±0ms";
  const sign = deltaMs > 0 ? "+" : "-";
  return `${sign}${formatDuration(Math.abs(deltaMs))}`;
}

function extractPhaseDurations(spans) {
  const phases = {};
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
  traceTimingLine,
  traceSummaryLines = [],
  budgetExceeded = false,
  budgetWarningMessage = null,
  budgetStatus = "not_evaluated",
) {
  return { traceTimingLine, traceSummaryLines, budgetExceeded, budgetWarningMessage, budgetStatus };
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeThreshold(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value;
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

function normalizeOnboardPerformanceBudget(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value;
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
    scope: object.scope,
    totalBudgetMs: object.totalBudgetMs,
    regressionWarning,
    phaseRegressionWarning,
  };
}

function repoRelativePath(baseDir, targetPath) {
  return path.relative(path.resolve(baseDir), path.resolve(targetPath));
}

function isPathInside(baseDir, targetPath) {
  const relativePath = repoRelativePath(baseDir, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function readOnboardPerformanceBudget(rootDir = process.env.GITHUB_WORKSPACE || REPO_ROOT) {
  const repoRoot = path.resolve(REPO_ROOT);
  const budgetRoot = path.resolve(rootDir);
  if (!isPathInside(repoRoot, budgetRoot)) {
    return { status: "unavailable", reason: "path_traversal" };
  }

  const filePath = path.resolve(budgetRoot, ONBOARD_PERFORMANCE_BUDGET_FILE);
  if (!isPathInside(budgetRoot, filePath)) {
    return { status: "unavailable", reason: "path_traversal" };
  }
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

function normalizePhaseDurations(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const phases = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!ONBOARD_PHASE_NAMES.has(name)) continue;
    const durationMs = Number(entry);
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;
    phases[name] = durationMs;
  }
  return phases;
}

function selectOnboardTrace(jsonTexts) {
  const candidates = [];
  for (const text of jsonTexts) {
    try {
      const artifact = JSON.parse(text);
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

function buildPhaseRows(currentPhases, priorPhases) {
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

function formatTopPhaseChanges(phaseRows) {
  return phaseRows
    .slice()
    .sort((a, b) => b.deltaAbsMs - a.deltaAbsMs || a.label.localeCompare(b.label))
    .slice(0, 3)
    .map((row) => `${row.label} ${formatPhaseDelta(row.currentMs, row.priorMs)}`)
    .join("; ");
}

function currentPhaseRows(phases) {
  return ONBOARD_PHASE_ORDER.filter((name) => phases?.[name] !== undefined)
    .map((name) => ({ label: phaseLabel(name), ms: phases?.[name] ?? 0 }))
    .sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label));
}

function percentDelta(currentMs, priorMs) {
  return priorMs > 0 ? ((currentMs - priorMs) / priorMs) * 100 : 0;
}

// Require both an absolute and percentage delta so tiny fast-phase noise does not page maintainers.
function exceedsThreshold(currentMs, priorMs, threshold) {
  const deltaMs = currentMs - priorMs;
  return (
    deltaMs >= threshold.minDeltaMs && percentDelta(currentMs, priorMs) >= threshold.minPercent
  );
}

function sanitizeTraceTimingError(error) {
  const errorName = error?.constructor?.name || "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage
    .replace(/(token|key|secret|password)=\S+/gi, "$1=[redacted]")
    .replace(/(token|key|secret|password):\S+/gi, "$1:[redacted]")
    .slice(0, 200);
  return `${errorName}: ${message}`;
}

function evaluateOnboardPerformanceBudget({
  budget,
  currentTrace,
  priorTrace = null,
  phaseRows = [],
}) {
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
  currentTrace,
  priorTrace,
  priorTag,
  phaseRows,
  budgetEvaluation = null,
) {
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

async function resolvePriorReleaseTag({ github, context }) {
  const tags = await github.paginate(github.rest.repos.listTags, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    per_page: 100,
  });
  const semverTags = tags
    .map((tag) => {
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

  const index = semverTags.findIndex((tag) => tag.name === currentTag.name);
  return index >= 0 ? (semverTags[index + 1] ?? null) : semverTags[0];
}

async function findLatestCompletedNightlyRunForReleaseTag({ github, context }, tag) {
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
      (candidate) => candidate.id !== context.runId && candidate.status === "completed",
    );
    if (run) return run;
    if (data.workflow_runs.length < 100) break;
  }
  return null;
}

async function readTraceSummaryFromRun({ github, context }, runId) {
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: runId,
    per_page: 100,
  });
  const artifact = artifacts.find((item) => item.name === TRACE_ARTIFACT_NAME);
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

async function buildTraceTimingResult(deps) {
  const { context } = deps;
  try {
    const currentTrace = await readTraceSummaryFromRun(deps, context.runId);
    if (currentTrace === null) {
      return traceTimingResult(`Trace: ⊘ ${TRACE_ARTIFACT_NAME} artifact not found for this run`);
    }
    const budget = readOnboardPerformanceBudget();

    const priorTag = await resolvePriorReleaseTag(deps);
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

    const priorRun = await findLatestCompletedNightlyRunForReleaseTag(deps, priorTag);
    if (!priorRun) {
      const budgetEvaluation = evaluateOnboardPerformanceBudget({ budget, currentTrace });
      return traceTimingResult(
        [
          `Trace: cloud-onboard total ${formatDuration(
            currentTrace.totalMs,
          )} (no nightly-e2e run found for ${priorTag.name})`,
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

    const priorTrace = await readTraceSummaryFromRun(deps, priorRun.id);
    if (priorTrace === null) {
      const budgetEvaluation = evaluateOnboardPerformanceBudget({ budget, currentTrace });
      return traceTimingResult(
        [
          `Trace: cloud-onboard total ${formatDuration(
            currentTrace.totalMs,
          )} (no ${TRACE_ARTIFACT_NAME} artifact found for ${priorTag.name})`,
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
  TRACE_SUMMARY_FILE,
  buildPhaseRows,
  buildTraceTimingResult,
  buildTraceSummaryLines,
  evaluateOnboardPerformanceBudget,
  exceedsThreshold,
  extractPhaseDurations,
  formatTraceDelta,
  formatTopPhaseChanges,
  readOnboardPerformanceBudget,
  readTraceSummaryFromRun,
  resolvePriorReleaseTag,
  sanitizeTraceTimingError,
  selectOnboardTrace,
};
