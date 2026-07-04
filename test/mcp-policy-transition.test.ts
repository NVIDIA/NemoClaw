// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function runPolicyTransition(
  mode: "crash-retry" | "post-set-crash" | "foreign-after-crash" | "rejected",
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-transition-"));
  const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
const mode = ${JSON.stringify(mode)};
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
const generated = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");

const entry = {
  server: "example",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.test/mcp",
  env: ["MCP_TOKEN"],
  providerName: "alpha-mcp-example",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-example",
  addedAt: "2026-06-01T00:00:00.000Z",
};
const oldContent = generated.buildMcpBridgePolicyYaml(
  entry.server,
  entry.url,
  entry.adapter,
  ["1.1.1.1"],
);
const desiredContent = generated.buildMcpBridgePolicyYaml(
  entry.server,
  entry.url,
  entry.adapter,
  ["8.8.8.8"],
);
let liveContent = oldContent;
let applyCalls = 0;

registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { example: entry } },
});
registry.addCustomPolicy("alpha", {
  name: entry.policyName,
  content: oldContent,
  sourcePath: "generated:nemoclaw-mcp-bridge",
});
policies.getPresetContentGatewayState = (_sandbox, candidate) =>
  candidate === liveContent ? "match" : "drift";
policies.applyPresetContent = () => {
  applyCalls += 1;
  if (mode === "rejected") return false;
  if (applyCalls === 1) {
    if (mode === "post-set-crash") liveContent = desiredContent;
    if (mode === "foreign-after-crash") liveContent = "foreign-policy-content";
    throw new Error("simulated process death after reservation");
  }
  liveContent = desiredContent;
  return true;
};

let firstError = "";
try {
  generated.applyGeneratedPolicy("alpha", entry, ["8.8.8.8"]);
} catch (error) {
  firstError = error instanceof Error ? error.message : String(error);
}

const afterFirst = registry.getCustomPolicies("alpha")[0];
const presenceAfterFirst = generated.getPolicyPresence("alpha", entry);
const afterPresence = registry.getCustomPolicies("alpha")[0];

let retryError = "";
if (mode !== "rejected") {
  try {
    generated.applyGeneratedPolicy("alpha", entry, ["8.8.8.8"]);
  } catch (error) {
    retryError = error instanceof Error ? error.message : String(error);
  }
}
const afterRetry = registry.getCustomPolicies("alpha")[0];

process.stdout.write(JSON.stringify({
  firstError,
  retryError,
  applyCalls,
  presenceAfterFirst,
  pendingPreservedByStatus: afterPresence?.pendingContent === desiredContent,
  afterFirst: {
    contentIsOld: afterFirst?.content === oldContent,
    pendingIsDesired: afterFirst?.pendingContent === desiredContent,
  },
  afterRetry: {
    contentIsOld: afterRetry?.content === oldContent,
    contentIsDesired: afterRetry?.content === desiredContent,
    hasPending: Object.hasOwn(afterRetry ?? {}, "pendingContent"),
  },
}));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 30_000,
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

function runUnownedRegistryCollision(operation: "assert" | "apply") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-unowned-"));
  const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
const generated = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");
const entry = {
  server: "example",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.test/mcp",
  env: ["MCP_TOKEN"],
  providerName: "alpha-mcp-example",
  policyName: "mcp-bridge-example",
  addedAt: "2026-06-01T00:00:00.000Z",
};
registry.registerSandbox({ name: "alpha", agent: "openclaw" });
registry.addCustomPolicy("alpha", {
  name: entry.policyName,
  content: "operator-owned-content",
  sourcePath: "/operator/policy.yaml",
});
let applyCalled = false;
policies.getPresetContentGatewayState = () => "absent";
policies.applyPresetContent = () => { applyCalled = true; return true; };
let message = "";
try {
  if (${JSON.stringify(operation)} === "assert") {
    generated.assertGeneratedPolicyMutationSafe("alpha", entry);
  } else {
    generated.applyGeneratedPolicy("alpha", entry, ["8.8.8.8"]);
  }
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify({
  message,
  applyCalled,
  policies: registry.getCustomPolicies("alpha"),
}));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

function runGeneratedPolicyRemoval(postRemovalState: "absent" | "match") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-remove-"));
  const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
