// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INVENTORY_PATH = path.resolve(
  import.meta.dirname,
  "../migration/legacy-inventory.json",
);

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

describe("E2E migration inventory deletion gates", () => {
  it("uses a constrained migration vocabulary with owning issues", () => {
    const inventory = loadInventory();
    const statuses = new Set(inventory.statusValues);

    expect(inventory.version).toBe(1);
    expect(inventory.deletionReadiness.requires.length).toBeGreaterThan(0);
    expect(inventory.entries.length).toBeGreaterThan(0);

    for (const entry of inventory.entries) {
      expect(statuses.has(entry.status)).toBe(true);
      expect(entry.domain).not.toBe("");
      expect(entry.ownerIssue).toMatch(/^#(?:3588|434[7-9]|435[0-7]|4941)$/);
      expect(entry.notes).not.toBe("");
    }
  });

  it("requires coverage, retirement evidence, and #4357 approval before deletion", () => {
    const inventory = loadInventory();

    for (const entry of inventory.entries) {
      if (entry.status === "covered") {
        expect(entry.targetVitestScenarios.length).toBeGreaterThan(0);
        for (const scenario of entry.targetVitestScenarios) {
          expect(scenario).toMatch(/^test\/e2e-scenario\/live\/.+\.test\.ts$/);
        }
      }

      if (entry.status === "bridge-probe") {
        expect(entry.bridgeProbes.length).toBeGreaterThan(0);
      }

      if (entry.status === "retired") {
        expect(entry.retiredReason).not.toBe("");
      }

      if (entry.deletionReady) {
        expect(["covered", "retired"]).toContain(entry.status);
        expect(entry.deletionApprovalIssue).toBe("#4357");
        expect(entry.status === "retired" ? entry.retiredReason : entry.targetVitestScenarios.length).toBeTruthy();
      }
    }
  });
});
