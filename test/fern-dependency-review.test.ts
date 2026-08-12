// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const fernConfig = JSON.parse(
  readFileSync(path.join(repoRoot, "fern", "fern.config.json"), "utf8"),
) as { version: string };
const review = readFileSync(
  path.join(repoRoot, "docs", "security", "fern-5.92.4-dependency-review.md"),
  "utf8",
);

function tableRows(sectionName: string): string[][] {
  const section = review.split(`## ${sectionName}\n`)[1]?.split(/\n## /u)[0];
  expect(section, `Missing review section: ${sectionName}`).toBeDefined();
  return (section ?? "")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

describe("Fern dependency review", () => {
  it("binds the production pin to the reviewed target artifact", () => {
    const identities = Object.fromEntries(
      tableRows("Reviewed Identities").map(([label, value]) => [label, value]),
    );

    expect(fernConfig.version).toBe("5.92.4");
    expect(identities["Target package"]).toBe("`fern-api@5.92.4`");
    expect(identities["Target source commit"]).toBe("`f501eb09d3a31776d54beaa70346af4174d09664`");
    expect(identities["Target integrity"]).toBe(
      "`sha512-+vOR7M+G98poLJTSnyx2gw3Si+5AT/cTF7yRAdFst+977+DsTxWmUDx4RtajvR75EFqEOERwUcmDDUa2vCUerw==`",
    );
    expect(identities["Target SHA-1"]).toBe("`fd89c28f9f72d41be7d0a021da3a0136f88027c9`");
  });

  it("records complete range, closure, and concern dispositions", () => {
    const ranges = tableRows("Complete Source Range Ledger");
    const concerns = tableRows("Concern Ledger");

    expect(ranges).toHaveLength(5);
    expect(ranges.reduce((total, [, commits]) => total + Number(commits), 0)).toBe(194);
    expect(review).toMatch(/Each\s+graph contains 11 packages/);
    expect(review).toContain("zero info, low, moderate, high, or critical findings");
    expect(review).toContain("Unresolved high-severity concerns: `0`");
    expect(concerns.map(([id]) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `\`FERN-${index + 1}\``),
    );
    expect(concerns.every((row) => row.length === 4 && row.every(Boolean))).toBe(true);
  });
});
