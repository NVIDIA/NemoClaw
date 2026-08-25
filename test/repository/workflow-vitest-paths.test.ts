// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_ROOTS = [".github/actions", ".github/workflows"];
const TEST_PATH_PATTERN = /\btest\/[A-Za-z0-9_./-]+\.test\.(?:js|ts)\b/gu;

function yamlFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(candidate);
    return /\.ya?ml$/u.test(entry.name) ? [candidate] : [];
  });
}

describe("GitHub workflow Vitest paths", () => {
  it("references only test files that exist after repository moves", () => {
    const references = WORKFLOW_ROOTS.flatMap(yamlFiles).flatMap((workflowPath) => {
      const source = fs.readFileSync(workflowPath, "utf8");
      return Array.from(source.matchAll(TEST_PATH_PATTERN), (match) => ({
        testPath: match[0],
        workflowPath,
      }));
    });

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(
        fs.existsSync(reference.testPath),
        `${reference.workflowPath}: ${reference.testPath}`,
      ).toBe(true);
    }
  });
});
