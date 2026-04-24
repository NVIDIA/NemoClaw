#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Validates NemoClaw configuration files against JSON Schemas.
// Used by CI (basic-checks) and locally via `npm run validate:configs`.
//
// Usage:
//   npx tsx scripts/validate-configs.ts              # validate all known config files
//   npx tsx scripts/validate-configs.ts --file <config> --schema <schema>  # validate one file

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface ConfigTarget {
  schema: string;
  files: string[];
}

/**
 * Build the list of config files and their corresponding JSON Schemas.
 * Preset YAML files are discovered dynamically from the presets directory.
 * Returns an array of {@link ConfigTarget} objects ready for validation.
 */
function discoverTargets(): ConfigTarget[] {
  const targets: ConfigTarget[] = [
    {
      schema: "schemas/blueprint.schema.json",
      files: ["nemoclaw-blueprint/blueprint.yaml"],
    },
    {
      schema: "schemas/sandbox-policy.schema.json",
      files: ["nemoclaw-blueprint/policies/openclaw-sandbox.yaml"],
    },
    {
      schema: "schemas/openclaw-plugin.schema.json",
      files: ["nemoclaw/openclaw.plugin.json"],
    },
  ];

  // Discover all preset YAML files dynamically.
  const presetsDir = join(REPO_ROOT, "nemoclaw-blueprint/policies/presets");
  try {
    const presetFiles = readdirSync(presetsDir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => `nemoclaw-blueprint/policies/presets/${f}`);
    if (presetFiles.length > 0) {
      targets.push({
        schema: "schemas/policy-preset.schema.json",
        files: presetFiles,
      });
    } else {
      console.warn("WARN: presets directory exists but contains no .yaml/.yml files — no preset validation performed");
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    // presets directory may not exist — not an error
  }

  return targets;
}

/**
 * Read and parse a config file relative to the repository root.
 * YAML files are parsed with the `yaml` library; everything else is parsed as JSON.
 */
function loadFile(repoRelative: string): unknown {
  const abs = join(REPO_ROOT, repoRelative);
  const raw = readFileSync(abs, "utf-8");
  if (repoRelative.endsWith(".yaml") || repoRelative.endsWith(".yml")) {
    return YAML.parse(raw);
  }
  return JSON.parse(raw);
}

/**
 * Read and parse a JSON Schema file relative to the repository root.
 * Returns the parsed schema object ready for AJV compilation.
 */
function loadSchema(repoRelative: string): object {
  const abs = join(REPO_ROOT, repoRelative);
  return JSON.parse(readFileSync(abs, "utf-8")) as object;
}

/**
 * Format a single AJV validation error into a human-readable string.
 * Includes the JSON Pointer path and a detail message, expanding
 * `additionalProperty` and `unevaluatedProperty` params for clarity.
 */
function formatError(err: { instancePath: string; keyword?: string; message?: string; params?: Record<string, unknown> }): string {
  const path = err.instancePath || "/";
  const detail = err.params?.additionalProperty
    ? `${err.message} '${err.params.additionalProperty}'`
    : err.params?.unevaluatedProperty
      ? `${err.message} '${err.params.unevaluatedProperty}'`
      : err.message ?? "unknown error";
  return `  ${path}: ${detail}`;
}

// ────────────────────────────────────────────────────────────────────
// Dangerous-host semantic check (ref: #1445)
//
// JSON Schema can enforce structure (required fields, enums, ranges) but
// can't express "this value grants access to everywhere". A commit that
// sets `host: "*"` or `host: "0.0.0.0/0"` on a network-policy endpoint
// would pass the schema yet widen egress to anything. Walk the parsed
// documents after schema validation and reject those patterns explicitly.
// Subdomain wildcards like "*.example.com" remain allowed — they're a
// legitimate pattern for real deployments.
// ────────────────────────────────────────────────────────────────────

const DANGEROUS_HOSTS: ReadonlySet<string> = new Set([
  "*",
  "0.0.0.0",
  "0.0.0.0/0",
  "::",
  "::/0",
]);

/**
 * Return true if `host` is a catch-all value that grants access to any destination.
 * Rejects exact members of {@link DANGEROUS_HOSTS} and bare wildcard-with-port patterns
 * like `*:443`. Subdomain wildcards such as `*.example.com` are intentionally allowed.
 */
function isDangerousHost(host: unknown): boolean {
  if (typeof host !== "string") return false;
  const trimmed = host.trim();
  if (DANGEROUS_HOSTS.has(trimmed)) return true;
  // Bare "*" with any non-domain suffix (e.g. "*:443") is also a catch-all.
  if (trimmed === "*" || trimmed.startsWith("*:")) return true;
  return false;
}

interface DangerousHostFinding {
  path: string;
  host: string;
}

/**
 * Walk a parsed policy document (full `network_policies` map or a preset
 * fragment with a `preset:` block) and return every endpoint whose host
 * is in DANGEROUS_HOSTS. Safe to call on any shape — unknown structures
 * just return [].
 */
function findDangerousHosts(data: unknown): DangerousHostFinding[] {
  const findings: DangerousHostFinding[] = [];
  if (!data || typeof data !== "object") return findings;
  const doc = data as Record<string, unknown>;
  const policies = doc.network_policies;
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) return findings;
  for (const [policyName, policy] of Object.entries(policies as Record<string, unknown>)) {
    if (!policy || typeof policy !== "object") continue;
    const endpoints = (policy as Record<string, unknown>).endpoints;
    if (!Array.isArray(endpoints)) continue;
    endpoints.forEach((ep, i) => {
      if (!ep || typeof ep !== "object") return;
      const host = (ep as Record<string, unknown>).host;
      if (isDangerousHost(host)) {
        findings.push({
          path: `/network_policies/${policyName}/endpoints/${i}/host`,
          host: String(host),
        });
      }
    });
  }
  return findings;
}

