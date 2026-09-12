// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listExecutionTargets, type E2eInventoryTarget } from "./target-inventory.mts";

type Job = { steps?: { run?: string }[] };
type Workflow = { jobs?: Record<string, Job> };

/** Inspect workflow consumers without running candidate commands or importing tests. */
export function reconcileWorkflowConsumers(
  workflows: ReadonlyMap<string, string>,
  targets: readonly E2eInventoryTarget[] = listExecutionTargets(),
  fileExists: (file: string) => boolean = fs.existsSync,
): string[] {
  const errors: string[] = [];
  const jobs = new Map<string, Job>();
  for (const [file, source] of workflows) {
    for (const [job, definition] of Object.entries((YAML.parse(source) as Workflow).jobs ?? {})) {
      jobs.set(`${file}:${job}`, definition);
    }
  }
  const registered = new Map<string, Set<string>>();
  const packagedTests = new Set<string>();
  for (const target of targets) {
    let owner: string;
    let tests: readonly string[];
    if (target.route === "workflow") {
      owner = `${target.definition.workflow}:${target.id}`;
      tests = target.definition.testFiles;
    } else if (target.route === "external-workflow") {
      owner = `${target.definition.workflow}:${target.definition.job}`;
      tests = target.definition.tests.map(({ file }) => file);
      const entrypoint = target.definition.entrypoint;
      if (entrypoint) {
        const runs = (jobs.get(owner)?.steps ?? []).map(({ run }) => run ?? "").join("\n");
        if (!fileExists(entrypoint) || !runs.includes(entrypoint)) {
          errors.push(
            `${target.id}: delegated entry point is missing from its workflow job: ${entrypoint}`,
          );
        }
      } else {
        const runs = (jobs.get(owner)?.steps ?? []).map(({ run }) => run ?? "").join("\n");
        for (const file of tests) {
          if (!/\b(?:vitest|live-vitest-invocation\.mts)\b/u.test(runs) || !runs.includes(file))
            errors.push(`${target.id}: workflow job no longer references ${file}`);
        }
      }
    } else if (target.route === "typed") {
      owner = ".github/workflows/e2e.yaml:live";
      tests = ["test/e2e/live/registry-targets.test.ts"];
    } else {
      continue;
    }
    if (!jobs.has(owner)) errors.push(`${target.id}: registered workflow job is missing: ${owner}`);
    const files = registered.get(owner) ?? new Set<string>();
    for (const file of tests) {
      if (!fileExists(file)) errors.push(`${target.id}: registered test file is missing: ${file}`);
      files.add(file);
      if (file.startsWith("test/e2e-runtime/")) packagedTests.add(file);
    }
    registered.set(owner, files);
  }
  for (const [owner, job] of jobs) {
    for (const { run = "" } of job.steps ?? []) {
      if (!/\b(?:vitest|live-vitest-invocation\.mts)\b/u.test(run)) continue;
      for (const [file] of run.matchAll(/test\/e2e(?:\/live|-runtime)\/[\w./-]+\.test\.ts/gu)) {
        if (!file.startsWith("test/e2e/live/") && !packagedTests.has(file)) continue;
        if (!registered.get(owner)?.has(file)) {
          errors.push(`${owner}: test consumer has no inventory route: ${file}`);
        }
      }
    }
  }
  return [...new Set(errors)].sort();
}

export function checkWorkflowConsumers(root: string): string[] {
  const workflows = new Map(
    [...fs.globSync(".github/workflows/*.{yaml,yml}", { cwd: root })].map((file) => [
      file,
      fs.readFileSync(path.join(root, file), "utf8"),
    ]),
  );
  return reconcileWorkflowConsumers(workflows, listExecutionTargets(), (file) =>
    fs.existsSync(path.join(root, file)),
  );
}
