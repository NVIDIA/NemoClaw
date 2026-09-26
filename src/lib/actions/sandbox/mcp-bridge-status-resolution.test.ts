// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, type TestContext } from "vitest";
import {
  expectTrustedPrivateStatusResult,
  statusHarnessConfig,
  TRUSTED_PRIVATE_STATUS_HARNESS,
} from "./mcp-bridge/status-resolution-test-fixture.js";
import {
  createAbortAwareLimiter,
  createControlledHarnessProcess,
} from "../../../../test/helpers/controlled-concurrency-harness";
import { runOnboardProcessAsync } from "../../../../test/helpers/onboard-child-process-harness";

let runHarnessProcess = runOnboardProcessAsync;
const {
  concurrency: harnessConcurrency,
  sourceNodeOptions,
  timeoutMs: harnessTimeoutMs,
} = statusHarnessConfig;
const limitHarness = createAbortAwareLimiter(harnessConcurrency);

function describeConcurrentProbeSuite(name: string, factory: () => void): void {
  describe.concurrent(name, { timeout: harnessTimeoutMs }, factory);
}

function createTempHome(prefix: string, root = os.tmpdir()): string {
  return fs.mkdtempSync(path.join(root, prefix));
}

// Healthy committed bridge with identical placeholder/control rejections: the #6379 "status lies
// while wire fails" shape. __PROBE_HTTP_STATUS__ covers auth-shaped and ambiguous failures.
const harnessPreludeTemplate = String.raw`
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
        "NEMOCLAW_MCP_PROBE_CURL_EXIT=" + resultMarker + ":0",
        "NEMOCLAW_MCP_CONTROL_HTTP_CODE=" + resultMarker + ":__CONTROL_HTTP_STATUS__",
        "NEMOCLAW_MCP_CONTROL_CURL_EXIT=" + resultMarker + ":0",
      ].join("\n"),
      stderr: "",
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

async function runHarness(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  home: string,
  body: string,
  options: { controlHttpStatus?: number; probeHttpStatus?: number } = {},
): Promise<{ status: number | null; stdout: string }> {
  try {
    const probeHttpStatus = options.probeHttpStatus ?? 401;
    const prelude = harnessPreludeTemplate
      .replaceAll("__PROBE_HTTP_STATUS__", String(probeHttpStatus))
      .replaceAll("__CONTROL_HTTP_STATUS__", String(options.controlHttpStatus ?? probeHttpStatus));
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
    const result = await limitHarness(context.signal, () =>
      runHarnessProcess(["-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, NODE_OPTIONS: sourceNodeOptions },
        timeoutMs: harnessTimeoutMs,
        context,
      }),
    );
    expect(result.status, `harness failed: ${result.stderr}`).toBe(0);
    return { status: result.status, stdout: result.stdout };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("MCP status harness concurrency", { timeout: harnessTimeoutMs }, () => {
  it("limits runHarness child launches to four", async (context) => {
    const originalRunHarnessProcess = runHarnessProcess;
    const homes = Array.from({ length: harnessConcurrency + 1 }, () =>
      createTempHome("nemoclaw-mcp-concurrency-"),
    );
    const controlled = createControlledHarnessProcess();
    let maxActive = 0;
    runHarnessProcess = async (...arguments_) => {
      const result = controlled.run(...arguments_);
      maxActive = Math.max(maxActive, controlled.activeHomes.size);
      return result;
    };
    const runs = homes.map((home) => runHarness(context, home, ""));

    try {
      await expect.poll(() => controlled.activeHomes.size).toBe(harnessConcurrency);
      expect(maxActive).toBe(harnessConcurrency);
      expect(controlled.activeHomes.has(homes[harnessConcurrency])).toBe(false);

      controlled.release(homes[1]);
      await expect.poll(() => controlled.activeHomes.has(homes[harnessConcurrency])).toBe(true);
      expect(controlled.activeHomes.has(homes[0])).toBe(true);
      controlled.releaseAll();
      await Promise.all(runs);
      expect(maxActive).toBe(harnessConcurrency);
    } finally {
      controlled.releaseAll();
      await Promise.allSettled(runs);
      runHarnessProcess = originalRunHarnessProcess;
    }
  });

  it("removes a cancelled queued harness without delaying the next launch", async (context) => {
    const originalRunHarnessProcess = runHarnessProcess;
    const blockerHomes = Array.from({ length: harnessConcurrency }, () =>
      createTempHome("nemoclaw-mcp-blocker-"),
    );
    const cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-queued-cleanup-"));
    const cancelledHome = createTempHome("cancelled-", cleanupRoot);
    const successorHome = createTempHome("nemoclaw-mcp-successor-");
    const controlled = createControlledHarnessProcess();
    runHarnessProcess = controlled.run;
    const blockerRuns = blockerHomes.map((home) => runHarness(context, home, ""));
    const controller = new AbortController();
    const reason = new Error("queued fixture cancelled");
    let cancelledRun: Promise<{ status: number | null; stdout: string }> | undefined;
    let successorRun: Promise<{ status: number | null; stdout: string }> | undefined;

    try {
      await expect.poll(() => controlled.activeHomes.size).toBe(harnessConcurrency);
      cancelledRun = runHarness(
        { signal: controller.signal, onTestFinished: context.onTestFinished },
        cancelledHome,
        "",
      );
      successorRun = runHarness(context, successorHome, "");
      controller.abort(reason);

      await expect(cancelledRun).rejects.toBe(reason);
      expect(fs.readdirSync(cleanupRoot)).toEqual([]);
      controlled.release(blockerHomes[2]);
      await expect.poll(() => controlled.activeHomes.has(successorHome)).toBe(true);
      controlled.releaseAll();
      await Promise.all([...blockerRuns, successorRun]);
    } finally {
      controller.abort(reason);
      controlled.releaseAll();
      await Promise.allSettled([
        ...blockerRuns,
        ...(cancelledRun ? [cancelledRun] : []),
        ...(successorRun ? [successorRun] : []),
      ]);
      runHarnessProcess = originalRunHarnessProcess;
      fs.rmSync(cleanupRoot, { recursive: true, force: true });
    }
  });
});

describeConcurrentProbeSuite("MCP status wire-level credential-resolution probe", () => {
  it("removes its home when cancelled before child launch", async (context) => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-cleanup-"));
    const home = createTempHome("home-", workspaceRoot);
    const controller = new AbortController();
    const reason = new Error("fixture test cancelled");
    controller.abort(reason);
    try {
      await expect(
        runHarness({ signal: controller.signal, onTestFinished: context.onTestFinished }, home, ""),
      ).rejects.toBe(reason);
      expect(fs.readdirSync(workspaceRoot)).toEqual([]);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it.for([
    { probeHttpStatus: 200, controlHttpStatus: 401, accepted: true },
    { probeHttpStatus: 401, controlHttpStatus: 401, accepted: false },
    { probeHttpStatus: 400, controlHttpStatus: 400, accepted: false },
  ] as const)(
    "requires wire authorization for an unchanged stable handle ($probeHttpStatus/control $controlHttpStatus)",
    async ({ probeHttpStatus, controlHttpStatus, accepted }, context) => {
      const home = createTempHome("nemoclaw-mcp-stable-authorization-");
      const { stdout } = await runHarness(
        context,
        home,
        String.raw`
  const status = require("./src/lib/actions/sandbox/mcp-bridge-status.js");
  const handle = "s" + "a".repeat(64);
  providerCredentialObservation = handle;
  let accepted = true;
  let detail = "";
  try {
    await status.assertUnchangedStableMcpCredentialAuthorized(
      "alpha", sourceEntry, { gatewayName: "nemoclaw", workspace: "default" }, handle, handle,
    );
  } catch (error) {
    accepted = false;
    detail = String(error.message);
  }
  writeHarnessResult(JSON.stringify({
    accepted, detail, probed: executedSandboxCommands.some((command) => command.includes("NEMOCLAW_MCP_PROBE")),
  }));
