// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveVitestWatchTests } from "../../test/helpers/vitest-watch-triggers.ts";

export const sourceProjects = ["cli", "integration", "plugin", "e2e-support"];

export function changedInputs(root: string, base = "HEAD"): string[] {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  // Resolve a commit before using user input as a diff operand.
  const commit = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    { cwd: root, encoding: "utf8" },
  ).trim();
  return [
    ...new Set([
      ...git("diff", "--name-only", "-z", commit, "--"),
      ...git("ls-files", "--others", "--exclude-standard", "-z"),
    ]),
  ];
}

export function relatedArguments(files: string[], extra: string[] = []): string[] {
  const inputs = [...new Set(files.flatMap((file) => [file, ...resolveVitestWatchTests(file)]))];
  if (!inputs.length) return [];
  if (inputs.some((file) => file.startsWith("-")))
    throw new Error("Input paths must not be command options");
  return [
    "related",
    ...inputs,
    "--run",
    "--passWithNoTests",
    ...sourceProjects.flatMap((project) => ["--project", project]),
    "--coverage=false",
    ...extra,
  ];
}

export function main(argv = process.argv.slice(2)): number {
  const baseArguments = argv.filter((arg) => arg.startsWith("--changed="));
  if (baseArguments.length > 1) throw new Error("Expected at most one --changed=BASE");
  const files = changedInputs(
    process.cwd(),
    baseArguments[0]?.slice("--changed=".length) || "HEAD",
  );
  const args = relatedArguments(
    files,
    argv.filter((arg) => !arg.startsWith("--changed=")),
  );
  const unmapped = files.filter(
    (file) => /\.(?:py|sh|lock|in|ya?ml)$/.test(file) && !resolveVitestWatchTests(file).length,
  );
  console.log(
    JSON.stringify({
      changedInputs: files,
      mappedTests: [...new Set(files.flatMap(resolveVitestWatchTests))],
      unmappedOpaqueInputs: unmapped,
    }),
  );
  if (!args.length) {
    console.log("No changed inputs; no tests executed.");
    return 0;
  }
  const started = performance.now();
  const result = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), ...args], {
    stdio: "inherit",
  });
  console.log(
    JSON.stringify({
      elapsedMs: Math.round(performance.now() - started),
      exitCode: result.status,
      signal: result.signal,
    }),
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Changed-test selection failed");
    process.exitCode = 1;
  }
}
