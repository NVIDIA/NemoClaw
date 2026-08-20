// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
const jobId = String(input.jobId);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^\d+$/.test(jobId) || jobId === "0")
  throw new Error("jobId must be a positive numeric GitHub Actions job ID");
const tailLines = Math.max(20, Math.min(500, input.tailLines ?? 260));
const artifactName = input.artifactName?.trim() ?? "";
if (
  input.artifactName !== undefined &&
  (artifactName !== input.artifactName || !/^[A-Za-z0-9_. -]{1,200}$/.test(artifactName))
)
  throw new Error("artifactName must be a trimmed GitHub Actions artifact name");
const q = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const redact = (value) =>
  String(value)
    .replace(/(authorization\s*:)[^\r\n]*/gi, "$1 [REDACTED]")
    .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*=)\s*[^\s]+/g, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[REDACTED]@")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "/[HOME]");
const run = async (command, description, timeoutMs = 30000) => {
  const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
  if (result.kind !== "foreground") throw new Error("Unexpected background result");
  return result;
};
const jobResult = await run(
  `gh api ${q(`repos/${repo}/actions/jobs/${jobId}`)}`,
  "Read GitHub Actions job metadata",
);
if (jobResult.exitCode !== 0)
  throw new Error(`Could not read job metadata: ${redact(jobResult.stderr.text).slice(-1500)}`);
const rawJob = JSON.parse(jobResult.stdout.text);
const job = {
  id: Number(rawJob.id ?? jobId),
  runId: Number(rawJob.run_id ?? 0),
  name: String(rawJob.name ?? "").slice(0, 500),
  status: String(rawJob.status ?? "").slice(0, 100),
  conclusion: rawJob.conclusion == null ? null : String(rawJob.conclusion).slice(0, 100),
  url: String(rawJob.html_url ?? "").slice(0, 2000),
};
const logTemp = await run(
  'umask 077; mktemp -d "${TMPDIR:-/tmp}/nemoclaw-ci-log.XXXXXX"',
  "Create temporary CI log directory",
);
if (logTemp.exitCode !== 0) throw new Error("Could not create temporary CI log directory");
const logDir = logTemp.stdout.text.trim();
if (!logDir) throw new Error("Could not create temporary CI log directory");
let logCode = -1;
let logStderr = "";
let sourceTruncated = false;
let logLines = [];
try {
  const rawPath = logDir + "/job.log";
  const boundedPath = logDir + "/job.tail.log";
  const downloaded = await run(
    `gh api ${q(`repos/${repo}/actions/jobs/${jobId}/logs`)} > ${q(rawPath)}`,
    "Download GitHub Actions job log",
    60000,
  );
  logCode = downloaded.exitCode ?? -1;
  logStderr = redact(downloaded.stderr.text).slice(-4000);
  if (logCode === 0) {
    const bounded = await run(
      `bytes=$(wc -c < ${q(rawPath)}); lines=$(wc -l < ${q(rawPath)}); if [ "$bytes" -gt 4000000 ]; then tail -c 4000000 ${q(rawPath)} | sed '1d'; else cat -- ${q(rawPath)}; fi | tail -n 20000 > ${q(boundedPath)}; printf '%s %s' "$bytes" "$lines"`,
      "Bound GitHub Actions job log",
    );
    if (bounded.exitCode !== 0) throw new Error("Could not bound GitHub Actions job log");
    const [byteText, lineText] = bounded.stdout.text.trim().split(/\s+/, 2);
    const byteCount = Number(byteText);
    const lineCount = Number(lineText);
    sourceTruncated =
      (Number.isFinite(byteCount) && byteCount > 4000000) ||
      (Number.isFinite(lineCount) && lineCount > 20000);
    const content = await tools.read({ file_path: boundedPath, limit: 20000 });
    logLines = content.lines.map((line) => line.text);
    sourceTruncated ||= content.totalLines > content.lines.length;
  }
} finally {
  await run(`rm -rf -- ${q(logDir)}`, "Remove temporary CI log directory");
}
const logPattern =
  /FAIL|Failed Tests|AssertionError|Test timed out|Process completed|SIGKILL|timed out|Source-shape|Source architecture|grew by|adds JavaScript|NEMOCLAW_|npm audit report|docs-review|Documentation writer|Fern validation|check-docs|hadolint|shellcheck|Nemotron/i;
