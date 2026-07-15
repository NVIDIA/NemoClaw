#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Validates NemoClaw configuration files against JSON Schemas.
// Used by CI (basic-checks) and locally via `npm run validate:configs`.
//
// Usage:
//   npx tsx scripts/validate-configs.mts              # validate all known config files
//   npx tsx scripts/validate-configs.mts --file <config> --schema <schema>  # validate one file

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import YAML from "yaml";

import type { SemanticCheck, SemanticFinding } from "../src/lib/policy/semantic-validation";

const {
  DANGEROUS_HOSTS,
  findDangerousHosts,
  isDangerousHost,
  POLICY_SEMANTIC_CHECKS,
  runSemanticChecks,
  splitSemanticFindings,
} = await import("../src/lib/policy/semantic-validation");

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface ConfigTarget {
  schema: string;
  files: string[];
}

type ConfigScalar = string | number | boolean | null;
type ConfigValue = ConfigScalar | ConfigObject | ConfigValue[];
type ConfigObject = { [key: string]: ConfigValue };

function pathRelativeToRepo(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll("\\", "/");
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
      files: [
        "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
        "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
      ],
    },
    {
      schema: "schemas/openclaw-plugin.schema.json",
      files: ["nemoclaw/openclaw.plugin.json"],
    },
    {
      schema: "schemas/router-pool-config.schema.json",
      files: ["nemoclaw-blueprint/router/pool-config.yaml"],
    },
    {
      schema: "schemas/onboard-config.schema.json",
      files: ["ci/onboard-performance-budget.json"],
    },
  ];

  const agentsDir = join(REPO_ROOT, "agents");
  try {
    const agentPolicyFiles = readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const base = `agents/${entry.name}`;
        return [`${base}/policy-additions.yaml`, `${base}/policy-permissive.yaml`];
      })
      .filter((file) => existsSync(join(REPO_ROOT, file)));
    if (agentPolicyFiles.length > 0) {
      const sandboxPolicyTarget = targets.find(
        (target) => target.schema === "schemas/sandbox-policy.schema.json",
      );
      sandboxPolicyTarget?.files.push(...agentPolicyFiles);
    }
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    // agents directory may not exist — not an error
  }

  const modelSetupDir = join(REPO_ROOT, "nemoclaw-blueprint", "model-specific-setup");
  try {
    const modelSetupFiles: string[] = [];
    const walkModelSetup = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkModelSetup(abs);
        } else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "schema.json") {
          modelSetupFiles.push(pathRelativeToRepo(abs));
        }
      }
    };
    walkModelSetup(modelSetupDir);
    if (modelSetupFiles.length > 0) {
      targets.push({
        schema: "nemoclaw-blueprint/model-specific-setup/schema.json",
        files: modelSetupFiles.sort(),
      });
    }
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    // model-specific setup directory may not exist — not an error
  }

  // Discover all preset YAML files dynamically.
  const presetsDir = join(REPO_ROOT, "nemoclaw-blueprint/policies/presets");
  const presetFiles: string[] = [];
  try {
    presetFiles.push(
      ...readdirSync(presetsDir)
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => `nemoclaw-blueprint/policies/presets/${f}`),
    );
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    // presets directory may not exist — not an error
  }

  const channelPoliciesDir = join(REPO_ROOT, "src/lib/messaging/channels");
  try {
    const walkChannelPolicies = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkChannelPolicies(abs);
        } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
          const repoPath = pathRelativeToRepo(abs);
          if (/(^|\/)policy\/[^/]+\.ya?ml$/.test(repoPath)) presetFiles.push(repoPath);
        }
      }
    };
    walkChannelPolicies(channelPoliciesDir);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    // channel policy directories may not exist — not an error
  }

  if (presetFiles.length > 0) {
    targets.push({
      schema: "schemas/policy-preset.schema.json",
      files: presetFiles.sort(),
    });
  } else {
    console.warn("WARN: no preset .yaml/.yml files discovered — no preset validation performed");
  }

  return targets;
}

/**
 * Read and parse a config file relative to the repository root.
 * YAML files are parsed with the `yaml` library; everything else is parsed as JSON.
 */
function loadFile(repoRelative: string): ConfigValue {
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
  const schema: object = JSON.parse(readFileSync(abs, "utf-8"));
  return schema;
}

function compileConfigSchema(
  repoRelative: string,
  ajv = new Ajv({ allErrors: true, strict: false, $data: true }),
) {
  return ajv.compile(loadSchema(repoRelative));
}

type ValidationParams = { additionalProperty?: string; unevaluatedProperty?: string };

/**
 * Format a single AJV validation error into a human-readable string.
 * Includes the JSON Pointer path and a detail message, expanding
 * `additionalProperty` and `unevaluatedProperty` params for clarity.
 */
