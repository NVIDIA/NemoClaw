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
const command = "npx " + args.map(quote).join(" ");
const result = await tools.bash({
  command,
  workdir: input.workdir,
  description: "Run selected Vitest files",
  timeoutMs,
});
if (result.kind !== "foreground") throw new Error("Unexpected background result");
return {
  command,
  code: result.exitCode ?? -1,
  stdout: result.stdout.text,
  stderr: result.stderr.text,
  truncated: result.stdout.truncated || result.stderr.truncated,
};