const selectedIndexes = new Set();
let matchedLines = 0;
for (let index = 0; index < logLines.length; index += 1) {
  if (!logPattern.test(logLines[index])) continue;
  matchedLines += 1;
  const first = Math.max(0, index - 20);
  const last = Math.min(logLines.length - 1, index + 20);
  for (let contextIndex = first; contextIndex <= last; contextIndex += 1)
    selectedIndexes.add(contextIndex);
}
const selectedLines = [...selectedIndexes]
  .sort((left, right) => left - right)
  .map((index) => logLines[index].slice(0, 4000));
const boundedLines = selectedLines.slice(-tailLines);
const log = {
  jobId,
  repo,
  pattern: "NemoClaw CI failure signatures",
  code: logCode,
  truncated: sourceTruncated || selectedLines.length > boundedLines.length,
  matchedLines,
  stdout: redact(boundedLines.join("\n").slice(-40000)),
  stderr: logStderr,
};
let artifact = null;
if (artifactName) {
  const inventoryResult = await run(
    `gh api ${q(`repos/${repo}/actions/runs/${job.runId}/artifacts?per_page=100`)}`,
    "Read workflow artifact inventory",
  );
  if (inventoryResult.exitCode !== 0) throw new Error("Could not read artifact inventory");
  const inventory = JSON.parse(inventoryResult.stdout.text);
  const found = (inventory.artifacts ?? []).find((entry) => entry.name === artifactName);
  if (!found) throw new Error(`Artifact ${artifactName} was not found for run ${job.runId}`);
  const sizeBytes = Number(found.size_in_bytes ?? 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes > 25000000)
    throw new Error(`Artifact ${artifactName} is too large for bounded inspection`);
  const temp = await run(
    'umask 077; mktemp -d "${TMPDIR:-/tmp}/nemoclaw-ci-triage.XXXXXX"',
    "Create temporary artifact directory",
  );
  if (temp.exitCode !== 0) throw new Error("Could not create temporary artifact directory");
  const dir = temp.stdout.text.trim();
  if (!dir) throw new Error("Could not create temporary artifact directory");
  try {
    const download = await run(
      `gh run download ${q(job.runId)} --repo ${q(repo)} --name ${q(artifactName)} --dir ${q(dir)}`,
      "Download selected workflow artifact",
      60000,
    );
    if (download.exitCode !== 0) throw new Error("Could not download selected artifact");
    const listed = await run(
      `find ${q(dir)} -type f -name '*.result.json' -printf '%P\0' | LC_ALL=C sort -z | head -z -n 101 | base64 -w0`,
      "List bounded test result artifacts",
    );
    if (listed.exitCode !== 0) throw new Error("Could not list selected artifact results");
    const resultPaths = Buffer.from(listed.stdout.text.trim(), "base64")
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const fileResults = await Promise.all(
      resultPaths.slice(0, 100).map(async (relativePath) => {
        try {
          const resultPath = `${dir}/${relativePath}`;
          const measured = await run(
            `wc -c < ${q(resultPath)}`,
            "Measure bounded test result artifact",
          );
          if (measured.exitCode !== 0) return null;
          const resultBytes = Number(measured.stdout.text.trim());
          if (!Number.isFinite(resultBytes) || resultBytes > 1000000) return null;
          const file = await tools.read({ file_path: resultPath, limit: 2000 });
          if (file.totalLines > 2000) return null;
          const value = JSON.parse(file.lines.map((line) => line.text).join("\n"));
          if (!value || typeof value !== "object" || Array.isArray(value)) return null;
          const exitCode = Number.isInteger(value.exitCode) ? value.exitCode : null;
          const signal = value.signal ? String(value.signal).slice(0, 100) : null;
          const timedOut = Boolean(value.timedOut);
          const error = value.error ? redact(String(value.error)).slice(0, 1000) : null;
          const command =
            value.command == null ? null : redact(String(value.command)).slice(0, 2000);
          if (exitCode === 0 && !signal && !error && !timedOut) return null;
          if (exitCode === null && !signal && !error && !timedOut && !value.command) return null;
          return {
            path: relativePath.slice(0, 1000),
            exitCode,
            signal,
            timedOut,
            error,
            command,
          };
        } catch {
          return null;
        }
      }),
    );
    const failures = fileResults.filter(Boolean);
    artifact = {
      name: artifactName,
      sizeBytes,
      inventoryTruncated: Number(inventory.total_count ?? 0) > 100,
      filesRead: Math.min(resultPaths.length, 100),
      filesTruncated: resultPaths.length > 100,
      failures: failures.slice(0, 20),
      failuresTruncated: failures.length > 20,
    };
  } finally {
    await run(`rm -rf -- ${q(dir)}`, "Remove temporary artifact directory");
  }
}
if (log.code !== 0)
  return {
    jobId,
    repo,
    job,
    result: "log-error",
    categories: [],
    findings: [],
    nextActions: [],
    artifact,
    log,
  };
