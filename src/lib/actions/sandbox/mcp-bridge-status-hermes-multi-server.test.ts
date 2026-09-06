// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
const sourceNodeOptions = [process.env.NODE_OPTIONS, `--require=${sourceRequireHook}`]
  .filter(Boolean)
  .join(" ");
const tempHomes = new Set<string>();

function createTempHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempHomes.add(home);
  return home;
}

afterEach(() => {
  tempHomes.forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
  tempHomes.clear();
});

// Regression coverage for a bug where `mcp status <server>` on a Hermes
// sandbox with two or more managed MCP servers built the Hermes
// reconciliation "present" payload from *every* bridge entry, while only
// having freshly observed a live OpenShell credential revision for the one
// named server being queried. The unobserved sibling entry fell back to a
// revision-agnostic (always-matching) expectation, while the queried server
// alone was held to an exact-revision match against a live probe that can
// legitimately drift from the revision committed in the sandbox's config file
// (e.g. across a background OpenShell credential-revision rotation). The
// practical symptom observed live: querying/restarting server "alpha"
// repeatedly reports server "beta" as unregistered ("Hermes MCP config does
// not match persisted managed intent"), and vice versa, even though both are
// correctly configured on disk and the gateway serves both correctly.
describe("Hermes multi-server MCP status reconciliation scoping", () => {
  it("scopes the reconciliation payload to only the queried server", () => {
    const home = createTempHome("nemoclaw-hermes-mcp-multi-status-");
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});

const inspectPayloads = [];
providerCommands.runOpenshellProviderCommand = (args) => {
  if (args[0] === "provider" && args[1] === "get") {
    const server = args[2].includes("alpha") ? "alpha" : "beta";
    return {
      status: 0,
      stdout:
        "Id: 11111111-2222-4333-8444-555555555555\nType: nemoclaw-mcp-v1\nResource version: 4\nCredential keys: " +
        server.toUpperCase() + "_MCP_TOKEN\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return {
      status: 0,
      stdout:
        "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n" +
        "nemoclaw-mcp-hermes-sandbox-alpha nemoclaw-mcp-v1 1 0\n" +
        "nemoclaw-mcp-hermes-sandbox-beta nemoclaw-mcp-v1 1 0\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "exec" && args.includes("inspect")) {
    const payload = JSON.parse(args[args.length - 1]);
    inspectPayloads.push(payload);
    // Every entry in "present" is reported matched: the point of this test is
    // *which servers are asked about*, not whether the match itself passes.
    return { status: 0, stdout: '{"ok":true,"state":"matched"}\n', stderr: "" };
  }
  throw new Error("Unexpected OpenShell call: " + args.join(" "));
};
policies.getPresetContentGatewayState = () => "match";
// The live credential-revision proof (used to build the exact-match
// "expected" value for the *queried* server) always reports a revision that
// has moved on ("v999") -- simulating drift from whatever revision is
// actually committed on disk for either server. This mock is intentionally
// decoupled from any specific env name, matching the real probe's
// per-sandbox (not per-server) invocation.
processRecovery.executeSandboxExecCommand = () => ({
  status: 0,
  stdout: "v999",
  stderr: "",
});

registry.registerSandbox({
  name: "hermes-sandbox",
  agent: "hermes",
  mcp: {
    bridges: {
      alpha: {
        server: "alpha",
        agent: "hermes",
        adapter: "hermes-config",
        url: "https://mcp-gw.example.test/mcp-alpha",
        env: ["ALPHA_MCP_TOKEN"],
        providerName: "nemoclaw-mcp-hermes-sandbox-alpha",
        policyName: "mcp-bridge-alpha",
        addedAt: "2026-06-01T00:00:00.000Z",
      },
      beta: {
        server: "beta",
        agent: "hermes",
        adapter: "hermes-config",
        url: "https://mcp-gw.example.test/mcp-beta",
        env: ["BETA_MCP_TOKEN"],
        providerName: "nemoclaw-mcp-hermes-sandbox-beta",
        policyName: "mcp-bridge-beta",
        addedAt: "2026-06-01T00:00:00.000Z",
      },
    },
    managedServerNames: ["alpha", "beta"],
  },
});

const status = require("./src/lib/actions/sandbox/mcp-bridge-status.js");
(async () => {
  await status.statusMcpBridge("hermes-sandbox", "alpha");
  await status.statusMcpBridge("hermes-sandbox", "beta");
  process.stdout.write(JSON.stringify({ inspectPayloads }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_OPTIONS: sourceNodeOptions },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      inspectPayloads: Array<{ present: Record<string, unknown>; absent: string[] }>;
    };

    expect(payload.inspectPayloads).toHaveLength(2);

    // Querying "alpha" must only ever assert intent about "alpha". Before the
    // fix, this payload's `present` object also contained "beta" (held to a
    // revision-agnostic, always-matching expectation it never earned).
    expect(Object.keys(payload.inspectPayloads[0]!.present)).toEqual(["alpha"]);
    expect(payload.inspectPayloads[0]!.absent).toEqual([]);

    // Querying "beta" must only ever assert intent about "beta".
    expect(Object.keys(payload.inspectPayloads[1]!.present)).toEqual(["beta"]);
    expect(payload.inspectPayloads[1]!.absent).toEqual([]);
  }, 20_000);
});
