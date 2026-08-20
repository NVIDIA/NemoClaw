// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
const jobId = String(input.jobId);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^\d+$/.test(jobId) || jobId === "0") throw new Error("jobId must be positive");
const tailLines = Math.max(20, Math.min(500, input.tailLines ?? 180));
const contextLines = Math.max(0, Math.min(80, input.contextLines ?? 40));
const pattern = input.pattern ?? "";
if (pattern.length > 500) throw new Error("pattern is too long");
let matcher;
try {
  matcher = new RegExp(pattern, "iu");
} catch (error) {
  throw new Error(`Invalid pattern: ${String(error)}`);
}
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
const temporary = await run(
  'umask 077; mktemp -d "${TMPDIR:-/tmp}/nemoclaw-job-log.XXXXXX"',
  "Create temporary job log directory",
);
if (temporary.exitCode !== 0) throw new Error("Could not create temporary job log directory");
const directory = temporary.stdout.text.trim();
if (!directory) throw new Error("Could not create temporary job log directory");
let code = -1;
let stderr = "";
let lines = [];
let sourceTruncated = false;
try {
  const rawPath = directory + "/job.log";
  const boundedPath = directory + "/job.tail.log";
  const downloaded = await run(
    `gh api ${q(`repos/${repo}/actions/jobs/${jobId}/logs`)} > ${q(rawPath)}`,
    "Download GitHub Actions job log",
    60000,
  );
  code = downloaded.exitCode ?? -1;
  stderr = redact(downloaded.stderr.text).slice(-12000);
  if (code === 0) {
    const bounded = await run(
      `bytes=$(wc -c < ${q(rawPath)}); lines=$(wc -l < ${q(rawPath)}); if [ "$bytes" -gt 4000000 ]; then tail -c 4000000 ${q(rawPath)} | sed '1d'; else cat -- ${q(rawPath)}; fi | tail -n 20000 > ${q(boundedPath)}; printf '%s %s' "$bytes" "$lines"`,
      "Bound downloaded GitHub job log",
    );
    if (bounded.exitCode !== 0) throw new Error("Could not bound downloaded job log");
    const [byteText, lineText] = bounded.stdout.text.trim().split(/\s+/, 2);
    const byteCount = Number(byteText);
    const lineCount = Number(lineText);
    sourceTruncated =
      (Number.isFinite(byteCount) && byteCount > 4000000) ||
      (Number.isFinite(lineCount) && lineCount > 20000);
    const content = await tools.read({ file_path: boundedPath, limit: 20000 });
    lines = content.lines.map((line) => line.text);
    sourceTruncated ||= content.totalLines > content.lines.length;
  }
} finally {
  await run(`rm -rf -- ${q(directory)}`, "Remove temporary job log directory");
}
let matchedLines = 0;
let selected = lines;
if (pattern) {
  const indexes = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!matcher.test(lines[index])) continue;
    matchedLines += 1;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length, index + contextLines + 1);
    for (let selectedIndex = start; selectedIndex < end; selectedIndex += 1)
      indexes.add(selectedIndex);
  }
  selected = [...indexes].sort((a, b) => a - b).map((index) => lines[index]);
}
const candidates = selected.slice(-tailLines);
const output = [];
let size = 0;
for (let index = candidates.length - 1; index >= 0; index -= 1) {
  const line = candidates[index].slice(0, 4000);
  if (size + line.length + 1 > 40000) break;
  output.push(line);
  size += line.length + 1;
}
output.reverse();
return {
  jobId,
  repo,
  pattern: input.pattern ?? null,
  code,
  truncated: sourceTruncated || selected.length > output.length,
  matchedLines,
  stdout: redact(output.join("\n")),
  stderr,
};
