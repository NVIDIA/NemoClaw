// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCENARIO_SUITE_DIR = path.join(REPO_ROOT, "test/e2e-scenario");
const MIGRATION_DOC = path.join(SCENARIO_SUITE_DIR, "docs", "MIGRATION.md");
const README_DOC = path.join(SCENARIO_SUITE_DIR, "docs", "README.md");
const MIGRATION_INVENTORY = path.join(SCENARIO_SUITE_DIR, "scenarios", "migration-inventory.ts");

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

describe("E2E migration tracking hygiene", () => {
  it("keeps mutable migration status out of the scenario source tree", () => {
    expect(fs.existsSync(MIGRATION_INVENTORY)).toBe(false);
  });

  it("documents that migration state lives in issues and PRs", () => {
    const migration = read(MIGRATION_DOC);
    const readme = read(README_DOC);

    expect(migration).toMatch(/tracked\s+outside the repository/);
    expect(migration).toContain("GitHub issues and pull requests");
    expect(readme).toMatch(/Migration status is tracked outside the repository/);
  });

  it("does not reintroduce stale per-script migration checklists", () => {
    const contents = `${read(MIGRATION_DOC)}\n${read(README_DOC)}`;

    expect(contents).not.toMatch(/\b\d+\s*\/\s*\d+ scripts migrated\b/i);
    expect(contents).not.toContain("Full deep migration");
    expect(contents).not.toContain("Per-script tracker");
    expect(contents).not.toContain("Merge gate:");
  });
});
