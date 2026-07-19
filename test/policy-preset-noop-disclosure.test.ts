// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import * as policies from "../src/lib/policy";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const POLICY_MODULE = JSON.stringify(path.join(REPO_ROOT, "src/lib/policy/index.ts"));
const REGISTRY_MODULE = JSON.stringify(path.join(REPO_ROOT, "src/lib/state/registry.ts"));
const SOURCE_NODE_ARGS = ["--import", "tsx"];
const tempRoots: string[] = [];

type Scenario = {
  currentPolicy: string;
  presetNames: string[];
  batch?: boolean;
  suppressDisclosure?: boolean;
  disclosedPresetState?: policies.PresetPolicyState | null;
};

function runScenario({
  currentPolicy,
  presetNames,
  batch = false,
  suppressDisclosure = false,
  disclosedPresetState,
}: Scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preset-disclosure-"));
  tempRoots.push(root);
  const currentPolicyPath = path.join(root, "current.yaml");
  const appliedPolicyPath = path.join(root, "applied.yaml");
  const callsPath = path.join(root, "calls.log");
  const openshell = path.join(root, "openshell");
  fs.writeFileSync(currentPolicyPath, currentPolicy);
  fs.writeFileSync(callsPath, "");
  fs.writeFileSync(
    openshell,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\n'
  cat ${JSON.stringify(currentPolicyPath)}
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  printf 'policy set\n' >> ${JSON.stringify(callsPath)}
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      cp "$2" ${JSON.stringify(appliedPolicyPath)}
      break
    fi
    shift
  done
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  const invocation = batch
    ? `policies.applyPresets("alpha", ${JSON.stringify(presetNames)})`
    : `policies.applyPreset("alpha", ${JSON.stringify(presetNames[0])}, ${JSON.stringify({ suppressDisclosure, disclosedPresetState })})`;
  const script = `
const fs = require("node:fs");
const policies = require(${POLICY_MODULE});
const registry = require(${REGISTRY_MODULE});
registry.registerSandbox({ name: "alpha", policies: [] });
const result = ${invocation};
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  result,
  calls: fs.readFileSync(process.env.CALLS_PATH, "utf8").trim().split("\\n").filter(Boolean),
  registry: registry.getSandbox("alpha"),
}));
`;
  const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      NEMOCLAW_OPENSHELL_BIN: openshell,
      CURRENT_POLICY_PATH: currentPolicyPath,
      APPLIED_POLICY_PATH: appliedPolicyPath,
      CALLS_PATH: callsPath,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout.split("__RESULT__")[1]) as {
    result: boolean;
    calls: string[];
    registry: { policies: string[] };
  };
  return { output: `${result.stdout.split("__RESULT__")[0]}\n${result.stderr}`, payload };
}

function policyWithPresets(names: string[]): string {
  return policies.mergePresetNamesIntoPolicy("version: 1\nnetwork_policies: {}\n", names).policy;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("preset no-op egress disclosure (#7179)", () => {
  it("repairs single-preset attribution without claiming or submitting new egress", () => {
    const { output, payload } = runScenario({
      currentPolicy: policyWithPresets(["npm"]),
      presetNames: ["npm"],
    });

    expect(output).toContain("Preset 'npm' is already effective; no new egress would be opened.");
    expect(output).not.toContain("Effective egress that would be opened:");
    expect(payload.calls).toEqual([]);
    expect(payload.registry.policies).toEqual(["npm"]);
  });

  it("skips the gateway set when every batch preset already matches", () => {
    const { output, payload } = runScenario({
      currentPolicy: policyWithPresets(["npm", "pypi"]),
      presetNames: ["npm", "pypi"],
      batch: true,
    });

    expect(output).toContain("Preset 'npm' is already effective");
    expect(output).toContain("Preset 'pypi' is already effective");
    expect(payload.calls).toEqual([]);
    expect(payload.registry.policies).toEqual(["npm", "pypi"]);
  });

  it("discloses and submits only the absent part of a mixed batch", () => {
    const { output, payload } = runScenario({
      currentPolicy: policyWithPresets(["npm"]),
      presetNames: ["npm", "pypi"],
      batch: true,
    });

    expect(output).toContain("Preset 'npm' is already effective");
    expect(output).toContain("Effective egress that would be opened:");
    expect(output).toContain("policy 'pypi'");
    expect(payload.calls).toEqual(["policy set"]);
  });

  it("treats same-key drift as an effective-scope replacement", () => {
    const drifted = policyWithPresets(["npm"]).replace("registry.npmjs.org", "drift.example");
    const { output, payload } = runScenario({ currentPolicy: drifted, presetNames: ["npm"] });

    expect(output).toContain(
      "Effective egress scope that would replace the current preset policy:",
    );
    expect(output).not.toContain("Preset 'npm' is already effective");
    expect(payload.calls).toEqual(["policy set"]);
  });

  it("does not print a duplicate scope when the caller already disclosed it", () => {
    const { output, payload } = runScenario({
      currentPolicy: "version: 1\nnetwork_policies: {}\n",
      presetNames: ["npm"],
      suppressDisclosure: true,
    });

    expect(output).not.toContain("Effective egress");
    expect(output).not.toContain("Preset 'npm' is already effective");
    expect(payload.calls).toEqual(["policy set"]);
    expect(payload.registry.policies).toEqual(["npm"]);
  });

  it("discloses again when the live policy changed after an earlier no-op preview (#7179)", () => {
    const { output, payload } = runScenario({
      currentPolicy: "version: 1\nnetwork_policies: {}\n",
      presetNames: ["npm"],
      disclosedPresetState: "match",
    });

    expect(output).toContain("Effective egress that would be opened:");
    expect(output).not.toContain("Preset 'npm' is already effective");
    expect(payload.calls).toEqual(["policy set"]);
  });
});
