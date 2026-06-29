// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCENARIO_SUITE_DIR = path.join(REPO_ROOT, "test/e2e-scenario");
const MIGRATION_DOC = path.join(SCENARIO_SUITE_DIR, "docs", "MIGRATION.md");
const README_DOC = path.join(SCENARIO_SUITE_DIR, "docs", "README.md");
const RETIREMENT_DOC = path.join(SCENARIO_SUITE_DIR, "docs", "RETIREMENT.md");
const FORBIDDEN_LEGACY_LEDGER = path.join(SCENARIO_SUITE_DIR, "migration", "legacy-inventory.json");
const FORBIDDEN_LEGACY_ASSERTION_LEDGER = path.join(
  REPO_ROOT,
  "test",
  "e2e",
  "docs",
  "parity-inventory.generated.json",
);

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

describe("E2E migration tracking policy", () => {
  it("does not use a repo-local JSON ledger as durable migration state", () => {
    expect(fs.existsSync(FORBIDDEN_LEGACY_LEDGER)).toBe(false);
    expect(fs.existsSync(FORBIDDEN_LEGACY_ASSERTION_LEDGER)).toBe(false);
  });

  it("documents GitHub issues and PRs as the migration source of truth", () => {
    const docs = [MIGRATION_DOC, README_DOC, RETIREMENT_DOC].map(read).join("\n");

    expect(docs).toContain("GitHub issues and pull requests");
    expect(docs).toContain("source of truth");
    expect(docs).toContain("replacement Vitest coverage");
    expect(docs).toContain("nightly-e2e.yaml");
    expect(docs).toContain("allowlist test");
    expect(docs).toContain("workflow contract test");
    expect(docs).toContain("machine-checkable boundary is the source tree plus workflow tests");
    expect(docs).toContain("generated legacy assertion inventories");
    expect(docs).toMatch(/not a test\s+harness or runner/);
    expect(docs).not.toContain("Legacy E2E deletion evidence");
    expect(docs).not.toContain("Fidelity verification");
  });

  it("keeps durable taxonomy out of the repo-local migration docs", () => {
    const docs = [MIGRATION_DOC, README_DOC, RETIREMENT_DOC].map(read).join("\n");

    expect(docs).not.toMatch(/\bKEEP_BASH\b/);
    expect(docs).not.toMatch(/\bHYBRID\b/);
    expect(docs).not.toMatch(/\bMIGRATE_TYPED\b/);
    expect(docs).not.toMatch(/\bnot-migrated\b/);
    expect(docs).not.toMatch(/\bbridge-probe\b/);
    expect(docs).not.toMatch(/\bdeletionReady\b/);
  });
});
