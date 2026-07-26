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

describe("cross-agent MCP status boundaries", () => {
  it("reports unsupported persisted boundaries without starting an unsafe sandbox child", () => {
    const home = createTempHome("nemoclaw-mcp-status-risk-");
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.LD_PRELOAD = "/tmp/legacy-attached-loader.so";
const registry = require("./src/lib/state/registry.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const globalActions = require("./src/lib/actions/global.js");
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
      stdout: "Id: 11111111-2222-4333-8444-555555555555\nType: generic\nResource version: 4\nCredential keys: LD_PRELOAD\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return {
      status: 0,
      stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-fake generic 1 0\n",
      stderr: "",
    };
  }
  throw new Error("Unexpected OpenShell call: " + args.join(" "));
};
policies.getPresetContentGatewayState = () => "match";
processRecovery.executeSandboxCommand = () => {
  throw new Error("unsafe sandbox child must not start while LD_PRELOAD is attached");
};
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { fake: {
    server: "fake",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://host.openshell.internal:31337/mcp",
    env: ["LD_PRELOAD"],
    providerName: "alpha-mcp-fake",
    providerId: "11111111-2222-4333-8444-555555555555",
    policyName: "mcp-bridge-fake",
    addedAt: "2026-06-01T00:00:00.000Z",
  } } },
});
registry.addCustomPolicy("alpha", {
  name: "mcp-bridge-fake",
  content: "network_policies: {}\n",
  sourcePath: "generated:nemoclaw-mcp-bridge",
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const [status] = await bridge.statusMcpBridge("alpha", "fake");
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await bridge.dispatchMcpBridgeCommand("alpha", ["status", "fake"]);
  } finally {
    console.log = originalLog;
  }
  process.stdout.write(JSON.stringify({ status, text: lines.join("\n") }));
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
      status: {
        warnings: string[];
        provider: { attached: boolean | null };
        adapter: { registered: boolean | null; detail?: string };
      };
      text: string;
    };
    expect(payload.status.provider.attached).toBe(true);
    expect(payload.status.adapter).toEqual({
      registered: null,
      detail: expect.stringMatching(/inspection was skipped.*legacy credential/i),
    });
    expect(payload.status.warnings).toEqual([
      expect.stringMatching(/provider at sandbox scope.*endpoint-exclusive credential binding/i),
      expect.stringMatching(/persisted MCP URL no longer satisfies.*remove this server/i),
      expect.stringMatching(
        /persisted MCP credential name no longer satisfies.*remove this server/i,
      ),
    ]);
    expect(payload.text).toMatch(
      /warning: OpenShell currently attaches this credential provider at sandbox scope/i,
    );
    expect(payload.text).toMatch(/warning: This persisted MCP URL no longer satisfies/i);
    expect(payload.text).toMatch(
      /warning: This persisted MCP credential name no longer satisfies/i,
    );
  });

  it("reports Hermes bridge support in status JSON without requiring servers", () => {
    const home = createTempHome("nemoclaw-mcp-status-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
registry.registerSandbox({ name: "hermes-sandbox", agent: "hermes" });
bridge.dispatchMcpBridgeCommand("hermes-sandbox", ["status", "--json"]).then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_OPTIONS: sourceNodeOptions },
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      sandbox: string;
      agent: string;
      support: { supported: boolean; mode: string; reason?: string };
      bridges: unknown[];
    };
    expect(payload.sandbox).toBe("hermes-sandbox");
    expect(payload.agent).toBe("hermes");
    expect(payload.support).toMatchObject({
      supported: true,
      mode: "bridge",
      adapter: "hermes-config",
    });
    expect(payload.bridges).toEqual([]);
  });
});
