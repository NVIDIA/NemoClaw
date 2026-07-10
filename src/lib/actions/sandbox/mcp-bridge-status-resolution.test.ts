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
// metadata is all-green, with the in-sandbox probe answering an identical
// rejection for the placeholder and control requests — the exact "status lies
// while the wire fails" shape from #6379. __PROBE_HTTP_STATUS__ is substituted
// per test so both the 401 (auth-shaped) and 400 (validation-ambiguous)
// warnings are exercised end-to-end.
const harnessPreludeTemplate = String.raw`
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
let providerAttachmentState = "attached";
let providerCredentialKey = "GITHUB_TOKEN";
globalActions.runOpenshellProviderCommand = (args) => {
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Id: 11111111-2222-4333-8444-555555555555\nType: generic\nResource version: 4\nCredential keys: " + providerCredentialKey + "\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    if (providerAttachmentState === "unknown") {
      return { status: 1, stdout: "", stderr: "attachment inspection failed" };
    }
    if (providerAttachmentState === "absent") {
      return { status: 0, stdout: "No providers attached to sandbox alpha\n", stderr: "" };
    }
    return {
      status: 0,
      stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-github generic 1 0\n",
      stderr: "",
    };
  }
  throw new Error("Unexpected OpenShell call: " + args.join(" "));
};
let activePolicyState = "match";
policies.getPresetContentGatewayState = () => activePolicyState;
const executedSandboxCommands = [];
processRecovery.executeSandboxCommand = (sandboxName, command) => {
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
        "NEMOCLAW_MCP_PROBE_CURL_EXIT=" + resultMarker + ":0",
        "NEMOCLAW_MCP_CONTROL_HTTP_CODE=" + resultMarker + ":__PROBE_HTTP_STATUS__",
        "NEMOCLAW_MCP_CONTROL_CURL_EXIT=" + resultMarker + ":0",
      ].join("\n"),
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

function runHarness(
  home: string,
  body: string,
  options: { probeHttpStatus?: number } = {},
): { status: number | null; stdout: string } {
  const prelude = harnessPreludeTemplate.replaceAll(
    "__PROBE_HTTP_STATUS__",
    String(options.probeHttpStatus ?? 401),
  );
  const script = `
