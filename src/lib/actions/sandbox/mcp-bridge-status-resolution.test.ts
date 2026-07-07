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

// Shared subprocess prelude: a healthy committed bridge whose provider
// metadata is all-green, with the in-sandbox probe answering HTTP 401 —
// the exact "status lies while the wire fails" shape from #6379.
const harnessPrelude = String.raw`
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
      stdout: "Id: 11111111-2222-4333-8444-555555555555\nType: generic\nResource version: 4\nCredential keys: GITHUB_TOKEN\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return {
      status: 0,
      stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-github generic 1 0\n",
      stderr: "",
    };
  }
  throw new Error("Unexpected OpenShell call: " + args.join(" "));
};
policies.getPresetContentGatewayState = () => "match";
const executedSandboxCommands = [];
processRecovery.executeSandboxCommand = (sandboxName, command) => {
  executedSandboxCommands.push(command);
  if (command.includes("NEMOCLAW_MCP_PROBE")) {
    return {
      status: 0,
      stdout: "\nNEMOCLAW_MCP_PROBE_HTTP_CODE=401\nNEMOCLAW_MCP_PROBE_CURL_EXIT=0\n{\"error\":\"unauthorized\"}",
      stderr: "",
    };
  }
  return { status: 0, stdout: "registered", stderr: "" };
};
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { github: {
    server: "github",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://api.githubcopilot.com/mcp/",
    env: ["GITHUB_TOKEN"],
    providerName: "alpha-mcp-github",
    providerId: "11111111-2222-4333-8444-555555555555",
    policyName: "mcp-bridge-github",
    addedAt: "2026-06-01T00:00:00.000Z",
  } } },
});
registry.addCustomPolicy("alpha", {
  name: "mcp-bridge-github",
  content: "network_policies: {}\n",
  sourcePath: "generated:nemoclaw-mcp-bridge",
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
const logLines = [];
const errorLines = [];
console.log = (...parts) => logLines.push(parts.join(" "));
console.error = (...parts) => errorLines.push(parts.join(" "));
`;

