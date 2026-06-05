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
//   npx tsx scripts/dev-tier-selector.ts
//
// This script is intentionally not part of the vitest suite. For automated coverage
// of this flow see test/policy-tiers-onboard.test.js.

import { createRequire } from "node:module";
import readline from "node:readline";

const require = createRequire(import.meta.url);

type MutableCredentials = typeof import("../dist/lib/credentials/store.js") & {
  ensureApiKey: () => Promise<{ kind: "credential"; value: string }>;
  prompt: (message: string) => Promise<string>;
};
type MutableRunner = typeof import("../dist/lib/runner.js");
type MutableRegistry = typeof import("../dist/lib/state/registry.js");
type OnboardUi = {
  selectPolicyTier: () => Promise<string>;
  selectTierPresetsAndAccess: (tierName: string, allPresets: unknown[]) => Promise<unknown>;
};
type PolicyModule = {
  listPresets: () => unknown[];
};

// ── Stubs ──────────────────────────────────────────────────────────────────
const creds = require("../dist/lib/credentials/store.js") as MutableCredentials;
const runner = require("../dist/lib/runner.js") as MutableRunner;
const registry = require("../dist/lib/state/registry.js") as MutableRegistry;

creds.ensureApiKey = async () => ({ kind: "credential", value: "dev-tier-selector" });
creds.getCredential = () => null;
creds.prompt = (msg: string) =>
  new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, (answer) => {
      rl.close();
      resolve(answer);
    });
  });

const successfulRunResult = {
  pid: 0,
  output: [null, "", ""],
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
};

runner.run = () => successfulRunResult;
runner.runCapture = () => "";

registry.getSandbox = () => ({ name: "test-sb", model: null, provider: null });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;

// ── Run ────────────────────────────────────────────────────────────────────
const { selectPolicyTier, selectTierPresetsAndAccess } =
  require("../dist/lib/onboard.js") as OnboardUi;
const policies = require("../dist/lib/policy/index.js") as PolicyModule;

(async () => {
  const tier = await selectPolicyTier();
  console.log("\nSelected tier:", tier);

  const allPresets = policies.listPresets();
  const resolved = await selectTierPresetsAndAccess(tier, allPresets);
  console.log("\nResolved presets:", resolved);
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
