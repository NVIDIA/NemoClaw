// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INVENTORY_PATH = path.resolve(import.meta.dirname, "../migration/legacy-inventory.json");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LEGACY_E2E_DIR = path.join(REPO_ROOT, "test/e2e");
const EXPECTED_STATUS_VALUES = ["not-migrated", "bridge-probe", "covered", "retired"] as const;

type MigrationStatus = "not-migrated" | "bridge-probe" | "covered" | "retired";

interface LegacyInventoryEntry {
  legacyScript: string;
  domain: string;
  ownerIssue: string;
  status: MigrationStatus;
  targetVitestScenarios: string[];
  bridgeProbes: string[];
  retiredReason: string;
  deletionReady: boolean;
  deletionApprovalIssue?: string;
  notes: string;
}

interface LegacyInventory {
  version: number;
  statusValues: MigrationStatus[];
  deletionReadiness: {
    requires: string[];
  };
  entries: LegacyInventoryEntry[];
}

function loadInventory(): LegacyInventory {
  return JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8")) as LegacyInventory;
}

function repoPathExists(repoRelativePath: string): boolean {
  expect(path.isAbsolute(repoRelativePath)).toBe(false);
  expect(repoRelativePath).not.toContain("..");

  return fs.existsSync(path.join(REPO_ROOT, repoRelativePath));
}

function listLegacyShellEntrypoints(): string[] {
  return fs
    .readdirSync(LEGACY_E2E_DIR)
    .filter((name) => /^test-.*\.sh$/.test(name))
    .map((name) => `test/e2e/${name}`)
    .sort();
}

describe("E2E migration inventory deletion gates", () => {
  it("uses a constrained migration vocabulary with owning issues", () => {
    const inventory = loadInventory();
    const statuses = new Set(inventory.statusValues);
    const legacyScripts = new Set<string>();

    expect(inventory.version).toBe(1);
    expect(inventory.statusValues).toEqual([...EXPECTED_STATUS_VALUES]);
    expect(inventory.deletionReadiness.requires.length).toBeGreaterThan(0);
    expect(inventory.entries.length).toBeGreaterThan(0);

    for (const entry of inventory.entries) {
      expect(statuses.has(entry.status)).toBe(true);
      expect(entry.legacyScript).not.toBe("");
      expect(repoPathExists(entry.legacyScript)).toBe(true);
      expect(legacyScripts.has(entry.legacyScript)).toBe(false);
      legacyScripts.add(entry.legacyScript);
      expect(entry.domain).not.toBe("");
      expect(entry.ownerIssue).toMatch(/^#(?:3588|434[7-9]|435[0-7]|4941)$/);
      expect(entry.notes).not.toBe("");
    }
  });

  it("covers every current direct legacy shell entrypoint", () => {
    const inventory = loadInventory();
    const inventoriedShellScripts = inventory.entries
      .map((entry) => entry.legacyScript)
      .filter((legacyScript) => /^test\/e2e\/test-.+\.sh$/.test(legacyScript))
      .sort();

    expect(inventoriedShellScripts).toEqual(listLegacyShellEntrypoints());
  });

  it("requires coverage, retirement evidence, and #4357 approval before deletion", () => {
    const inventory = loadInventory();

    for (const entry of inventory.entries) {
      if (entry.status === "covered") {
        expect(entry.targetVitestScenarios.length).toBeGreaterThan(0);
        for (const scenario of entry.targetVitestScenarios) {
          expect(scenario).toMatch(/^test\/e2e-scenario\/live\/.+\.test\.ts$/);
          expect(repoPathExists(scenario)).toBe(true);
        }
      }

      if (entry.status === "bridge-probe") {
        expect(entry.bridgeProbes.length).toBeGreaterThan(0);
        for (const probe of entry.bridgeProbes) {
          expect(repoPathExists(probe)).toBe(true);
        }
      }

      if (entry.status === "retired") {
        expect(entry.retiredReason).not.toBe("");
      }

      if (entry.deletionReady) {
        expect(["covered", "retired"]).toContain(entry.status);
        expect(entry.deletionApprovalIssue).toBe("#4357");
        expect(
          entry.status === "retired" ? entry.retiredReason : entry.targetVitestScenarios.length,
        ).toBeTruthy();
      }
    }
  });
});
