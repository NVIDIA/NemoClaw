// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const skill = fs.readFileSync(
  path.join(repoRoot, ".agents", "skills", "nemoclaw-contributor-update-dependencies", "SKILL.md"),
  "utf8",
);
const retentionSection = skill
  .split("## Keep Point-in-Time Review Records out of the Repository", 2)[1]
  ?.split("\n## ", 1)[0]
  ?.replace(/\s+/g, " ")
  .trim();

describe("dependency review record retention guidance", () => {
  it("prohibits point-in-time review records without historical-fixture loopholes", () => {
    expect(retentionSection).toBeDefined();
    expect(retentionSection).toMatch(
      /do not commit.*release ledgers.*concern records.*review reports.*qualification reports.*anywhere in the repository/i,
    );
    expect(retentionSection).toMatch(/outside the repository.*private permissions/i);
    expect(retentionSection).toMatch(/pull request.*conclusions.*supporting evidence/i);
    expect(retentionSection).toMatch(/durable claims.*executable configuration and tests/i);
    expect(retentionSection).toMatch(
      /canonical .*docs\/.*current supported behavior.*not review chronology/i,
    );
    expect(retentionSection).toMatch(/historical executable fixtures.*current test/i);
    expect(retentionSection).toMatch(
      /point-in-time review (?:records|evidence).*must not.*historical/i,
    );
    expect(retentionSection).toMatch(/renaming|relocating/);
    expect(retentionSection).toMatch(/does not create an exception/i);
  });

  it("does not track the retired review-ledger directory", () => {
    const retiredDirectory = ["internal", "security-reviews", "**"].join("/");
    const tracked = execFileSync("git", ["ls-files", retiredDirectory], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(tracked).toBe("");
  });
});
