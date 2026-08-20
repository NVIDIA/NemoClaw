// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 100)
  throw new Error("files must contain 1 to 100 test files");
const allowed = new Set([
  "cli",
  "integration",
  "installer-integration",
  "package-contract",
  "plugin",
  "e2e-support",
]);
if (input.projects && (!Array.isArray(input.projects) || input.projects.length > 6))
  throw new Error("projects must contain at most 6 entries");
const projects = input.projects?.length ? [...new Set(input.projects)] : ["cli", "integration"];
const invalid = projects.filter((x) => !allowed.has(x));
if (invalid.length) throw new Error(`Unsupported Vitest project(s): ${invalid.join(", ")}`);
const repoRelative = (value, maxLength) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxLength &&
  !value.startsWith("-") &&
  !value.startsWith("/") &&
  !value.split("/").some((part) => part === ".." || part === ".") &&
  /^[A-Za-z0-9_./@-]+$/.test(value);
if (!input.files.every((x) => repoRelative(x, 4096)))
  throw new Error(
    "Test files must be non-option repository-relative paths of at most 4096 characters",
  );
if (!projects.every((x) => repoRelative(x, 128)))
  throw new Error(
    "Vitest projects must be non-option repository-relative names of at most 128 characters",
  );
const quote = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const args = ["vitest", "run", ...projects.flatMap((x) => ["--project", x]), ...input.files];
if (input.coverage)
  args.push(
    "--coverage",
    "--coverage.reporter=json-summary",
    "--coverage.reportsDirectory=coverage/targeted",
    "--coverage.include=bin/**/*.js",
    "--coverage.include=src/**/*.ts",
    "--coverage.exclude=test/**/*.js",
    "--coverage.exclude=test/**/*.ts",
  );
const timeoutMs = Math.max(30000, Math.min(300000, input.timeoutMs ?? 180000));
const maxLines = Math.max(1, Math.min(500, input.maxLines ?? 120));
const clipMode = input.clipMode ?? "tail";
if (!new Set(["head", "tail"]).has(clipMode)) throw new Error("clipMode must be head or tail");
const clip = (value) => {
  const lines = String(value).split(/\r?\n/);
  const clipped = lines.length > maxLines;
  const kept = clipMode === "head" ? lines.slice(0, maxLines) : lines.slice(-maxLines);
  return { text: kept.join("\n"), totalLines: lines.length, returnedLines: kept.length, clipped };
};
const command = "npx " + args.map(quote).join(" ");
const result = await tools.bash({
  command,
  workdir: input.workdir,
  description: "Run selected Vitest files",
  timeoutMs,
});
if (result.kind !== "foreground") throw new Error("Unexpected background result");
const stdout = clip(result.stdout.text);
const stderr = clip(result.stderr.text);
const truncated =
  result.stdout.truncated || result.stderr.truncated || stdout.clipped || stderr.clipped;
return {
  command,
  code: result.exitCode ?? -1,
  stdout: stdout.text,
  stderr: stderr.text,
  truncated,
  truncationNotice: truncated
    ? "TRUNCATED OUTPUT: do not assume omitted test output is irrelevant or absent."
    : null,
  truncationReasons: [
    ...(result.stdout.truncated || result.stderr.truncated ? ["tool-transport-truncated"] : []),
    ...(stdout.clipped ? ["stdout-exceeded-maxLines"] : []),
    ...(stderr.clipped ? ["stderr-exceeded-maxLines"] : []),
  ],
  clipMode,
  maxLines,
  stdoutTotalLines: stdout.totalLines,
  stdoutReturnedLines: stdout.returnedLines,
  stderrTotalLines: stderr.totalLines,
  stderrReturnedLines: stderr.returnedLines,
};
