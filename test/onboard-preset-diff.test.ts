// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #2177 — when a user re-runs `nemoclaw onboard` on an
// existing sandbox and narrows the preset selection (e.g. Balanced default
// of [npm, pypi, huggingface, brew, brave] down to just [npm]), the policy
// setup step must honor the final selection: apply new presets AND remove
// previously-applied ones that are no longer selected.

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function runScript(scriptBody: string): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preset-diff-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
    },
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

/**
 * Build a preamble that:
 *   - seeds `applied` to simulate the user's prior onboard (Balanced defaults)
 *   - tracks every applyPreset / removePreset call so the test can assert
 *     exactly what the preset-diff logic did
 *   - stubs the heavy I/O surfaces the same way policy-tiers-onboard.test.ts does
 */
function buildPreamble({
  tierEnv = "balanced",
  policyMode = "custom",
  policyPresets = "npm",
  alreadyApplied = ["npm", "pypi", "huggingface", "brew", "brave"],
} = {}): string {
  const credPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
  const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
  const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
  const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
  const resolveOpenshellPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "adapters", "openshell", "resolve.js"),
  );
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

  return String.raw`
// All stubs MUST be installed before requiring onboard so its module-level
// destructuring picks up the patched functions.
const resolver = require(${resolveOpenshellPath});
resolver.resolveOpenshell = () => "/fake/openshell";

const runner = require(${runnerPath});
runner.run = () => {};
// Return "Running" so waitForSandboxReady passes immediately.
runner.runCapture = () => "Running";

const credentials = require(${credPath});
credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };
credentials.ensureApiKey = async () => {};
credentials.getCredential = () => null;

const registry = require(${registryPath});
const updates = [];
registry.registerSandbox = () => true;
registry.updateSandbox = (_name, fields) => { updates.push(fields); return true; };
registry.getSandbox = () => ({ name: "test-sb", model: null, provider: null, policies: ${JSON.stringify(alreadyApplied)} });

const policies = require(${policiesPath});
const appliedCalls = [];
const removedCalls = [];
let appliedState = ${JSON.stringify(alreadyApplied)}.slice();
policies.getAppliedPresets = () => appliedState.slice();
policies.applyPreset = (_name, preset) => {
  appliedCalls.push(preset);
  if (!appliedState.includes(preset)) appliedState.push(preset);
  // Mirror production contract: real applyPreset returns true on success
  // and false on recoverable errors (unknown preset, malformed YAML, etc).
  return true;
};
policies.removePreset = (_name, preset) => {
  removedCalls.push(preset);
  appliedState = appliedState.filter((p) => p !== preset);
  return true;
};

process.env.NEMOCLAW_POLICY_TIER = ${JSON.stringify(tierEnv)};
process.env.NEMOCLAW_POLICY_MODE = ${JSON.stringify(policyMode)};
process.env.NEMOCLAW_POLICY_PRESETS = ${JSON.stringify(policyPresets)};

const { setupPoliciesWithSelection } = require(${onboardPath});
`;
}

