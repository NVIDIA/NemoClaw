// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

const root = process.cwd();
const manifestPath = path.join(root, "test/e2e/e2e-manifest.yaml");
const rulesPath = path.join(root, "tools/e2e-advisor/rules.yaml");
const schemaPath = path.join(root, "tools/e2e-advisor/schema.json");
const modelsTemplatePath = path.join(root, "tools/e2e-advisor/pi-models.template.json");

const manifest = readYaml(manifestPath);
const rules = readYaml(rulesPath);
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const modelsTemplate = JSON.parse(fs.readFileSync(modelsTemplatePath, "utf8"));

const failures: string[] = [];
const testIds = new Set((manifest.tests ?? []).map((test: { id: string }) => test.id));

if (testIds.size === 0) {
  failures.push("test/e2e/e2e-manifest.yaml must define at least one test");
}

for (const test of manifest.tests ?? []) {
  requireField(test, "id", `manifest test ${test.id ?? "<unknown>"}`);
  requireField(test, "workflow", `manifest test ${test.id ?? "<unknown>"}`);
  requireField(test, "job", `manifest test ${test.id ?? "<unknown>"}`);
  if (test.script && !fs.existsSync(path.join(root, test.script))) {
    failures.push(`manifest test ${test.id} references missing script ${test.script}`);
  }
}

for (const rule of rules.rules ?? []) {
  requireField(rule, "id", `rule ${rule.id ?? "<unknown>"}`);
  requireField(rule, "domain", `rule ${rule.id ?? "<unknown>"}`);
  for (const testId of [...(rule.required_tests ?? []), ...(rule.optional_tests ?? [])]) {
    if (!testIds.has(testId)) {
      failures.push(`rule ${rule.id} references unknown test id ${testId}`);
    }
  }
  if (rule.gap_if_missing && !rules.gaps?.[rule.gap_if_missing]) {
    failures.push(`rule ${rule.id} references unknown gap ${rule.gap_if_missing}`);
  }
  for (const pattern of rule.any ?? []) {
    try {
      new RegExp(pattern);
    } catch (error) {
      failures.push(`rule ${rule.id} has invalid regex ${pattern}: ${(error as Error).message}`);
    }
  }
}

if (schema.title !== "NemoClaw E2E Advisor Result") {
  failures.push("schema title must be 'NemoClaw E2E Advisor Result'");
}

for (const [providerName, provider] of Object.entries(modelsTemplate.providers ?? {}) as Array<[string, { apiKey?: string; models?: Array<{ id?: string }> }]>) {
  if (provider.apiKey !== "__PI_E2E_ADVISOR_API_KEY__") {
    failures.push(`provider ${providerName} must use __PI_E2E_ADVISOR_API_KEY__ placeholder`);
  }
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    failures.push(`provider ${providerName} must define at least one model`);
  }
  for (const model of provider.models ?? []) {
    if (!model.id) {
      failures.push(`provider ${providerName} contains a model without id`);
    }
  }
}

if (failures.length > 0) {
  console.error("E2E Advisor config check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`E2E Advisor config check passed (${testIds.size} manifest tests, ${(rules.rules ?? []).length} rules)`);

function readYaml(filePath: string): any {
  return yaml.parse(fs.readFileSync(filePath, "utf8"));
}

function requireField(object: Record<string, unknown>, field: string, context: string): void {
  if (!object[field]) {
    failures.push(`${context} missing required field ${field}`);
  }
}
