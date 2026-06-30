// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_SUITE_DIR = path.join(REPO_ROOT, "test/e2e");
const LIVE_TEST_DIR = path.join(E2E_SUITE_DIR, "live");
const MIGRATION_DOC = path.join(E2E_SUITE_DIR, "docs", "MIGRATION.md");
const README_DOC = path.join(E2E_SUITE_DIR, "docs", "README.md");
const FORBIDDEN_MUTABLE_MIGRATION_MODULE = path.join(
  E2E_SUITE_DIR,
  "targets",
  "migration-inventory.ts",
);

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

describe("E2E migration source-of-truth hygiene", () => {
  it("keeps mutable migration status out of the target source tree", () => {
    expect(fs.existsSync(FORBIDDEN_MUTABLE_MIGRATION_MODULE)).toBe(false);
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

  it("keeps shell quoting centralized after the migration helper audit", () => {
    const localDefinitions = fs
      .readdirSync(LIVE_TEST_DIR, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
      .filter((entry) =>
        /\b(?:function|const)\s+shellQuote\b/u.test(read(path.join(LIVE_TEST_DIR, entry))),
      );

    expect(
      localDefinitions,
      "Import shellQuote from test/e2e/fixtures/clients/command.ts instead of adding a local copy",
    ).toEqual([]);
  });
});