process.env.HOME = ${JSON.stringify(home)};
${prelude}
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
      ok: null,
      httpStatus: 401,
      controlHttpStatus: 401,
    });
    expect(
      payload.status.warnings.some((warning) =>
        warning.includes("Credential resolution could not be verified"),
      ),
    ).toBe(true);
    expect(payload.exitCode).toBe(0);
  });

  it("skips status probe traffic until exact policy and provider readiness are verified (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-readiness-");
    const { stdout } = runHarness(
      home,
      String.raw`
  const outcomes = [];
  for (const policyState of ["absent", "drift", null]) {
    activePolicyState = policyState;
    providerAttachmentState = "attached";
    providerCredentialKey = "GITHUB_TOKEN";
    executedSandboxCommands.length = 0;
    const [status] = await bridge.statusMcpBridge("alpha", "github", {
      probeCredentialResolution: true,
    });
    outcomes.push({
      case: "policy:" + String(policyState),
      gatewayPresent: status.policy.gatewayPresent,
      resolution: status.provider.credentialResolution,
      probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    });
  }
  activePolicyState = "match";
  for (const attachmentState of ["absent", "unknown"]) {
    providerAttachmentState = attachmentState;
    providerCredentialKey = "GITHUB_TOKEN";
    executedSandboxCommands.length = 0;
    const [status] = await bridge.statusMcpBridge("alpha", "github", {
      probeCredentialResolution: true,
    });
    outcomes.push({
      case: "attachment:" + attachmentState,
      resolution: status.provider.credentialResolution,
      probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    });
  }
  providerAttachmentState = "attached";
  providerCredentialKey = "WRONG_TOKEN";
  executedSandboxCommands.length = 0;
  const [wrongProvider] = await bridge.statusMcpBridge("alpha", "github", {
    probeCredentialResolution: true,
  });
  outcomes.push({
    case: "provider:wrong-shape",
    resolution: wrongProvider.provider.credentialResolution,
    probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
  });
  process.stdout.write(JSON.stringify(outcomes));
`,
    );
    const outcomes = JSON.parse(stdout) as Array<{
      case: string;
      gatewayPresent?: boolean | null;
      resolution: { ok: boolean | null; detail?: string };
      probed: boolean;
    }>;
    expect(outcomes).toHaveLength(6);
    expect(outcomes.map((outcome) => outcome.gatewayPresent).slice(0, 3)).toEqual([
      false,
      false,
      null,
    ]);
    for (const outcome of outcomes) {
      expect(outcome.probed, outcome.case).toBe(false);
      expect(outcome.resolution.ok, outcome.case).toBeNull();
      expect(outcome.resolution.detail, outcome.case).toContain("probe skipped");
    }
  });

  it("renders the identical-rejection probe in the human-readable status output (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-render-");
    const { stdout } = runHarness(
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github"]);
  process.stdout.write(JSON.stringify({ lines: logLines }));
`,
    );
    const payload = JSON.parse(stdout) as { lines: string[] };
    expect(payload.lines.some((line) => line.includes("credential resolution: unknown"))).toBe(
      true,
    );
    expect(
      payload.lines.some((line) => line.includes("Credential resolution could not be verified")),
    ).toBe(true);
  });

  it("keeps the status warning for identical 400 explicitly inconclusive (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-400-");
    const { stdout } = runHarness(
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  process.stdout.write(JSON.stringify({ warnings: status.warnings }));
`,
      { probeHttpStatus: 400 },
    );
    const payload = JSON.parse(stdout) as { warnings: string[] };
    const warning = payload.warnings.find((line) =>
      line.includes("Credential resolution could not be verified"),
    );
    expect(warning).toBeDefined();
    expect(warning).toContain("inconclusive even with a valid stored credential");
    expect(warning).toContain("request validation");
    expect(warning).not.toContain("the OpenShell host is not rewriting");
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
    expect(payload.forcedResolution).toMatchObject({
      ok: null,
      httpStatus: 401,
      controlHttpStatus: 401,
    });
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
  it("warns loudly on an identical-rejection probe without failing the committed add (#6379)", () => {
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
          line.includes("WARNING") && line.includes("Credential resolution could not be verified"),
      ),
    ).toBe(true);
    expect(payload.exitCode).toBe(0);
  });

  it("skips post-add probe traffic when policy verification is absent, drifted, or unknown (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-add-policy-gate-");
    const { stdout } = runHarness(
      home,
      String.raw`
  const addRestart = require("./src/lib/actions/sandbox/mcp-bridge-add-restart.js");
  addRestart.addMcpBridge = async () => {};
  const outcomes = [];
  for (const policyState of ["absent", "drift", null]) {
    activePolicyState = policyState;
    executedSandboxCommands.length = 0;
    logLines.length = 0;
    errorLines.length = 0;
    await bridge.dispatchMcpBridgeCommand("alpha", [
      "add", "github", "--url", "https://api.githubcopilot.com/mcp/", "--env", "GITHUB_TOKEN",
    ]);
    outcomes.push({
      policyState,
      probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
      output: [...logLines, ...errorLines].join("\n"),
      exitCode: process.exitCode ?? 0,
    });
  }
  process.stdout.write(JSON.stringify(outcomes));
`,
    );
    const outcomes = JSON.parse(stdout) as Array<{
      policyState: "absent" | "drift" | null;
      probed: boolean;
      output: string;
      exitCode: number;
    }>;
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.probed, String(outcome.policyState)).toBe(false);
      expect(outcome.output).toContain("Credential resolution probe was inconclusive");
      expect(outcome.output).toContain("probe skipped");
      expect(outcome.exitCode).toBe(0);
    }
  });

  it("keeps the post-add warning for identical 400 explicitly inconclusive (#6379)", () => {
    const home = createTempHome("nemoclaw-mcp-resolution-add-400-");
    const { stdout } = runHarness(
      home,
      String.raw`
  const addRestart = require("./src/lib/actions/sandbox/mcp-bridge-add-restart.js");
  addRestart.addMcpBridge = async () => {};
  await bridge.dispatchMcpBridgeCommand("alpha", [
    "add", "github", "--url", "https://api.githubcopilot.com/mcp/", "--env", "GITHUB_TOKEN",
  ]);
  process.stdout.write(JSON.stringify({ errorLines, exitCode: process.exitCode ?? 0 }));
`,
      { probeHttpStatus: 400 },
    );
    const payload = JSON.parse(stdout) as { errorLines: string[]; exitCode: number };
    const warning = payload.errorLines.find((line) => line.includes("WARNING"));
    expect(warning).toBeDefined();
    expect(warning).toContain("inconclusive even with a valid stored credential");
    expect(warning).toContain("request validation");
    expect(warning).not.toContain("the OpenShell host is not rewriting");
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
