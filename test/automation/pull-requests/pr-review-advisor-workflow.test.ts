// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

const advisorPath = join(process.cwd(), ".github/workflows/pr-review-advisor.yaml");

describe("PR Review Advisor workflow gate", () => {
  it.each([
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
      "analysis commit binding",
      "needs.require-green-checks.outputs.head_sha || ''",
      "needs.require-green-checks.outputs.base_sha || ''",
      "Unified advisor must prepare the PR revision from the successful checks run",
    ],
  ])("rejects removal of the %s", (_case, before, after, error) => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-pr-advisor-workflow-"));
    const mutatedPath = join(directory, "advisor.yaml");
    try {
      const source = readFileSync(advisorPath, "utf8");
      const mutated = source.replace(before, after);
      writeFileSync(mutatedPath, mutated);
      expect(validateE2eOperationsWorkflow(readE2eOperationsWorkflow(), mutatedPath)).toEqual(
        expect.arrayContaining([expect.stringContaining(error)]),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
