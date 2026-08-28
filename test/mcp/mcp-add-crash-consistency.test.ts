// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const MATCHING_OPENSHELL = path.resolve("test/fixtures/openshell-v0.0.106");

type CrashBoundary =
  | "provider"
  | "policy"
  | "policy-failure"
  | "policy-drift"
  | "credential-collision"
  | "credential-command-race"
  | "credential-projection-coalesced"
  | "credential-projection-unstable"
  | "credential-projection-delayed-hostless"
  | "registered-credential-collision"
  | "registered-late-collision"
  | "adapter"
  | "adapter-mismatch"
  | "attach-race"
  | "race"
  | "late-race"
  | "preupdate-observation-forbidden"
  | "";

function buildAddProcessScript(
  home: string,
  crashAfter: CrashBoundary,
  includeSecret = true,
  initializeSandbox = true,
): string {
  return String.raw`
process.env.HOME = ${JSON.stringify(home)};
const includeSecret = ${JSON.stringify(includeSecret)};
const initializeSandbox = ${JSON.stringify(initializeSandbox)};
includeSecret ? (process.env.FAKE_MCP_SECRET = "host-only-secret") : delete process.env.FAKE_MCP_SECRET;
const fs = require("node:fs");
const path = require("node:path");
const crashAfter = ${JSON.stringify(crashAfter)};
const credentialProjectionScenario =
  crashAfter === "credential-projection-coalesced" ||
  crashAfter === "credential-projection-unstable";
if (crashAfter === "credential-projection-coalesced") {
  process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS = "3";
} else if (crashAfter === "credential-projection-unstable") {
  process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS = "2";
} else if (crashAfter === "credential-projection-delayed-hostless") {
  process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS = "2";
}
const marker = (name) => path.join(process.env.HOME, name + ".marker");
const mark = (name) => fs.writeFileSync(marker(name), "yes\n", { mode: 0o600 });
const marked = (name) => fs.existsSync(marker(name));
const providerVersion = () => Number.parseInt(marked("provider-version") ? fs.readFileSync(marker("provider-version"), "utf8") : "1", 10);
// OpenShell provider resource versions and child credential revisions are
// separate identities. Keep the fixture values unrelated so readiness cannot
// derive one from the other.
const initialChildCredentialRevision = "v4067750153477477214";
const childCredentialRevision = () => marked("child-credential-revision")
  ? fs.readFileSync(marker("child-credential-revision"), "utf8").trim()
  : initialChildCredentialRevision;
const setChildCredentialRevision = (revision) => fs.writeFileSync(marker("child-credential-revision"), revision, { mode: 0o600 });
const advanceChildCredentialRevision = () => setChildCredentialRevision(
  "v" + (BigInt(childCredentialRevision().slice(1)) + 1n).toString(),
);
const setProviderVersion = (version) => fs.writeFileSync(marker("provider-version"), String(version), { mode: 0o600 });
const providerPresentAtStart = marked("provider");
const providerId = "11111111-2222-4333-8444-555555555555";
const foreignProviderId = "99999999-8888-4777-8666-555555555555";
let providerGetCount = 0;
let observedProviderName = null;
let attachmentAttemptedThisProcess = false;
let credentialUpdatedThisProcess = false;
let observedCredentialAbsentThisProcess = false;
let credentialRepublishBeforeObservationCountThisProcess = 0;
let credentialRepublishAfterAbsenceCountThisProcess = 0;
let credentialFreeRefreshBeforeObservationCountThisProcess = 0;
let credentialFreeRefreshAfterAbsenceCountThisProcess = 0;
let credentialObservationAfterRepublishCountThisProcess = 0;

const registry = require("./src/lib/state/registry.js");
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const { mockManagedEndpointlessProviderProfileRun } = require("./test/helpers/onboard-script-mocks.cjs");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const ownershipLocks = require("./src/lib/state/mcp-lifecycle-lock/credential-ownership.js");

if (crashAfter === "credential-command-race") {
  const withMcpCredentialOwnershipLock = ownershipLocks.withMcpCredentialOwnershipLock;
  ownershipLocks.withMcpCredentialOwnershipLock = (operation) => {
    mark("mcp-ownership-lock-attempt");
    return withMcpCredentialOwnershipLock(operation);
  };
}

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});

providerCommands.runOpenshellProviderCommand = (args) => {
  const profileResult = mockManagedEndpointlessProviderProfileRun(args);
  if (profileResult) return profileResult;
  if (args[0] === "status" && args[1] === "--output" && args[2] === "json") {
    return { status: 0, stdout: JSON.stringify({ gateway: "nemoclaw" }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    if (args[2] === "foreign-attached" || args[2] === "foreign-registered") {
      return { status: 0, stdout: "Id: " + foreignProviderId + "\nType: nemoclaw-mcp-v1\nResource version: 1\nCredential keys: FAKE_MCP_SECRET\n", stderr: "" };
    }
    observedProviderName = args[2];
    providerGetCount += 1;
    if (crashAfter === "race" && providerGetCount === 2) mark("provider");
    if (crashAfter === "late-race" && providerGetCount === 3) mark("provider");
    return marked("provider")
      ? { status: 0, stdout: "Id: " + (marked("foreign-provider") ? foreignProviderId : providerId) + "\nType: nemoclaw-mcp-v1\nResource version: " + providerVersion() + "\nCredential keys: FAKE_MCP_SECRET\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "NotFound: provider" };
  }
  if (args[0] === "provider" && (args[1] === "create" || args[1] === "update")) {
    if (credentialProjectionScenario) {
      fs.appendFileSync(marker("provider-mutation-log"), args[1] + "\n", { mode: 0o600 });
    }
    if (!marked("policy")) {
      return { status: 1, stdout: "", stderr: "provider mutation preceded policy attestation" };
    }
    if (args[1] === "create") {
      observedProviderName = args[args.indexOf("--name") + 1];
      setProviderVersion(1);
      setChildCredentialRevision(initialChildCredentialRevision);
    }
    if (args[1] === "update") {
      const isCredentialUpdate =
        args.length === 5 &&
        args[2] === observedProviderName &&
        args[3] === "--credential" &&
        args[4] === "FAKE_MCP_SECRET";
      const isCredentialFreeRefresh = args.length === 3 && args[2] === observedProviderName;
      if (!isCredentialUpdate && !isCredentialFreeRefresh) {
        throw new Error("Unexpected provider update: " + args.join(" "));
      }
      setProviderVersion(providerVersion() + 1);
      if (isCredentialUpdate) {
        credentialUpdatedThisProcess = true;
        advanceChildCredentialRevision();
        mark("updated");
      }
      if (
        credentialProjectionScenario &&
        isCredentialUpdate &&
        marked("bound-policy") &&
        !observedCredentialAbsentThisProcess
      ) {
        credentialRepublishBeforeObservationCountThisProcess += 1;
        fs.appendFileSync(marker("republish-before-observation"), "republish\n", { mode: 0o600 });
      }
      if (
        credentialProjectionScenario &&
        isCredentialUpdate &&
        marked("bound-policy") &&
        observedCredentialAbsentThisProcess
      ) {
        credentialRepublishAfterAbsenceCountThisProcess += 1;
        fs.appendFileSync(marker("republish-after-observed-absence"), "republish\n", { mode: 0o600 });
      }
      if (
        crashAfter === "credential-projection-delayed-hostless" &&
        isCredentialFreeRefresh &&
        !observedCredentialAbsentThisProcess
      ) {
        credentialFreeRefreshBeforeObservationCountThisProcess += 1;
        fs.appendFileSync(marker("refresh-before-observed-absence"), "refresh\n", { mode: 0o600 });
      }
      if (
        crashAfter === "credential-projection-delayed-hostless" &&
        isCredentialFreeRefresh &&
        observedCredentialAbsentThisProcess
      ) {
        credentialFreeRefreshAfterAbsenceCountThisProcess += 1;
        fs.appendFileSync(marker("refresh-after-observed-absence"), "refresh\n", { mode: 0o600 });
      }
    }
    mark("provider");
    if (crashAfter === "registered-late-collision") registry.addExtraProvider("foreign-registered");
    if (crashAfter === "provider") process.exit(86);
    return { status: 0, stdout: args[1] === "create" ? "Created provider" : "Updated provider", stderr: "" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    if (crashAfter === "credential-collision") {
      return {
        status: 0,
        stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nforeign-attached nemoclaw-mcp-v1 1 0\n",
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
        ? "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n" + providerName + " nemoclaw-mcp-v1 1 0\n"
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
  if (marked("attached")) mark("bound-policy");
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
    !credentialUpdatedThisProcess &&
    !attachmentAttemptedThisProcess;
  isPreupdateObservation && mark("observation");
  if (credentialProjectionScenario && isObservation) {
    const credentialRepublishCount =
      credentialRepublishBeforeObservationCountThisProcess +
      credentialRepublishAfterAbsenceCountThisProcess;
    if (credentialRepublishCount === 0) {
      observedCredentialAbsentThisProcess = true;
      mark("credential-observed-absent");
    } else {
      credentialObservationAfterRepublishCountThisProcess += 1;
    }
    const observation =
      credentialRepublishCount === 0
        ? "absent"
        : crashAfter === "credential-projection-unstable"
          ? credentialObservationAfterRepublishCountThisProcess % 2 === 1
            ? initialChildCredentialRevision
            : childCredentialRevision()
          : credentialObservationAfterRepublishCountThisProcess === 1
            ? initialChildCredentialRevision
            : childCredentialRevision();
    if (credentialRepublishCount > 0) {
      fs.appendFileSync(marker("credential-observation-log"), observation + "\n", { mode: 0o600 });
    }
    return {
      status: 0,
      stdout: observation,
      stderr: "",
    };
  }
  if (crashAfter === "credential-projection-delayed-hostless" && isObservation) {
    if (credentialFreeRefreshAfterAbsenceCountThisProcess === 0) {
      observedCredentialAbsentThisProcess = true;
      mark("credential-observed-absent");
    }
    return {
      status: 0,
      stdout: credentialFreeRefreshAfterAbsenceCountThisProcess > 0 ? childCredentialRevision() : "absent",
      stderr: "",
    };
  }
  return {
    status: crashAfter === "preupdate-observation-forbidden" && isPreupdateObservation ? 1 : 0,
    stdout: isObservation ? (marked("updated") || marked("provider") ? childCredentialRevision() : "absent") : "",
    stderr: "",
  };
};
processRecovery.executeSandboxCommand = (_sandbox, command) => {
  if (command === "command -v mcporter") {
    return { status: 0, stdout: "/usr/local/bin/mcporter\n", stderr: "" };
  }
  if (command.includes("config' 'add") || command.includes('"config", "add"')) {
    const adapterRevision = command.match(/openshell:resolve:env:(v[0-9]+)_FAKE_MCP_SECRET/)?.[1];
    if (adapterRevision) {
      fs.writeFileSync(marker("adapter-revision"), adapterRevision, { mode: 0o600 });
    }
    mark("adapter");
    if (crashAfter === "adapter") process.exit(86);
    return { status: 0, stdout: "", stderr: "" };
  }
  if (
    command.includes("config' 'remove") ||
    (command.includes('spawnSync("mcporter"') && command.includes('"remove", expected.server'))
  ) {
    fs.rmSync(marker("adapter"), { force: true });
    return { status: 0, stdout: "", stderr: "" };
  }
  if (
    crashAfter === "adapter-mismatch" &&
    marked("adapter") &&
    (command.includes('["config", "get"') || command.includes('"get", expected.server'))
  ) {
    return { status: 0, stdout: "mismatch\n", stderr: "" };
  }
  if (
    crashAfter === "credential-projection-coalesced" &&
    marked("adapter") &&
    (command.includes('["config", "get"') || command.includes('"get", expected.server'))
  ) {
    const expectedRevision = command.match(/openshell:resolve:env:(v[0-9]+)_FAKE_MCP_SECRET/)?.[1];
    const adapterRevision = fs.readFileSync(marker("adapter-revision"), "utf8");
    return {
      status: 0,
      stdout: expectedRevision === adapterRevision ? "registered\n" : "mismatch\n",
      stderr: "",
    };
  }
  return {
    status: 0,
    stdout: marked("adapter") ? "registered\n" : "absent\n",
    stderr: "",
  };
};

if (initializeSandbox && !registry.getSandbox("crash-test")) {
  registry.registerSandbox({
    name: "crash-test",
    agent: "openclaw",
    gatewayName: "nemoclaw",
  });
}
if (crashAfter === "registered-credential-collision") {
  registry.addExtraProvider("foreign-registered");
}
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.addMcpBridge("crash-test", {
  server: "fake",
  url: "https://8.8.8.8/mcp",
  env: [{ name: "FAKE_MCP_SECRET" }],
}).then(
  async () => {
    try {
      if (crashAfter === "credential-projection-coalesced") {
        const [status] = await bridge.statusMcpBridge("crash-test", "fake");
        fs.writeFileSync(marker("post-add-status"), JSON.stringify(status), { mode: 0o600 });
      }
      process.exit(0);
    } catch (error) {
      console.error(error && error.stack || error);
      process.exit(2);
    }
  },
  (error) => {
    console.error(error && error.stack || error);
    process.exit(2);
  },
);
`;
}