function formatError(err: {
  instancePath: string;
  keyword?: string;
  message?: string;
  params?: ValidationParams;
}): string {
  const path = err.instancePath || "/";
  const message = err.message ?? "unknown error";
  const detail = err.params?.additionalProperty
    ? `${message} '${err.params.additionalProperty}'`
    : err.params?.unevaluatedProperty
      ? `${message} '${err.params.unevaluatedProperty}'`
      : message;
  return `  ${path}: ${detail}`;
}

const ROUTER_API_BASE_HOST_ALLOWLIST: ReadonlySet<string> = new Set(["integrate.api.nvidia.com"]);

type RouterApiBaseFinding = { path: string; host: string };

function findDangerousRouterApiBases(data: unknown): RouterApiBaseFinding[] {
  const findings: RouterApiBaseFinding[] = [];
  if (!data || typeof data !== "object") return findings;
  const models = (data as Record<string, unknown>).models;
  if (!Array.isArray(models)) return findings;

  models.forEach((model, index) => {
    if (!model || typeof model !== "object") return;
    const apiBase = (model as Record<string, unknown>).api_base;
    if (typeof apiBase !== "string") return;
    let url: URL;
    try {
      url = new URL(apiBase);
    } catch {
      return;
    }
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      isDangerousHost(hostname) ||
      !ROUTER_API_BASE_HOST_ALLOWLIST.has(hostname)
    ) {
      findings.push({
        path: `/models/${index}/api_base`,
        host: apiBase,
      });
    }
  });

  return findings;
}

const ROUTER_API_BASE_SEMANTIC_CHECK: SemanticCheck = {
  name: "router-api-base",
  description: "Restricts router API bases to the NVIDIA Build endpoint.",
  run(data) {
    return findDangerousRouterApiBases(data).map(({ path, host }) => ({
      path,
      severity: "error",
      message:
        `host "${host}" is not allowed — use a specific public hostname ` +
        `(subdomain wildcards like "*.example.com" are allowed for policy hosts)`,
    }));
  },
};

function runConfigSemanticChecks(data: unknown): SemanticFinding[] {
  return runSemanticChecks(data, [...POLICY_SEMANTIC_CHECKS, ROUTER_API_BASE_SEMANTIC_CHECK]);
}

/**
 * Entry point: validate all config files (or a single file via --file/--schema flags)
 * against their JSON Schemas, then run semantic checks.
 * Exits with a non-zero code if schema validation or semantic errors are found.
 * Semantic warnings are reported without failing validation.
 */
function main(): void {
  const args = process.argv.slice(2);

  let targets: ConfigTarget[];

  const hasFileFlag = args.indexOf("--file") !== -1;
  const hasSchemaFlag = args.indexOf("--schema") !== -1;
  if (hasFileFlag !== hasSchemaFlag) {
    console.error("Usage: validate-configs.mts --file <config> --schema <schema>");
    process.exitCode = 1;
    return;
  }
  if (hasFileFlag && hasSchemaFlag) {
    const fileIdx = args.indexOf("--file");
    const schemaIdx = args.indexOf("--schema");
    const file = args[fileIdx + 1];
    const schema = args[schemaIdx + 1];
    if (!file || !schema || file.startsWith("-") || schema.startsWith("-")) {
      console.error("Usage: validate-configs.mts --file <config> --schema <schema>");
      process.exitCode = 1;
      return;
    }
    targets = [{ schema, files: [file] }];
  } else {
    targets = discoverTargets();
  }

  const ajv = new Ajv({ allErrors: true, strict: false, $data: true });
  let totalErrors = 0;
  let totalFiles = 0;

  console.log("=== Config Schema Validation ===\n");

  for (const target of targets) {
    let validate;
    try {
      validate = compileConfigSchema(target.schema, ajv);
    } catch (err) {
      console.error(`FAIL: ${target.schema}`);
      console.error(`  Could not compile schema: ${err}`);
      totalErrors++;
      continue;
    }

    for (const file of target.files) {
      totalFiles++;
      let data: ConfigValue;
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
      // Runs regardless of schema outcome so operators see all issues at once.
      const { errors: semanticErrors, warnings: semanticWarnings } = splitSemanticFindings(
        runConfigSemanticChecks(data),
      );

      if (schemaErrors > 0 || semanticErrors.length > 0) {
        console.error(`FAIL: ${file}`);
        if (schemaErrors > 0 && validate.errors) {
          for (const err of validate.errors) {
            console.error(formatError(err));
          }
        }
        for (const finding of semanticErrors)
          console.error(`  ${finding.path}: ${finding.message}`);
        totalErrors += schemaErrors + semanticErrors.length;
      } else {
        console.log(`OK:   ${file}`);
      }
      for (const finding of semanticWarnings)
        console.warn(`WARN: ${file}\n  ${finding.path}: ${finding.message}`);
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
export {
  DANGEROUS_HOSTS,
  compileConfigSchema,
  discoverTargets,
  findDangerousHosts,
  findDangerousRouterApiBases,
  isDangerousHost,
  ROUTER_API_BASE_HOST_ALLOWLIST,
  runConfigSemanticChecks,
};

// Only run main() when invoked directly (skip on test `import`).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("validate-configs.mts")
) {
  main();
}
