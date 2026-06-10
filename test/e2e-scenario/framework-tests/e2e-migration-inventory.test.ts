// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INVENTORY_PATH = path.resolve(import.meta.dirname, "../migration/legacy-inventory.json");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LEGACY_E2E_DIR = path.join(REPO_ROOT, "test/e2e");
const EXPECTED_STATUS_VALUES = ["not-migrated", "bridge-probe", "covered", "retired"] as const;
const INTERNAL_SURFACE_ROOTS = [
  "test/e2e-scenario/nemoclaw_scenarios",
  "test/e2e-scenario/onboarding_assertions",
  "test/e2e-scenario/runtime/lib",
  "test/e2e-scenario/runtime/reports",
  "test/e2e-scenario/scenarios/orchestrators",
  "test/e2e-scenario/validation_suites",
] as const;

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

interface LegacyInternalSurface {
  id: string;
  paths: string[];
  domain: string;
  ownerIssue: string;
  status: MigrationStatus;
  replacementSurface: string;
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
  internalSurfaces: LegacyInternalSurface[];
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

function listRepoFilesUnder(repoRelativeDir: string): string[] {
  const absoluteDir = path.join(REPO_ROOT, repoRelativeDir);
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        visit(absolutePath);
      } else if (dirent.isFile()) {
        files.push(path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/"));
      }
    }
  };
  visit(absoluteDir);
  return files.sort();
}

function isCoveredByInventoryPath(filePath: string, inventoryPath: string): boolean {
  return filePath === inventoryPath || filePath.startsWith(`${inventoryPath}/`);
}

function expectPathListIsRepoRelative(paths: readonly string[]) {
  expect(paths.length).toBeGreaterThan(0);
  for (const repoRelativePath of paths) {
    expect(repoRelativePath).not.toBe("");
    expect(repoPathExists(repoRelativePath)).toBe(true);
  }
}

function expectMigrationRecordDeletionGate(
  record: Pick<
    LegacyInventoryEntry | LegacyInternalSurface,
    | "status"
    | "targetVitestScenarios"
    | "bridgeProbes"
    | "retiredReason"
    | "deletionReady"
    | "deletionApprovalIssue"
  >,
) {
  if (record.status === "covered") {
    expect(record.targetVitestScenarios.length).toBeGreaterThan(0);
    for (const scenario of record.targetVitestScenarios) {
      expect(scenario).toMatch(/^test\/e2e-scenario\/live\/.+\.test\.ts$/);
      expect(repoPathExists(scenario)).toBe(true);
    }
  }

  if (record.status === "bridge-probe") {
    expect(record.bridgeProbes.length).toBeGreaterThan(0);
    for (const probe of record.bridgeProbes) {
      expect(repoPathExists(probe)).toBe(true);
    }
  }

  if (record.status === "retired") {
    expect(record.retiredReason).not.toBe("");
  }

  if (record.deletionReady) {
    expect(["covered", "retired"]).toContain(record.status);
    expect(record.deletionApprovalIssue).toBe("#4357");
    expect(
      record.status === "retired" ? record.retiredReason : record.targetVitestScenarios.length,
    ).toBeTruthy();
  }
}

describe("E2E migration inventory deletion gates", () => {
  it("uses a constrained migration vocabulary with owning issues", () => {
    const inventory = loadInventory();
    const statuses = new Set(inventory.statusValues);
    const legacyScripts = new Set<string>();
    const internalSurfaceIds = new Set<string>();

    expect(inventory.version).toBe(1);
    expect(inventory.statusValues).toEqual([...EXPECTED_STATUS_VALUES]);
    expect(inventory.deletionReadiness.requires.length).toBeGreaterThan(0);
    expect(inventory.entries.length).toBeGreaterThan(0);
    expect(inventory.internalSurfaces.length).toBeGreaterThan(0);

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

    for (const surface of inventory.internalSurfaces) {
      expect(statuses.has(surface.status)).toBe(true);
      expect(surface.id).toMatch(/^[a-z0-9-]+$/);
      expect(internalSurfaceIds.has(surface.id)).toBe(false);
      internalSurfaceIds.add(surface.id);
      expectPathListIsRepoRelative(surface.paths);
      expect(surface.domain).not.toBe("");
      expect(surface.ownerIssue).toMatch(/^#(?:3588|434[7-9]|435[0-7]|4941)$/);
      expect(surface.replacementSurface).not.toBe("");
      expect(surface.notes).not.toBe("");
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

  it("covers legacy scenario runner internal surfaces by path", () => {
    const inventory = loadInventory();
    const surfacePaths = inventory.internalSurfaces.flatMap((surface) => surface.paths);

    for (const root of INTERNAL_SURFACE_ROOTS) {
      const files = listRepoFilesUnder(root);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(
          surfacePaths.some((surfacePath) => isCoveredByInventoryPath(file, surfacePath)),
        ).toBe(true);
      }
    }
  });

  it("requires coverage, retirement evidence, and #4357 approval before deletion", () => {
    const inventory = loadInventory();

    for (const entry of inventory.entries) {
      expectMigrationRecordDeletionGate(entry);
    }

    for (const surface of inventory.internalSurfaces) {
      expectMigrationRecordDeletionGate(surface);
    }
  });
});
