// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MATCHING_OPENSHELL = path.resolve("test/fixtures/openshell-v0.0.72");
const MATCHING_OPENSHELL_VERSION_CLAUSE = `if [ "$1" = "--version" ]; then printf '%s\\n' 'openshell 0.0.72'; exit 0; fi`;

const PRESET = `network_policies:
  example:
    name: generated-policy
    endpoints: []
`;

function runApply(
  expectedExistingNetworkPolicyContent: string | null,
  liveName: string | null = "operator-owned",
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-owner-"));
  const binDir = path.join(home, ".local", "bin");
  const callsPath = path.join(home, "calls.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "openshell"),
    `#!/bin/sh
${MATCHING_OPENSHELL_VERSION_CLAUSE}
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\n${
    liveName === null
      ? "network_policies: {}"
      : `network_policies:\n  example:\n    name: ${liveName}\n    endpoints: []`
  }\n'
fi
exit 0
`,
    { mode: 0o755 },
  );
  const script = `
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
registry.registerSandbox({ name: "alpha" });
const result = policies.applyPresetContent(
  "alpha",
  "mcp-bridge-example",
  ${JSON.stringify(PRESET)},
  {
    custom: { sourcePath: "generated:nemoclaw-mcp-bridge" },
    expectedExistingNetworkPolicyContent: ${JSON.stringify(expectedExistingNetworkPolicyContent)},
  },
);
process.stdout.write("\\n__RESULT__" + JSON.stringify(result));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NEMOCLAW_OPENSHELL_BIN: path.join(binDir, "openshell"),
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });
  const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8") : "";
  fs.rmSync(home, { recursive: true, force: true });
  return { calls, result };
}

function runContentMatch(liveName: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-match-"));
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "openshell"),
    `#!/bin/sh
${MATCHING_OPENSHELL_VERSION_CLAUSE}
printf 'Version: 1\nHash: test\n---\nversion: 1\nnetwork_policies:\n  example:\n    name: ${liveName}\n    endpoints: []\n'
`,
    { mode: 0o755 },
  );
  const script = `
const policies = require("./src/lib/policy/index.js");
process.stdout.write(String(policies.presetContentMatchesGateway("alpha", ${JSON.stringify(PRESET)})));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NEMOCLAW_OPENSHELL_BIN: path.join(binDir, "openshell"),
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

function runFailedPolicyMutation(operation: "apply" | "remove") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-failure-"));
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "openshell"),
    `#!/bin/sh
${MATCHING_OPENSHELL_VERSION_CLAUSE}
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\nnetwork_policies:\n  example:\n    name: generated-policy\n    endpoints: []\n'
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  exit 19
fi
exit 0
`,
    { mode: 0o755 },
  );
  const script = `
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
registry.registerSandbox({ name: "alpha" });
${
  operation === "remove"
    ? `registry.addCustomPolicy("alpha", {
  name: "mcp-bridge-example",
  content: ${JSON.stringify(PRESET)},
  sourcePath: "generated:nemoclaw-mcp-bridge",
});`
    : ""
}
const result = ${
    operation === "apply"
      ? `policies.applyPresetContent(
  "alpha",
  "mcp-bridge-example",
  ${JSON.stringify(PRESET)},
  {
    custom: { sourcePath: "generated:nemoclaw-mcp-bridge" },
    expectedExistingNetworkPolicyContent: ${JSON.stringify(PRESET)},
    nonFatal: true,
  },
)`
      : `policies.removePreset("alpha", "mcp-bridge-example", { nonFatal: true })`
  };
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  result,
  policies: registry.getCustomPolicies("alpha").map((policy) => policy.name),
}));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NEMOCLAW_OPENSHELL_BIN: path.join(binDir, "openshell"),
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

function runSuccessfulPolicyRemoval(skipRegistryUpdate: boolean) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-remove-success-"));
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "openshell"),
    `#!/bin/sh
${MATCHING_OPENSHELL_VERSION_CLAUSE}
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\nnetwork_policies:\n  example:\n    name: generated-policy\n    endpoints: []\n'
fi
exit 0
`,
    { mode: 0o755 },
  );
  const script = `
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
registry.registerSandbox({ name: "alpha" });
registry.addCustomPolicy("alpha", {
  name: "mcp-bridge-example",
  content: ${JSON.stringify(PRESET)},
  sourcePath: "generated:nemoclaw-mcp-bridge",
});
const result = policies.removePreset("alpha", "mcp-bridge-example", {
  nonFatal: true,
  skipRegistryUpdate: ${JSON.stringify(skipRegistryUpdate)},
});
process.stdout.write("\\n__RESULT__" + JSON.stringify({
  result,
  policies: registry.getCustomPolicies("alpha").map((policy) => policy.name),
}));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NEMOCLAW_OPENSHELL_BIN: path.join(binDir, "openshell"),
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

