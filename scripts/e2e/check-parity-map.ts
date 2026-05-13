#!/usr/bin/env tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Validate legacy assertion parity-map.yaml against generated inventory. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const SCRIPT_STATUSES = new Set([
  "not-started",
  "migrated",
  "parity-verified",
  "deferred",
  "retired",
]);
const ASSERTION_STATUSES = new Set(["mapped", "deferred", "retired"]);

type AssertionStatus = "mapped" | "deferred" | "retired";

interface InventoryAssertion {
  text: string;
}

interface InventoryEntrypoint {
  script: string;
  assertions: InventoryAssertion[];
}

interface Inventory {
  entrypoints: InventoryEntrypoint[];
}

interface ParityAssertion {
  legacy?: unknown;
  id?: unknown;
  status?: unknown;
  reason?: unknown;
  owner?: unknown;
  runner_requirement?: unknown;
  secret_requirement?: unknown;
  reviewer?: unknown;
  approved_at?: unknown;
  reusable?: unknown;
}

interface ParityScript {
  scenario?: unknown;
  status?: unknown;
  owner?: unknown;
  assertions?: unknown;
}

interface ParityMap {
  scripts?: Record<string, ParityScript>;
}

interface ValidationOptions {
  root: string;
  strict: boolean;
}

function repoRootFromScript(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function parseArgs(argv: string[]): ValidationOptions {
  let root = repoRootFromScript();
  let strict = false;
  const args = argv.slice(2);
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--root") root = path.resolve(args.shift() ?? "");
    else if (arg === "--strict") strict = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write("tsx scripts/e2e/check-parity-map.ts [--root <repo-root>] [--strict]\n");
      process.exit(0);
    } else {
      process.stderr.write(`check-parity-map: unexpected arg: ${arg}\n`);
      process.exit(2);
    }
  }
  return { root, strict };
}

function basenameScript(scriptPath: string): string {
  return path.basename(scriptPath);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function loadInventory(root: string): Inventory {
  const inventoryPath = path.join(root, "test/e2e/docs/parity-inventory.generated.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf8")) as Inventory;
}

function loadParityMap(root: string): ParityMap {
  const mapPath = path.join(root, "test/e2e/docs/parity-map.yaml");
  const loaded = yaml.load(fs.readFileSync(mapPath, "utf8"));
  if (!loaded || typeof loaded !== "object") return { scripts: {} };
  return loaded as ParityMap;
}

function validateAssertion(
  scriptName: string,
  assertion: ParityAssertion,
  index: number,
  inventoryTexts: Set<string>,
  strict: boolean,
): string[] {
  const errors: string[] = [];
  const label = `${scriptName} assertions[${index}]`;
  const legacy = assertion.legacy;
  const status = assertion.status;

  if (!isNonEmptyString(legacy)) {
    errors.push(`${label}: legacy is required`);
  } else if (!inventoryTexts.has(legacy)) {
    errors.push(`${label}: unknown legacy assertion string not found in inventory: ${legacy}`);
  }

  if (!isNonEmptyString(status)) {
    if (strict) errors.push(`${label}: status is required in strict mode`);
  } else if (!ASSERTION_STATUSES.has(status)) {
    errors.push(`${label}: status must be one of ${Array.from(ASSERTION_STATUSES).join(", ")}`);
  }

  const effectiveStatus = (status ?? "mapped") as AssertionStatus;
  if (effectiveStatus === "mapped") {
    if (!isNonEmptyString(assertion.id)) errors.push(`${label}: mapped assertion requires id`);
  } else if (effectiveStatus === "deferred") {
    if (!isNonEmptyString(assertion.reason))
      errors.push(`${label}: deferred assertion requires reason`);
    if (!isNonEmptyString(assertion.owner))
      errors.push(`${label}: deferred assertion requires owner`);
    if (
      !isNonEmptyString(assertion.runner_requirement) &&
      !isNonEmptyString(assertion.secret_requirement)
    ) {
      errors.push(`${label}: deferred assertion requires runner_requirement or secret_requirement`);
    }
  } else if (effectiveStatus === "retired") {
    if (!isNonEmptyString(assertion.reason))
      errors.push(`${label}: retired assertion requires reason`);
    if (!isNonEmptyString(assertion.reviewer))
      errors.push(`${label}: retired assertion requires reviewer`);
    if (!isNonEmptyString(assertion.approved_at))
      errors.push(`${label}: retired assertion requires approved_at`);
  }

  return errors;
}