describe("setupPoliciesWithSelection preset-diff (issue #2177)", () => {
  // In non-interactive mode a user who runs onboard twice — first with Balanced
  // defaults (applies 5 presets), second with NEMOCLAW_POLICY_PRESETS=npm —
  // expects the final sandbox to have ONLY npm. Previously-applied presets
  // must be removed.
  it("non-interactive narrow selection removes previously-applied presets", () => {
    const script =
      buildPreamble({ policyMode: "custom", policyPresets: "npm" }) +
      String.raw`
console.log = () => {};
(async () => {
  try {
    const chosen = await setupPoliciesWithSelection("test-sb", {});
    process.stdout.write(JSON.stringify({ chosen, appliedCalls, removedCalls, finalApplied: appliedState }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);

    // User asked for only npm.
    assert.deepEqual(payload.chosen, ["npm"]);

    // The 4 defaults from Balanced that the user did NOT re-select must be
    // removed. This is the regression guard for #2177.
    const expectedRemoved = ["pypi", "huggingface", "brew", "brave"].sort();
    assert.deepEqual(
      payload.removedCalls.slice().sort(),
      expectedRemoved,
      `expected to remove ${JSON.stringify(expectedRemoved)}, got ${JSON.stringify(payload.removedCalls)}`,
    );

    // Final applied set must equal the user's narrowed selection.
    assert.deepEqual(
      payload.finalApplied.slice().sort(),
      ["npm"],
      `final applied presets should be exactly [npm], got ${JSON.stringify(payload.finalApplied)}`,
    );
  });

  // Re-onboarding in the default `suggested` mode must not silently remove
  // presets the user added via `nemoclaw <name> policy-add` after the original
  // onboard. Tier defaults are recomputed against the current provider, so a
  // user-added preset such as `local-inference` is not in `suggestions` on a
  // cloud-provider sandbox — without the additive guard it would be removed.
  it("non-interactive suggested re-onboard preserves user-added presets", () => {
    const script =
      buildPreamble({
        policyMode: "suggested",
        policyPresets: "",
        // Balanced defaults plus a manually-added preset.
        alreadyApplied: ["npm", "pypi", "huggingface", "brew", "brave", "local-inference"],
      }) +
      String.raw`
console.log = () => {};
(async () => {
  try {
    const chosen = await setupPoliciesWithSelection("test-sb", { provider: "openai" });
    process.stdout.write(JSON.stringify({ chosen, appliedCalls, removedCalls, finalApplied: appliedState }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);

    // The user-added preset must still be in the chosen list.
    assert.ok(
      payload.chosen.includes("local-inference"),
      `expected chosen to preserve local-inference, got ${JSON.stringify(payload.chosen)}`,
    );

    // Nothing should be removed — every applied preset is either a tier
    // default or a user-added extra that the additive policy preserves.
    assert.deepEqual(
      payload.removedCalls,
      [],
      `expected no removals, got ${JSON.stringify(payload.removedCalls)}`,
    );

    // Final state should still contain every previously-applied preset.
    const finalSorted = payload.finalApplied.slice().sort();
    assert.deepEqual(finalSorted, ["brave", "brew", "huggingface", "local-inference", "npm", "pypi"]);
  });

  // Custom presets loaded via `policy-add --from-file` / `--from-dir` are
  // recorded on the sandbox alongside built-in presets. They must survive a
  // non-interactive re-onboard the same way named built-ins do — even though
  // they do not appear in `policies.listPresets()`.
  it("non-interactive suggested re-onboard preserves custom presets", () => {
    const script =
      buildPreamble({
        policyMode: "suggested",
        policyPresets: "",
        alreadyApplied: ["npm", "pypi", "huggingface", "brew", "brave", "my-internal-api"],
      }) +
      String.raw`
console.log = () => {};
(async () => {
  try {
    const chosen = await setupPoliciesWithSelection("test-sb", { provider: "openai" });
    process.stdout.write(JSON.stringify({ chosen, appliedCalls, removedCalls, finalApplied: appliedState }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);

    assert.ok(
      payload.chosen.includes("my-internal-api"),
      `expected chosen to preserve my-internal-api, got ${JSON.stringify(payload.chosen)}`,
    );
    assert.deepEqual(
      payload.removedCalls,
      [],
      `expected no removals, got ${JSON.stringify(payload.removedCalls)}`,
    );
  });

  // Widening the selection (user re-enables a preset they'd previously dropped)
  // must apply the new one and not re-apply things that are already applied.
  it("non-interactive widen selection applies only new presets", () => {
    const script =
      buildPreamble({
        policyMode: "custom",
        policyPresets: "npm,pypi",
        alreadyApplied: ["npm"],
      }) +
      String.raw`
console.log = () => {};
(async () => {
  try {
    const chosen = await setupPoliciesWithSelection("test-sb", {});
    process.stdout.write(JSON.stringify({ chosen, appliedCalls, removedCalls, finalApplied: appliedState }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);

    assert.deepEqual(payload.chosen.sort(), ["npm", "pypi"]);
    // Only pypi should be newly applied (npm was already there).
    assert.deepEqual(payload.appliedCalls, ["pypi"]);
    assert.deepEqual(payload.removedCalls, []);
    assert.deepEqual(payload.finalApplied.sort(), ["npm", "pypi"]);
  });
});
