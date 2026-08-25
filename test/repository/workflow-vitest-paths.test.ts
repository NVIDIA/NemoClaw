// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_ROOTS = [".github/actions", ".github/workflows"];
const TEST_PATH_PATTERN = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.test\.(?:[cm]?js|[cm]?ts)\b/gu;

function yamlFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory()
      ? yamlFiles(candidate)
      : /\.ya?ml$/u.test(entry.name)
        ? [candidate]
        : [];
  });
}

const WORKFLOW_TEST_REFERENCES = WORKFLOW_ROOTS.flatMap(yamlFiles).flatMap((workflowPath) => {
  const source = fs.readFileSync(workflowPath, "utf8");
  return Array.from(source.matchAll(TEST_PATH_PATTERN), (match) => ({
    testPath: match[0],
    workflowPath,
  }));
});

describe("GitHub workflow Vitest paths", () => {
  it("discovers literal test references", () => {
    expect(WORKFLOW_TEST_REFERENCES.length).toBeGreaterThan(0);
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
