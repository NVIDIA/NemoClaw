// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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

const UNRELATED_POLICY_ENTRY = {
  name: "unrelated_fixture",
  endpoints: [{ host: "fixture.example.com", port: 443, access: "full" }],
  binaries: [{ path: "/usr/bin/fixture" }],
};

const REVIEWED_NPM_PRESET = YAML.stringify({
  preset: { name: "npm", description: "independent npm compatibility fixture" },
  network_policies: { npm_yarn: REVIEWED_NPM_ENTRY },
});
const REVIEWED_PERSONAL_ENTRY = YAML.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "nemoclaw-blueprint/policies/presets/personal-open-internet.yaml"),
    "utf8",
  ),
).network_policies.personal_open_internet;

function policyWith(networkPolicies: Record<string, unknown>): string {
  return YAML.stringify({ version: 1, network_policies: networkPolicies });
}

function reviewedBaselinePolicy(): string {
  return policyWith({ npm_registry: structuredClone(REVIEWED_BASELINE_ENTRY) });
}

function excludedBaselinePolicy(): string {
  return policyWith({ unrelated_fixture: structuredClone(UNRELATED_POLICY_ENTRY) });
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

function parseResultPayload(stdout: string): any {
  const marker = "__RESULT__";
  const markerIndex = stdout.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(markerIndex + marker.length));
}

type LiveScenario = {
  initialPolicy: string;
  childScript: string;
  setMode?: "success" | "fail" | "fail-once";
};