describe("MCP-generated network policy ownership", () => {
  it("refuses to replace a same-key policy the bridge does not own", () => {
    const { calls, result } = runApply(null);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("__RESULT__false");
    expect(result.stderr).toContain("does not match the exact state owned");
    expect(calls).not.toContain("policy set");
  });

  it("allows a registered bridge to refresh its owned key", () => {
    const { calls, result } = runApply(PRESET, "generated-policy");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("__RESULT__true");
    expect(calls).toContain("policy set");
  });

  it("refuses a same-key value changed after the caller's ownership proof", () => {
    const { calls, result } = runApply(PRESET, "concurrent-writer");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("__RESULT__false");
    expect(result.stderr).toContain("does not match the exact state owned");
    expect(calls).not.toContain("policy set");
  });

  it("refuses an owned key removed after the caller's ownership proof", () => {
    const { calls, result } = runApply(PRESET, null);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("__RESULT__false");
    expect(result.stderr).toContain("does not match the exact state owned");
    expect(calls).not.toContain("policy set");
  });

  it("detects same-key live policy drift instead of reporting presence", () => {
    expect(runContentMatch("operator-widened").stdout).toBe("false");
    expect(runContentMatch("generated-policy").stdout).toBe("true");
  });

  it("returns control to MCP rollback when policy apply fails", () => {
    const result = runFailedPolicyMutation("apply");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('__RESULT__{"result":false,"policies":[]}');
    expect(result.stderr).toContain("Failed to update policy");
  });

  it("preserves MCP policy ownership state when policy removal fails", () => {
    const result = runFailedPolicyMutation("remove");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('__RESULT__{"result":false,"policies":["mcp-bridge-example"]}');
    expect(result.stderr).toContain("Failed to update policy");
  });

  it.each([
    [false, []],
    [true, ["mcp-bridge-example"]],
  ] as const)("supports ownership-preserving policy removal (skipRegistryUpdate=%s)", (skipRegistryUpdate, expectedPolicies) => {
    const result = runSuccessfulPolicyRemoval(skipRegistryUpdate);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      `__RESULT__${JSON.stringify({ result: true, policies: expectedPolicies })}`,
    );
  });

  it("does not delete an operator-owned same-key policy when add rolls back", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-lifecycle-"));
    const binDir = path.join(home, ".local", "bin");
    const callsPath = path.join(home, "calls.log");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "openshell"),
      `#!/bin/sh
${MATCHING_OPENSHELL_VERSION_CLAUSE}
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
if [ "$1 $2 $3" = "status --output json" ]; then
  printf '%s\n' 'ready'
  exit 0
fi
if [ "$1 $2" = "provider get" ]; then
  printf 'Provider not found\n' >&2
  exit 1
fi
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\nnetwork_policies:\n  mcp_bridge_example:\n    name: operator-owned\n    endpoints: []\n'
fi
exit 0
`,
      { mode: 0o755 },
    );
    const script = `
process.env.HOME = ${JSON.stringify(home)};
process.env.COLLISION_TOKEN = "host-only-secret";
const registry = require("./src/lib/state/registry.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
processRecovery.executeSandboxCommand = () => ({
  status: 0,
  stdout: "absent\\n",
  stderr: "",
});
processRecovery.executeSandboxExecCommand = () => ({
  status: 0,
  stdout: "",
  stderr: "",
});
registry.registerSandbox({ name: "alpha", agent: "openclaw" });
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.addMcpBridge("alpha", {
  server: "example",
  url: "https://8.8.8.8/mcp",
  env: [{ name: "COLLISION_TOKEN" }],
}).then(
  () => process.exit(2),
  (error) => {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      message: error.message,
      customPolicies: registry.getCustomPolicies("alpha"),
    }));
  },
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NEMOCLAW_OPENSHELL_BIN: path.join(binDir, "openshell"),
        PATH: `${binDir}:/usr/bin:/bin`,
      },
    });
    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8") : "";
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "could not prove generated policy key 'mcp_bridge_example' absent",
    );
    expect(result.stdout).toContain('"customPolicies":[]');
    expect(calls).not.toContain("provider create");
    expect(calls).not.toContain("provider delete");
    expect(calls).not.toContain("policy set");
  });

  it("reserves policy ownership before the live gateway mutation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-registry-failure-"));
    const binDir = path.join(home, ".local", "bin");
    const callsPath = path.join(home, "calls.log");
    const providerStatePath = path.join(home, "provider.state");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "openshell"),
      `#!/bin/sh
