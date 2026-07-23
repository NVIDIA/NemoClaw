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
//   advisory-early-warning-scan.mts --list-packages
//   advisory-early-warning-scan.mts --advisories <advisories.json> [--output <signals.json>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AdvisorySignal,
  correlateAdvisories,
  type InventoryEntry,
  parseInventoryFromAuditConfig,
  parseInventoryFromPackageLock,
} from "./lib/advisory-early-warning.mts";

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

function describeSignal(signal: AdvisorySignal): string {
  return `${signal.advisoryId} ${signal.package} ${signal.vulnerableRange || "(no range)"} -> ${signal.action} (${signal.confidence}, matched ${signal.matchedVersions.join(", ")})`;
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
  const inventory = loadReviewedInventory();
  if (argv.includes("--list-packages")) {
    const names = [...new Set(inventory.map((entry) => entry.name))].sort();
    for (const name of names) console.log(name);
    return;
  }
  const advisoriesPath = readFlagValue(argv, "--advisories");
  if (!advisoriesPath) {
    throw new Error(
      "usage: advisory-early-warning-scan.mts --list-packages | --advisories <file> [--output <file>]",
    );
  }
  const advisories = loadAdvisories(advisoriesPath);
  const signals = correlateAdvisories(advisories, inventory);
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
