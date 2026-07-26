// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MATCHING_OPENSHELL = path.resolve("test/fixtures/openshell-v0.0.85");

type CrashBoundary =
  | "provider"
  | "policy"
  | "policy-failure"
  | "policy-drift"
  | "credential-collision"
  | "adapter"
  | "adapter-mismatch"
  | "attach-race"
  | "race"
  | "late-race"
  | "preupdate-observation-forbidden"
  | "";

function runAddProcess(home: string, crashAfter: CrashBoundary, includeSecret = true) {
  const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
const includeSecret = ${JSON.stringify(includeSecret)};
includeSecret ? (process.env.FAKE_MCP_SECRET = "host-only-secret") : delete process.env.FAKE_MCP_SECRET;
const fs = require("node:fs");
const path = require("node:path");
const crashAfter = ${JSON.stringify(crashAfter)};
const marker = (name) => path.join(process.env.HOME, name + ".marker");
const mark = (name) => fs.writeFileSync(marker(name), "yes\n", { mode: 0o600 });
const marked = (name) => fs.existsSync(marker(name));
const providerPresentAtStart = marked("provider");
const providerId = "11111111-2222-4333-8444-555555555555";
const foreignProviderId = "99999999-8888-4777-8666-555555555555";
let providerGetCount = 0;
let observedProviderName = null;
let attachmentAttemptedThisProcess = false;

const registry = require("./src/lib/state/registry.js");
const globalActions = require("./src/lib/actions/global.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});

globalActions.runOpenshellProviderCommand = (args) => {
  if (args[0] === "status" && args[1] === "--output" && args[2] === "json") {
    return { status: 0, stdout: JSON.stringify({ gateway: "nemoclaw" }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    if (args[2] === "foreign-attached") {
      return { status: 0, stdout: "Id: " + foreignProviderId + "\nType: generic\nResource version: 1\nCredential keys: FAKE_MCP_SECRET\n", stderr: "" };
    }
    observedProviderName = args[2];
    providerGetCount += 1;
    if (crashAfter === "race" && providerGetCount === 2) mark("provider");
    if (crashAfter === "late-race" && providerGetCount === 3) mark("provider");
    return marked("provider")
      ? { status: 0, stdout: "Id: " + (marked("foreign-provider") ? foreignProviderId : providerId) + "\nType: generic\nResource version: " + (marked("updated") ? "2" : "1") + "\nCredential keys: FAKE_MCP_SECRET\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "NotFound: provider" };
  }
  if (args[0] === "provider" && (args[1] === "create" || args[1] === "update")) {
    if (!marked("policy")) {
      return { status: 1, stdout: "", stderr: "provider mutation preceded policy attestation" };
    }
    if (args[1] === "create") observedProviderName = args[args.indexOf("--name") + 1];
    if (args[1] === "update") observedProviderName = args[2];
    mark("provider");
    if (args[1] === "update") mark("updated");
    if (crashAfter === "provider") process.exit(86);
    return { status: 0, stdout: args[1] === "create" ? "Created provider" : "Updated provider", stderr: "" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    if (crashAfter === "credential-collision") {
      return {
        status: 0,
        stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nforeign-attached generic 1 0\n",
        stderr: "",
      };
    }
    if (crashAfter === "attach-race" && marked("provider") && !marked("attached")) {
      mark("foreign-provider");
    }
    const attached = marked("attached");
    const providerName = observedProviderName ?? registry.getSandbox("crash-test")?.mcp?.bridges?.fake?.providerName;
    if (attached && !marked("provider")) {
      return { status: 1, stdout: "", stderr: "FailedPrecondition: provider '" + providerName + "' not found" };
    }
    return {
      status: 0,
      stdout: attached
        ? "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n" + providerName + " generic 1 0\n"
        : "No providers attached to sandbox crash-test.\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach") {
    observedProviderName = args[4];
    attachmentAttemptedThisProcess = true;
    mark("attached");
    return { status: 0, stdout: "attached", stderr: "" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    fs.rmSync(marker("attached"), { force: true });
    return { status: 0, stdout: "Detached provider", stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "delete") {
    fs.rmSync(marker("provider"), { force: true });
    return { status: 0, stdout: "deleted", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};

policies.getPresetContentGatewayState = () => {
  if (!marked("policy")) return "absent";
  return crashAfter === "policy-drift" ? "drift" : "match";
};
policies.applyPresetContent = () => {
  if (crashAfter === "policy-failure") return false;
  fs.appendFileSync(marker("policy-apply-log"), "apply\n", { mode: 0o600 });
  mark("policy");
  if (crashAfter === "policy") process.exit(86);
  return true;
};
policies.removePreset = () => {
  fs.rmSync(marker("policy"), { force: true });
  return true;
};

processRecovery.executeSandboxExecCommand = (_sandbox, command) => {
  const encoded = command.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] || "";
  const proof = encoded ? Buffer.from(encoded, "base64").toString("utf8") : command;
  const isObservation = proof.includes("printf '%s\\n' absent");
  const isPreupdateObservation =
    isObservation &&
    providerPresentAtStart &&
    !marked("updated") &&
    !attachmentAttemptedThisProcess;
  isPreupdateObservation && mark("observation");
  return {
    status: crashAfter === "preupdate-observation-forbidden" && isPreupdateObservation ? 1 : 0,
    stdout: isObservation ? (marked("updated") ? "v2" : marked("provider") ? "v1" : "absent") : "",
    stderr: "",
  };
};
processRecovery.executeSandboxCommand = (_sandbox, command) => {
  if (command === "command -v mcporter") {
    return { status: 0, stdout: "/usr/local/bin/mcporter\n", stderr: "" };
  }
  if (command.includes("config' 'add")) {
    mark("adapter");
    if (crashAfter === "adapter") process.exit(86);
    return { status: 0, stdout: "", stderr: "" };
  }
  if (command.includes("config' 'remove") || command.includes('["config", "remove"')) {
    fs.rmSync(marker("adapter"), { force: true });
    return { status: 0, stdout: "", stderr: "" };
  }
  if (
    crashAfter === "adapter-mismatch" &&
    marked("adapter") &&
    command.includes('["config", "get"')
  ) {
    return { status: 0, stdout: "mismatch\n", stderr: "" };
  }
  return {
    status: 0,
    stdout: marked("adapter") ? "registered\n" : "absent\n",
    stderr: "",
  };
};

if (!registry.getSandbox("crash-test")) {
  registry.registerSandbox({
    name: "crash-test",
    agent: "openclaw",
    gatewayName: "nemoclaw",
  });
}
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.addMcpBridge("crash-test", {
  server: "fake",
  url: "https://8.8.8.8/mcp",
  env: [{ name: "FAKE_MCP_SECRET" }],
}).then(
  () => process.exit(0),
  (error) => {
    console.error(error && error.stack || error);
    process.exit(2);
  },
);
`;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
    timeout: 30_000,
  });
}

function runRemoveProcess(home: string, crashAfterProviderDelete: boolean) {
  const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.FAKE_MCP_SECRET = "host-only-secret";
const fs = require("node:fs");
const path = require("node:path");
const crashAfterProviderDelete = ${JSON.stringify(crashAfterProviderDelete)};
const marker = (name) => path.join(process.env.HOME, name + ".marker");
const marked = (name) => fs.existsSync(marker(name));
const providerId = "11111111-2222-4333-8444-555555555555";
let observedProviderName = null;

const globalActions = require("./src/lib/actions/global.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});

globalActions.runOpenshellProviderCommand = (args) => {
  if (args[0] === "status" && args[1] === "--output" && args[2] === "json") {
    return { status: 0, stdout: JSON.stringify({ gateway: "nemoclaw" }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    observedProviderName = args[2];
    return marked("provider")
      ? { status: 0, stdout: "Id: " + providerId + "\nType: generic\nResource version: 1\nCredential keys: FAKE_MCP_SECRET\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "NotFound: provider" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    observedProviderName = args[4];
    const wasAttached = marked("attached");
    fs.rmSync(marker("attached"), { force: true });
    return {
      status: 0,
      stdout: wasAttached
        ? "Detached provider " + observedProviderName + " from sandbox crash-test.\n"
        : "Provider " + observedProviderName + " was not attached to sandbox crash-test.\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    const attached = marked("attached");
    const providerName = observedProviderName ?? require("./src/lib/state/registry.js").getSandbox("crash-test")?.mcp?.bridges?.fake?.providerName;
    if (attached && !marked("provider")) {
      return { status: 1, stdout: "", stderr: "FailedPrecondition: provider '" + providerName + "' not found" };
    }
    return {
      status: 0,
      stdout: attached
        ? "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n" + providerName + " generic 1 0\n"
        : "No providers attached to sandbox crash-test.\n",
      stderr: "",
    };
  }
  if (args[0] === "provider" && args[1] === "delete") {
    if (!marked("provider")) {
      return { status: 1, stdout: "", stderr: "NotFound: provider" };
    }
    fs.rmSync(marker("provider"), { force: true });
    if (crashAfterProviderDelete) process.exit(87);
    return { status: 0, stdout: "deleted", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};

policies.getPresetContentGatewayState = () => marked("policy") ? "match" : "absent";
policies.removePreset = () => {
  fs.rmSync(marker("policy"), { force: true });
  return true;
};

processRecovery.executeSandboxCommand = (_sandbox, command) => {
  if (command.includes('["config", "remove"')) {
    fs.rmSync(marker("adapter"), { force: true });
  }
  return { status: 0, stdout: "", stderr: "" };
};
processRecovery.executeSandboxExecCommand = () => ({ status: 0, stdout: "", stderr: "" });

const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("crash-test", "fake").then(
  () => process.exit(0),
  (error) => {
    console.error(error && error.stack || error);
    process.exit(2);
  },
);
`;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
    timeout: 30_000,
  });
}

function runStatusProcess(home: string) {
  const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
const globalActions = require("./src/lib/actions/global.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
globalActions.runOpenshellProviderCommand = (args) => {
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Type: generic\nCredential keys: FAKE_MCP_SECRET\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return { status: 0, stdout: "No providers attached to sandbox crash-test.\n", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
policies.presetContentMatchesGateway = () => {
  throw new Error("unowned prepared policy must not be inspected as registered");
};
processRecovery.executeSandboxCommand = () => ({
  status: 0,
  stdout: "absent\n",
  stderr: "",
});

const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.statusMcpBridge("crash-test", "fake").then(
  (status) => {
    process.stdout.write(JSON.stringify(status[0]));
    process.exit(0);
  },
  (error) => {
    console.error(error && error.stack || error);
    process.exit(2);
  },
);
`;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
    timeout: 30_000,
  });
}

function readBridge(home: string): Record<string, unknown> {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
  ) as {
    sandboxes: {
      "crash-test": { mcp: { bridges: { fake: Record<string, unknown> } } };
    };
  };
  return parsed.sandboxes["crash-test"].mcp.bridges.fake;
}

describe("MCP add crash consistency", () => {
  it("rejects a missing host credential before creating durable MCP state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-missing-secret-"));
    try {
      const result = runAddProcess(home, "", false);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stderr).toContain("Host environment variable 'FAKE_MCP_SECRET' is required");
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "observation.marker"))).toBe(false);
      const registry = JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
      ) as { sandboxes: { "crash-test": { mcp?: unknown } } };
      expect(registry.sandboxes["crash-test"].mcp).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("creates a fresh provider without an update-only prior revision observation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-no-prior-observation-"));
    try {
      const result = runAddProcess(home, "preupdate-observation-forbidden");

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(path.join(home, "observation.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "attached.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(true);
      expect(readBridge(home).addState).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("resumes an exact provider without a host credential or prior revision observation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-reuse-no-observation-"));
    try {
      const interrupted = runAddProcess(home, "adapter");
      expect(interrupted.status, `${interrupted.stdout}\n${interrupted.stderr}`).toBe(86);
      expect(fs.existsSync(path.join(home, "observation.marker"))).toBe(false);

      const resumed = runAddProcess(home, "", false);
      expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      expect(fs.existsSync(path.join(home, "observation.marker"))).toBe(false);
      expect(readBridge(home).addState).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not reapply policy when a resumed provider is missing its host credential", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-resume-no-secret-"));
    try {
      const interrupted = runAddProcess(home, "adapter");
      expect(interrupted.status, `${interrupted.stdout}\n${interrupted.stderr}`).toBe(86);
      const policyApplyLog = path.join(home, "policy-apply-log.marker");
      expect(fs.readFileSync(policyApplyLog, "utf8").trim().split("\n")).toHaveLength(1);
      fs.rmSync(path.join(home, "provider.marker"));

      const resumed = runAddProcess(home, "", false);
      expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(2);
      expect(resumed.stderr).toContain("is missing. Export host environment variable");
      expect(fs.readFileSync(policyApplyLog, "utf8").trim().split("\n")).toHaveLength(1);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "observation.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "attached.marker"))).toBe(false);
      expect(readBridge(home)).toMatchObject({ addState: "preflighted" });

      const recovered = runAddProcess(home, "");
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(fs.readFileSync(policyApplyLog, "utf8").trim().split("\n")).toHaveLength(2);
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "attached.marker"))).toBe(true);
      expect(readBridge(home).addState).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("requires a host credential before retrying a prepared provider create", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-prepared-no-secret-"));
    try {
      const providerMarker = path.join(home, "provider.marker");
      fs.writeFileSync(providerMarker, "foreign\n", { mode: 0o600 });
      const staged = runAddProcess(home, "");
      expect(staged.status, `${staged.stdout}\n${staged.stderr}`).toBe(2);
      expect(readBridge(home).addState).toBe("prepared");
      fs.rmSync(providerMarker);

      const resumed = runAddProcess(home, "", false);
      expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(2);
      expect(resumed.stderr).toContain("Host environment variable 'FAKE_MCP_SECRET' is required");
      expect(readBridge(home).addState).toBe("prepared");
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "policy-apply-log.marker"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects and rolls back an adapter definition that differs after a successful add", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-mismatch-"));
    try {
      const result = runAddProcess(home, "adapter-mismatch");

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stderr).toContain("mcporter config verification failed");
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(false);
      expect(readBridge(home)).toMatchObject({
        server: "fake",
        addState: "preflighted",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed after process death between provider create and provider-ID persistence", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-provider-"));
    try {
      const crashed = runAddProcess(home, "provider");
      expect(crashed.status, `${crashed.stdout}\n${crashed.stderr}`).toBe(86);
      expect(readBridge(home)).toMatchObject({ addState: "preflighted" });
      expect(readBridge(home)).not.toHaveProperty("providerId");
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(true);

      const resumed = runAddProcess(home, "");
      expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(2);
      expect(resumed.stderr).toContain("has no stable provider ID and cannot safely adopt it");
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(readBridge(home)).not.toHaveProperty("providerId");

      // After the operator independently removes the unowned provider, the
      // local preflight manifest can be cleaned without adopting/deleting it.
      fs.rmSync(path.join(home, "provider.marker"));
      const cleaned = runRemoveProcess(home, false);
      expect(cleaned.status, `${cleaned.stdout}\n${cleaned.stderr}`).toBe(0);
      const registry = JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
      ) as { sandboxes: { "crash-test": { mcp?: unknown } } };
      expect(registry.sandboxes["crash-test"].mcp).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not create a credential provider unless the generated policy is effective", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-policy-drift-"));
    try {
      const rejected = runAddProcess(home, "policy-drift");

      expect(rejected.status, `${rejected.stdout}\n${rejected.stderr}`).toBe(2);
      expect(rejected.stderr).toContain("Failed to activate generated MCP policy");
      expect(rejected.stderr).toContain("effective state: drift");
      expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain("host-only-secret");
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "attached.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(false);
      expect(readBridge(home)).toMatchObject({ addState: "preflighted" });
      expect(readBridge(home)).not.toHaveProperty("providerId");
      const registry = JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
      ) as {
        sandboxes: { "crash-test": { customPolicies?: Array<{ name: string }> } };
      };
      expect(registry.sandboxes["crash-test"].customPolicies).toEqual([
        expect.objectContaining({
          name: "mcp-bridge-fake",
          content: expect.any(String),
          sourcePath: "generated:nemoclaw-mcp-bridge",
        }),
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("releases a generated-policy reservation when policy activation definitely fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-policy-failure-"));
    try {
      const rejected = runAddProcess(home, "policy-failure");

      expect(rejected.status, `${rejected.stdout}\n${rejected.stderr}`).toBe(2);
      expect(rejected.stderr).toContain("Failed to activate generated MCP policy");
      expect(rejected.stderr).toContain("effective state: absent");
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "attached.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(false);
      expect(readBridge(home)).toMatchObject({ addState: "preflighted" });
      const registry = JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
      ) as {
        sandboxes: { "crash-test": { customPolicies?: Array<{ name: string }> } };
      };
      expect(registry.sandboxes["crash-test"].customPolicies).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an attached credential-key collision before activating the MCP policy", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-key-collision-"));
    try {
      const rejected = runAddProcess(home, "credential-collision");

      expect(rejected.status, `${rejected.stdout}\n${rejected.stderr}`).toBe(2);
      expect(rejected.stderr).toContain(
        "Credential key 'FAKE_MCP_SECRET' is already supplied by attached provider 'foreign-attached'",
      );
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  for (const [boundary, expectedProviderId, expectedProviderMarker, expectedObservationMarker] of [
    ["policy", undefined, false, false],
    ["adapter", "11111111-2222-4333-8444-555555555555", true, true],
  ] as const) {
    it(`resumes exact resources after process death at the ${boundary} boundary`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-mcp-add-${boundary}-`));
      try {
        const crashed = runAddProcess(home, boundary);
        expect(crashed.status, `${crashed.stdout}\n${crashed.stderr}`).toBe(86);
        const pending = readBridge(home);
        expect(pending.addState).toBe("preflighted");
        expect(pending.providerId).toBe(expectedProviderId);
        expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(expectedProviderMarker);
        expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(true);
        expect(JSON.stringify(pending)).not.toContain("host-only-secret");

        const resumed = runAddProcess(home, "");
        expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
        const committed = readBridge(home);
        expect(committed.addState).toBeUndefined();
        expect(committed).toMatchObject({
          server: "fake",
          env: ["FAKE_MCP_SECRET"],
          policyName: "mcp-bridge-fake",
        });
        expect(committed.providerName).toBe(pending.providerName);
        expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(true);
        expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(true);
        expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(true);
        expect(fs.existsSync(path.join(home, "observation.marker"))).toBe(
          expectedObservationMarker,
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("rejects a same-name provider created after preflight and before the first mutation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-race-"));
    try {
      const raced = runAddProcess(home, "race");
      expect(raced.status, `${raced.stdout}\n${raced.stderr}`).toBe(2);
      expect(raced.stderr).toContain("already exists but is not owned");
      expect(readBridge(home)).toMatchObject({ addState: "preflighted" });
      expect(readBridge(home)).not.toHaveProperty("providerId");
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rechecks absence immediately before provider create", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-late-race-"));
    try {
      const raced = runAddProcess(home, "late-race");
      expect(raced.status, `${raced.stdout}\n${raced.stderr}`).toBe(2);
      expect(raced.stderr).toContain("changed before create");
      expect(readBridge(home)).toMatchObject({ addState: "preflighted" });
      expect(readBridge(home)).not.toHaveProperty("providerId");
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rechecks stable identity immediately before provider attach", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-attach-race-"));
    try {
      const raced = runAddProcess(home, "attach-race");
      expect(raced.status, `${raced.stdout}\n${raced.stderr}`).toBe(2);
      expect(raced.stderr).toContain("changed before attach");
      expect(readBridge(home)).toMatchObject({
        addState: "preflighted",
        providerId: "11111111-2222-4333-8444-555555555555",
      });
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not claim or delete a same-name resource found before preflight", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-foreign-provider-"));
    try {
      const providerMarker = path.join(home, "provider.marker");
      fs.writeFileSync(providerMarker, "foreign\n", { mode: 0o600 });

      const rejected = runAddProcess(home, "");
      expect(rejected.status, `${rejected.stdout}\n${rejected.stderr}`).toBe(2);
      expect(rejected.stderr).toContain("could not prove provider");
      expect(readBridge(home).addState).toBe("prepared");

      const statusResult = runStatusProcess(home);
      expect(statusResult.status, `${statusResult.stdout}\n${statusResult.stderr}`).toBe(0);
      const status = JSON.parse(statusResult.stdout) as {
        addState?: string;
        policy: { registryPresent: boolean; gatewayPresent: boolean | null };
      };
      expect(status.addState).toBe("prepared");
      expect(status.policy).toEqual({
        name: "mcp-bridge-fake",
        registryPresent: false,
        gatewayPresent: null,
      });

      const cancelScript = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("crash-test", "fake", { force: true }).then(
  () => process.exit(0),
  (error) => { console.error(error); process.exit(2); },
);
`;
      const cancelled = spawnSync(process.execPath, ["-e", cancelScript], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
        timeout: 30_000,
      });
      expect(cancelled.status, `${cancelled.stdout}\n${cancelled.stderr}`).toBe(0);
      expect(fs.existsSync(providerMarker)).toBe(true);
      const registry = JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
      ) as { sandboxes: { "crash-test": { mcp?: unknown } } };
      expect(registry.sandboxes["crash-test"].mcp).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("MCP remove crash consistency", () => {
  it("converges when the process dies after provider deletion", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-remove-provider-"));
    try {
      const added = runAddProcess(home, "");
      expect(added.status, `${added.stdout}\n${added.stderr}`).toBe(0);
      const providerName = readBridge(home).providerName;

      const crashed = runRemoveProcess(home, true);
      expect(crashed.status, `${crashed.stdout}\n${crashed.stderr}`).toBe(87);
      expect(readBridge(home)).toMatchObject({
        server: "fake",
        providerName,
      });
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(false);

      const resumed = runRemoveProcess(home, false);
      expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      const registry = JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
      ) as {
        sandboxes: {
          "crash-test": {
            mcp?: { bridges: Record<string, unknown>; managedServerNames: string[] };
          };
        };
      };
      expect(registry.sandboxes["crash-test"].mcp).toEqual({
        bridges: {},
        managedServerNames: ["fake"],
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
