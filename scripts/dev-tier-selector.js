// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// DEV SCRIPT — NOT FOR PRODUCTION USE
//
// Manual smoke-test for the interactive tier selector and preset access-mode UI.
// Stubs out heavy I/O (openshell, registry, credentials) so the TUI can be exercised
// without a real NemoClaw installation.
//
// Usage:
//   node scripts/dev-tier-selector.js
//
// This script is intentionally not part of the vitest suite. For automated coverage
// of this flow see test/policy-tiers-onboard.test.js.

"use strict";

const readline = require("readline");

// ── Stubs ──────────────────────────────────────────────────────────────────
const creds = require("../dist/lib/credentials.js");
const runner = require("../dist/lib/runner.js");
const registry = require("../dist/lib/registry.js");

creds.ensureApiKey = async () => {};
creds.getCredential = () => null;
creds.prompt = (msg) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, (answer) => {
      rl.close();
      resolve(answer);
    });
  });

runner.run = () => {};
runner.runCapture = () => "";

registry.getSandbox = () => ({ name: "test-sb", model: null, provider: null });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;

// ── Run ────────────────────────────────────────────────────────────────────
const { selectPolicyTier, selectTierPresetsAndAccess } = require("../dist/lib/onboard.js");
const policies = require("../dist/lib/policies.js");

(async () => {
  const tier = await selectPolicyTier();
  console.log("\nSelected tier:", tier);

  const allPresets = policies.listPresets();
  const resolved = await selectTierPresetsAndAccess(tier, allPresets);
  console.log("\nResolved presets:", resolved);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
