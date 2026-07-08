// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import {
  buildPolicyTierOnboardPreamble as buildPreamble,
  policyTierOnboardScriptRepoRoot as repoRoot,
  runPolicyTierOnboardScript as runScript,
} from "./helpers/policy-tier-onboard-script";

const policiesPath = JSON.stringify(path.join(repoRoot, "src", "lib", "policy", "index.ts"));

function buildRestrictedOpenclawScript({
  applied,
  selectedPresets,
  resumeTier,
}: {
  applied: string[];
  selectedPresets?: string[];
  resumeTier?: boolean;
}): string {
  const resumePreamble = resumeTier
    ? `\nregistry.getSandbox = () => ({ name: "test-sb", policyTier: "restricted" });\n`
    : "";
  const callOpts =
    selectedPresets !== undefined ? `, selectedPresets: ${JSON.stringify(selectedPresets)}` : "";
  return (
    buildPreamble({
      tierEnv: "restricted",
      policyMode: "suggested",
      stubOpenshellBin: true,
      runCaptureReturn: "Running",
    }) +
    String.raw`${resumePreamble}
const policies = require(${policiesPath});
const appliedCalls = [];
const removedCalls = [];
policies.applyPreset = (_sandbox, name) => { appliedCalls.push(name); return true; };
policies.applyPresets = (_sandbox, names) => { for (const name of names) appliedCalls.push(name); return true; };
policies.removePreset = (_sandbox, name) => { removedCalls.push(name); return true; };
policies.getAppliedPresets = () => ${JSON.stringify(applied)};

console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", { agent: "openclaw"${callOpts} });
    process.stdout.write(JSON.stringify({ applied, appliedCalls, removedCalls }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`
  );
}

const otelDisabledEnv = {
  NEMOCLAW_OPENCLAW_OTEL: undefined,
  NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: undefined,
};

describe("restricted tier reconciles stale openclaw-diagnostics-otel-local with OTEL disabled", () => {
  it("non-interactive path removes a previously-applied openclaw-diagnostics-otel-local", () => {
    const script = buildRestrictedOpenclawScript({
      applied: ["openclaw-diagnostics-otel-local"],
    });
    const result = runScript(script, otelDisabledEnv);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    assert.ok(
      !payload.applied.includes("openclaw-diagnostics-otel-local"),
      `restricted reconciliation must exclude stale openclaw-diagnostics-otel-local when OTEL is disabled; got: ${JSON.stringify(payload.applied)}`,
    );
    assert.ok(
      payload.removedCalls.includes("openclaw-diagnostics-otel-local"),
      `restricted reconciliation must call removePreset for stale openclaw-diagnostics-otel-local when OTEL is disabled; got: ${JSON.stringify(payload.removedCalls)}`,
    );
  });

  it("resume path excludes a previously-applied openclaw-diagnostics-otel-local", () => {
    const script = buildRestrictedOpenclawScript({
      applied: ["openclaw-diagnostics-otel-local"],
      selectedPresets: [],
      resumeTier: true,
    });
    const result = runScript(script, otelDisabledEnv);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    assert.ok(
      !payload.applied.includes("openclaw-diagnostics-otel-local"),
      `resume target must exclude stale openclaw-diagnostics-otel-local on restricted when OTEL is disabled; got: ${JSON.stringify(payload.applied)}`,
    );
    assert.ok(
      payload.removedCalls.includes("openclaw-diagnostics-otel-local"),
      `restricted resume must call removePreset for stale openclaw-diagnostics-otel-local when OTEL is disabled; got: ${JSON.stringify(payload.removedCalls)}`,
    );
  });
});

describe("restricted recordedTierName plumbing through resume", () => {
  it("resume against an originally-restricted sandbox filters openclaw-pricing from the operator's selected presets", () => {
    const script = buildRestrictedOpenclawScript({
      applied: [],
      selectedPresets: ["openclaw-pricing", "npm"],
      resumeTier: true,
    });
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    assert.ok(
      !payload.applied.includes("openclaw-pricing"),
      `resume target must filter openclaw-pricing when recordedTierName='restricted'; got: ${JSON.stringify(payload.applied)}`,
    );
    assert.ok(
      !payload.appliedCalls.includes("openclaw-pricing"),
      `resume must not call applyPreset/applyPresets for openclaw-pricing on restricted recordedTierName; got: ${JSON.stringify(payload.appliedCalls)}`,
    );
  });

  it("resume against an originally-balanced sandbox preserves operator-selected openclaw-pricing", () => {
    const script =
      buildPreamble({
        tierEnv: "balanced",
        policyMode: "suggested",
        stubOpenshellBin: true,
        runCaptureReturn: "Running",
      }) +
      String.raw`
registry.getSandbox = () => ({ name: "test-sb", policyTier: "balanced" });

const policies = require(${policiesPath});
const appliedCalls = [];
const removedCalls = [];
policies.applyPreset = (_sandbox, name) => { appliedCalls.push(name); return true; };
policies.applyPresets = (_sandbox, names) => { for (const name of names) appliedCalls.push(name); return true; };
policies.removePreset = (_sandbox, name) => { removedCalls.push(name); return true; };
policies.getAppliedPresets = () => [];

console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", {
      agent: "openclaw",
      selectedPresets: ["openclaw-pricing", "npm"],
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
    assert.ok(
      payload.applied.includes("openclaw-pricing"),
      `resume target must keep openclaw-pricing when recordedTierName='balanced'; got: ${JSON.stringify(payload.applied)}`,
    );
  });
});
