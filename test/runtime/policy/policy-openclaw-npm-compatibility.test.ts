// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  livePolicyMetadata,
  managedSandboxEntry,
  parseResultPayload,
  SANDBOX_ID,
} from "../../helpers/live-policy-fixture";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");
const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"));
const SOURCE_NODE_ARGS = ["--import", "tsx"];

const REVIEWED_BASELINE_ENTRY = {
  name: "npm_registry",
  endpoints: [
    {
      host: "registry.npmjs.org",
      port: 443,
      protocol: "rest",
      enforcement: "enforce",
      rules: [{ allow: { method: "GET", path: "/**" } }],
    },
  ],
  binaries: [{ path: "/usr/local/bin/openclaw" }],
};

const REVIEWED_NPM_ENTRY = {
  name: "npm_yarn",
  endpoints: [
    { host: "registry.npmjs.org", port: 443, access: "full", tls: "skip" },
    { host: "registry.yarnpkg.com", port: 443, access: "full", tls: "skip" },
  ],
  binaries: [
    { path: "/usr/local/bin/npm*" },
    { path: "/usr/local/bin/npx*" },
    { path: "/usr/local/bin/node*" },
    { path: "/usr/local/bin/yarn*" },
    { path: "/usr/bin/npm*" },
    { path: "/usr/bin/node*" },
  ],
};

const REVIEWED_PERSONAL_ENTRY = YAML.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "nemoclaw-blueprint/policies/presets/personal-open-internet.yaml"),
    "utf8",
  ),
).network_policies.personal_open_internet;

function policyWith(networkPolicies: Record<string, unknown>): string {
  return YAML.stringify({ version: 1, network_policies: networkPolicies });
}

function compatibilityEntry(npmEntry = REVIEWED_NPM_ENTRY) {
  const registryEndpoint = npmEntry.endpoints.find(
    (endpoint) => endpoint.host === "registry.npmjs.org" && endpoint.port === 443,
  );
  expect(registryEndpoint).toBeDefined();
  return {
    ...structuredClone(REVIEWED_BASELINE_ENTRY),
    endpoints: [structuredClone(registryEndpoint!)],
  };
}

function activePolicy(npmEntry = REVIEWED_NPM_ENTRY): string {
  return policyWith({
    npm_registry: compatibilityEntry(npmEntry),
    npm_yarn: structuredClone(npmEntry),
  });
}

function unoverlaidActivePolicy(): string {
  return policyWith({
    npm_registry: structuredClone(REVIEWED_BASELINE_ENTRY),
    npm_yarn: structuredClone(REVIEWED_NPM_ENTRY),
  });
}

function olderNpmEntry() {
  const entry = structuredClone(REVIEWED_NPM_ENTRY);
  const registryEndpoint = entry.endpoints.find(
    (endpoint) => endpoint.host === "registry.npmjs.org",
  );
  expect(registryEndpoint).toBeDefined();
  registryEndpoint!.tls = "auto";
  return entry;
}

type LiveScenario = {
  sandboxName: string;
  initialPolicy: string;
  childScript: string;
  setMode?: "success" | "fail" | "fail-once";
};