function runHarness(home: string, body: string): { status: number | null; stdout: string } {
  const script = `
process.env.HOME = ${JSON.stringify(home)};
${harnessPrelude}
(async () => {
${body}
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home, NODE_OPTIONS: sourceNodeOptions },
  });
  expect(result.status, `harness failed: ${result.stderr}`).toBe(0);
  return { status: result.status, stdout: result.stdout };
}

describe("MCP status wire-level credential-resolution probe", () => {
  it("probes by default for a single named server and surfaces the wire failure (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-single-");
    const { stdout } = runHarness(
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  process.stdout.write(JSON.stringify({
    status,
    probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    exitCode: process.exitCode ?? 0,
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      status: {
        provider: { credentialResolution?: { ok: boolean | null; httpStatus?: number } };
        warnings: string[];
      };
      probed: boolean;
      exitCode: number;
    };
    expect(payload.probed).toBe(true);
    expect(payload.status.provider.credentialResolution).toMatchObject({
      ok: false,
      httpStatus: 401,
    });
    expect(
      payload.status.warnings.some((warning) =>
        warning.includes("did not resolve the credential placeholder"),
      ),
    ).toBe(true);
    expect(payload.exitCode).toBe(0);
  });

  it("renders the failed probe in the human-readable status output (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-render-");
    const { stdout } = runHarness(
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github"]);
  process.stdout.write(JSON.stringify({ lines: logLines }));
`,
    );
    const payload = JSON.parse(stdout) as { lines: string[] };
    expect(
      payload.lines.some((line) => line.includes("credential resolution: FAILED (HTTP 401)")),
    ).toBe(true);
    expect(
      payload.lines.some((line) => line.includes("did not resolve the credential placeholder")),
    ).toBe(true);
  });

  it("never probes from bare status or list so multi-server views stay fast (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-list-");
    const { stdout } = runHarness(
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "--json"]);
  const bareStatus = JSON.parse(logLines.join("\n"));
  logLines.length = 0;
  await bridge.dispatchMcpBridgeCommand("alpha", ["list", "--json"]);
  const list = JSON.parse(logLines.join("\n"));
  process.stdout.write(JSON.stringify({
    probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    bareStatusResolution: bareStatus.bridges[0].provider.credentialResolution ?? null,
    listResolution: list.bridges[0].provider.credentialResolution ?? null,
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      probed: boolean;
      bareStatusResolution: unknown;
      listResolution: unknown;
    };
    expect(payload.probed).toBe(false);
    expect(payload.bareStatusResolution).toBeNull();
    expect(payload.listResolution).toBeNull();
  });

  it("honors --no-probe on a named server and --probe on the multi-server form (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-flags-");
    const { stdout } = runHarness(
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--no-probe", "--json"]);
  const skipped = JSON.parse(logLines.join("\n"));
  const probesAfterSkip = executedSandboxCommands.filter((c) => c.includes("NEMOCLAW_MCP_PROBE")).length;
  logLines.length = 0;
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "--probe", "--json"]);
  const forced = JSON.parse(logLines.join("\n"));
  process.stdout.write(JSON.stringify({
    probesAfterSkip,
    skippedResolution: skipped.provider.credentialResolution ?? null,
    forcedResolution: forced.bridges[0].provider.credentialResolution ?? null,
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      probesAfterSkip: number;
      skippedResolution: unknown;
      forcedResolution: { ok: boolean | null; httpStatus?: number } | null;
    };
    expect(payload.probesAfterSkip).toBe(0);
    expect(payload.skippedResolution).toBeNull();
    expect(payload.forcedResolution).toMatchObject({ ok: false, httpStatus: 401 });
  });

  it("rejects combining --probe with --no-probe (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-conflict-");
    const { stdout } = runHarness(
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--probe", "--no-probe"]);
  const observedExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  process.stdout.write(JSON.stringify({ errorLines, exitCode: observedExitCode }));
`,
    );
    const payload = JSON.parse(stdout) as { errorLines: string[]; exitCode: number };
    expect(payload.exitCode).toBe(2);
    expect(payload.errorLines.join("\n")).toContain("at most one of --probe / --no-probe");
  });
});

describe("MCP add post-add credential-resolution probe", () => {
  it("warns loudly on a wire failure without failing the committed add (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-add-");
    const { stdout } = runHarness(
      home,
      String.raw`
  const addRestart = require("./src/lib/actions/sandbox/mcp-bridge-add-restart.js");
  addRestart.addMcpBridge = async () => {};
  await bridge.dispatchMcpBridgeCommand("alpha", [
    "add", "github", "--url", "https://api.githubcopilot.com/mcp/", "--env", "GITHUB_TOKEN",
  ]);
  process.stdout.write(JSON.stringify({
    logLines,
    errorLines,
    probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    exitCode: process.exitCode ?? 0,
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      logLines: string[];
      errorLines: string[];
      probed: boolean;
      exitCode: number;
    };
    expect(payload.probed).toBe(true);
    expect(payload.logLines.some((line) => line.includes("MCP server 'github' added"))).toBe(true);
    expect(
      payload.errorLines.some(
        (line) =>
          line.includes("WARNING") && line.includes("did not resolve the credential placeholder"),
      ),
    ).toBe(true);
    expect(payload.exitCode).toBe(0);
  });

  it("skips the post-add probe when --no-probe is passed (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-add-skip-");
    const { stdout } = runHarness(
      home,
      String.raw`
  const addRestart = require("./src/lib/actions/sandbox/mcp-bridge-add-restart.js");
  addRestart.addMcpBridge = async () => {};
  await bridge.dispatchMcpBridgeCommand("alpha", [
    "add", "github", "--url", "https://api.githubcopilot.com/mcp/", "--env", "GITHUB_TOKEN", "--no-probe",
  ]);
  process.stdout.write(JSON.stringify({
    errorLines,
    probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    exitCode: process.exitCode ?? 0,
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      errorLines: string[];
      probed: boolean;
      exitCode: number;
    };
    expect(payload.probed).toBe(false);
    expect(payload.errorLines).toHaveLength(0);
    expect(payload.exitCode).toBe(0);
  });
});
