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
  path.join(repoRoot, "docs", "security", "fern-5.80.1-dependency-review.md"),
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
      tableRows("Reviewed identities").map(([label, value]) => [label, value]),
    );

    expect(fernConfig.version).toBe("5.80.1");
    expect(identities["Target package"]).toBe("`fern-api@5.80.1`");
    expect(identities["Target source commit"]).toBe("`76de91e1216afbdb56a36d3389ee6b91d3e59a9e`");
    expect(identities["Target integrity"]).toBe(
      "`sha512-1GZglZnA8T1JogREverqNwIY5G9e3e6uRHv1bpMjX0iIJVr+Dh+5MMPSBq6NegTmBjppqRHF6PVNbnuuO9VfRA==`",
    );
    expect(identities["Target SHA-1"]).toBe("`a06a295390f91b8bbd42de56d0d481f545642595`");
  });

  it("records complete range, closure, and concern dispositions", () => {
    const ranges = tableRows("Complete source range ledger");
    const concerns = tableRows("Concern ledger");

    expect(ranges).toHaveLength(21);
    expect(ranges.reduce((total, [, commits]) => total + Number(commits), 0)).toBe(225);
    expect(review).toMatch(/Each\s+graph contains 11 packages/);
    expect(review).toContain("zero info, low, moderate, high, or critical findings");
    expect(review).toContain("Unresolved high-severity concerns: `0`");
    expect(concerns.map(([id]) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `\`FERN-${index + 1}\``),
    );
    expect(concerns.every((row) => row.length === 4 && row.every(Boolean))).toBe(true);
  });
});
