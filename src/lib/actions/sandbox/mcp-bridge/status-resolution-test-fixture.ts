// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { expect } from "vitest";

// Shared child-process fixture for source-backed MCP status tests.

export const statusHarnessConfig = {
  concurrency: 4,
  sourceNodeOptions: [
    process.env.NODE_OPTIONS,
    `--require=${path.resolve("test/helpers/onboard-script-mocks.cjs")}`,
  ]
    .filter(Boolean)
    .join(" "),
  timeoutMs: 60_000,
};

export const TRUSTED_PRIVATE_STATUS_HARNESS = String.raw`
  Object.assign(sourceEntry, {
    url: "https://172.17.0.2:8443/mcp",
    trustedPrivateHost: "172.17.0.2",
    allowedIps: ["172.17.0.2"],
  });
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--probe", "--tools", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({
    status,
    probeCommands: executedSandboxCommands.filter((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    discoveryCommands: executedSandboxCommands.filter((c) => c.includes("mcp-tool-discovery-runtime")),
  }));
`;

export function expectTrustedPrivateStatusResult(stdout: string): void {
  const payload = JSON.parse(stdout) as {
    status: {
      url: string;
      trustedPrivateTarget: { host: string; recordedPins: string[] };
      provider: { credentialResolution: { ok: boolean | null; detail?: string } };
      toolDiscovery: { ok: boolean; count: number; tools: string[]; detail?: string };
    };
    probeCommands: string[];
    discoveryCommands: string[];
  };
  expect(payload.probeCommands).toHaveLength(1);
  expect(payload.probeCommands[0]).toContain("https://172.17.0.2:8443/mcp");
  expect(payload.discoveryCommands).toHaveLength(1);
  expect(payload.discoveryCommands[0]).toContain("https://172.17.0.2:8443/mcp");
  expect(payload.status.url).toBe("https://172.17.0.2:8443/mcp");
  expect(payload.status.trustedPrivateTarget).toMatchObject({
    host: "172.17.0.2",
    recordedPins: ["172.17.0.2"],
  });
  expect(payload.status.provider.credentialResolution).toMatchObject({
    ok: true,
    httpStatus: 200,
    controlHttpStatus: 401,
  });
  expect(payload.status.toolDiscovery).toMatchObject({
    ok: true,
    count: 2,
    tools: ["alpha", "zeta"],
    commandStatus: 0,
  });
}