/**
 * Entry point: validate all config files (or a single file via --file/--schema flags)
 * against their JSON Schemas, then run the dangerous-host semantic check.
 * Exits with a non-zero code if any validation errors or dangerous hosts are found.
 */
function main(): void {
  const args = process.argv.slice(2);

  let targets: ConfigTarget[];

  const hasFileFlag = args.indexOf("--file") !== -1;
  const hasSchemaFlag = args.indexOf("--schema") !== -1;
  if (hasFileFlag !== hasSchemaFlag) {
    console.error("Usage: validate-configs.ts --file <config> --schema <schema>");
    process.exitCode = 1;
    return;
  }
  if (hasFileFlag && hasSchemaFlag) {
    const fileIdx = args.indexOf("--file");
    const schemaIdx = args.indexOf("--schema");
    const file = args[fileIdx + 1];
    const schema = args[schemaIdx + 1];
    if (!file || !schema || file.startsWith("-") || schema.startsWith("-")) {
      console.error("Usage: validate-configs.ts --file <config> --schema <schema>");
      process.exitCode = 1;
      return;
    }
    targets = [{ schema, files: [file] }];
  } else {
    targets = discoverTargets();
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  let totalErrors = 0;
  let totalFiles = 0;

  console.log("=== Config Schema Validation ===\n");

  for (const target of targets) {
    let validate;
    try {
      const schema = loadSchema(target.schema);
      validate = ajv.compile(schema);
    } catch (err) {
      console.error(`FAIL: ${target.schema}`);
      console.error(`  Could not compile schema: ${err}`);
      totalErrors++;
      continue;
    }

    for (const file of target.files) {
      totalFiles++;
      let data: unknown;
      try {
        data = loadFile(file);
      } catch (err) {
        console.error(`FAIL: ${file}`);
        console.error(`  Could not load file: ${err}`);
        totalErrors++;
        continue;
      }

      const valid = validate(data);
      const schemaErrors = !valid && validate.errors ? validate.errors.length : 0;
      // Semantic check: walk the parsed doc and reject catch-all hosts.
      // Runs regardless of schema outcome so operators see all issues at once.
      const dangerous = findDangerousHosts(data);

      if (schemaErrors > 0 || dangerous.length > 0) {
        console.error(`FAIL: ${file}`);
        if (schemaErrors > 0 && validate.errors) {
          for (const err of validate.errors) {
            console.error(formatError(err));
          }
        }
        for (const finding of dangerous) {
          console.error(
            `  ${finding.path}: host "${finding.host}" grants access to any destination — ` +
              `use a specific hostname (subdomain wildcards like "*.example.com" are allowed)`,
          );
        }
        totalErrors += schemaErrors + dangerous.length;
      } else {
        console.log(`OK:   ${file}`);
      }
    }
  }

  console.log();
  if (totalErrors > 0) {
    console.error(`${totalErrors} validation error(s) across ${totalFiles} file(s).`);
    process.exitCode = 1;
  } else {
    console.log(`All ${totalFiles} config file(s) pass schema validation.`);
  }
}

// Export for unit tests without re-running main().
export { DANGEROUS_HOSTS, isDangerousHost, findDangerousHosts };

// Only run main() when invoked directly (skip on test `import`).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("validate-configs.ts")) {
  main();
}
