#!/usr/bin/env tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate the legacy E2E assertion inventory used by parity migration.
 *
 * The inventory is intentionally deterministic and reviewer-readable: every
 * legacy E2E entrypoint discovered from the filesystem is listed, including
 * scripts with zero extractable PASS/FAIL assertions.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export type AssertionPolarity = "pass" | "fail";
export type MappingStatus = "mapped" | "deferred" | "retired" | "unmapped";

export interface LegacyAssertionRecord {
  script: string;
  line: number;
  text: string;
  polarity: AssertionPolarity;
  normalized_id: string;
  mapping_status: MappingStatus;
}

export interface LegacyEntrypointInventory {
  script: string;
  assertions: LegacyAssertionRecord[];
  zero_assertion_review?: {
    reason: string;
  };
}

export interface LegacyAssertionInventory {
  generated_by: string;
  entrypoints: LegacyEntrypointInventory[];
  totals: {
    scripts: number;
    assertions: number;
    zero_assertion_scripts: number;
  };
}

interface ParityAssertionEntry {
  legacy?: unknown;
  status?: unknown;
}

interface ParityScriptEntry {
  assertions?: unknown;
}

interface ParsedParityMap {
  scripts?: Record<string, ParityScriptEntry>;
}

function repoRootFromScript(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function unescapeShellString(text: string): string {
  return text.replace(/\\(["'\\])/g, "$1");
}

export function normalizeAssertionId(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
  return normalized || "assertion";
}

function discoverLegacyEntrypoints(root: string): string[] {
  const e2eDir = path.join(root, "test/e2e");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(e2eDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const scripts = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^test-.*\.sh$/.test(name) || name === "brev-e2e.test.ts")
    .sort((a, b) => a.localeCompare(b));
  return scripts.map((name) => path.join(e2eDir, name));
}

function loadMappedStatuses(root: string): Map<string, MappingStatus> {
  const mapPath = path.join(root, "test/e2e/docs/parity-map.yaml");
  if (!fs.existsSync(mapPath)) return new Map();
  const text = fs.readFileSync(mapPath, "utf8");
  const parsed = (yaml.load(text) ?? {}) as ParsedParityMap;
  const statuses = new Map<string, MappingStatus>();

  for (const [script, entry] of Object.entries(parsed.scripts ?? {})) {
    if (!Array.isArray(entry.assertions)) continue;
    for (const assertion of entry.assertions as ParityAssertionEntry[]) {
      if (typeof assertion.legacy !== "string") continue;
      const status =
        assertion.status === "mapped" ||
        assertion.status === "deferred" ||
        assertion.status === "retired"
          ? assertion.status
          : "mapped";
      statuses.set(`${script}\u0000${assertion.legacy}`, status);
    }
  }

  return statuses;
}

function extractQuotedCall(line: string, helper: AssertionPolarity): string[] {
  const out: string[] = [];
  const helperPattern = new RegExp(
    `(?:^|[^A-Za-z0-9_-])${helper}\\s+(["'])((?:\\\\.|(?!\\1).)*)\\1`,
    "g",
  );
  for (const match of line.matchAll(helperPattern)) {
    out.push(unescapeShellString(match[2]));
  }
  return out;
}

function extractDirectOutput(line: string, polarity: AssertionPolarity): string[] {
  const out: string[] = [];
  const label = polarity === "pass" ? "PASS" : "FAIL";
  const pattern = new RegExp(`${label}:\\s*([^"'\\)\\r\\n]+|["']?[^"'\\r\\n]*["']?)`, "g");
  for (const match of line.matchAll(pattern)) {
    const previous = match.index && match.index > 0 ? line[match.index - 1] : "";
    if (previous === "/") continue;
    if (/^\s*(printf|echo)\s+['\"][^'\"]*%s/.test(line)) continue;
    let text = match[1].trim();
    text = text
      .replace(/["'`);]+$/g, "")
      .replace(/^["'`]+/g, "")
      .trim();
    if (text.length > 0 && !/^\$[A-Z_][A-Z0-9_]*$/.test(text)) out.push(text);
  }
  return out;
}

export function extractAssertionsFromText(script: string, text: string): LegacyAssertionRecord[] {
  const assertions: LegacyAssertionRecord[] = [];
  const lines = text.split("\n");

  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) return;

    for (const polarity of ["pass", "fail"] as const) {
      const seenOnLine = new Set<string>();
      for (const extracted of [
        ...extractQuotedCall(line, polarity),
        ...extractDirectOutput(line, polarity),
      ]) {
        const key = `${polarity}\u0000${extracted}`;
        if (seenOnLine.has(key)) continue;
        seenOnLine.add(key);
        assertions.push({
          script,
          line: index + 1,
          text: extracted,
          polarity,
          normalized_id: normalizeAssertionId(extracted),
          mapping_status: "unmapped",
        });
      }
    }
  });

  return assertions;
}

export function buildLegacyAssertionInventory(root: string): LegacyAssertionInventory {
  const mappedStatuses = loadMappedStatuses(root);
  const entrypoints = discoverLegacyEntrypoints(root).map((file): LegacyEntrypointInventory => {
    const script = toPosix(path.relative(root, file));
    const scriptName = path.basename(file);
    const text = fs.readFileSync(file, "utf8");
    const assertions = extractAssertionsFromText(script, text).map((assertion) => ({
      ...assertion,
      mapping_status: mappedStatuses.get(`${scriptName}\u0000${assertion.text}`) ?? "unmapped",
    }));
    if (assertions.length === 0) {
      return {
        script,
        assertions,
        zero_assertion_review: {
          reason: "TODO: review legacy entrypoint for assertions not expressed as PASS/FAIL output",
        },
      };
    }
    return { script, assertions };
  });

  const assertions = entrypoints.reduce((sum, entry) => sum + entry.assertions.length, 0);
  const zeroAssertionScripts = entrypoints.filter((entry) => entry.assertions.length === 0).length;

  return {
    generated_by: "scripts/e2e/extract-legacy-assertions.ts",
    entrypoints,
    totals: {
      scripts: entrypoints.length,
      assertions,
      zero_assertion_scripts: zeroAssertionScripts,
    },
  };
}

function parseArgs(argv: string[]): { root: string; output: string; check: boolean } {
  let root = repoRootFromScript();
  let output = path.join(root, "test/e2e/docs/parity-inventory.generated.json");
  let check = false;
  const args = argv.slice(2);
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--root") {
      root = path.resolve(args.shift() ?? "");
      output = path.join(root, "test/e2e/docs/parity-inventory.generated.json");
    } else if (arg === "--output") {
      output = path.resolve(args.shift() ?? "");
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "tsx scripts/e2e/extract-legacy-assertions.ts [--root <repo-root>] [--output <path>] [--check]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`extract-legacy-assertions: unexpected arg: ${arg}\n`);
      process.exit(2);
    }
  }
  return { root, output, check };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main(): number {
  const { root, output, check } = parseArgs(process.argv);
  const inventory = buildLegacyAssertionInventory(root);
  const serialized = stableJson(inventory);

  if (check) {
    if (!fs.existsSync(output)) {
      process.stderr.write(
        `${output} does not exist; regenerate with scripts/e2e/extract-legacy-assertions.ts\n`,
      );
      return 1;
    }
    const existing = fs.readFileSync(output, "utf8");
    if (existing !== serialized) {
      process.stderr.write(
        `${output} is out of date; regenerate with scripts/e2e/extract-legacy-assertions.ts\n`,
      );
      return 1;
    }
    process.stdout.write(`legacy assertion inventory is current: ${output}\n`);
    return 0;
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, serialized);
  process.stdout.write(
    `wrote ${output} (${inventory.totals.scripts} entrypoints, ${inventory.totals.assertions} assertions)\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
