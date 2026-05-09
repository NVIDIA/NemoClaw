// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Integration tests for the tier selector in the onboarding wizard.
// Verifies that selectPolicyTier and setupPoliciesWithSelection wire correctly.

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

/**
 * Run a small inline Node script that mocks out the minimal dependencies of
 * onboard.js, calls the given async expression, and prints a JSON payload.
 */
function runScript(scriptBody: string): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tier-onboard-"));
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
 * Build a minimal mock preamble that stubs out the heavy I/O dependencies of
 * onboard.js so we can require it without a real openshell installation.
 *
 * Sets NEMOCLAW_POLICY_TIER, NEMOCLAW_POLICY_MODE, and NEMOCLAW_POLICY_PRESETS
 * before the require so non-interactive paths read the right values.
 */
function buildPreamble({
  tierEnv = "balanced",
  policyMode = "skip",
  policyPresets = "",
  stubOpenshellBin = false,
  runCaptureReturn = "",
} = {}): string {
  const credPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));
  const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
  const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const resolveOpenshellPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "adapters", "openshell", "resolve.js"),
  );

  // Both stubs must run before onboard.js is required — onboard destructures
  // resolveOpenshell and runCapture at require time, so later overrides are
  // too late for anything onboard calls internally.
  const openshellStub = stubOpenshellBin
    ? `require(${resolveOpenshellPath}).resolveOpenshell = () => "/usr/bin/true";`
    : "";

  return String.raw`
const credentials = require(${credPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});

// Stub heavy I/O
credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };
credentials.ensureApiKey = async () => {};
credentials.getCredential = () => null;
runner.run = () => {};
runner.runCapture = () => ${JSON.stringify(runCaptureReturn)};
${openshellStub}

const updates = [];
registry.registerSandbox = () => true;
registry.updateSandbox = (_name, fields) => { updates.push(fields); return true; };
registry.getSandbox = () => ({ name: "test-sb", model: null, provider: null });

// Set env vars before requiring onboard so module-level code sees them
process.env.NEMOCLAW_POLICY_TIER = ${JSON.stringify(tierEnv)};
process.env.NEMOCLAW_POLICY_MODE = ${JSON.stringify(policyMode)};
process.env.NEMOCLAW_POLICY_PRESETS = ${JSON.stringify(policyPresets)};

const { selectPolicyTier, setupPoliciesWithSelection } = require(${onboardPath});
`;
}

describe("policy tier onboarding integration", () => {
  it("selectPolicyTier returns selected tier name in non-interactive mode", () => {
    const script =
      buildPreamble({ tierEnv: "balanced" }) +
      String.raw`
// Suppress note() output so stdout is clean JSON
console.log = () => {};
(async () => {
  const tier = await selectPolicyTier();
  process.stdout.write(JSON.stringify({ tier }) + "\n");
})().catch((err) => { process.stderr.write(err.message + "\n"); process.exit(1); });
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.tier, "balanced");
  });

  it("restricted tier produces an empty preset list", () => {
    const tiersPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "tiers.js"));
    const script =
      buildPreamble({ tierEnv: "restricted" }) +
      String.raw`
console.log = () => {};
(async () => {
  const tier = await selectPolicyTier();
  const tiers = require(${tiersPath});
  const presets = tiers.resolveTierPresets(tier);
  process.stdout.write(JSON.stringify({ tier, presets }) + "\n");
})().catch((err) => { process.stderr.write(err.message + "\n"); process.exit(1); });
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.tier, "restricted");
    assert.equal(payload.presets.length, 0);
  });

  it("balanced tier resolves presets all with read-write access", () => {
    const tiersPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "tiers.js"));
    const script =
      buildPreamble({ tierEnv: "balanced" }) +
      String.raw`
console.log = () => {};
(async () => {
  const tier = await selectPolicyTier();
  const tiers = require(${tiersPath});
  const presets = tiers.resolveTierPresets(tier);
  process.stdout.write(JSON.stringify({ tier, presets }) + "\n");
})().catch((err) => { process.stderr.write(err.message + "\n"); process.exit(1); });
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.tier, "balanced");
    assert.ok(payload.presets.length >= 5, "balanced tier must have at least 5 presets");
    for (const p of payload.presets) {
      assert.equal(p.access, "read-write", `preset ${p.name} in balanced should be read-write`);
    }
  });

  it("open tier resolves presets including at least one social/messaging preset", () => {
    const tiersPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "tiers.js"));
    const script =
      buildPreamble({ tierEnv: "open" }) +
      String.raw`
console.log = () => {};
(async () => {
  const tier = await selectPolicyTier();
  const tiers = require(${tiersPath});
  const presets = tiers.resolveTierPresets(tier);
  process.stdout.write(JSON.stringify({ tier, presets }) + "\n");
})().catch((err) => { process.stderr.write(err.message + "\n"); process.exit(1); });
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.tier, "open");
    const names: string[] = payload.presets.map((p: { name: string }) => p.name);
    const social = ["slack", "discord", "telegram"];
    const hasSocial = social.some((n) => names.includes(n));
    assert.ok(
      hasSocial,
      `open tier must include at least one social preset, got: ${names.join(", ")}`,
    );
  });

  it("a preset can be deselected via selected option in resolveTierPresets", () => {
    const tiersPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "tiers.js"));
    const script =
      buildPreamble({ tierEnv: "balanced" }) +
      String.raw`
(async () => {
  const tiers = require(${tiersPath});
  // Deselect npm — keep only the remaining names
  const allPresets = tiers.resolveTierPresets("balanced");
  const withoutNpm = allPresets.filter((p) => p.name !== "npm").map((p) => p.name);
  const resolved = tiers.resolveTierPresets("balanced", { selected: withoutNpm });
  process.stdout.write(JSON.stringify({ resolved }) + "\n");
})().catch((err) => { process.stderr.write(err.message + "\n"); process.exit(1); });
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.resolved.map((p: { name: string }) => p.name).includes("npm"), "npm should be deselected");
  });

  it("access level can be restricted from read-write to read via override", () => {
    const tiersPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "tiers.js"));
    const script =
      buildPreamble({ tierEnv: "balanced" }) +
      String.raw`
