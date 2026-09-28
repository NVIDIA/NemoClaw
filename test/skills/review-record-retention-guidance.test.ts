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
  it("prohibits point-in-time review records and preserves executable evidence", () => {
    expect(retentionSection).toBeDefined();
    expect(retentionSection).toMatch(
      /do not commit.*release ledgers.*concern records.*review reports.*qualification reports.*anywhere in the repository/i,
    );
    expect(retentionSection).toMatch(/durable claims.*executable configuration and tests/i);
    expect(retentionSection).toMatch(/canonical .*docs\/.*current supported behavior/i);
    expect(retentionSection).toMatch(/historical executable fixtures.*current test/i);
  });

  it("distinguishes point-in-time dependency reports from maintained contracts", () => {
    expect(retentionSection).toMatch(
      /do not commit or update point-in-time.*dependency-review reports/i,
    );
    expect(retentionSection).toMatch(
      /does not apply.*durable.*code-synchronized dependency contract documents/i,
    );
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
