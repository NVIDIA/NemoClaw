#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// CLI entry for the advisory early-warning path (#7338). Correlates public
// GitHub Security Advisory JSON with the reviewed npm inventory derived from
// ci/reviewed-npm-audit.json (committed package specs plus the locked-graph
// package-locks) and prints structured, NON-blocking signals. Signals never
// fail the process: enforcement stays with the reviewed npm audit gate.
//
// Usage:
//   advisory-early-warning-scan.mts [--inventory <inventory.json>] --list-packages
//   advisory-early-warning-scan.mts [--inventory <inventory.json>]
//     --advisories <advisories.json>
//     [--nvd-records <nvd-responses.json>] [--output <signals.json>]
//
// --inventory replaces the repo-derived reviewed inventory with an explicit
// JSON array of {name, version[, origin]} entries, so offline callers and
// tests can run hermetically; without it (the workflow default) the inventory
// is built from ci/reviewed-npm-audit.json and the locked-graph package-locks.
//
// --nvd-records attaches supplementary NVD reconciliations from a file of
// previously fetched NVD 2.0 API responses. The CLI itself never performs
// network requests; the caller (the early-warning workflow) fetches.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  correlateAdvisories,
  type InventoryEntry,
  parseInventoryFromAuditConfig,
  parseInventoryFromPackageLock,
} from "./lib/advisory-early-warning.mts";
import { attachNvdReconciliations, type NvdAnnotatedSignal } from "./lib/nvd-reconciliation.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_RELATIVE_PATH = path.join("ci", "reviewed-npm-audit.json");

function loadReviewedInventory(): InventoryEntry[] {
  const config = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, CONFIG_RELATIVE_PATH), "utf-8"),
  ) as Record<string, unknown>;
  const inventory = parseInventoryFromAuditConfig(config, CONFIG_RELATIVE_PATH);
  const lockedGraphs = Array.isArray(config.lockedGraphs) ? config.lockedGraphs : [];
  for (const graph of lockedGraphs) {
    const directory = (graph as Record<string, unknown> | null)?.directory;
    if (typeof directory !== "string" || directory.length === 0) continue;
    const lockRelativePath = path.join(directory, "package-lock.json");
    const lockPath = path.join(REPO_ROOT, lockRelativePath);
    if (!fs.existsSync(lockPath)) continue;
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as unknown;
    inventory.push(...parseInventoryFromPackageLock(lock, lockRelativePath));
  }
  return inventory;
}

function loadAdvisories(advisoriesPath: string): unknown[] {
  const parsed = JSON.parse(fs.readFileSync(advisoriesPath, "utf-8")) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function loadNvdResponses(nvdRecordsPath: string): unknown[] {
  const parsed = JSON.parse(fs.readFileSync(nvdRecordsPath, "utf-8")) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function loadInventoryOverride(inventoryPath: string): InventoryEntry[] {
  const parsed = JSON.parse(fs.readFileSync(inventoryPath, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`--inventory file '${inventoryPath}' must contain a JSON array.`);
  }
  // A malformed entry fails the run instead of being skipped: silently
  // shrinking the inventory would under-report advisories with no signal
  // that anything was dropped.
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`--inventory entry ${index} in '${inventoryPath}' is not an object.`);
    }
    const name = (entry as Record<string, unknown>).name;
    const version = (entry as Record<string, unknown>).version;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        `--inventory entry ${index} in '${inventoryPath}' is missing a non-empty string "name".`,
      );
    }
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(
        `--inventory entry ${index} in '${inventoryPath}' is missing a non-empty string "version".`,
      );
    }
    const origin = (entry as Record<string, unknown>).origin;
    return {
      name,
      version,
      origin: typeof origin === "string" && origin.length > 0 ? origin : inventoryPath,
    };
  });
}

function describeNvd(signal: NvdAnnotatedSignal): string {
  if (!signal.nvd) return "";
  const published =
    signal.nvd.nvdPublished === null ? "" : ` (published ${signal.nvd.nvdPublished.slice(0, 10)})`;
  return ` — NVD: ${signal.nvd.agreement}${published}`;
}

function describeSignal(signal: NvdAnnotatedSignal): string {
  return `${signal.advisoryId} ${signal.package} ${signal.vulnerableRange || "(no range)"} -> ${signal.action} (${signal.confidence}, matched ${signal.matchedVersions.join(", ")})${describeNvd(signal)}`;
}

function readFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function main(argv: readonly string[]): void {
  const inventoryPath = readFlagValue(argv, "--inventory");
  const inventory = inventoryPath ? loadInventoryOverride(inventoryPath) : loadReviewedInventory();
  if (argv.includes("--list-packages")) {
    const names = [...new Set(inventory.map((entry) => entry.name))].sort();
    for (const name of names) console.log(name);
    return;
  }
  const advisoriesPath = readFlagValue(argv, "--advisories");
  if (!advisoriesPath) {
    throw new Error(
      "usage: advisory-early-warning-scan.mts [--inventory <file>] --list-packages | [--inventory <file>] --advisories <file> [--nvd-records <file>] [--output <file>]",
    );
  }
  const advisories = loadAdvisories(advisoriesPath);
  const correlated = correlateAdvisories(advisories, inventory);
  const nvdRecordsPath = readFlagValue(argv, "--nvd-records");
  // NVD reconciliation is offline here by design: responses come from a file
  // the caller fetched, and annotations are informational only.
  const signals: readonly NvdAnnotatedSignal[] = nvdRecordsPath
    ? attachNvdReconciliations(correlated, loadNvdResponses(nvdRecordsPath))
    : correlated;
  const outputPath = readFlagValue(argv, "--output");
  if (outputPath) {
    fs.writeFileSync(outputPath, `${JSON.stringify(signals, null, 2)}\n`);
  }
  console.log(
    `advisory early warning: ${advisories.length} advisories, ${inventory.length} inventory entries, ${signals.length} signals`,
  );
  for (const signal of signals) console.log(describeSignal(signal));
  // Signals are intentionally non-blocking: the process exits 0 either way,
  // and the caller routes signals to a tracking issue for investigation.
}

function isMainModule(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    : false;
}

if (isMainModule()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