(async () => {
  const tiers = require(${tiersPath});
  const resolved = tiers.resolveTierPresets("balanced", { overrides: { npm: "read" } });
  const npm = resolved.find((p) => p.name === "npm");
  const pypi = resolved.find((p) => p.name === "pypi");
  process.stdout.write(JSON.stringify({ npmAccess: npm.access, pypiAccess: pypi.access }) + "\n");
})().catch((err) => { process.stderr.write(err.message + "\n"); process.exit(1); });
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.npmAccess, "read");
    assert.equal(payload.pypiAccess, "read-write");
  });

  it("selectPolicyTier emits a note containing the tier name", () => {
    const script =
      buildPreamble({ tierEnv: "balanced" }) +
      String.raw`
const lines = [];
const origLog = console.log;
console.log = (...args) => lines.push(args.join(" "));

(async () => {
  try {
    const tier = await selectPolicyTier();
    lines.push("TIER:" + tier);
    origLog(JSON.stringify({ lines }));
  } catch (err) {
    console.log = origLog;
    origLog(JSON.stringify({ lines, error: err.message }));
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    // non-interactive note includes the tier name
    assert.ok(
      payload.lines.some((l: string) => l.includes("balanced")),
      `summary must mention balanced tier, got: ${JSON.stringify(payload.lines)}`,
    );
    assert.ok(payload.lines.some((l: string) => l.includes("TIER:balanced")));
  });

  it("selected tier is persisted to the registry via updateSandbox({ policyTier })", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
    const script =
      buildPreamble({ tierEnv: "open", policyMode: "skip" }) +
      String.raw`
const policies = require(${policiesPath});
policies.applyPreset = () => {};
policies.getAppliedPresets = () => [];

const lines = [];
const origLog = console.log;
console.log = (...args) => lines.push(args.join(" "));

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", {});
    console.log = origLog;
    origLog(JSON.stringify({ applied, updates }));
  } catch (err) {
    console.log = origLog;
    origLog(JSON.stringify({ error: err.message, updates }));
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    // registry.updateSandbox must have been called with policyTier: "open"
    const tierUpdate = payload.updates.find((u: { policyTier?: string }) => u.policyTier !== undefined);
    assert.ok(
      tierUpdate,
      `updateSandbox should have been called with policyTier, updates: ${JSON.stringify(payload.updates)}`,
    );
    assert.equal(tierUpdate.policyTier, "open");
    // With POLICY_MODE=skip, applied presets list is empty
    assert.deepEqual(payload.applied, []);
  });

  it("omits Brave from policy preset selection when web search is unsupported", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
    const script =
      buildPreamble({
        tierEnv: "balanced",
        policyMode: "suggested",
        stubOpenshellBin: true,
        runCaptureReturn: "Running",
      }) +
      String.raw`
const policies = require(${policiesPath});
const appliedCalls = [];
policies.applyPreset = (_sandbox, name) => { appliedCalls.push(name); return true; };
policies.getAppliedPresets = () => [];

console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", { webSearchSupported: false });
    process.stdout.write(JSON.stringify({ applied, appliedCalls }) + "\n");
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
      !payload.applied.includes("brave"),
      `Unsupported web-search presets included Brave: ${payload.applied}`,
    );
    assert.ok(
      !payload.appliedCalls.includes("brave"),
      `Unsupported web-search flow applied Brave: ${payload.appliedCalls}`,
    );
    assert.ok(payload.applied.includes("pypi"), "normal dev presets should still be included");
  });

  it("removes a previously-applied Brave preset when web search is unsupported", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
    const script =
      buildPreamble({
        tierEnv: "balanced",
        policyMode: "suggested",
        stubOpenshellBin: true,
        runCaptureReturn: "Running",
      }) +
      String.raw`
const policies = require(${policiesPath});
const appliedCalls = [];
const removedCalls = [];
policies.applyPreset = (_sandbox, name) => { appliedCalls.push(name); return true; };
policies.removePreset = (_sandbox, name) => { removedCalls.push(name); return true; };
policies.getAppliedPresets = () => ["brave", "npm"];

console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", { webSearchSupported: false });
    process.stdout.write(JSON.stringify({ applied, appliedCalls, removedCalls }) + "\n");
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
      !payload.applied.includes("brave"),
      `Unsupported web-search presets included Brave: ${payload.applied}`,
    );
    assert.ok(
      payload.removedCalls.includes("brave"),
      `Unsupported web-search flow did not remove Brave: ${payload.removedCalls}`,
    );
    assert.ok(
      !payload.appliedCalls.includes("brave"),
      `Unsupported web-search flow applied Brave: ${payload.appliedCalls}`,
    );
  });

  it("clamps resumed policy presets to web-search-supported presets", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
    const script =
      buildPreamble({
        tierEnv: "balanced",
        policyMode: "suggested",
        stubOpenshellBin: true,
        runCaptureReturn: "Running",
      }) +
      String.raw`
const policies = require(${policiesPath});
const appliedCalls = [];
const removedCalls = [];
policies.applyPreset = (_sandbox, name) => { appliedCalls.push(name); return true; };
policies.removePreset = (_sandbox, name) => { removedCalls.push(name); return true; };
policies.getAppliedPresets = () => ["brave"];

console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", {
      webSearchSupported: false,
      selectedPresets: ["brave", "npm"],
    });
    process.stdout.write(JSON.stringify({ applied, appliedCalls, removedCalls }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    assert.deepEqual(payload.applied, ["npm"]);
    assert.deepEqual(payload.appliedCalls, ["npm"]);
    assert.deepEqual(payload.removedCalls, ["brave"]);
  });

  it("clamps an unsupported-only resumed policy preset list to empty", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
    const script =
      buildPreamble({
        tierEnv: "balanced",
        policyMode: "suggested",
        stubOpenshellBin: true,
        runCaptureReturn: "Running",
      }) +
      String.raw`
const policies = require(${policiesPath});
const appliedCalls = [];
const removedCalls = [];
policies.applyPreset = (_sandbox, name) => { appliedCalls.push(name); return true; };
policies.removePreset = (_sandbox, name) => { removedCalls.push(name); return true; };
policies.getAppliedPresets = () => ["brave"];

console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", {
      webSearchSupported: false,
      selectedPresets: ["brave"],
    });
    process.stdout.write(JSON.stringify({ applied, appliedCalls, removedCalls }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    assert.deepEqual(payload.applied, []);
    assert.deepEqual(payload.appliedCalls, []);
    assert.deepEqual(payload.removedCalls, ["brave"]);
  });

  it("preserves a resumed custom preset whose name matches an unsupported built-in", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
    const script =
      buildPreamble({
        tierEnv: "balanced",
        policyMode: "suggested",
        stubOpenshellBin: true,
        runCaptureReturn: "Running",
      }) +
      String.raw`
const policies = require(${policiesPath});
const appliedCalls = [];
const removedCalls = [];
policies.applyPreset = (_sandbox, name) => { appliedCalls.push(name); return true; };
policies.removePreset = (_sandbox, name) => { removedCalls.push(name); return true; };
policies.getAppliedPresets = () => ["brave"];
policies.listCustomPresets = () => [{ name: "brave", description: "custom preset" }];

console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", {
      webSearchSupported: false,
      selectedPresets: ["brave", "npm"],
    });
    process.stdout.write(JSON.stringify({ applied, appliedCalls, removedCalls }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    assert.deepEqual(payload.applied, ["brave", "npm"]);
    assert.deepEqual(payload.appliedCalls, ["npm"]);
    assert.deepEqual(payload.removedCalls, []);
  });

  it("preserves a non-interactive custom preset whose name matches an unsupported built-in", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
    const script =
      buildPreamble({
        tierEnv: "balanced",
        policyMode: "suggested",
        stubOpenshellBin: true,
        runCaptureReturn: "Running",
      }) +
      String.raw`
const policies = require(${policiesPath});
const appliedCalls = [];
const removedCalls = [];
policies.applyPreset = (_sandbox, name) => { appliedCalls.push(name); return true; };
policies.removePreset = (_sandbox, name) => { removedCalls.push(name); return true; };
policies.getAppliedPresets = () => ["brave"];
policies.listCustomPresets = () => [{ name: "brave", description: "custom preset" }];

console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", { webSearchSupported: false });
    process.stdout.write(JSON.stringify({ applied, appliedCalls, removedCalls }) + "\n");
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
      payload.applied.includes("brave"),
      `custom Brave was dropped: ${payload.applied}`,
    );
    assert.ok(
      !payload.appliedCalls.includes("brave"),
      `custom Brave was re-applied: ${payload.appliedCalls}`,
    );
    assert.deepEqual(payload.removedCalls, []);
  });

  // #2429: an unrecognised NEMOCLAW_POLICY_MODE used to hard-exit at step 8/8,
  // leaving the already-built sandbox with zero presets. We now warn and fall
  // back to the tier-derived suggestions so the sandbox stays usable, and hint
  // that the user may have meant NEMOCLAW_POLICY_TIER when the value looks like
  // a tier name.
  it("falls back to tier suggestions when NEMOCLAW_POLICY_MODE is unknown (#2429)", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
    const script =
      buildPreamble({
        tierEnv: "balanced",
        policyMode: "restricted",
        stubOpenshellBin: true,
        runCaptureReturn: "Running",
      }) +
      String.raw`
const policies = require(${policiesPath});
const appliedCalls = [];
policies.applyPreset = (sandbox, name) => { appliedCalls.push(name); return true; };
policies.getAppliedPresets = () => [];

// Silence onboard's note()/console.log so stdout is pure JSON.
console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", {});
    process.stdout.write(JSON.stringify({ applied, appliedCalls }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    // Warn path, not exit: tier suggestions were applied (non-empty).
    assert.ok(
      payload.applied.length > 0,
      `expected fallback presets to be applied, got: ${JSON.stringify(payload.applied)}`,
    );
    // Warnings mention the bad value, the tier-name hint, and the fallback.
    // They land on stderr via console.warn.
    assert.match(result.stderr, /Unsupported NEMOCLAW_POLICY_MODE: restricted/);
    assert.match(result.stderr, /NEMOCLAW_POLICY_TIER=restricted/);
    assert.match(result.stderr, /Falling back to suggested presets/);
  });

  it("omits the tier-name hint for a non-tier invalid value (#2429)", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));
    const script =
      buildPreamble({
        tierEnv: "balanced",
        policyMode: "garbage",
        stubOpenshellBin: true,
        runCaptureReturn: "Running",
      }) +
      String.raw`
const policies = require(${policiesPath});
policies.applyPreset = () => true;
policies.getAppliedPresets = () => [];

console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", {});
    process.stdout.write(JSON.stringify({ applied }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    assert.match(result.stderr, /Unsupported NEMOCLAW_POLICY_MODE: garbage/);
    assert.ok(
      !/did you mean NEMOCLAW_POLICY_TIER/.test(result.stderr),
      `tier-name hint should not appear for non-tier values, stderr: ${result.stderr}`,
    );
  });
});

