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

/** All config files validated by default (paths relative to repo root). */
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

function loadFile(repoRelative: string): unknown {
  const abs = join(REPO_ROOT, repoRelative);
  const raw = readFileSync(abs, "utf-8");
  if (repoRelative.endsWith(".yaml") || repoRelative.endsWith(".yml")) {
    return YAML.parse(raw);
  }
  return JSON.parse(raw);
}

function loadSchema(repoRelative: string): object {
  const abs = join(REPO_ROOT, repoRelative);
  return JSON.parse(readFileSync(abs, "utf-8")) as object;
}

function formatError(err: { instancePath: string; keyword?: string; message?: string; params?: Record<string, unknown> }): string {
  const path = err.instancePath || "/";
  const detail = err.params?.additionalProperty
    ? `${err.message} '${err.params.additionalProperty}'`
    : err.params?.unevaluatedProperty
      ? `${err.message} '${err.params.unevaluatedProperty}'`
      : err.message ?? "unknown error";
  return `  ${path}: ${detail}`;
}

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
      if (!valid && validate.errors) {
        console.error(`FAIL: ${file}`);
        for (const err of validate.errors) {
          console.error(formatError(err));
        }
        totalErrors += validate.errors.length;
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

main();
