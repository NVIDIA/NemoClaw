#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Validate NemoClaw network-policy YAML files against a security schema.
// Rejects structural errors, unknown field values, and known-dangerous
// patterns (wildcard-everywhere hosts, 0.0.0.0 bind-everything) before
// they can reach `git commit`.
//
// Usage: node scripts/validate-policies.js <file1.yaml> [<file2.yaml> ...]
// Exits 0 on success, 1 on any validation failure.
//
// Ref: https://github.com/NVIDIA/NemoClaw/issues/1445
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

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
const VALID_TLS = new Set(["terminate", "passthrough"]);

// Hosts that grant access to everything. Subdomain wildcards like
// "*.example.com" are allowed; bare "*" and "0.0.0.0"/"0.0.0.0/0" are not.
const DANGEROUS_HOSTS = new Set(["*", "0.0.0.0", "0.0.0.0/0", "::", "::/0"]);

function isDangerousHost(host) {
  if (typeof host !== "string") return false;
  const trimmed = host.trim();
  if (DANGEROUS_HOSTS.has(trimmed)) return true;
  // Reject bare "*" with any suffix that doesn't anchor to a domain label
  // (e.g. "*:443" would be caught because `host` shouldn't carry a port).
  if (trimmed === "*" || trimmed.startsWith("*:")) return true;
  return false;
}

function validateEndpoint(policyName, index, ep, errors) {
  const loc = `${policyName}.endpoints[${index}]`;

  if (!ep || typeof ep !== "object") {
    errors.push(`${loc}: must be a mapping`);
    return;
  }

  if (!ep.host) {
    errors.push(`${loc}: missing required field: host`);
  } else if (isDangerousHost(ep.host)) {
    errors.push(
      `${loc}: host "${ep.host}" grants access to any destination — ` +
        `use a specific hostname (subdomain wildcards like "*.example.com" are allowed)`,
    );
  }

  if (ep.port === undefined || ep.port === null) {
    errors.push(`${loc}: missing required field: port`);
  } else if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) {
    errors.push(`${loc}: port must be an integer between 1 and 65535, got "${ep.port}"`);
  }

  if (ep.protocol && !VALID_PROTOCOLS.has(ep.protocol)) {
    errors.push(
      `${loc}: invalid protocol "${ep.protocol}" (expected one of: ${[...VALID_PROTOCOLS].join(", ")})`,
    );
  }

  if (ep.enforcement && !VALID_ENFORCEMENTS.has(ep.enforcement)) {
    errors.push(
      `${loc}: invalid enforcement "${ep.enforcement}" (expected one of: ${[...VALID_ENFORCEMENTS].join(", ")})`,
    );
  }

  if (ep.tls && !VALID_TLS.has(ep.tls)) {
    errors.push(
      `${loc}: invalid tls "${ep.tls}" (expected one of: ${[...VALID_TLS].join(", ")})`,
    );
  }

  if (ep.access !== undefined) {
    if (!VALID_ACCESS.has(ep.access)) {
      errors.push(
        `${loc}: invalid access "${ep.access}" (expected one of: ${[...VALID_ACCESS].join(", ")})`,
      );
    }
    if (Array.isArray(ep.rules) && ep.rules.length > 0) {
      errors.push(
        `${loc}: 'access: full' and 'rules' are mutually exclusive — choose one`,
      );
    }
  }

  if (Array.isArray(ep.rules)) {
    ep.rules.forEach((rule, i) => {
      const rloc = `${loc}.rules[${i}]`;
      if (!rule || typeof rule !== "object") {
        errors.push(`${rloc}: must be a mapping`);
        return;
      }
      const allow = rule.allow || {};
      if (allow.method && !VALID_METHODS.has(allow.method)) {
        errors.push(
          `${rloc}: invalid HTTP method "${allow.method}" (expected one of: ${[...VALID_METHODS].join(", ")})`,
        );
      }
      if (allow.path && typeof allow.path === "string" && !allow.path.startsWith("/")) {
        errors.push(`${rloc}: path must start with "/": "${allow.path}"`);
      }
    });
  }
}

function validatePolicy(filePath) {
  const errors = [];
  let doc;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    doc = yaml.load(content);
  } catch (err) {
    errors.push(`failed to parse YAML: ${err.message}`);
    return errors;
  }

  if (!doc || typeof doc !== "object") {
    errors.push("top-level YAML document must be a mapping");
    return errors;
  }

  // Preset fragments (policies/presets/*.yaml) carry a `preset:` block and
  // are merged into a parent policy at runtime, so they do not require a
  // top-level `version`. Full policies (openclaw-sandbox.yaml, etc.) do.
  const isPresetFragment = doc.preset && typeof doc.preset === "object";

  // Files without `network_policies` or a `preset:` block are not network-policy
  // documents (e.g. tiers.yaml defines policy tiers, not endpoints). Skip them
  // here — they may have their own schema that isn't this validator's concern.
  if (!doc.network_policies && !isPresetFragment) {
    return errors;
  }

  if (!isPresetFragment && (doc.version === undefined || doc.version === null)) {
    errors.push("missing required top-level field: version");
  }

  const policies = doc.network_policies || {};
  if (typeof policies !== "object" || Array.isArray(policies)) {
    errors.push("network_policies must be a mapping of policy name -> config");
    return errors;
  }

  for (const [name, policy] of Object.entries(policies)) {
    if (!policy || typeof policy !== "object") {
      errors.push(`${name}: policy must be a mapping`);
      continue;
    }
    if (!Array.isArray(policy.endpoints)) {
      errors.push(`${name}: endpoints must be an array`);
      continue;
    }
    policy.endpoints.forEach((ep, i) => validateEndpoint(name, i, ep, errors));
  }

  return errors;
}

function main(argv) {
  const files = argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: validate-policies.js <file1.yaml> [<file2.yaml> ...]");
    process.exit(2);
  }

  let exitCode = 0;
  for (const f of files) {
    const errors = validatePolicy(f);
    if (errors.length > 0) {
      console.error(`\n❌ ${f}:`);
      for (const e of errors) console.error(`   - ${e}`);
      exitCode = 1;
    } else {
      console.log(`✅ ${path.basename(f)}`);
    }
  }
  process.exit(exitCode);
}

main(process.argv);
