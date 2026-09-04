// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSystemPrompt,
  readTrustedSecurityRubric,
} from "../../../tools/pr-review-advisor/trusted-guidance.mts";
const ROOT = path.resolve(import.meta.dirname, "../../..");

describe("PR review advisor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });


  it("loads the security rubric from the trusted module checkout, not cwd", () => {
    const originalCwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-cwd-"));
    const rubricDir = path.join(tmp, ".agents", "skills", "_shared");
    fs.mkdirSync(rubricDir, { recursive: true });
    fs.writeFileSync(path.join(rubricDir, "security-rubric.md"), "# PR-controlled rubric\n");

    try {
      process.chdir(tmp);
      const rubric = readTrustedSecurityRubric();
      expect(rubric).toContain("## Category 9: System Security");
      expect(rubric).not.toContain("PR-controlled rubric");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("embeds the complete trusted security rubric in the model prompt", () => {
    const rubric = readTrustedSecurityRubric();

    expect(buildSystemPrompt()).toContain(rubric);
  });

  it("reports a missing trusted security rubric", () => {
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("missing rubric fixture");
    });

    expect(() => readTrustedSecurityRubric()).toThrow("Security rubric unavailable");
  });

  it.each([
    [
      "a missing category",
      (rubric: string) => rubric.replace(/## Category 5:.*?(?=## Category 6:)/su, ""),
      "must define exactly 9 categories",
    ],
    [
      "an out-of-order category",
      (rubric: string) => rubric.replace("## Category 2:", "## Category 3:"),
      "category 2 has a malformed heading",
    ],
    [
      "a duplicate category name",
      (rubric: string) =>
        rubric.replace("## Category 2: Input Validation and Data Sanitization", "## Category 2: Secrets and Credentials"),
      "category names must be unique",
    ],
    [
      "an empty category section",
      (rubric: string) =>
        rubric.replace(
          /### Meaning\n\nKeep credentials[^\n]*\n/u,
          "### Meaning\n\n",
        ),
      "category 1 has empty Meaning",
    ],
    [
      "a different final category",
      (rubric: string) => rubric.replace("## Category 9: System Security", "## Category 9: Host Security"),
      "category 9 must be System Security",
    ],
    [
      "reordered category subsections",
      (rubric: string) =>
        rubric
          .replace("### Meaning", "### Temporary")
          .replace("### Questions", "### Meaning")
          .replace("### Temporary", "### Questions"),
      "must define Meaning, Questions, and Expected evidence in order",
    ],
  ])("rejects a trusted security rubric with %s", (_case, mutate, message) => {
    const malformed = mutate(readTrustedSecurityRubric());
    vi.spyOn(fs, "readFileSync").mockReturnValueOnce(malformed);

    expect(() => readTrustedSecurityRubric()).toThrow(message);
  });

});
