// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_SUITE_DIR = path.join(REPO_ROOT, "test", "e2e");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const REVIEW_ADVISOR_CONFIGS = [path.join(REPO_ROOT, ".coderabbit.yaml")];
const FORBIDDEN_WORKFLOW_REFERENCES = [
  ".github/workflows/e2e-script.yaml",
  ".github/actions/run-e2e-script",
  ".github/workflows/nightly-e2e.yaml",
  "nightly-e2e.yaml",
];

function workflowFiles(): string[] {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => path.join(WORKFLOWS_DIR, name));
}

describe("retired shell E2E entrypoints", () => {
  it("keeps shell E2E entrypoints out of test/e2e recursively", () => {
    const shellEntrypoints = fs
      .readdirSync(E2E_SUITE_DIR, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string")
      .filter((entry) => /^test-.*\.sh$/u.test(path.basename(entry)));

    expect(shellEntrypoints).toEqual([]);
  });

  it("keeps workflows from referencing retired shell lanes", () => {
    const workflowText = workflowFiles()
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");

    for (const reference of FORBIDDEN_WORKFLOW_REFERENCES) {
      expect(workflowText).not.toContain(reference);
    }
    expect(workflowText).not.toMatch(/test\/e2e\/test-[A-Za-z0-9_.-]+\.sh/u);
  });

  it("keeps review-advisor configuration from recommending retired shell lanes", () => {
    const advisorText = REVIEW_ADVISOR_CONFIGS.map((file) => fs.readFileSync(file, "utf8")).join(
      "\n",
    );

    for (const reference of FORBIDDEN_WORKFLOW_REFERENCES) {
      expect(advisorText).not.toContain(reference);
    }
    expect(advisorText).not.toMatch(/test\/e2e\/test-[A-Za-z0-9_.-]+\.sh/u);
  });
});