describe("selectTierPresetsAndAccess", () => {
  const tiersPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "tiers.js"));
  const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policies.js"));

  function buildPresetsScript(body: string): string {
    const credPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    return String.raw`
const credentials = require(${credPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
credentials.prompt = async () => { throw new Error("unexpected prompt"); };
credentials.ensureApiKey = async () => {};
credentials.getCredential = () => null;
runner.run = () => {};
runner.runCapture = () => "";
registry.getSandbox = () => ({ name: "test-sb", model: null, provider: null });
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
const { selectTierPresetsAndAccess } = require(${onboardPath});
const tiers = require(${tiersPath});
const policies = require(${policiesPath});
${body}
`;
  }

  function run(body: string): SpawnSyncReturns<string> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-presets-"));
    const scriptPath = path.join(tmpDir, "script.js");
    fs.writeFileSync(scriptPath, buildPresetsScript(body));
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir, NEMOCLAW_NON_INTERACTIVE: "1" },
      timeout: 10000,
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return result;
  }

  it("returns tier presets with their default access levels", () => {
    const result = run(String.raw`
(async () => {
  const allPresets = policies.listPresets();
  const resolved = await selectTierPresetsAndAccess("balanced", allPresets);
  process.stdout.write(JSON.stringify(resolved) + "\n");
})().catch((e) => { process.stderr.write(e.message); process.exit(1); });
`);
    assert.equal(result.status, 0, result.stderr);
    const resolved: Array<{ name: string; access: string }> = JSON.parse(result.stdout.trim());
    const names = resolved.map((p) => p.name);
    assert.ok(names.includes("npm"), "npm should be included");
    assert.ok(names.includes("brave"), "brave should be included");
    assert.ok(!names.includes("slack"), "slack should not be included in balanced");
    for (const p of resolved) {
      assert.equal(p.access, "read-write", `${p.name} should default to read-write`);
    }
  });

  it("restricted tier returns empty array", () => {
    const result = run(String.raw`
(async () => {
  const allPresets = policies.listPresets();
  const resolved = await selectTierPresetsAndAccess("restricted", allPresets);
  process.stdout.write(JSON.stringify(resolved) + "\n");
})().catch((e) => { process.stderr.write(e.message); process.exit(1); });
`);
    assert.equal(result.status, 0, result.stderr);
    const resolved = JSON.parse(result.stdout.trim());
    assert.deepEqual(resolved, []);
  });

  it("extraSelected adds non-tier preset to initial checked set", () => {
    const result = run(String.raw`
(async () => {
  const allPresets = policies.listPresets();
  const resolved = await selectTierPresetsAndAccess("balanced", allPresets, ["slack"]);
  process.stdout.write(JSON.stringify(resolved) + "\n");
})().catch((e) => { process.stderr.write(e.message); process.exit(1); });
`);
    assert.equal(result.status, 0, result.stderr);
    const resolved: Array<{ name: string }> = JSON.parse(result.stdout.trim());
    const names = resolved.map((p) => p.name);
    assert.ok(names.includes("slack"), "slack should be included via extraSelected");
    assert.ok(names.includes("npm"), "npm (tier default) should still be included");
  });

  it("extraSelected with invalid preset name is silently filtered", () => {
    const result = run(String.raw`
(async () => {
  const allPresets = policies.listPresets();
  const resolved = await selectTierPresetsAndAccess("balanced", allPresets, ["nonexistent-preset"]);
  process.stdout.write(JSON.stringify(resolved) + "\n");
})().catch((e) => { process.stderr.write(e.message); process.exit(1); });
`);
    assert.equal(result.status, 0, result.stderr);
    const resolved: Array<{ name: string }> = JSON.parse(result.stdout.trim());
    const names = resolved.map((p) => p.name);
    assert.ok(!names.includes("nonexistent-preset"), "invalid preset should be dropped");
  });

  it("tier presets appear before non-tier presets in returned order", () => {
    const result = run(String.raw`
(async () => {
  const allPresets = policies.listPresets();
  const resolved = await selectTierPresetsAndAccess("balanced", allPresets, ["slack"]);
  process.stdout.write(JSON.stringify(resolved) + "\n");
})().catch((e) => { process.stderr.write(e.message); process.exit(1); });
`);
    assert.equal(result.status, 0, result.stderr);
    const resolved: Array<{ name: string }> = JSON.parse(result.stdout.trim());
    const names = resolved.map((p) => p.name);
    const tierNames = ["npm", "pypi", "huggingface", "brew", "brave"];
    const lastTierIdx = Math.max(...tierNames.map((n) => names.indexOf(n)));
    const slackIdx = names.indexOf("slack");
    assert.ok(slackIdx > lastTierIdx, "non-tier preset (slack) should appear after tier presets");
  });

  it("each resolved preset has name and access fields", () => {
    const result = run(String.raw`
(async () => {
  const allPresets = policies.listPresets();
  const resolved = await selectTierPresetsAndAccess("open", allPresets);
  process.stdout.write(JSON.stringify(resolved) + "\n");
})().catch((e) => { process.stderr.write(e.message); process.exit(1); });
`);
    assert.equal(result.status, 0, result.stderr);
    const resolved: Array<{ name: string; access: string }> = JSON.parse(result.stdout.trim());
    assert.ok(resolved.length > 0, "open tier should have presets");
    for (const p of resolved) {
      assert.equal(typeof p.name, "string");
      assert.ok(p.access === "read" || p.access === "read-write", `unexpected access: ${p.access}`);
    }
  });
});
