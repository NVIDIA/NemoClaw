// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

const run = "${{ github.run_id }}";
const attempt = "${{ github.run_attempt }}";
const temp = "${{ runner.temp }}";
const matrix = "${{ matrix.advisor.artifact_name }}";

it.each([
  [
    "context attempt suffix",
    `pr-review-advisor-context-${run}\n`,
    `pr-review-advisor-context-${run}-${attempt}\n`,
    "Unified advisor context artifact must survive failed-job and full reruns",
  ],
  [
    "context name attempt suffix",
    `name: pr-review-advisor-context-${run}\n          path: ${temp}`,
    `name: pr-review-advisor-context-${run}-${attempt}\n          path: ${temp}`,
    "Unified advisor context artifact must survive failed-job and full reruns",
  ],
  [
    "context overwrite",
    "overwrite: true",
    "overwrite: false",
    "Unified advisor context artifact must survive failed-job and full reruns",
  ],
  [
    "specialist attempt suffix",
    `${matrix}-${attempt}`,
    matrix,
    "Unified advisor specialist artifacts must be unique per rerun attempt",
  ],
  [
    "successful CI requirement",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.conclusion == 'failure'",
    "Unified advisor green checks gate must require",
  ],
  [
    "gate dependency",
    "needs: require-green-checks",
    "needs: []",
    "Unified advisor entry jobs must depend on the green checks gate",
  ],
  [
    "source commit binding",
    ".head.sha == $sha",
    ".head.sha != $sha",
    "Unified advisor green checks gate must retain .head.sha == $sha",
  ],
  [
    "source base binding",
    ".base.sha == $base_sha",
    ".base.sha != $base_sha",
    "Unified advisor green checks gate must retain .base.sha == $base_sha",
  ],
  [
    "analysis commit binding",
    "needs.require-green-checks.outputs.head_sha || ''",
    "needs.require-green-checks.outputs.base_sha || ''",
    "Unified advisor must prepare the PR revision from the successful checks run",
  ],
])("rejects an unsafe Advisor %s mutation", (_case, before, after, error) => {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-e2e-operations-"));
  const advisorPath = join(directory, "advisor.yaml");
  try {
    const source = readFileSync(
      join(process.cwd(), ".github/workflows/pr-review-advisor.yaml"),
      "utf8",
    );
    writeFileSync(advisorPath, source.replace(before, after));
    expect(validateE2eOperationsWorkflow(readE2eOperationsWorkflow(), advisorPath)).toEqual(
      expect.arrayContaining([expect.stringContaining(error)]),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