function runLiveScenario({ initialPolicy, childScript, setMode = "success" }: LiveScenario): {
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
if [ "$1 $2" = "policy get" ] && [[ " $* " == *" --output json "* ]]; then
  sandbox=""
  for sandbox in "$@"; do :; done
  printf '{"scope":"sandbox","sandbox":"%s","status":"effective","policy_source":"sandbox","policy":{}}\n' "$sandbox"
  exit 0
fi
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\n'
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

function exclusionRegistration(sandboxName: string, digestCharacter: string): string {
  return `
registry.addBaselineExclusion(${JSON.stringify(sandboxName)}, {
  version: 1,
  agent: "openclaw",
  key: "npm_registry",
  digest: ${JSON.stringify(digestCharacter.repeat(64))},
});`;
}

describe("OpenClaw npm compatibility policy lifecycle", () => {
  it("removes npm attribution superseded by Personal without mutating live policy", () => {
    const initialPolicy = policyWith({
      personal_open_internet: structuredClone(REVIEWED_PERSONAL_ENTRY),
    });
    const { calls, payload } = runLiveScenario({
      initialPolicy,
      childScript: `
registry.registerSandbox({
  name: "personal-owner",
  agent: "openclaw",
  policies: ["personal-open-internet", "npm"],
});
const removed = policies.removePreset("personal-owner", "npm");
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  removed,
  policy: fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"),
  registry: registry.getSandbox("personal-owner"),
}));`,
    });

    expect(payload.removed).toBe(true);
    expect(payload.policy).toBe(initialPolicy);
    expect(payload.registry.policies).toEqual(["personal-open-internet"]);
    expect(calls.filter((call) => call.startsWith("policy get "))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
  });

  it("preserves superseded npm attribution while baseline repair is pending", () => {
    const initialPolicy = policyWith({
      personal_open_internet: structuredClone(REVIEWED_PERSONAL_ENTRY),
    });
    const { calls, payload, stderr } = runLiveScenario({
      initialPolicy,
      childScript: `
registry.registerSandbox({
  name: "personal-pending",
  agent: "openclaw",
  policies: ["personal-open-internet", "npm"],
});
registry.beginBaselineExclusionTransition("personal-pending", {
  id: "123e4567-e89b-42d3-a456-426614174920",
  operation: "exclude",
  exclusion: {
    version: 1,
    agent: "openclaw",
    key: "npm_registry",
    digest: "d".repeat(64),
  },
  targetLiveDigest: null,
  startedAt: "2026-08-17T00:00:00.000Z",
});
const removed = policies.removePreset("personal-pending", "npm", { nonFatal: true });
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  removed,
  policy: fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"),
  registry: registry.getSandbox("personal-pending"),
}));`,
    });

    expect(payload.removed).toBe(false);
    expect(payload.policy).toBe(initialPolicy);
    expect(payload.registry.policies).toEqual(["personal-open-internet", "npm"]);
    expect(payload.registry.baselineExclusionTransition).toBeDefined();
    expect(calls.filter((call) => call.startsWith("policy get "))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
    expect(stderr).toContain("baseline repair for 'npm_registry' is still pending");
  });

  it("does not restore overlapping npm web routes beside Personal during removal", () => {
    const initialPolicy = policyWith({
      personal_open_internet: structuredClone(REVIEWED_PERSONAL_ENTRY),
      npm_registry: compatibilityEntry(),
      npm_yarn: structuredClone(REVIEWED_NPM_ENTRY),
    });
    const { calls, payload } = runLiveScenario({
      initialPolicy,
      childScript: `
registry.registerSandbox({
  name: "personal-npm",
  agent: "openclaw",
  policies: ["personal-open-internet", "npm"],
});
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
    expect(payload.registry.policies).toEqual(["personal-open-internet"]);
    expect(calls.filter((call) => call.startsWith("policy set "))).toHaveLength(1);
  });

  it("repairs an active npm preset and restores the reviewed baseline on removal (#8497)", () => {
    const { calls, payload, stdout } = runLiveScenario({
      initialPolicy: unoverlaidActivePolicy(),
      childScript: `
registry.registerSandbox({ name: "npm-lifecycle", agent: "openclaw", policies: ["npm"] });
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
    expect(payload.registry.policies).toEqual([]);
    expect(stdout).toContain("Effective egress scope that would replace the current preset policy");
    expect(stdout).toContain("OpenClaw npm compatibility");
    expect(stdout).not.toContain("already effective; no new egress would be opened");
    expect(calls.filter((call) => call.startsWith("policy get "))).toHaveLength(4);
    expect(calls.filter((call) => call.startsWith("policy set "))).toHaveLength(2);
  });

  it("removes an older compatible overlay only after a successful policy set (#8497)", () => {
    const oldNpmEntry = olderNpmEntry();
    const oldActivePolicy = YAML.parse(activePolicy(oldNpmEntry));
    const { calls, payload, stderr } = runLiveScenario({
      initialPolicy: YAML.stringify(oldActivePolicy),
      setMode: "fail-once",
      childScript: `
registry.registerSandbox({ name: "npm-old-overlay", agent: "openclaw", policies: ["npm"] });
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
    expect(payload.afterFailedRegistry.policies).toEqual(["npm"]);
    expect(payload.removed, stderr).toBe(true);
    expect(payload.afterRemove.network_policies.npm_yarn).toBeUndefined();
    expect(payload.afterRemove.network_policies.npm_registry).toEqual(REVIEWED_BASELINE_ENTRY);
    expect(payload.registry.policies).toEqual([]);
    expect(calls.filter((call) => call.startsWith("policy get "))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("policy set "))).toHaveLength(2);
  });

  it("refuses removal when the live compatibility overlay has drifted (#8497)", () => {
    const drifted = YAML.parse(activePolicy());
    drifted.network_policies.npm_registry.endpoints[0].tls = "auto";
    const { calls, payload, stderr } = runLiveScenario({
      initialPolicy: YAML.stringify(drifted),
      childScript: `
registry.registerSandbox({ name: "npm-drift", agent: "openclaw", policies: ["npm"] });
const removed = policies.removePreset("npm-drift", "npm", { nonFatal: true });
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  removed,
  policy: YAML.parse(fs.readFileSync(process.env.CURRENT_POLICY, "utf-8")),
  registry: registry.getSandbox("npm-drift"),
}));`,
    });

    expect(payload.removed).toBe(false);
    expect(payload.policy).toEqual(drifted);
    expect(payload.registry.policies).toEqual(["npm"]);
    expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
    expect(stderr).toContain("differs from both the reviewed baseline");
  });

  it("keeps an approved baseline exclusion absent through apply and removal (#8497)", () => {
    const { calls, payload, stderr } = runLiveScenario({
      initialPolicy: excludedBaselinePolicy(),
      childScript: `
registry.registerSandbox({ name: "npm-excluded", agent: "openclaw", policies: [] });
${exclusionRegistration("npm-excluded", "a")}
const applied = policies.applyPresets("npm-excluded", ["npm"]);
const afterApply = YAML.parse(fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"));
const removed = policies.removePreset("npm-excluded", "npm");
const afterRemove = YAML.parse(fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"));
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  applied,
  afterApply,
  removed,
  afterRemove,
  registry: registry.getSandbox("npm-excluded"),
}));`,
    });

    expect(payload.applied).toBe(true);
    expect(payload.afterApply.network_policies.npm_yarn).toEqual(REVIEWED_NPM_ENTRY);
    expect(payload.afterApply.network_policies.npm_registry).toBeUndefined();
    expect(payload.removed, stderr).toBe(true);
    expect(payload.afterRemove.network_policies.npm_yarn).toBeUndefined();
    expect(payload.afterRemove.network_policies.npm_registry).toBeUndefined();
    expect(payload.registry.policies).toEqual([]);
    expect(payload.registry.baselineExclusions).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("policy set "))).toHaveLength(2);
  });

  it("refuses batch apply when an excluded baseline drifted back into the live policy (#8497)", () => {
    const initialPolicy = reviewedBaselinePolicy();
    const { calls, payload, stderr } = runLiveScenario({
      initialPolicy,
      childScript: `
registry.registerSandbox({ name: "npm-excl-batch", agent: "openclaw", policies: [] });
${exclusionRegistration("npm-excl-batch", "b")}
const applied = policies.applyPresets("npm-excl-batch", ["npm"]);
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  applied,
  policy: fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"),
  registry: registry.getSandbox("npm-excl-batch"),
}));`,
    });

    expect(payload.applied).toBe(false);
    expect(YAML.parse(payload.policy)).toEqual(YAML.parse(initialPolicy));
    expect(payload.registry.policies).toEqual([]);
    expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
    expect(stderr).toContain("requires the live entry to remain absent");
  });

  it("refuses direct apply when an excluded baseline drifted back into the live policy (#8497)", () => {
    const initialPolicy = reviewedBaselinePolicy();
    const { calls, payload, stderr } = runLiveScenario({
      initialPolicy,
      childScript: `
registry.registerSandbox({ name: "npm-excl-direct", agent: "openclaw", policies: [] });
${exclusionRegistration("npm-excl-direct", "c")}
const applied = policies.applyPreset("npm-excl-direct", "npm");
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  applied,
  policy: fs.readFileSync(process.env.CURRENT_POLICY, "utf-8"),
  registry: registry.getSandbox("npm-excl-direct"),
}));`,
    });

    expect(payload.applied).toBe(false);
    expect(YAML.parse(payload.policy)).toEqual(YAML.parse(initialPolicy));
    expect(payload.registry.policies).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("policy get");
    expect(stderr).toContain("requires the live entry to remain absent");
  });

  it("rejects custom ownership of the reserved npm compatibility key (#8497)", () => {
    const policies = requireForTest(
      path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
    ) as typeof import("../../../src/lib/policy");
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    try {
      expect(
        policies.applyPresetContent("custom-npm-key", "custom-registry", REVIEWED_NPM_PRESET, {
          custom: { sourcePath: "/tmp/custom-registry.yaml" },
        }),
      ).toBe(false);
      expect(errors.join("\n")).toContain("reserved network policy key 'npm_yarn'");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each(["hermes", "langchain-deepagents-code"] as const)(
    "does not inject an OpenClaw baseline into other agent policies [%s] (#8497)",
    (agent) => {
      const policies = requireForTest(
        path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
      ) as typeof import("../../../src/lib/policy");

      const result = policies.mergePresetNamesIntoPolicy(excludedBaselinePolicy(), ["npm"], {
        agent,
      });
      const effective = YAML.parse(result.policy);
      expect(effective.network_policies.npm_yarn, agent).toBeDefined();
      expect(effective.network_policies.npm_registry, agent).toBeUndefined();
    },
  );

  it("keeps an approved baseline exclusion absent during create-time composition (#8497)", () => {
    const policies = requireForTest(
      path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
    ) as typeof import("../../../src/lib/policy");
    const result = policies.mergePresetNamesIntoPolicy(excludedBaselinePolicy(), ["npm"], {
      agent: "openclaw",
      excludedBaselineKeys: ["npm_registry"],
    });
    const effective = YAML.parse(result.policy);

    expect(effective.network_policies.npm_yarn).toBeDefined();
    expect(effective.network_policies.npm_registry).toBeUndefined();
  });

  it("refuses create-time composition from a drifted OpenClaw npm baseline (#8497)", () => {
    const policies = requireForTest(
      path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
    ) as typeof import("../../../src/lib/policy");
    const driftedBaseline = YAML.parse(reviewedBaselinePolicy());
    driftedBaseline.network_policies.npm_registry.binaries = [{ path: "/**" }];

    expect(() =>
      policies.mergePresetNamesIntoPolicy(YAML.stringify(driftedBaseline), ["npm"], {
        agent: "openclaw",
      }),
    ).toThrow(/differs from the reviewed baseline/i);
  });

  it("discloses the temporary OpenClaw baseline widening and exact restoration (#8497)", () => {
    const policies = requireForTest(
      path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
    ) as typeof import("../../../src/lib/policy");
    const lines: string[] = [];
    policies.logOpenClawNpmCompatibilityDisclosure((line) => lines.push(line));

    expect(lines.join("\n")).toContain("/usr/local/bin/openclaw");
    expect(lines.join("\n")).toContain("GET-only REST");
    expect(lines.join("\n")).toContain("full L4 pass-through");
    expect(lines.join("\n")).toContain("HTTP methods and paths are not inspected");
    expect(lines.join("\n")).toContain("restores the exact reviewed GET-only baseline");
  });
});