const generated = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");
const entry = {
  server: "example",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.test/mcp",
  env: ["MCP_TOKEN"],
  providerName: "alpha-mcp-example",
  policyName: "mcp-bridge-example",
  addedAt: "2026-06-01T00:00:00.000Z",
};
const content = generated.buildMcpBridgePolicyYaml(
  entry.server,
  entry.url,
  entry.adapter,
  ["8.8.8.8"],
);
registry.registerSandbox({ name: "alpha", agent: "openclaw" });
registry.addCustomPolicy("alpha", {
  name: entry.policyName,
  content,
  sourcePath: "generated:nemoclaw-mcp-bridge",
});
let state = "match";
let skipRegistryUpdate = false;
policies.getPresetContentGatewayState = () => state;
policies.removePreset = (_sandbox, _policyName, options) => {
  skipRegistryUpdate = options?.skipRegistryUpdate === true;
  if (!skipRegistryUpdate) registry.removeCustomPolicyByName("alpha", entry.policyName);
  state = ${JSON.stringify(postRemovalState)};
  return true;
};
let message = "";
try {
  generated.removeGeneratedPolicy("alpha", entry);
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify({
  message,
  skipRegistryUpdate,
  policies: registry.getCustomPolicies("alpha"),
}));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

describe("generated MCP policy transitions", () => {
  it.each([
    "assert",
    "apply",
  ] as const)("preserves an unowned same-name registry record during %s", (operation) => {
    const result = runUnownedRegistryCollision(operation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      message: string;
      applyCalled: boolean;
      policies: Array<{ content: string; sourcePath: string }>;
    };
    expect(payload.message).toMatch(/unowned same-name registry record/);
    expect(payload.applyCalled).toBe(false);
    expect(payload.policies).toEqual([
      expect.objectContaining({
        content: "operator-owned-content",
        sourcePath: "/operator/policy.yaml",
      }),
    ]);
  });

  it("preserves the confirmed and desired policy across an interrupted refresh", () => {
    const result = runPolicyTransition("crash-retry");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      firstError: string;
      retryError: string;
      applyCalls: number;
      presenceAfterFirst: boolean;
      pendingPreservedByStatus: boolean;
      afterFirst: { contentIsOld: boolean; pendingIsDesired: boolean };
      afterRetry: { contentIsDesired: boolean; hasPending: boolean };
    };
    expect(payload).toMatchObject({
      firstError: "simulated process death after reservation",
      retryError: "",
      applyCalls: 2,
      presenceAfterFirst: true,
      pendingPreservedByStatus: true,
      afterFirst: { contentIsOld: true, pendingIsDesired: true },
      afterRetry: { contentIsDesired: true, hasPending: false },
    });
  });

  it("restores confirmed ownership when a changed policy is rejected", () => {
    const result = runPolicyTransition("rejected");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      firstError: string;
      applyCalls: number;
      afterFirst: { contentIsOld: boolean; pendingIsDesired: boolean };
      afterRetry: { contentIsOld: boolean; hasPending: boolean };
    };
    expect(payload.firstError).toContain("Failed to activate generated MCP policy");
    expect(payload).toMatchObject({
      applyCalls: 1,
      afterFirst: { contentIsOld: true, pendingIsDesired: false },
      afterRetry: { contentIsOld: true, hasPending: false },
    });
  });

  it("finalizes desired ownership after policy load wins the crash boundary", () => {
    const result = runPolicyTransition("post-set-crash");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      retryError: string;
      applyCalls: number;
      presenceAfterFirst: boolean;
      pendingPreservedByStatus: boolean;
      afterFirst: { contentIsOld: boolean; pendingIsDesired: boolean };
      afterRetry: { contentIsDesired: boolean; hasPending: boolean };
    };
    expect(payload).toMatchObject({
      retryError: "",
      applyCalls: 2,
      presenceAfterFirst: true,
      pendingPreservedByStatus: true,
      afterFirst: { contentIsOld: true, pendingIsDesired: true },
      afterRetry: { contentIsDesired: true, hasPending: false },
    });
  });

  it("keeps both versions and fails closed when live policy matches neither", () => {
    const result = runPolicyTransition("foreign-after-crash");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      retryError: string;
      applyCalls: number;
      afterRetry: { contentIsOld: boolean; hasPending: boolean };
    };
    expect(payload.retryError).toMatch(/drifted|could not be inspected/);
    expect(payload).toMatchObject({
      applyCalls: 1,
      afterRetry: { contentIsOld: true, hasPending: true },
    });
  });

  it.each([
    ["absent", false],
    ["match", true],
  ] as const)("requires exact post-removal state %s before dropping ownership", (postRemovalState, preservesOwnership) => {
    const result = runGeneratedPolicyRemoval(postRemovalState);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      message: string;
      skipRegistryUpdate: boolean;
      policies: Array<{ content: string; sourcePath: string }>;
    };
    expect(payload.skipRegistryUpdate).toBe(true);
    expect(payload.message).toMatch(preservesOwnership ? /effective state: match/ : /^$/);
    expect(payload.policies.map((policy) => policy.sourcePath)).toEqual(
      preservesOwnership ? ["generated:nemoclaw-mcp-bridge"] : [],
    );
  });
});