function runLiveScenario({
  sandboxName,
  initialPolicy,
  childScript,
  setMode = "success",
}: LiveScenario): {
  calls: string[];
  payload: any;
  stderr: string;
  stdout: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-compat-"));
  const fakeOpenshell = path.join(tmpDir, "openshell");
  const callsPath = path.join(tmpDir, "calls.log");
  const currentPolicyPath = path.join(tmpDir, "current-policy.yaml");
  const firstSetMarker = path.join(tmpDir, "first-set-attempted");
  fs.writeFileSync(currentPolicyPath, initialPolicy);

  fs.writeFileSync(
    fakeOpenshell,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "sandbox get" ]; then
  printf 'Name: %s\nId: ${SANDBOX_ID}\nPhase: Ready\n' ${JSON.stringify(sandboxName)}
  exit 0
fi
if [ "$1 $2" = "policy get" ] && [[ " $* " == *" --output json "* ]]; then
  printf '%s\n' ${JSON.stringify(livePolicyMetadata(sandboxName))}
  exit 0
fi
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
if [ "$1 $2" = "policy get" ]; then
  cat ${JSON.stringify(currentPolicyPath)}
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  npm_test_set_mode=${JSON.stringify(setMode)}
  if [ "$npm_test_set_mode" = "fail" ]; then
    exit 88
  fi
  if [ "$npm_test_set_mode" = "fail-once" ] && [ ! -f ${JSON.stringify(firstSetMarker)} ]; then
    touch ${JSON.stringify(firstSetMarker)}
    exit 88
  fi
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      cp "$2" ${JSON.stringify(currentPolicyPath)}
      break
    fi
    shift
  done
  printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  const script = String.raw`
const fs = require("node:fs");
const YAML = require("yaml");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox(${JSON.stringify({
    ...managedSandboxEntry(sandboxName),
  })});
${childScript}
`;

  try {
    const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
        CURRENT_POLICY: currentPolicyPath,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = fs.existsSync(callsPath)
      ? fs.readFileSync(callsPath, "utf-8").trim().split("\n").filter(Boolean)
      : [];
    return {
      calls,
      payload: parseResultPayload(result.stdout),
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("OpenClaw npm compatibility policy lifecycle", () => {
  it("removes npm attribution superseded by Personal without mutating live policy", () => {
    const initialPolicy = policyWith({
      personal_open_internet: structuredClone(REVIEWED_PERSONAL_ENTRY),
    });
    const { calls, payload } = runLiveScenario({
      sandboxName: "personal-owner",
      initialPolicy,
      childScript: `
const removed = policies.removePreset("personal-owner", "npm");
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  removed,
  policy: fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"),
  registry: registry.getSandbox("personal-owner"),
}));`,
    });

    expect(payload.removed).toBe(true);
    expect(payload.policy).toBe(initialPolicy);
    expect(payload.registry).not.toHaveProperty("policies");
    expect(calls.some((call) => call.startsWith("policy get "))).toBe(true);
    expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
  });

  it("does not restore overlapping npm web routes beside Personal during removal", () => {
    const initialPolicy = policyWith({
      personal_open_internet: structuredClone(REVIEWED_PERSONAL_ENTRY),
      npm_registry: compatibilityEntry(),
      npm_yarn: structuredClone(REVIEWED_NPM_ENTRY),
    });
    const { calls, payload } = runLiveScenario({
      sandboxName: "personal-npm",
      initialPolicy,
      childScript: `
const removed = policies.removePreset("personal-npm", "npm");
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  removed,
  policy: YAML.parse(fs.readFileSync(process.env.CURRENT_POLICY, "utf-8")),
  registry: registry.getSandbox("personal-npm"),
}));`,
    });

    expect(payload.removed).toBe(true);
    expect(payload.policy.network_policies).toEqual({
      personal_open_internet: REVIEWED_PERSONAL_ENTRY,
    });
    expect(payload.registry).not.toHaveProperty("policies");
    expect(calls.filter((call) => call.startsWith("policy set "))).toHaveLength(1);
  });

  it("repairs an active npm preset and restores the reviewed baseline on removal (#8497)", () => {
    const { calls, payload, stdout } = runLiveScenario({
      sandboxName: "npm-lifecycle",
      initialPolicy: unoverlaidActivePolicy(),
      childScript: `
const beforeApplyState = policies.getOpenClawNpmCompatibilityState("npm-lifecycle");
const applied = policies.applyPresets("npm-lifecycle", ["npm"]);
const afterApply = YAML.parse(fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"));
const afterApplyState = policies.getOpenClawNpmCompatibilityState("npm-lifecycle");
const removed = policies.removePreset("npm-lifecycle", "npm");
const afterRemove = YAML.parse(fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"));
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  beforeApplyState,
  applied,
  afterApplyState,
  afterApply,
  removed,
  afterRemove,
  registry: registry.getSandbox("npm-lifecycle"),
}));`,
    });

    expect(payload.beforeApplyState).toBe("repair");
    expect(payload.applied).toBe(true);
    expect(payload.afterApplyState).toBe("match");
    expect(payload.afterApply.network_policies.npm_registry).toEqual(compatibilityEntry());
    expect(payload.afterApply.network_policies.npm_yarn).toEqual(REVIEWED_NPM_ENTRY);
    expect(payload.removed).toBe(true);
    expect(payload.afterRemove.network_policies.npm_yarn).toBeUndefined();
    expect(payload.afterRemove.network_policies.npm_registry).toEqual(REVIEWED_BASELINE_ENTRY);
    expect(payload.registry).not.toHaveProperty("policies");
    expect(stdout).toContain("Effective egress scope that would replace the current preset policy");
    expect(stdout).toContain("OpenClaw npm compatibility");
    expect(stdout).not.toContain("already effective; no new egress would be opened");
    expect(calls.filter((call) => call.startsWith("policy set "))).toHaveLength(2);
  });

  it("removes an older compatible overlay only after a successful policy set (#8497)", () => {
    const oldNpmEntry = olderNpmEntry();
    const oldActivePolicy = YAML.parse(activePolicy(oldNpmEntry));
    const { calls, payload, stderr } = runLiveScenario({
      sandboxName: "npm-old-overlay",
      initialPolicy: YAML.stringify(oldActivePolicy),
      setMode: "fail-once",
      childScript: `
const failedRemoval = policies.removePreset("npm-old-overlay", "npm", { nonFatal: true });
const afterFailedPolicy = YAML.parse(fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"));
const afterFailedRegistry = structuredClone(registry.getSandbox("npm-old-overlay"));
const removed = policies.removePreset("npm-old-overlay", "npm", { nonFatal: true });
const afterRemove = YAML.parse(fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"));
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  failedRemoval,
  afterFailedPolicy,
  afterFailedRegistry,
  removed,
  afterRemove,
  registry: registry.getSandbox("npm-old-overlay"),
}));`,
    });

    expect(payload.failedRemoval).toBe(false);
    expect(payload.afterFailedPolicy).toEqual(oldActivePolicy);
    expect(payload.afterFailedRegistry).not.toHaveProperty("policies");
    expect(payload.removed, stderr).toBe(true);
    expect(payload.afterRemove.network_policies.npm_yarn).toBeUndefined();
    expect(payload.afterRemove.network_policies.npm_registry).toEqual(REVIEWED_BASELINE_ENTRY);
    expect(payload.registry).not.toHaveProperty("policies");
    expect(calls.filter((call) => call.startsWith("policy set "))).toHaveLength(2);
  });

  it("refuses removal when the live compatibility overlay has drifted (#8497)", () => {
    const drifted = YAML.parse(activePolicy());
    drifted.network_policies.npm_registry.endpoints[0].tls = "auto";
    const { calls, payload, stderr } = runLiveScenario({
      sandboxName: "npm-drift",
      initialPolicy: YAML.stringify(drifted),
      childScript: `
const removed = policies.removePreset("npm-drift", "npm", { nonFatal: true });
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  removed,
  policy: YAML.parse(fs.readFileSync(process.env.CURRENT_POLICY, "utf-8")),
  registry: registry.getSandbox("npm-drift"),
}));`,
    });

    expect(payload.removed).toBe(false);
    expect(payload.policy).toEqual(drifted);
    expect(payload.registry).not.toHaveProperty("policies");
    expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
    expect(stderr).toContain("differs from both the reviewed baseline");
  });
});