${MATCHING_OPENSHELL_VERSION_CLAUSE}
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
if [ "$1 $2 $3" = "status --output json" ]; then
  printf '%s\n' 'ready'
  exit 0
fi
if [ "$1 $2 $3" = "sandbox provider list" ]; then
  printf '%s\n' 'No providers attached to sandbox alpha.'
  exit 0
fi
if [ "$1 $2" = "provider get" ]; then
  if [ -f ${JSON.stringify(providerStatePath)} ]; then
    printf 'Id: 11111111-2222-4333-8444-555555555555\nType: generic\nResource version: 1\nCredential keys: RESERVATION_TOKEN\n'
    exit 0
  fi
  printf 'Provider not found\n' >&2
  exit 1
fi
if [ "$1 $2" = "provider create" ]; then
  : > ${JSON.stringify(providerStatePath)}
  printf '%s\n' 'Created provider.'
fi
if [ "$1 $2" = "provider delete" ]; then
  rm -f -- ${JSON.stringify(providerStatePath)}
fi
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\nnetwork_policies: {}\n'
fi
exit 0
`,
      { mode: 0o755 },
    );
    const script = `
process.env.HOME = ${JSON.stringify(home)};
process.env.RESERVATION_TOKEN = "host-only-secret";
const registry = require("./src/lib/state/registry.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
processRecovery.executeSandboxCommand = () => ({
  status: 0,
  stdout: "absent\\n",
  stderr: "",
});
processRecovery.executeSandboxExecCommand = () => ({
  status: 0,
  stdout: "",
  stderr: "",
});
registry.registerSandbox({ name: "alpha", agent: "openclaw" });
registry.addCustomPolicy = () => { throw new Error("injected registry write failure"); };
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.addMcpBridge("alpha", {
  server: "reservation",
  url: "https://8.8.8.8/mcp",
  env: [{ name: "RESERVATION_TOKEN" }],
}).then(
  () => process.exit(2),
  (error) => process.stdout.write("\\n__RESULT__" + error.message),
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NEMOCLAW_OPENSHELL_BIN: path.join(binDir, "openshell"),
        PATH: `${binDir}:/usr/bin:/bin`,
      },
    });
    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8") : "";
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("injected registry write failure");
    expect(calls).not.toContain("provider create");
    expect(calls).not.toContain("provider delete");
    expect(calls).not.toContain("policy set");
  });

  it("refuses to overwrite a drifted owned policy during restart", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-drift-"));
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const globalActions = require("./src/lib/actions/global.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
let applyCalled = false;
const providerCalls = [];

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
globalActions.runOpenshellProviderCommand = (args) => {
  if (args.join(" ") === "status --output json") {
    return {
      status: 0,
      stdout: "ready",
      stderr: "",
    };
  }
  providerCalls.push(args.join(" "));
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Type: generic\\nCredential keys: DRIFT_TOKEN\\n",
      stderr: "",
    };
  }
  return { status: 0, stdout: "", stderr: "" };
};
policies.getPresetContentGatewayState = () => "drift";
policies.applyPresetContent = () => {
  applyCalled = true;
  return true;
};
processRecovery.executeSandboxExecCommand = () => ({
  status: 0,
  stdout: "",
  stderr: "",
});
processRecovery.executeSandboxCommand = () => ({
  status: 0,
  stdout: "registered\\n",
  stderr: "",
});

const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
const entry = {
  server: "example",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://8.8.8.8/mcp",
  env: ["DRIFT_TOKEN"],
  providerName: "alpha-mcp-example",
  policyName: "mcp-bridge-example",
  addedAt: "2026-06-01T00:00:00.000Z",
};
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: { example: entry } },
});
registry.addCustomPolicy("alpha", {
  name: entry.policyName,
  content: bridge.buildMcpBridgePolicyYaml(entry.server, entry.url, entry.adapter),
  sourcePath: "generated:nemoclaw-mcp-bridge",
});

bridge.restartMcpBridge("alpha", "example").then(
  () => process.exit(9),
  (error) => {
    process.stdout.write(JSON.stringify({
      message: error.message,
      applyCalled,
      providerCalls,
    }));
    process.exit(0);
  },
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
      timeout: 30_000,
    });
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      message: string;
      applyCalled: boolean;
      providerCalls: string[];
    };
    expect(payload.message).toMatch(/policy.*drift/i);
    expect(payload.applyCalled).toBe(false);
    expect(payload.providerCalls).toEqual([]);
  });
});