`,
        { probeHttpStatus, controlHttpStatus },
      );
      const result = JSON.parse(stdout) as { accepted: boolean; detail: string; probed: boolean };
      expect(result.accepted).toBe(accepted);
      expect(result.probed).toBe(true);
      expect(result.detail).toEqual(
        accepted
          ? ""
          : expect.stringContaining(
              "did not authorize its unchanged stable credential handle after provider update",
            ),
      );
    },
  );

  it("inspects the attachment inventory once for a multi-server source read (#9806)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-status-attachments-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  includeSecondSource = true;
  providerAttachmentInspectionCount = 0;
  const statuses = await bridge.statusMcpBridge("alpha");
  writeHarnessResult(JSON.stringify({
    attachmentInspections: providerAttachmentInspectionCount,
    attached: statuses.map((status) => status.provider.attached),
    supported: statuses.map((status) => status.support.supported),
  }));
`,
    );

    expect(JSON.parse(stdout)).toEqual({
      attachmentInspections: 1,
      attached: [true, true],
      supported: [true, true],
    });
  });

  it.for([false, true])(
    "reports policy-derived adapter availability (transport failure: %s)",
    async (transportFailure, context) => {
      const home = createTempHome("nemoclaw-mcp-resolution-policy-source-");
      const { stdout } = await runHarness(
        context,
        home,
        String.raw`
  policyOnlySourceEnabled = true;
  if (${transportFailure}) {
    const { SandboxCommandTransportError } = require("./src/lib/adapters/sandbox/command-transport.js");
    executeAdapterCommand = async () => { throw new SandboxCommandTransportError("unavailable"); };
  }
  const [status] = await bridge.statusMcpBridge("alpha", "github");
  writeHarnessResult(JSON.stringify({
    adapter: status.adapter,
    policy: status.policy,
    provider: status.provider,
  }));
`,
      );
      const payload = JSON.parse(stdout);
      expect(payload.adapter.registered).toBe(transportFailure ? null : true);
      expect(payload.adapter.detail ?? "").toContain(transportFailure ? "unavailable" : "");
      expect(payload.policy.state).toBe(transportFailure ? "orphaned" : "configured");
      expect(payload.provider.state).toBe(transportFailure ? "orphaned" : "configured");
    },
  );

  it("refuses status while a legacy source still requires explicit migration", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-legacy-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  legacySourceEnabled = true;
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github"]);
  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  writeHarnessResult(JSON.stringify({ errorLines, exitCode }));
`,
    );
    const payload = JSON.parse(stdout) as { errorLines: string[]; exitCode: number };
    expect(payload.exitCode).toBe(2);
    expect(payload.errorLines.join("\n")).toContain("mcp migrate");
  });

  it("probes by default for a single named server and surfaces the wire failure (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-single-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({
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

  it("sends the observed revision and rejects canonical probe authority (#10079)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-revision-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  const outcomes = [];
  for (const observation of ["v19", "canonical"]) {
    providerCredentialObservation = observation;
    persistedCredentialRevision = observation === "v19" ? "v19" : "v11";
    credentialObservationCount = 0;
    executedSandboxCommands.length = 0;
    const [status] = await bridge.statusMcpBridge("alpha", "github", {
      probeCredentialResolution: true,
    });
    const probeCommand = executedSandboxCommands.find((command) =>
      command.includes("NEMOCLAW_MCP_PROBE"),
    );
    outcomes.push({
      observation,
      resolution: status.provider.credentialResolution,
      probeCommand: probeCommand ?? null,
      credentialObservationCount,
    });
  }
  writeHarnessResult(JSON.stringify(outcomes));
`,
    );
    const outcomes = JSON.parse(stdout) as Array<{
      observation: string;
      resolution: { ok: boolean | null; detail?: string };
      probeCommand: string | null;
      credentialObservationCount: number;
    }>;

    expect(outcomes[0]?.probeCommand).toContain("openshell:resolve:env:v19_GITHUB_TOKEN");
    expect(outcomes[0]?.probeCommand).not.toContain("openshell:resolve:env:GITHUB_TOKEN");
    expect(outcomes[1]?.probeCommand).toBeNull();
    expect(outcomes[1]?.resolution.detail).toContain("identityless credential placeholder");
    expect(outcomes.map((outcome) => outcome.credentialObservationCount)).toEqual([1, 1]);
  });

  it("reports stale persisted revisions for every agent adapter (#10079)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-status-stale-revision-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  providerCredentialObservation = "v12";
  persistedCredentialRevision = "v11";
  const outcomes = [];
  for (const [agent, adapter] of [
    ["openclaw", "openclaw-config"],
    ["langchain-deepagents-code", "deepagents-config"],
    ["hermes", "hermes-config"],
  ]) {
    Object.assign(sourceEntry, { agent, adapter });
    registry.updateSandbox("alpha", { agent });
    credentialObservationCount = 0;
    executedSandboxCommands.length = 0;
    hermesIntentPayloads.length = 0;
    const [status] = await bridge.statusMcpBridge("alpha", "github", {
      probeCredentialResolution: true,
    });
    outcomes.push({
      agent,
      adapter: status.adapter,
      resolution: status.provider.credentialResolution,
      credentialObservationCount,
      adapterCommand: executedSandboxCommands.find(
        (command) => !command.includes("NEMOCLAW_MCP_PROBE"),
      ) ?? null,
      hermesIntent: hermesIntentPayloads[0] ?? null,
      probed: executedSandboxCommands.some((command) => command.includes("NEMOCLAW_MCP_PROBE")),
    });
  }
  writeHarnessResult(JSON.stringify(outcomes));
`,
    );
    const outcomes = JSON.parse(stdout) as Array<{
      agent: string;
      adapter: { registered: boolean | null; detail?: string };
      resolution: { ok: boolean | null; detail?: string };
      credentialObservationCount: number;
      adapterCommand: string | null;
      hermesIntent: unknown;
      probed: boolean;
    }>;

    expect(outcomes.map((outcome) => outcome.adapter.registered)).toEqual([false, false, false]);
    expect(outcomes.map((outcome) => outcome.credentialObservationCount)).toEqual([1, 1, 1]);
    expect(outcomes.map((outcome) => outcome.probed)).toEqual([false, false, false]);
    outcomes.forEach((outcome) => {
      expect(outcome.resolution).toEqual({
        ok: null,
        detail:
          "probe skipped: the managed agent adapter does not match the current credential revision",
      });
    });
    expect(outcomes[0]?.adapterCommand).toContain("openshell:resolve:env:v12_GITHUB_TOKEN");
    expect(outcomes[1]?.adapterCommand).toContain("openshell:resolve:env:v12_GITHUB_TOKEN");
    expect(outcomes[2]?.adapterCommand).toContain("openshell:resolve:env:v12_GITHUB_TOKEN");
    expect(JSON.stringify(outcomes)).not.toContain("openshell:resolve:env:v11_GITHUB_TOKEN");
  });

  it("lets restart verify a stored credential before repairing a stale adapter revision", async (context) => {
    const home = createTempHome("nemoclaw-mcp-status-restart-revision-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  providerCredentialObservation = "v12";
  persistedCredentialRevision = "v11";
  sourceEntry.agent = "hermes";
  sourceEntry.adapter = "hermes-config";
  registry.updateSandbox("alpha", { agent: "hermes" });
  const [status] = await bridge.statusMcpBridge("alpha", "github", {
    allowCredentialProbeWithAdapterMismatch: true,
    probeCredentialResolution: true,
  });
  writeHarnessResult(JSON.stringify({
    adapter: status.adapter,
    resolution: status.provider.credentialResolution,
    probed: executedSandboxCommands.some((command) => command.includes("NEMOCLAW_MCP_PROBE")),
  }));
`,
      { controlHttpStatus: 401, probeHttpStatus: 200 },
    );
    const payload = JSON.parse(stdout) as {
      adapter: { registered: boolean | null };
      resolution: { ok: boolean | null; httpStatus?: number; controlHttpStatus?: number };
      probed: boolean;
    };

    expect(payload.adapter.registered).toBe(false);
    expect(payload.probed).toBe(true);
    expect(payload.resolution).toMatchObject({
      ok: true,
      httpStatus: 200,
      controlHttpStatus: 401,
    });
  });

  it("reports an unsafe Deep Agents projection when credential handling would hide it (#10754)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-unsafe-deepagents-projection-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  const deepAgentsFixture = require("./test/helpers/mcp-bridge-adapter-deepagents-fixture.ts");
  process.env.GITHUB_TOKEN = "Unsafe";
  const credentialCases = [
    {
      name: "unavailable credential observation",
      env: "GITHUB_TOKEN",
      observation: "absent",
    },
    {
      name: "unsupported persisted credential",
      env: "v1_TOKEN",
      observation: "v11",
    },
  ];
  const cases = [
    {
      name: "dangling symbolic link",
      type: "symbolic link",
      config: undefined,
      options: { symlink: true },
    },
    {
      name: "symbolic link",
      type: "symbolic link",
      config: { mcpServers: {} },
      options: { symlink: true },
    },
    {
      name: "FIFO",
      type: "FIFO",
      config: undefined,
      options: { fifo: true, mode: 0o000 },
    },
    {
      name: "directory",
      type: "non-regular file",
      config: undefined,
      options: { directory: true },
    },
  ];
  const outcomes = [];
  for (const credentialCase of credentialCases) {
    registry.updateSandbox("alpha", { agent: "langchain-deepagents-code" });
    Object.assign(sourceEntry, {
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config",
      env: [credentialCase.env],
    });
    providerCredentialObservation = credentialCase.observation;
    for (const fixture of cases) {
      process.exitCode = undefined;
      logLines.length = 0;
      errorLines.length = 0;
      executeAdapterCommand = async (_sandboxName, command) =>
        deepAgentsFixture.runDeepAgentsConfigCommand(
          command,
          fixture.config,
          "v2",
          undefined,
          0o600,
          fixture.options,
        );
      await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github"]);
      outcomes.push({
        credentialCase: credentialCase.name,
        name: fixture.name,
        type: fixture.type,
        exitCode: process.exitCode ?? 0,
        stdout: logLines.join("\n"),
        stderr: errorLines.join("\n"),
      });
    }
  }
  process.exitCode = 0;
  writeHarnessResult(JSON.stringify(outcomes));
`,
    );
    const outcomes = JSON.parse(stdout) as Array<{
      credentialCase: string;
      name: string;
      type: string;
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;

    expect(
      outcomes.map(({ credentialCase, name, exitCode }) => ({
        credentialCase,
        name,
        exitCode,
      })),
    ).toEqual([
      {
        credentialCase: "unavailable credential observation",
        name: "dangling symbolic link",
        exitCode: 2,
      },
      {
        credentialCase: "unavailable credential observation",
        name: "symbolic link",
        exitCode: 2,
      },
      {
        credentialCase: "unavailable credential observation",
        name: "FIFO",
        exitCode: 2,
      },
      {
        credentialCase: "unavailable credential observation",
        name: "directory",
        exitCode: 2,
      },
      {
        credentialCase: "unsupported persisted credential",
        name: "dangling symbolic link",
        exitCode: 2,
      },
      {
        credentialCase: "unsupported persisted credential",
        name: "symbolic link",
        exitCode: 2,
      },
      {
        credentialCase: "unsupported persisted credential",
        name: "FIFO",
        exitCode: 2,
      },
      {
        credentialCase: "unsupported persisted credential",
        name: "directory",
        exitCode: 2,
      },
    ]);
    outcomes.forEach((outcome) => {
      expect(outcome.stdout, outcome.name).toBe("");
      expect(outcome.stderr, outcome.name).toContain(
        `Unsafe Deep Agents native MCP config path: ${outcome.type}`,
      );
      expect(outcome.stderr, outcome.name).not.toContain("adapter does not match");
    });
  });

  it("preserves unsupported-credential status for a regular Deep Agents projection (#10754)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-unsupported-deepagents-credential-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  const deepAgentsFixture = require("./test/helpers/mcp-bridge-adapter-deepagents-fixture.ts");
  registry.updateSandbox("alpha", { agent: "langchain-deepagents-code" });
  Object.assign(sourceEntry, {
    agent: "langchain-deepagents-code",
    adapter: "deepagents-config",
    env: ["v1_TOKEN"],
  });
  let inspected = false;
  executeAdapterCommand = async (_sandboxName, command) => {
    inspected = true;
    return deepAgentsFixture.runDeepAgentsConfigCommand(command, { mcpServers: {} }, "v2");
  };
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({
    inspected,
    exitCode: process.exitCode ?? 0,
    adapter: status.adapter,
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      inspected: boolean;
      exitCode: number;
      adapter: { registered: boolean | null; detail?: string };
    };

    expect(payload).toEqual({
      inspected: true,
      exitCode: 0,
      adapter: {
        registered: null,
        detail:
          "Adapter inspection was skipped because the unsupported legacy credential may still be attached to fresh sandbox children.",
      },
    });
  });

  it("preserves legacy Deep Agents status when credential handling is unavailable (#10754)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-legacy-deepagents-projection-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  const deepAgentsFixture = require("./test/helpers/mcp-bridge-adapter-deepagents-fixture.ts");
  registry.updateSandbox("alpha", { agent: "langchain-deepagents-code" });
  Object.assign(sourceEntry, {
    agent: "langchain-deepagents-code",
    adapter: "deepagents-config",
  });
  providerCredentialObservation = "absent";
  let inspected = false;
  executeAdapterCommand = async (_sandboxName, command) => {
    inspected = true;
    return deepAgentsFixture.runDeepAgentsConfigCommand(
      command,
      undefined,
      "legacy",
      {
        mcpServers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
            },
          },
        },
      },
    );
  };
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({
    inspected,
    exitCode: process.exitCode ?? 0,
    adapter: status.adapter,
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      inspected: boolean;
      exitCode: number;
      adapter: { registered: boolean | null; detail?: string };
    };

    expect(payload).toEqual({
      inspected: true,
      exitCode: 0,
      adapter: {
        registered: null,
        detail:
          "Adapter inspection was skipped because a fresh OpenShell exec did not expose the credential placeholder.",
      },
    });
  });

  it("skips status probe traffic until policy presence and provider readiness are verified (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-readiness-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  const outcomes = [];
  for (const policyState of ["absent", null]) {
    activePolicyState = policyState;
    providerAttachmentState = "attached";
    providerCredentialKey = "GITHUB_TOKEN";
    executedSandboxCommands.length = 0;
    const [status] = await bridge.statusMcpBridge("alpha", "github", {
      probeCredentialResolution: true,
    });
    outcomes.push({
      case: "policy:" + String(policyState),
      policyPresent: status.policy.present,
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
  writeHarnessResult(JSON.stringify(outcomes));
`,
    );
    const outcomes = JSON.parse(stdout) as Array<{
      case: string;
      policyPresent?: boolean | null;
      resolution: { ok: boolean | null; detail?: string };
      probed: boolean;
    }>;
    expect(outcomes).toHaveLength(5);
    expect(outcomes.map((outcome) => outcome.policyPresent).slice(0, 2)).toEqual([false, null]);
    outcomes.forEach((outcome) => {
      expect(outcome.probed, outcome.case).toBe(false);
      expect(outcome.resolution.ok, outcome.case).toBeNull();
      expect(outcome.resolution.detail, outcome.case).toContain("probe skipped");
    });
  });

  it("renders the identical-rejection probe in the human-readable status output (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-render-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github"]);
  writeHarnessResult(JSON.stringify({ lines: logLines }));
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

  it("keeps the status warning for identical 400 explicitly inconclusive (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-400-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({ warnings: status.warnings }));
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

  it("never probes from bare status or list so multi-server views stay fast (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-list-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "--json"]);
  const bareStatus = JSON.parse(logLines.join("\n"));
  logLines.length = 0;
  await bridge.dispatchMcpBridgeCommand("alpha", ["list", "--json"]);
  const list = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({
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

  it("honors --no-probe on a named server and --probe on the multi-server form (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-flags-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--no-probe", "--json"]);
  const skipped = JSON.parse(logLines.join("\n"));
  const probesAfterSkip = executedSandboxCommands.filter((c) => c.includes("NEMOCLAW_MCP_PROBE")).length;
  logLines.length = 0;
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "--probe", "--json"]);
  const forced = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({
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

  it("rejects combining --probe with --no-probe (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-conflict-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--probe", "--no-probe"]);
  const observedExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  writeHarnessResult(JSON.stringify({ errorLines, exitCode: observedExitCode }));
`,
    );
    const payload = JSON.parse(stdout) as { errorLines: string[]; exitCode: number };
    expect(payload.exitCode).toBe(2);
    expect(payload.errorLines.join("\n")).toContain("at most one of --probe / --no-probe");
  });

  it("runs authenticated discovery without duplicating the implicit probe (#6901)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-tools-single-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--tools", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({
    status,
    probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    discovered: executedSandboxCommands.some((c) => c.includes("mcp-tool-discovery-runtime")),
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      status: {
        provider: { credentialResolution?: unknown };
        toolDiscovery: {
          ok: boolean;
          count: number;
          tools: string[];
          truncated: boolean;
          commandStatus: number | null;
        };
      };
      probed: boolean;
      discovered: boolean;
    };
    expect(payload.probed).toBe(false);
    expect(payload.discovered).toBe(true);
    expect(payload.status.provider.credentialResolution).toBeUndefined();
    expect(payload.status.toolDiscovery).toMatchObject({
      ok: true,
      count: 2,
      tools: ["alpha", "zeta"],
      truncated: false,
      commandStatus: 0,
    });
  });

  it("uses recorded trusted-private host for status probes (#11377)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-trusted-private-status-");
    const { stdout } = await runHarness(context, home, TRUSTED_PRIVATE_STATUS_HARNESS, {
      controlHttpStatus: 401,
      probeHttpStatus: 200,
    });
    expectTrustedPrivateStatusResult(stdout);
  });

  it("exits nonzero when a zero-exit runtime reports denied authentication (#10944)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-tools-auth-failure-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  toolDiscoveryResult = {
    protocol: 2,
    ok: false,
    count: 0,
    tools: [],
    truncated: false,
    detail: "MCP endpoint rejected the request (HTTP 401)",
    failedStage: "initialization",
    failureClass: "authentication",
  };
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--tools", "--json"]);
  const observedExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  writeHarnessResult(JSON.stringify({
    observedExitCode,
    status: JSON.parse(logLines.join("\n")),
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      observedExitCode: number;
      status: { toolDiscovery: Record<string, unknown> };
    };
    expect(payload.observedExitCode).toBe(1);
    expect(payload.status.toolDiscovery).toEqual({
      ok: false,
      count: 0,
      tools: [],
      truncated: false,
      commandStatus: 0,
      detail: "MCP endpoint rejected the request (HTTP 401)",
      failedStage: "initialization",
      failureClass: "authentication",
    });
  });

  it("does not accept a successful payload from a nonzero runtime (#10944)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-tools-runtime-failure-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  toolDiscoveryStatus = 7;
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--tools"]);
  const observedExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  writeHarnessResult(JSON.stringify({ observedExitCode, rendered: logLines }));
`,
    );
    const payload = JSON.parse(stdout) as { observedExitCode: number; rendered: string[] };
    expect(payload.observedExitCode).toBe(1);
    expect(payload.rendered.join("\n")).toContain("runtime exit 7");
    expect(payload.rendered.join("\n")).toContain("FAILED");
  });

  it("skips authenticated discovery until provider readiness is verified (#6901)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-tools-provider-readiness-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  activePolicyState = "match";
  const outcomes = [];
  for (const attachmentState of ["absent", "unknown"]) {
    providerInspectionState = "present";
    providerAttachmentState = attachmentState;
    providerCredentialKey = "GITHUB_TOKEN";
    executedSandboxCommands.length = 0;
    const [status] = await bridge.statusMcpBridge("alpha", "github", {
      discoverTools: true,
    });
    outcomes.push({
      case: "attachment:" + attachmentState,
      discovery: status.toolDiscovery,
      discoveryCommands: executedSandboxCommands.filter(
        (command) => command.includes("mcp-tool-discovery-runtime"),
      ).length,
    });
  }
  providerAttachmentState = "attached";
  providerInspectionState = "absent";
  providerCredentialKey = "GITHUB_TOKEN";
  executedSandboxCommands.length = 0;
  const [absentProvider] = await bridge.statusMcpBridge("alpha", "github", {
    discoverTools: true,
  });
  outcomes.push({
    case: "provider:absent",
    discovery: absentProvider.toolDiscovery,
    discoveryCommands: executedSandboxCommands.filter(
      (command) => command.includes("mcp-tool-discovery-runtime"),
    ).length,
  });
  providerInspectionState = "present";
  providerCredentialKey = "WRONG_TOKEN";
  executedSandboxCommands.length = 0;
  const [wrongProvider] = await bridge.statusMcpBridge("alpha", "github", {
    discoverTools: true,
  });
  outcomes.push({
    case: "provider:wrong-shape",
    discovery: wrongProvider.toolDiscovery,
    discoveryCommands: executedSandboxCommands.filter(
      (command) => command.includes("mcp-tool-discovery-runtime"),
    ).length,
  });
  writeHarnessResult(JSON.stringify(outcomes));
`,
    );
    expect(JSON.parse(stdout)).toEqual([
      {
        case: "attachment:absent",
        discovery: {
          ok: false,
          count: 0,
          tools: [],
          truncated: false,
          commandStatus: null,
          detail: "tool discovery skipped: the credential provider is not attached to the sandbox",
          failedStage: "preflight",
          failureClass: "precondition",
        },
        discoveryCommands: 0,
      },
      {
        case: "attachment:unknown",
        discovery: {
          ok: false,
          count: 0,
          tools: [],
          truncated: false,
          commandStatus: null,
          detail: "tool discovery skipped: provider attachment could not be inspected",
          failedStage: "preflight",
          failureClass: "precondition",
        },
        discoveryCommands: 0,
      },
      {
        case: "provider:absent",
        discovery: {
          ok: false,
          count: 0,
          tools: [],
          truncated: false,
          commandStatus: null,
          detail: "tool discovery skipped: provider attachment could not be inspected",
          failedStage: "preflight",
          failureClass: "precondition",
        },
        discoveryCommands: 0,
      },
      {
        case: "provider:wrong-shape",
        discovery: {
          ok: false,
          count: 0,
          tools: [],
          truncated: false,
          commandStatus: null,
          detail:
            "tool discovery skipped: the OpenShell provider is absent or does not match the recorded credential binding",
          failedStage: "preflight",
          failureClass: "precondition",
        },
        discoveryCommands: 0,
      },
    ]);
  });

  it("runs both diagnostics only when --probe is explicit with --tools (#6901)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-tools-explicit-probe-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--tools", "--probe", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({
    hasResolution: !!status.provider.credentialResolution,
    hasDiscovery: !!status.toolDiscovery,
    probeCommands: executedSandboxCommands.filter((c) => c.includes("NEMOCLAW_MCP_PROBE")).length,
    discoveryCommands: executedSandboxCommands.filter((c) => c.includes("mcp-tool-discovery-runtime")).length,
  }));
`,
    );
    expect(JSON.parse(stdout)).toEqual({
      hasResolution: true,
      hasDiscovery: true,
      probeCommands: 1,
      discoveryCommands: 1,
    });
  });

  it("requires a named server for --tools and renders the discovered names (#6901)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-tools-validation-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "--tools"]);
  const rejectedExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  const rejection = [...errorLines];
  errorLines.length = 0;
  logLines.length = 0;
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--tools"]);
  writeHarnessResult(JSON.stringify({ rejectedExitCode, rejection, rendered: logLines }));
`,
    );
    const payload = JSON.parse(stdout) as {
      rejectedExitCode: number;
      rejection: string[];
      rendered: string[];
    };
    expect(payload.rejectedExitCode).toBe(2);
    expect(payload.rejection.join("\n")).toContain("one MCP server name");
    expect(payload.rendered.some((line) => line.includes("tool discovery: successful"))).toBe(true);
    expect(payload.rendered.some((line) => line.includes("alpha"))).toBe(true);
  });
});

describeConcurrentProbeSuite("MCP add post-add credential-resolution probe", () => {
  it("warns loudly on an identical-rejection probe without failing the committed add (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-add-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  const addRestart = require("./src/lib/actions/sandbox/mcp-bridge-add-restart.js");
  addRestart.addMcpBridge = async () => {};
  await bridge.dispatchMcpBridgeCommand("alpha", [
    "add", "github", "--url", "https://api.githubcopilot.com/mcp/", "--env", "GITHUB_TOKEN",
  ]);
  writeHarnessResult(JSON.stringify({
    logLines,
    errorLines,
    probed: executedSandboxCommands.some((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    probeCommand: executedSandboxCommands.find((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    exitCode: process.exitCode ?? 0,
  }));
`,
    );
    const payload = JSON.parse(stdout) as {
      logLines: string[];
      errorLines: string[];
      probed: boolean;
      probeCommand?: string;
      exitCode: number;
    };
    expect(payload.probed).toBe(true);
    expect(payload.probeCommand).toContain("openshell:resolve:env:v11_GITHUB_TOKEN");
    expect(payload.probeCommand).not.toContain("openshell:resolve:env:GITHUB_TOKEN");
    expect(payload.logLines.some((line) => line.includes("MCP server 'github' added"))).toBe(true);
    expect(
      payload.errorLines.some(
        (line) =>
          line.includes("WARNING") && line.includes("Credential resolution could not be verified"),
      ),
    ).toBe(true);
    expect(payload.exitCode).toBe(0);
  });

  it("skips post-add probe traffic when policy presence is absent or unknown (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-add-policy-gate-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  const addRestart = require("./src/lib/actions/sandbox/mcp-bridge-add-restart.js");
  addRestart.addMcpBridge = async () => {};
  const outcomes = [];
  for (const policyState of ["absent", null]) {
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
  writeHarnessResult(JSON.stringify(outcomes));
`,
    );
    const outcomes = JSON.parse(stdout) as Array<{
      policyState: "absent" | null;
      probed: boolean;
      output: string;
      exitCode: number;
    }>;
    expect(outcomes).toHaveLength(2);
    outcomes.forEach((outcome) => {
      expect(outcome.probed, String(outcome.policyState)).toBe(false);
      expect(outcome.output).toContain("Credential resolution probe was inconclusive");
      expect(outcome.output).toContain("probe skipped");
      expect(outcome.exitCode).toBe(0);
    });
  });

  it("keeps the post-add warning for identical 400 explicitly inconclusive (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-add-400-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  const addRestart = require("./src/lib/actions/sandbox/mcp-bridge-add-restart.js");
  addRestart.addMcpBridge = async () => {};
  await bridge.dispatchMcpBridgeCommand("alpha", [
    "add", "github", "--url", "https://api.githubcopilot.com/mcp/", "--env", "GITHUB_TOKEN",
  ]);
  writeHarnessResult(JSON.stringify({ errorLines, exitCode: process.exitCode ?? 0 }));
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

  it("skips the post-add probe when --no-probe is passed (#6379)", async (context) => {
    const home = createTempHome("nemoclaw-mcp-resolution-add-skip-");
    const { stdout } = await runHarness(
      context,
      home,
      String.raw`
  const addRestart = require("./src/lib/actions/sandbox/mcp-bridge-add-restart.js");
  addRestart.addMcpBridge = async () => {};
  await bridge.dispatchMcpBridgeCommand("alpha", [
    "add", "github", "--url", "https://api.githubcopilot.com/mcp/", "--env", "GITHUB_TOKEN", "--no-probe",
  ]);
  writeHarnessResult(JSON.stringify({
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