export function validateParityMap(options: ValidationOptions): string[] {
  const inventory = loadInventory(options.root);
  const parityMap = loadParityMap(options.root);
  const mapScripts = parityMap.scripts ?? {};
  const errors: string[] = [];

  for (const entrypoint of inventory.entrypoints) {
    const scriptName = basenameScript(entrypoint.script);
    const scriptEntry = mapScripts[scriptName];
    const inventoryTexts = new Set(entrypoint.assertions.map((assertion) => assertion.text));

    if (!scriptEntry) {
      errors.push(`${scriptName}: missing parity-map entry`);
      continue;
    }

    const scriptStatus = scriptEntry.status;
    if (
      scriptStatus !== undefined &&
      (!isNonEmptyString(scriptStatus) || !SCRIPT_STATUSES.has(scriptStatus))
    ) {
      errors.push(`${scriptName}: status must be one of ${Array.from(SCRIPT_STATUSES).join(", ")}`);
    }

    const assertions = Array.isArray(scriptEntry.assertions)
      ? (scriptEntry.assertions as ParityAssertion[])
      : [];
    const effectiveScriptStatus = isNonEmptyString(scriptStatus)
      ? scriptStatus
      : assertions.length === 0
        ? "not-started"
        : "migrated";

    if (
      (effectiveScriptStatus === "migrated" || effectiveScriptStatus === "parity-verified") &&
      !isNonEmptyString(scriptEntry.scenario)
    ) {
      errors.push(`${scriptName}: ${effectiveScriptStatus} script requires scenario`);
    }

    if (options.strict && assertions.length === 0 && entrypoint.assertions.length > 0) {
      errors.push(`${scriptName}: strict mode rejects empty or uncategorized assertion mappings`);
    }

    const mappedIds = new Map<string, number[]>();
    assertions.forEach((assertion, index) => {
      errors.push(
        ...validateAssertion(scriptName, assertion, index, inventoryTexts, options.strict),
      );
      const status = assertion.status ?? "mapped";
      if (status === "mapped" && isNonEmptyString(assertion.id)) {
        const entries = mappedIds.get(assertion.id) ?? [];
        entries.push(index);
        mappedIds.set(assertion.id, entries);
      }
    });

    for (const [id, indexes] of mappedIds.entries()) {
      if (indexes.length <= 1) continue;
      const allReusable = indexes.every((index) => assertions[index]?.reusable === true);
      if (!allReusable) {
        errors.push(
          `${scriptName}: duplicate scenario assertion id ${id}; set reusable: true on all duplicates if intentional`,
        );
      }
    }

    if (options.strict) {
      const categorized = new Set(
        assertions
          .filter(
            (assertion) =>
              isNonEmptyString(assertion.legacy) &&
              ASSERTION_STATUSES.has(assertion.status as string),
          )
          .map((assertion) => assertion.legacy as string),
      );
      for (const inventoryText of inventoryTexts) {
        if (!categorized.has(inventoryText)) {
          errors.push(`${scriptName}: uncategorized assertion in strict mode: ${inventoryText}`);
        }
      }
    }
  }

  return errors;
}

function main(): number {
  const options = parseArgs(process.argv);
  const errors = validateParityMap(options);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    process.stderr.write(
      `\ncheck-parity-map: ${errors.length} error(s)${options.strict ? " in strict mode" : ""}\n`,
    );
    return 1;
  }
  process.stdout.write(`parity map valid${options.strict ? " (strict)" : ""}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
