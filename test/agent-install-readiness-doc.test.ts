// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const readinessDoc = readFileSync(
  join(process.cwd(), "docs/resources/agent-install-readiness.mdx"),
  "utf8",
);

describe("agent install readiness docs", () => {
  it("keeps the #5051 validation matrix grounded in the accepted workflows", () => {
    const headings = [...readinessDoc.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "Validation Scope",
      "Baseline Workflow",
      "Improved Workflow",
      "Evidence To Record",
      "Pass Criteria",
    ]);

    const frontmatter = readinessDoc.match(/^---\n(?<body>[\s\S]+?)\n---/)?.groups?.body ?? "";
    expect(frontmatter).toContain('title: "Validate Agent-Supported Install Readiness"');
    expect(frontmatter).toContain("issue #5051");

    const skillStateRows = [...readinessDoc.matchAll(/^\| (Skills [^|]+) \|/gm)].map(
      (match) => match[1],
    );
    expect(skillStateRows).toEqual(["Skills already available", "Skills missing"]);
    expect(readinessDoc).toMatch(/^\| Stale skills \|/m);

    const baselineIds = [...readinessDoc.matchAll(/^\| (B\d) \|/gm)].map((match) => match[1]);
    const improvedIds = [...readinessDoc.matchAll(/^\| (I\d) \|/gm)].map((match) => match[1]);
    expect(baselineIds).toEqual(["B1", "B2", "B3", "B4"]);
    expect(improvedIds).toEqual(["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8"]);
  });
});