const text = `${job.name}\n${log.stdout}\n${log.stderr}`;
const findings = [];
const add = (type, detail, suggestion) =>
  findings.push({ type, detail: detail.slice(0, 4000), suggestion: suggestion.slice(0, 1000) });
const signalled = (artifact?.failures ?? []).filter((failure) => failure.signal);
if (signalled.length)
  add(
    "process-signal",
    `A captured command ended with ${signalled[0].signal}.`,
    "Inspect timeout and resource evidence before changing behavior or retrying the same commit.",
  );
if (/AssertionError|Test timed out|Failed Tests|Vitest|Tests?\s+\d+\s+failed/i.test(text))
  add(
    "test-failure",
    "A test assertion, timeout, or Vitest failure was reported.",
    "Run the named failing test in its Vitest project and inspect the first assertion or timeout.",
  );
const onboard = text.match(/FAIL: (src\/lib\/onboard\.ts) grew by (\d+) line\(s\)\./);
if (onboard)
  add(
    "onboard-entrypoint-growth",
    `${onboard[1]} grew by ${onboard[2]} line(s).`,
    "Move new logic under src/lib/onboard/ or make the entry point net-neutral or smaller.",
  );
if (/FAIL: this PR adds JavaScript source files/i.test(text))
  add(
    "new-javascript-source",
    "The PR adds JavaScript source files.",
    "Use TypeScript for new Node.js source, test, and script files.",
  );
if (/Source architecture budget failed/i.test(text))
  add(
    "source-architecture-budget",
    "Source architecture budget failed.",
    "Reduce imports or exports, move code behind an existing boundary, or lower a limit only when measured debt decreases.",
  );
if (/Source-shape test budget|source-shape exception|source_shape/i.test(text))
  add(
    "source-shape-budget",
    "The source-shape test budget failed.",
    "Prefer behavior tests; otherwise repair the documented source-shape contract and its narrow budget entry.",
  );
if (/NEMOCLAW_\* env-var documentation gate[\s\S]*(Failed|FAIL|missing|undocumented)/i.test(text))
  add(
    "env-var-documentation",
    "The environment-variable documentation gate failed.",
    "Document the new NEMOCLAW_* variable in the required reference or remove it.",
  );
if (
  /reviewed-npm-audit/i.test(job.name) ||
  /reviewed npm audit|npm audit report|audit-reviewed-npm-graph/i.test(text)
)
  add(
    "reviewed-npm-audit",
    "The reviewed npm audit check reported advisory drift.",
    "Determine whether this is live advisory drift or update the reviewed baseline through the security process.",
  );
if (/docs-review|Documentation writer review/i.test(text))
  add(
    "docs-review-receipt",
    "The documentation writer review receipt failed.",
    "Rerun the review for the current commit and refresh both hidden SHA fields.",
  );
if (/Fern validation|check-docs|npm run docs/i.test(text))
  add(
    "docs-validation",
    "Documentation validation failed.",
    "Run npm run docs and fix the reported route, frontmatter, or MDX error.",
  );
if (/hadolint|DL\d{4}/.test(text))
  add(
    "hadolint",
    "Hadolint reported a Dockerfile diagnostic.",
    "Fix the Dockerfile diagnostic or use a narrow policy-approved ignore.",
  );
if (/shellcheck|SC\d{4}/i.test(text))
  add(
    "shellcheck",
    "ShellCheck reported a shell diagnostic.",
    "Run the targeted ShellCheck and shfmt checks and fix the diagnostic.",
  );
if (/PR review advisor/i.test(job.name) && /Nemotron 3 Ultra|second-opinion/i.test(text))
  add(
    "advisor-second-opinion",
    "The Nemotron second-opinion check reported a failure.",
    "Treat it as advisory unless the primary advisor or a maintainer identifies a concrete blocker.",
  );
const boundedFindings = findings.slice(0, 20);
return {
  jobId,
  repo,
  job,
  result: boundedFindings.length ? "classified" : "unclassified",
  categories: [...new Set(boundedFindings.map((item) => item.type))],
  findings: boundedFindings,
  nextActions: [...new Set(boundedFindings.map((item) => item.suggestion))],
  artifact,
  log,
};
