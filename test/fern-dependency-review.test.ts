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
  path.join(repoRoot, "docs", "security", "fern-5.92.2-dependency-review.md"),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const fernConsumerFiles = [
  ".github/workflows/docs-publish-public.yaml",
  ".github/workflows/docs-preview-pr.yaml",
  ".github/workflows/docs-publish-staging.yaml",
].map((filename) => readFileSync(path.join(repoRoot, filename), "utf8"));

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

    expect(fernConfig.version).toBe("5.92.2");
    expect(identities["Target package"]).toBe("`fern-api@5.92.2`");
    expect(identities["Target source commit"]).toBe("`ac0f7cf4247e8bcab09bef82be01b083d83f502e`");
    expect(identities["Target integrity"]).toBe(
      "`sha512-a6mpETDVxEAABuBTMbo0my/Z8PGZBWvs95MCFnHUhWQne5fLbNSri/2FJrsLOZBhuBJ7MLg9ebpnCTE4kywoVA==`",
    );
    expect(identities["Target SHA-1"]).toBe("`a8b9bd143c2ad08b704eee9b4b331fd60c3f92fc`");
  });

  it("records complete range, closure, and concern dispositions", () => {
    const ranges = tableRows("Complete source range ledger");
    const concerns = tableRows("Concern ledger");

    expect(ranges).toHaveLength(26);
    expect(ranges.reduce((total, [, commits]) => total + Number(commits), 0)).toBe(188);
    expect(review).toMatch(/Each\s+resolved graph contains 11 package identities/);
    expect(review).toContain("zero info, low, moderate, high, or critical findings");
    expect(review).toContain("Unresolved high-severity concerns: `0`");
    expect(concerns.map(([id]) => id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `\`FERN-${index + 1}\``),
    );
    expect(concerns.every((row) => row.length === 4 && row.every(Boolean))).toBe(true);
  });

  // source-shape-contract: security -- Every Fern npx entry point must block package lifecycle scripts before jobs expose Fern credentials
  it("disables package lifecycle scripts for every Fern npx consumer", () => {
    for (const scriptName of ["docs:deps", "docs:validate", "docs:live"]) {
      expect(packageJson.scripts[scriptName]).toContain("npx --yes --ignore-scripts");
    }

    for (const source of fernConsumerFiles) {
      expect(source.match(/npx --yes(?:\s+\\\s*)? --ignore-scripts/gu)).not.toBeNull();
      expect(source).not.toMatch(/npx --yes(?:\s+\\\s*)? ["`]?fern-api@/u);
    }
  });
});