// Healthy committed bridge with identical placeholder/control rejections: the #6379 "status lies
// while wire fails" shape. __PROBE_HTTP_STATUS__ covers auth-shaped and ambiguous failures.
export const harnessPreludeTemplate = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const gatewayManagementPath = path.join(process.env.HOME, "gateway-management.json");
fs.writeFileSync(gatewayManagementPath, JSON.stringify({
  version: 1,
  mode: "nemoclaw-managed",
  requiredCapabilities: [],
}));
process.env.NEMOCLAW_GATEWAY_MANAGEMENT = gatewayManagementPath;
const registry = require("./src/lib/state/registry.js");
const dns = require("node:dns/promises");
dns.lookup = async () => [{ address: "8.8.8.8", family: 4 }];
require("./src/lib/adapters/dns/resolve.js").resolveHostAddressesBounded =
  (host) => dns.lookup(host, { all: true, verbatim: true });
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const providerInspection = require("./src/lib/actions/sandbox/mcp-bridge-provider-inspection.js");
const policies = require("./src/lib/policy/index.js");
const commandTransport = require("./src/lib/adapters/sandbox/command-transport.js");
const sourceState = require("./src/lib/actions/sandbox/mcp-bridge-source.js");
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
providerInspection.getMcpProviderInspectionRuntimeSelection = () => ({
  gatewayName: "nemoclaw",
  workspace: "default",
});
let providerAttachmentState = "attached";
let providerInspectionState = "present";
let providerCredentialKey = "GITHUB_TOKEN";
let persistedCredentialRevision = "v11";
let includeSecondSource = false;
let providerAttachmentInspectionCount = 0;
const hermesIntentPayloads = [];
providerCommands.runOpenshellProviderCommand = (args) => {
  if (args[0] === "provider" && args[1] === "get") {
    if (providerInspectionState === "absent") {
      return { status: 1, stdout: "", stderr: "provider not found" };
    }
    const providerName = args[2];
    const credentialKey = providerName === "alpha-mcp-slack" ? "SLACK_TOKEN" : providerCredentialKey;
    return {
      status: 0,
      stdout: "Name: " + providerName + "\nId: 11111111-2222-4333-8444-555555555555\nType: nemoclaw-mcp-v1\nResource version: 4\nCredential keys: " + credentialKey + "\nConfig keys: <none>\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    providerAttachmentInspectionCount += 1;
    if (providerAttachmentState === "unknown") {
      return { status: 1, stdout: "", stderr: "attachment inspection failed" };
    }
    if (providerAttachmentState === "absent") {
      return { status: 0, stdout: "No providers attached to sandbox alpha\n", stderr: "" };
    }
    return {
      status: 0,
      stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-github nemoclaw-mcp-v1 1 0\n" +
        (includeSecondSource ? "alpha-mcp-slack nemoclaw-mcp-v1 1 0\n" : ""),
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "exec" && args.includes("inspect")) {
    const payload = JSON.parse(args[args.length - 1]);
    hermesIntentPayloads.push(payload);
    const authorization = payload.present?.github?.headers?.Authorization;
    const matches = authorization ===
      "Bearer openshell:resolve:env:" + persistedCredentialRevision + "_GITHUB_TOKEN";
    return matches
      ? { status: 0, stdout: '{"ok":true,"state":"matched"}\n', stderr: "" }
      : { status: 2, stdout: "", stderr: "Hermes MCP config does not match the requested native entry" };
  }
  throw new Error("Unexpected OpenShell call: " + args.join(" "));
};
let activePolicyState = "match";
policies.getPresetContentGatewayState = () => activePolicyState;
policies.captureRecordedSandboxBasePolicy = () => {
  if (activePolicyState === null) throw new Error("policy inspection failed");
  return activePolicyState === "absent"
    ? "network_policies: {}\n"
    : "network_policies:\n  mcp_bridge_github: {}\n";
};
const executedSandboxCommands = [];
let providerCredentialObservation = "v11";
let credentialObservationCount = 0;
let probeCurlExit = 0;
let probeStderr = "";
let toolDiscoveryStatus = 0;
let toolDiscoveryResult = {
  protocol: 2,
  ok: true,
  count: 2,
  tools: ["alpha", "zeta"],
  truncated: false,
};
const observeCredential = async () => {
  credentialObservationCount += 1;
  return {
    status: 0,
    stdout: providerCredentialObservation,
    stderr: "",
  };
};
let executeAdapterCommand = async (sandboxName, command) => {
  executedSandboxCommands.push(command);
  if (command.includes("NEMOCLAW_MCP_PROBE")) {
    const resultMarker = command.match(/__NEMOCLAW_SANDBOX_EXEC_STARTED___[0-9a-f]{32}/)?.[0];
    if (!resultMarker) throw new Error("credential probe result marker missing");
    return {
      status: 0,
      stdout: [
        resultMarker,
        "",
        "NEMOCLAW_MCP_PROBE_HTTP_CODE=" + resultMarker + ":__PROBE_HTTP_STATUS__",
        "NEMOCLAW_MCP_PROBE_CURL_EXIT=" + resultMarker + ":" + probeCurlExit,
        "NEMOCLAW_MCP_CONTROL_HTTP_CODE=" + resultMarker + ":__CONTROL_HTTP_STATUS__",
        "NEMOCLAW_MCP_CONTROL_CURL_EXIT=" + resultMarker + ":0",
      ].join("\n"),
      stderr: probeStderr,
    };
  }
  if (command.includes("mcp-tool-discovery-runtime")) {
    const resultMarker = command.match(/__NEMOCLAW_SANDBOX_EXEC_STARTED___[0-9a-f]{32}/)?.[0];
    if (!resultMarker) throw new Error("tool discovery result marker missing");
    return {
      status: toolDiscoveryStatus,
      stdout: resultMarker + "\n" + JSON.stringify(toolDiscoveryResult),
      stderr: "",
    };
  }
  const expectedAuthorization =
    "openshell:resolve:env:" + persistedCredentialRevision + "_GITHUB_TOKEN";
  return {
    status: 0,
    stdout: command.includes(expectedAuthorization) ? "registered" : "mismatch",
    stderr: "",
  };
};
commandTransport.executeSandboxExecCommand = async (sandboxName, command) =>
  command.includes('valid_placeholder "$value" || exit 1')
    ? observeCredential()
    : executeAdapterCommand(sandboxName, command);
const sourceEntry = {
    server: "github",
    agent: "openclaw",
    adapter: "openclaw-config",
    url: "https://api.githubcopilot.com/mcp/",
    env: ["GITHUB_TOKEN"],
    allowedIps: ["8.8.8.8"],
    providerName: "alpha-mcp-github",
    providerId: "11111111-2222-4333-8444-555555555555",
    policyName: "mcp-bridge-github",
};
const secondSourceEntry = {
  ...sourceEntry,
  server: "slack",
  env: ["SLACK_TOKEN"],
  providerName: "alpha-mcp-slack",
  policyName: "mcp-bridge-slack",
};
let legacySourceEnabled = false;
let policyOnlySourceEnabled = false;
sourceState.inspectSourceBridgeState = () => ({
  bridges: {
    github: policyOnlySourceEnabled ? { ...sourceEntry, source: "policy" } : sourceEntry,
    ...(includeSecondSource ? { slack: secondSourceEntry } : {}),
  },
  sources: {
    native: legacySourceEnabled || policyOnlySourceEnabled
      ? {}
      : { github: sourceEntry, ...(includeSecondSource ? { slack: secondSourceEntry } : {}) },
    legacy: legacySourceEnabled ? { github: { ...sourceEntry, source: "legacy" } } : {},
  },
});
registry.registerSandbox({ name: "alpha", agent: "openclaw" });
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
const logLines = [];
const errorLines = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const writeHarnessResult = (value) => originalStdoutWrite(value);
process.stdout.write = (value) => {
  logLines.push(String(value).trimEnd());
  return true;
};
console.log = (...parts) => logLines.push(parts.join(" "));
console.error = (...parts) => errorLines.push(parts.join(" "));
`;
