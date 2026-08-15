// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeReviewResult,
  parseSecurityRubric,
  readTrustedSecurityRubric,
} from "../tools/pr-review-advisor/analyze.mts";
import { metadata, ROOT, validResult } from "./helpers/pr-review-advisor-test-fixtures.ts";

describe("canonical security rubric", () => {
  it("owns exactly nine ordered categories and the lifecycle evidence contract", () => {
    const rubric = readTrustedSecurityRubric();
    const parsed = parseSecurityRubric(rubric);

    expect(parsed.categories).toHaveLength(9);
    expect(new Set(parsed.categories)).toHaveLength(9);
    expect(parsed.categories[0]).toBe("Secrets and Credentials");
    expect(parsed.categories.at(-1)).toBe("System Security");
    expect(rubric).toContain("Planning names the applicable risks");
    expect(rubric).toContain("Implementation records the controls that changed");
    expect(rubric).toContain("focused negative evidence");
    expect(rubric).toContain(
      "Does the test include the component that enforces the control, or does mocking bypass that component?",
    );
    expect(rubric.match(/^### Expected evidence$/gmu)).toHaveLength(9);
  });

  it("keeps review procedure in the skill and category definitions only in the rubric", () => {
    const skill = fs.readFileSync(
      path.join(ROOT, ".agents", "skills", "nemoclaw-maintainer-security-code-review", "SKILL.md"),
      "utf8",
    );
    const advisor = fs.readFileSync(
      path.join(ROOT, "tools", "pr-review-advisor", "analyze.mts"),
      "utf8",
    );
    const bootstrap = fs.readFileSync(
      path.join(ROOT, "tools", "pr-review-advisor", "run-analysis.mts"),
      "utf8",
    );

    expect(skill).toContain("../_shared/security-rubric.md");
    expect(skill).toContain("Use **PASS**");
    expect(skill).toContain("## Step 6: Produce the Report");
    expect(skill).not.toMatch(/^### Category \d+:/mu);
    expect(advisor).not.toContain("use this built-in 9-category security rubric instead");
    expect(advisor).not.toContain("nemoclaw-maintainer-security-code-review/SKILL.md");
    expect(`${advisor}\n${bootstrap}`).not.toContain(["Holistic", "Security", "Posture"].join(" "));
  });

  it("round-trips every rubric category without replacing System Security", () => {
    const categories = parseSecurityRubric(readTrustedSecurityRubric()).categories;
    const securityCategories = categories.map((category, index) => ({
      category,
      verdict: index === 8 ? "fail" : index % 2 === 0 ? "pass" : "warning",
      justification: `evidence-${index + 1}`,
    }));

    const result = normalizeReviewResult(validResult({ securityCategories }), metadata());

    expect(result.securityCategories).toEqual(securityCategories);
    expect(result.securityCategories.at(-1)).toEqual({
      category: "System Security",
      verdict: "fail",
      justification: "evidence-9",
    });
  });
});
