#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate blueprint.yaml profile declarations and base sandbox policy.
 *
 * Runs as a standalone script in CI (validate-profiles job) and can also be
 * invoked locally for quick smoke checks:
 *
 *     npx tsx test/validate-blueprint.ts
 */

import { readFileSync } from "node:fs";
import YAML from "yaml";

const BLUEPRINT_PATH = "nemoclaw-blueprint/blueprint.yaml";
const BASE_POLICY_PATH = "nemoclaw-blueprint/policies/openclaw-sandbox.yaml";
const REQUIRED_PROFILE_FIELDS = ["provider_type", "endpoint"] as const;

const errors: string[] = [];

function check(condition: boolean, msg: string): void {
  if (!condition) {
    errors.push(msg);
    console.log(`  FAIL  ${msg}`);
  } else {
    console.log(`  OK    ${msg}`);
  }
}

// ── Blueprint profiles ────────────────────────────────────────────────

const bp: unknown = YAML.parse(readFileSync(BLUEPRINT_PATH, "utf-8"));
check(typeof bp === "object" && bp !== null, `${BLUEPRINT_PATH} parses as a YAML mapping`);
if (typeof bp !== "object" || bp === null) {
  console.log(`\nFAILED — ${String(errors.length)} error(s)`);
  process.exit(1);
}

const bpObj = bp as Record<string, unknown>;
const declared = bpObj.profiles as string[] | undefined;
const components = bpObj.components as Record<string, unknown> | undefined;
const inference = components?.inference as Record<string, unknown> | undefined;
const defined = (inference?.profiles ?? {}) as Record<string, Record<string, unknown>>;

check(Array.isArray(declared) && declared.length > 0, "top-level 'profiles' is a non-empty list");
check(typeof defined === "object" && Object.keys(defined).length > 0, "components.inference.profiles is a non-empty mapping");

console.log(`Declared profiles: ${JSON.stringify(declared)}`);
console.log(`Defined profiles:  ${JSON.stringify(Object.keys(defined))}`);

for (const name of declared ?? []) {
  check(name in defined, `declared profile '${name}' has a definition`);
  if (name in defined) {
    const cfg = defined[name];
    for (const field of REQUIRED_PROFILE_FIELDS) {
      if (field === "endpoint" && cfg.dynamic_endpoint) {
        check(field in cfg, `profile '${name}' has '${field}' (dynamic)`);
      } else {
        check(field in cfg && Boolean(cfg[field]), `profile '${name}' has non-empty '${field}'`);
      }
    }
  }
}

for (const name of Object.keys(defined)) {
  check(declared?.includes(name) ?? false, `defined profile '${name}' is declared in top-level list`);
}

// ── Base sandbox policy ───────────────────────────────────────────────

const policy: unknown = YAML.parse(readFileSync(BASE_POLICY_PATH, "utf-8"));
check(typeof policy === "object" && policy !== null, `${BASE_POLICY_PATH} parses as a YAML mapping`);
if (typeof policy === "object" && policy !== null) {
  const policyObj = policy as Record<string, unknown>;
  check("version" in policyObj, "base policy has 'version'");
  check("network_policies" in policyObj, "base policy has 'network_policies'");
}

// ── Result ────────────────────────────────────────────────────────────

console.log();
if (errors.length > 0) {
  console.log(`FAILED — ${String(errors.length)} error(s)`);
  process.exit(1);
} else {
  const total = (declared?.length ?? 0) * (1 + REQUIRED_PROFILE_FIELDS.length) + Object.keys(defined).length + 2;
  console.log(`PASSED — ${String(total)} checks OK`);
}
