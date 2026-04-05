#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-commit validation for NemoClaw network policy YAML files.
 *
 * Checks:
 *   - Required top-level fields (version, network_policies)
 *   - Endpoint structure (host, port)
 *   - Valid HTTP methods in rules
 *   - Valid protocol / enforcement / access values
 *   - Mutual exclusivity of access:full and rules
 *   - Paths start with /
 *   - Wildcard host rejection (host: "*" or host: "0.0.0.0/0")
 *
 * Usage:
 *   node scripts/validate-policies.js <file1.yaml> [file2.yaml ...]
 *
 * Exit code 0 = all files valid, 1 = errors found.
 */

"use strict";

const fs = require("fs");
const yaml = require("js-yaml");
const path = require("path");

const VALID_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
const VALID_PROTOCOLS = new Set(["rest"]);
const VALID_ENFORCEMENTS = new Set(["enforce", "audit"]);
const VALID_ACCESS = new Set(["full"]);
const DANGEROUS_HOSTS = new Set(["*", "0.0.0.0/0", "0.0.0.0"]);

/**
 * Validate a single allow-rule inside an endpoint.
 * @param {object} rule   - The rule object (expected to have .allow).
 * @param {string} rloc   - Human-readable location string for error messages.
 * @param {string[]} errors - Accumulator; errors are pushed in-place.
 */
function validateRule(rule, rloc, errors) {
  const allow = rule.allow || {};

  if (allow.method && !VALID_METHODS.has(allow.method)) {
    errors.push(`${rloc}: invalid HTTP method "${allow.method}"`);
  }

  if (allow.path && !allow.path.startsWith("/")) {
    errors.push(`${rloc}: path must start with "/": "${allow.path}"`);
  }
}

/**
 * Validate a single endpoint entry.
 * @param {object} ep     - The endpoint object.
 * @param {string} loc    - Human-readable location string.
 * @param {string[]} errors - Accumulator.
 */
function validateEndpoint(ep, loc, errors) {
  if (!ep.host) {
    errors.push(`${loc}: missing required field "host"`);
  } else if (DANGEROUS_HOSTS.has(ep.host)) {
    errors.push(
      `${loc}: dangerous wildcard host "${ep.host}" — ` +
        "use an explicit hostname instead",
    );
  }

  if (ep.port === undefined || ep.port === null) {
    errors.push(`${loc}: missing required field "port"`);
  }

  if (ep.protocol && !VALID_PROTOCOLS.has(ep.protocol)) {
    errors.push(`${loc}: invalid protocol "${ep.protocol}"`);
  }

  if (ep.access && !VALID_ACCESS.has(ep.access)) {
    errors.push(`${loc}: invalid access "${ep.access}"`);
  }

  if (ep.enforcement && !VALID_ENFORCEMENTS.has(ep.enforcement)) {
    errors.push(`${loc}: invalid enforcement "${ep.enforcement}"`);
  }

  if (ep.access && ep.rules) {
    errors.push(
      `${loc}: "access: full" and "rules" are mutually exclusive`,
    );
  }

  for (const [j, rule] of (ep.rules || []).entries()) {
    validateRule(rule, `${loc}.rules[${j}]`, errors);
  }
}

/**
 * Validate all network_policies in a parsed document.
 * @param {object} policies - The network_policies mapping.
 * @param {string[]} errors - Accumulator.
 */
function validateNetworkPolicies(policies, errors) {
  for (const [name, policy] of Object.entries(policies)) {
    if (!policy || typeof policy !== "object") {
      errors.push(`${name}: policy must be a mapping`);
      continue;
    }

    if (!policy.endpoints || !Array.isArray(policy.endpoints)) {
      errors.push(`${name}: endpoints must be an array`);
      continue;
    }

    for (const [i, ep] of policy.endpoints.entries()) {
      validateEndpoint(ep, `${name}.endpoints[${i}]`, errors);
    }
  }
}

/**
 * Parse and validate a single policy YAML file.
 * @param {string} filePath - Absolute or relative path to the YAML file.
 * @returns {string[]} Array of error messages (empty = valid).
 */
function validatePolicy(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  let doc;
  try {
    doc = yaml.load(content);
  } catch (e) {
    return [`YAML parse error: ${e.message}`];
  }

  if (!doc || typeof doc !== "object") {
    return ["File does not contain a YAML mapping"];
  }

  const errors = [];

  if (!doc.version) {
    errors.push("Missing required field: version");
  }

  const policies = doc.network_policies;
  if (!policies || typeof policies !== "object") {
    // network_policies is optional — some policy files may only have
    // filesystem_policy or other sections. Skip endpoint validation.
    return errors;
  }

  validateNetworkPolicies(policies, errors);
  return errors;
}

// ── main ──────────────────────────────────────────────────────────────

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log("No policy files to validate.");
  process.exit(0);
}

let exitCode = 0;
for (const f of files) {
  try {
    const errors = validatePolicy(f);
    if (errors.length > 0) {
      console.error(`\nFAIL ${f}:`);
      errors.forEach((e) => console.error(`   - ${e}`));
      exitCode = 1;
    } else {
      console.log(`OK   ${path.basename(f)}`);
    }
  } catch (e) {
    console.error(`\nFAIL ${f}: ${e.message}`);
    exitCode = 1;
  }
}

process.exit(exitCode);