function initializeSandboxRegistry(home: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `process.env.HOME = ${JSON.stringify(home)}; const registry = require("./src/lib/state/registry.js"); registry.registerSandbox({ name: "crash-test", agent: "openclaw", gatewayName: "nemoclaw" });`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 30_000,
    },
  );
  expect(
    result.status,
    `Could not initialize the MCP race fixture:\n${result.stdout}\n${result.stderr}`,
  ).toBe(0);
}

function runAddProcess(home: string, crashAfter: CrashBoundary, includeSecret = true) {
  const script = buildAddProcessScript(home, crashAfter, includeSecret);
  return spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
    timeout: 30_000,
  });
}

function spawnScript(home: string, script: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
    stdio: "pipe",
  });
}

function collectProcess(child: ChildProcessWithoutNullStreams): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function waitForMarker(home: string, name: string): Promise<void> {
  const marker = path.join(home, `${name}.marker`);
  await vi.waitFor(
    () => expect(fs.existsSync(marker), `Timed out waiting for ${name}`).toBe(true),
    {
      timeout: 10_000,
      interval: 10,
    },
  );
}

function buildCredentialAddRaceScript(home: string): string {
  return String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.FAKE_MCP_SECRET = "host-only-secret";
const fs = require("node:fs");
const path = require("node:path");
const marker = (name) => path.join(process.env.HOME, name + ".marker");
const mark = (name) => fs.writeFileSync(marker(name), "yes\n", { mode: 0o600 });
const marked = (name) => fs.existsSync(marker(name));
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const { mockManagedEndpointlessProviderProfileRun } = require("./test/helpers/onboard-script-mocks.cjs");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const teardownAuthority = require("./src/lib/onboard/gateway-teardown-authority.js");

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({ recovered: true, attempted: false });
teardownAuthority.resolveGatewayCredentialMutationAuthority = () => ({});
providerCommands.runOpenshellProviderCommand = (args) => {
  const profileResult = mockManagedEndpointlessProviderProfileRun(args);
  if (profileResult) return profileResult;
  if (args[0] === "provider" && args[1] === "create") {
    mark("credential-provider-create-entered");
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    while (!marked("release-credential-provider")) Atomics.wait(sleep, 0, 0, 10);
    mark("provider");
    return { status: 0, stdout: "Created provider", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};

const { runCredentialsAddAction } = require("./src/lib/actions/credentials-add.js");
runCredentialsAddAction({
  provider: "custom-provider",
  type: "nemoclaw-mcp-v1",
  credentials: ["FAKE_MCP_SECRET"],
  configPairs: [],
  fromExisting: false,
}).then(
  (result) => {
    if (result.exitCode !== 0) console.error(result.failureLines.join("\n"));
    process.exit(result.exitCode === 0 ? 0 : 2);
  },
  (error) => {
    console.error(error && error.stack || error);
    process.exit(2);
  },
);
`;
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

const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const { mockManagedEndpointlessProviderProfileRun } = require("./test/helpers/onboard-script-mocks.cjs");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});

providerCommands.runOpenshellProviderCommand = (args) => {
  const profileResult = mockManagedEndpointlessProviderProfileRun(args);
  if (profileResult) return profileResult;
  if (args[0] === "status" && args[1] === "--output" && args[2] === "json") {
    return { status: 0, stdout: JSON.stringify({ gateway: "nemoclaw" }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    observedProviderName = args[2];
    return marked("provider")
      ? { status: 0, stdout: "Id: " + providerId + "\nType: nemoclaw-mcp-v1\nResource version: 1\nCredential keys: FAKE_MCP_SECRET\n", stderr: "" }
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
        ? "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n" + providerName + " nemoclaw-mcp-v1 1 0\n"
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
policies.getLiveSandboxPolicyEntryDigest = () => marked("policy") ? "present" : null;
policies.removePreset = () => {
  fs.rmSync(marker("policy"), { force: true });
  return true;
};

processRecovery.executeSandboxCommand = (_sandbox, command) => {
  if (
    command.includes('["config", "remove"') ||
    (command.includes('spawnSync("mcporter"') && command.includes('"remove", expected.server'))
  ) {
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
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const { mockManagedEndpointlessProviderProfileRun } = require("./test/helpers/onboard-script-mocks.cjs");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
providerCommands.runOpenshellProviderCommand = (args) => {
  const profileResult = mockManagedEndpointlessProviderProfileRun(args);
  if (profileResult) return profileResult;
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Type: nemoclaw-mcp-v1\nCredential keys: FAKE_MCP_SECRET\n",
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

function readFixtureArtifacts(directory: string): string {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory()
        ? readFixtureArtifacts(target)
        : entry.isFile()
          ? fs.readFileSync(target, "utf8")
          : "";
    })
    .join("\n");
}

describe("MCP add crash consistency", () => {
  it("commits one bridge at the stable credential revision and rejects one duplicate (#9764)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-concurrent-projection-"));
    try {
      // Create the fixture before either process loads the registry. The
      // behavior under test starts at the lifecycle lock, after fixture creation.
      initializeSandboxRegistry(home);
      const script = buildAddProcessScript(home, "credential-projection-coalesced", true, false);
      const first = spawnScript(home, script);
      const second = spawnScript(home, script);
      const results = await Promise.all([collectProcess(first), collectProcess(second)]);
      const combinedOutput = results
        .map((result) => `${result.stdout}\n${result.stderr}`)
        .join("\n---\n");

      expect(results.map((result) => result.status).sort(), combinedOutput).toEqual([0, 2]);
      expect(results.find((result) => result.status === 2)?.stderr).toContain("already exists");
      expect(combinedOutput).not.toContain("host-only-secret");
      expect(fs.existsSync(path.join(home, "credential-observed-absent.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "republish-before-observation.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "republish-after-observed-absence.marker"))).toBe(true);
      const credentialRepublishCount = fs
        .readFileSync(path.join(home, "republish-after-observed-absence.marker"), "utf8")
        .split("\n")
        .filter(Boolean).length;
      expect(credentialRepublishCount).toBe(1);
      expect(
        fs
          .readFileSync(path.join(home, "provider-mutation-log.marker"), "utf8")
          .split("\n")
          .filter(Boolean),
      ).toEqual(["create", "update"]);
      expect(
        fs
          .readFileSync(path.join(home, "credential-observation-log.marker"), "utf8")
          .split("\n")
          .filter(Boolean),
      ).toEqual([
        "v4067750153477477214",
        "v4067750153477477215",
        "v4067750153477477215",
        "v4067750153477477215",
      ]);
      expect(fs.readFileSync(path.join(home, "adapter-revision.marker"), "utf8")).toBe(
        fs.readFileSync(path.join(home, "child-credential-revision.marker"), "utf8"),
      );
      expect(fs.readFileSync(path.join(home, "adapter-revision.marker"), "utf8")).not.toBe(
        `v${fs.readFileSync(path.join(home, "provider-version.marker"), "utf8")}`,
      );
      const postAddStatus = JSON.parse(
        fs.readFileSync(path.join(home, "post-add-status.marker"), "utf8"),
      ) as { adapter: { registered: boolean | null } };
      expect(postAddStatus.adapter.registered).toBe(true);
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "attached.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(true);
      expect(readBridge(home).addState).toBeUndefined();
      expect(readFixtureArtifacts(home)).not.toContain("host-only-secret");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("times out without committing an adapter while credential revisions remain unstable (#9764)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-unstable-revision-"));
    try {
      const result = runAddProcess(home, "credential-projection-unstable");

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stderr).toContain("did not synchronize the expected credential revision");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("host-only-secret");
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "attached.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      const observations = fs
        .readFileSync(path.join(home, "credential-observation-log.marker"), "utf8")
        .split("\n")
        .filter(Boolean);
      expect(observations.length).toBeGreaterThan(1);
      expect(
        observations.every(
          (revision, index) => index === 0 || revision !== observations[index - 1],
        ),
      ).toBe(true);
      expect(readFixtureArtifacts(home)).not.toContain("host-only-secret");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses one credential-free refresh when hostless recovery observes absence (#9764)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-hostless-projection-"));
    try {
      const interrupted = runAddProcess(home, "adapter");
      expect(interrupted.status, `${interrupted.stdout}\n${interrupted.stderr}`).toBe(86);

      const resumed = runAddProcess(home, "credential-projection-delayed-hostless", false);
      expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      expect(`${resumed.stdout}\n${resumed.stderr}`).not.toContain("host-only-secret");
      expect(fs.existsSync(path.join(home, "credential-observed-absent.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "refresh-before-observed-absence.marker"))).toBe(false);
      const credentialFreeRefreshCount = fs
        .readFileSync(path.join(home, "refresh-after-observed-absence.marker"), "utf8")
        .split("\n")
        .filter(Boolean).length;
      expect(credentialFreeRefreshCount).toBe(1);
      expect(readBridge(home).addState).toBeUndefined();
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "attached.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(true);
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

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
      expect(fs.existsSync(path.join(home, "updated.marker"))).toBe(true);
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
      expect(fs.readFileSync(policyApplyLog, "utf8").trim().split("\n")).toHaveLength(2);
      fs.rmSync(path.join(home, "provider.marker"));

      const resumed = runAddProcess(home, "", false);
      expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(2);
      expect(resumed.stderr).toContain("is missing. Export host environment variable");
      expect(fs.readFileSync(policyApplyLog, "utf8").trim().split("\n")).toHaveLength(2);
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "observation.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "attached.marker"))).toBe(false);
      expect(readBridge(home)).toMatchObject({ addState: "preflighted" });
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

  it("rejects a registered credential-key collision before recording MCP state (#9388)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-registered-collision-"));
    try {
      const rejected = runAddProcess(home, "registered-credential-collision");

      expect(rejected.status, `${rejected.stdout}\n${rejected.stderr}`).toBe(2);
      expect(rejected.stderr).toContain(
        "Credential key 'FAKE_MCP_SECRET' is already supplied by registered provider 'foreign-registered'",
      );
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(false);
      const state = JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
      ) as { sandboxes: { "crash-test": { mcp?: unknown } } };
      expect(state.sandboxes["crash-test"].mcp).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("serializes credential registration with a fresh MCP reservation (#9388)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-credential-race-"));
    let credentialChild: ChildProcessWithoutNullStreams | undefined;
    let mcpChild: ChildProcessWithoutNullStreams | undefined;
    try {
      credentialChild = spawnScript(home, buildCredentialAddRaceScript(home));
      const credentialResult = collectProcess(credentialChild);
      await waitForMarker(home, "credential-provider-create-entered");

      mcpChild = spawnScript(home, buildAddProcessScript(home, "credential-command-race"));
      const mcpResult = collectProcess(mcpChild);
      await waitForMarker(home, "mcp-ownership-lock-attempt");

      const beforeRelease = JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
      ) as { sandboxes: { "crash-test": { mcp?: unknown } }; extraProviders?: string[] };
      expect(beforeRelease.sandboxes["crash-test"].mcp).toBeUndefined();
      expect(beforeRelease.extraProviders).toContain("custom-provider");
      fs.writeFileSync(path.join(home, "release-credential-provider.marker"), "yes\n", {
        mode: 0o600,
      });

      const [credential, mcp] = await Promise.all([credentialResult, mcpResult]);
      expect(credential.status, `${credential.stdout}\n${credential.stderr}`).toBe(0);
      expect(mcp.status, `${mcp.stdout}\n${mcp.stderr}`).toBe(2);
      expect(mcp.stderr).toContain(
        "Credential key 'FAKE_MCP_SECRET' is already supplied by registered provider 'custom-provider'",
      );
      const state = JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
      ) as { sandboxes: { "crash-test": { mcp?: unknown } }; extraProviders?: string[] };
      expect(state.sandboxes["crash-test"].mcp).toBeUndefined();
      expect(state.extraProviders).toContain("custom-provider");
    } finally {
      fs.writeFileSync(path.join(home, "release-credential-provider.marker"), "yes\n", {
        mode: 0o600,
      });
      credentialChild?.kill();
      mcpChild?.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("records managed MCP state before rejecting a late registered collision (#9388)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-add-late-collision-"));
    try {
      const rejected = runAddProcess(home, "registered-late-collision");

      expect(rejected.status, `${rejected.stdout}\n${rejected.stderr}`).toBe(2);
      expect(rejected.stderr).toContain(
        "Credential key 'FAKE_MCP_SECRET' is already supplied by registered provider 'foreign-registered'",
      );
      expect(readBridge(home)).toMatchObject({
        addState: "preflighted",
        providerId: "11111111-2222-4333-8444-555555555555",
      });
      expect(fs.existsSync(path.join(home, "policy.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "provider.marker"))).toBe(false);
      expect(fs.existsSync(path.join(home, "adapter.marker"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["policy", undefined, false, false],
    ["adapter", "11111111-2222-4333-8444-555555555555", true, true],
  ] as const)(
    "resumes exact resources after process death at the %s boundary",
    (boundary, expectedProviderId, expectedProviderMarker, expectedObservationMarker) => {
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
    },
  );

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
