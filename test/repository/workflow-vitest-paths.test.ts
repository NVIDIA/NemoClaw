// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_ROOTS = [".github/actions", ".github/workflows"];
const TEST_PATH_PATTERN = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.test\.(?:[cm]?js|[cm]?ts)\b/gu;

function noWorkflowTestReferences(): never {
  throw new Error("GitHub workflows contain no literal Vitest test paths");
}

function collectWorkflowTestReferences(workflowRoots: readonly string[]) {
  const references = workflowRoots
    .flatMap((workflowRoot) =>
      fs
        .globSync(["**/*.yaml", "**/*.yml"], { cwd: workflowRoot })
        .map((workflowPath) => path.join(workflowRoot, workflowPath)),
    )
    .flatMap((workflowPath) => {
      const source = fs.readFileSync(workflowPath, "utf8");
      return Array.from(source.matchAll(TEST_PATH_PATTERN), (match) => ({
        testPath: match[0],
        workflowPath,
      }));
    });
  references[0] ?? noWorkflowTestReferences();
  return references;
}

const WORKFLOW_TEST_REFERENCES = collectWorkflowTestReferences(WORKFLOW_ROOTS);

describe("GitHub workflow Vitest paths", () => {
  it("rejects workflow inventories without literal test references", () => {
    const workflowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-workflow-paths-"));
    try {
      fs.writeFileSync(path.join(workflowRoot, "empty.yaml"), "jobs: {}\n");
      expect(() => collectWorkflowTestReferences([workflowRoot])).toThrow(
        "GitHub workflows contain no literal Vitest test paths",
      );
    } finally {
      fs.rmSync(workflowRoot, { force: true, recursive: true });
    }
  });

  it("discovers co-located source test references", () => {
    const source = "npx vitest run smoke.test.ts src/lib/onboard/preflight.test.ts";
    expect(Array.from(source.matchAll(TEST_PATH_PATTERN), (match) => match[0])).toEqual([
      "smoke.test.ts",
      "src/lib/onboard/preflight.test.ts",
    ]);
  });

  it.each(WORKFLOW_TEST_REFERENCES)(
    "references existing $testPath from $workflowPath",
    ({ testPath }) => {
      expect(fs.existsSync(testPath)).toBe(true);
    },
  );
});
