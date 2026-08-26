// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// The ready summary resolves the sandbox's API port from the registry. Stub the
// lookup so these unit tests never read the developer's real state file.
const getSandboxMock = vi.hoisted(() =>
  vi.fn((): { hermesApiPort?: number | null } | null => null),
);
vi.mock("../state/registry", () => ({ getSandbox: getSandboxMock }));

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run: mocks.run,
}));

import { sandboxConfigSyncArgs } from "../onboard/config-sync";
import type { AgentDefinition } from "./defs";
// Import source directly so tests cannot pass against a stale build.
import {
  collectHermesStartupDiagnostics,
  handleAgentSetup,
  type OnboardContext,
  printDashboardUi,
  verifyAgentBinaryAvailable,
} from "./onboard";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "agent",
    displayName: "Agent",
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/", healthPath: "/health", auth: "url_token" },
    webAuth: { method: "none", env: null },
    configPaths: {
      dir: "/tmp/agent",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
      shieldsFiles: [],
    },
    inferenceProviderOptions: [],
    mcpCapability: {
      support: "disabled",
      reason: "test fixture",
    },
    stateDirectories: [],
    stateDirs: [],
    stateDirPrefixes: [],
    backupStateDirs: [],
    backupStateDirPrefixes: [],
    nonBackupStateDirs: [],
    nonBackupStateDirPrefixes: [],
    stateLockPlan: {
      version: 1,
      readOnlyRoots: [],
      confidentialRoots: [],
      readOnlyPrefixes: [],
      confidentialPrefixes: [],
      writableSubpaths: [],
    },
    stateLockPlanInImage: false,
    stateFiles: [],
    userManagedFiles: [],
    versionCommand: "agent --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    dockerfileBasePath: null,
    dockerfilePath: null,
    startScriptPath: null,
    policyAdditionsPath: null,
    policyPermissivePath: null,
    pluginDir: null,
    legacyPaths: null,
    agentDir: "/tmp/agent",
    manifestPath: "/tmp/agent/manifest.yaml",
    ...overrides,
  };
}

const apiAgent = makeAgent({
  name: "hermes",
  displayName: "Hermes Agent",
  forwardPort: 8642,
  dashboard: {
    kind: "api",
    label: "OpenAI-compatible API",
    path: "/v1",
    healthPath: "/health",
    auth: "none",
  },
  dashboardUi: {
    label: "Web dashboard",
    port: 9119,
    path: "/",
    enableEnv: "NEMOCLAW_HERMES_DASHBOARD",
    portEnv: "NEMOCLAW_HERMES_DASHBOARD_PORT",
    tuiEnv: "NEMOCLAW_HERMES_DASHBOARD_TUI",
  },
});

const uiAgent = makeAgent({
  name: "ficticious-ui",
  displayName: "Ficticious",
  forwardPort: 19000,
  dashboard: { kind: "ui", label: "UI", path: "/", healthPath: "/health", auth: "url_token" },
});

const sessionAuthUiAgent = makeAgent({
  name: "hermes",
  displayName: "Hermes Agent",
  forwardPort: 18789,
  dashboard: {
    kind: "ui",
    label: "Dashboard",
    path: "/",
    healthPath: "/api/status",
    auth: "session",
  },
});

// Regression fixture for issue #2078 — matches the text a user sees when
// no token is available and prevents the wording from regressing to
// something that implies port 8642 is a browser UI.
const buildUrlsLoopback = (token: string | null, port: number): string[] => {
  const hash = token ? `#token=${token}` : "";
  return [`http://127.0.0.1:${port}/${hash}`];
};

describe("printDashboardUi with port 8642 outside the chat UI (#2078)", () => {
  let logSpy: MockInstance<typeof console.log>;
  const noteSpy = vi.fn();

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    noteSpy.mockReset();
    getSandboxMock.mockReturnValue(null);
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.NEMOCLAW_HERMES_DASHBOARD;
    delete process.env.NEMOCLAW_HERMES_DASHBOARD_PORT;
  });

  it("labels an API-kind agent as the API — not a UI — and does not embed a token in the URL", () => {
    printDashboardUi("sandbox-x", "secret-token", apiAgent, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Hermes Agent OpenAI-compatible API");
    expect(output).not.toContain("UI (tokenized URL");
    expect(output).toContain("Port 8642 must be forwarded before connecting.");
    expect(output).toContain("http://127.0.0.1:8642/v1");
    // Token-in-URL-fragment auth does not apply to the OpenAI API endpoint.
    expect(output).not.toContain("#token=secret-token");
  });

  it("prints the API URL consistently whether or not a gateway token was read", () => {
    printDashboardUi("sandbox-x", null, apiAgent, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Hermes Agent OpenAI-compatible API");
    expect(output).toContain("http://127.0.0.1:8642/v1");
    // The API endpoint does not require the gateway token — don't confuse
    // the user with the OpenClaw-style "token missing" warning.
    expect(noteSpy).not.toHaveBeenCalled();
  });

  it("prints the optional Hermes web dashboard URL when dashboard mode is enabled", () => {
    process.env.NEMOCLAW_HERMES_DASHBOARD = "1";

    printDashboardUi("sandbox-x", null, apiAgent, {
      note: noteSpy,
      effectiveDashboardPort: 9120,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Hermes Agent OpenAI-compatible API");
    expect(output).toContain("http://127.0.0.1:8642/v1");
    expect(output).toContain("Hermes Agent Web dashboard");
    expect(output).toContain("Port 9120 must be forwarded before opening this URL.");
    expect(output).toContain("http://127.0.0.1:9120/");
  });

  it("falls back to the manifest dashboard port for privileged env override ports", () => {
    process.env.NEMOCLAW_HERMES_DASHBOARD = "1";
    process.env.NEMOCLAW_HERMES_DASHBOARD_PORT = "1023";

    printDashboardUi("sandbox-x", null, apiAgent, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Port 9119 must be forwarded before opening this URL.");
    expect(output).toContain("http://127.0.0.1:9119/");
    expect(output).not.toContain("http://127.0.0.1:1023/");
  });

  it("does not request an OpenClaw gateway token for session-authenticated dashboards", () => {
    printDashboardUi("sandbox-z", null, sessionAuthUiAgent, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Hermes Agent Dashboard");
    expect(output).toContain("Port 18789 must be forwarded before opening this URL.");
    expect(output).toContain("http://127.0.0.1:18789/");
    expect(output).not.toContain("gateway-token");
    expect(noteSpy).not.toHaveBeenCalled();
  });

  it("uses the effective Hermes dashboard port while preserving the secondary API (#6277)", () => {
    const hermesShipped = makeAgent({
      name: "hermes",
      displayName: "Hermes Agent",
      forwardPort: 18789,
      forward_ports: [18789, 8642],
      healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 90 },
      dashboard: {
        kind: "ui",
        label: "Dashboard",
        path: "/",
        healthPath: "/api/status",
        auth: "session",
      },
    });

    printDashboardUi("hermes-box", null, hermesShipped, {
      note: noteSpy,
      effectiveDashboardPort: 9121,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Hermes Agent Dashboard");
    expect(output).toContain("Port 9121 must be forwarded before opening this URL.");
    expect(output).toContain("http://127.0.0.1:9121/");
    expect(output).not.toContain("http://127.0.0.1:18789/");
    expect(output).toContain("Hermes Agent OpenAI-compatible API");
    expect(output).toContain("Port 8642 must be forwarded before connecting.");
    expect(output).toContain("http://127.0.0.1:8642/v1");
  });

  it("labels a non-health-probe secondary forward port as 'additional port' rooted at /", () => {
    const dualAgent = makeAgent({
      name: "experimental",
      displayName: "Experimental",
      forwardPort: 18789,
      forward_ports: [18789, 9100],
      healthProbe: { url: "http://localhost:18789/health", port: 18789, timeout_seconds: 30 },
      dashboard: {
        kind: "ui",
        label: "Dashboard",
        path: "/",
        healthPath: "/health",
        auth: "session",
      },
    });

    printDashboardUi("agent-box", null, dualAgent, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Experimental additional port");
    expect(output).toContain("Port 9100 must be forwarded before connecting.");
    expect(output).toContain("http://127.0.0.1:9100/");
    expect(output).not.toContain("OpenAI-compatible API");
    expect(output).not.toContain("http://127.0.0.1:9100/v1");
  });

  it("redacts tokenized URLs for UI-kind agents and shows the token retrieval command", () => {
    const token = "a".repeat(64);
    printDashboardUi("sandbox-y", token, uiAgent, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Ficticious UI (auth token redacted from displayed URLs)");
    expect(output).toContain("Port 19000 must be forwarded before opening this URL.");
    expect(output).toContain("http://127.0.0.1:19000/");
    expect(output).toContain("Token: nemoclaw sandbox-y gateway-token --quiet");
    expect(output).not.toContain("http://127.0.0.1:19000/#token=");
    expect(output).not.toContain(token);
  });
});

describe("agent setup session boundaries", () => {
  function createAgentSetupContext(
    runCaptureOpenshell: OnboardContext["runCaptureOpenshell"] = vi.fn(() => ""),
    timing: Pick<OnboardContext, "now" | "sleepSeconds"> = {},
    policyRequirements: Pick<OnboardContext, "revalidatePolicyRequirements"> = {},
  ) {
    return {
      context: {
        step: vi.fn(),
        runCaptureOpenshell,
        openshellShellCommand: vi.fn(() => "openshell sandbox connect sandbox-x"),
        openshellBinary: "/usr/bin/openshell",
        startRecordedStep: vi.fn(async () => undefined),
        recordStepComplete: vi.fn(async () => undefined),
        recordStepFailed: vi.fn(async () => undefined),
        skippedStepMessage: vi.fn(),
        ...timing,
        ...policyRequirements,
      },
    };
  }

  beforeEach(() => {
    getSandboxMock.mockReset();
    getSandboxMock.mockReturnValue(null);
  });

  afterEach(() => {
    mocks.run.mockReset();
    vi.restoreAllMocks();
  });

  it("records resume success through the supplied completion boundary", async () => {
    const runCaptureOpenshell = vi.fn(() => "ok");
    const { context } = createAgentSetupContext(runCaptureOpenshell);
    const agent = makeAgent();

    await handleAgentSetup("sandbox-x", "model-x", "provider-x", agent, true, null, context);

    expect(context.skippedStepMessage).toHaveBeenCalledWith("agent_setup", "sandbox-x");
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "sandbox-x",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.startRecordedStep).not.toHaveBeenCalled();
    expect(context.recordStepFailed).not.toHaveBeenCalled();
  });

  it("records fresh setup success through the supplied completion boundary", async () => {
    const runCaptureOpenshell = vi.fn(() => "NEMOCLAW_AGENT_BINARY_CHECK:ok");
    const { context } = createAgentSetupContext(runCaptureOpenshell);
    const agent = makeAgent({ healthProbe: { url: "", port: 0, timeout_seconds: 0 } });

    await handleAgentSetup("sandbox-x", "model-x", "provider-x", agent, false, null, context);

    expect(context.startRecordedStep).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "sandbox-x",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "sandbox-x",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepFailed).not.toHaveBeenCalled();
  });

  it("writes non-default agent configuration through noninteractive sandbox exec", async () => {
    const runCaptureOpenshell = vi.fn(() => "NEMOCLAW_AGENT_BINARY_CHECK:ok");
    const { context } = createAgentSetupContext(runCaptureOpenshell);
    const agent = makeAgent({
      name: "hermes",
      healthProbe: { url: "", port: 0, timeout_seconds: 0 },
    });

    await handleAgentSetup("sandbox-x", "meta-llama", "vllm-local", agent, false, null, context);

    expect(mocks.run).toHaveBeenCalledTimes(1);
    const [args, options] = mocks.run.mock.calls[0];
    expect(args).toEqual(["/usr/bin/openshell", ...sandboxConfigSyncArgs("sandbox-x")]);
    expect(options).toMatchObject({
      input: expect.any(String),
      stdio: ["pipe", "ignore", "inherit"],
    });
    expect(options.input).toContain('"provider": "vllm-local"');
    expect(options.input).toContain('"model": "meta-llama"');
    expect(options.input).toContain('"agent": "hermes"');
  });

  it("retries a configured gateway probe through the supplied scheduler", async () => {
    let nowMs = 0;
    const sleepSeconds = vi.fn((seconds: number) => {
      nowMs += seconds * 1000;
    });
    const runCaptureOpenshell = vi
      .fn<OnboardContext["runCaptureOpenshell"]>(() => "ok")
      .mockReturnValueOnce("NEMOCLAW_AGENT_BINARY_CHECK:ok")
      .mockReturnValueOnce("");
    const { context } = createAgentSetupContext(runCaptureOpenshell, {
      now: () => nowMs,
      sleepSeconds,
    });

    await handleAgentSetup(
      "sandbox-x",
      "model-x",
      "provider-x",
      makeAgent({
        healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 1 },
      }),
      false,
      null,
      context,
    );

    expect(runCaptureOpenshell.mock.calls.filter(([args]) => args.includes("curl"))).toHaveLength(
      2,
    );
    expect(sleepSeconds).toHaveBeenCalledWith(0.25);
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "sandbox-x",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepFailed).not.toHaveBeenCalled();
  });

  it("refuses completion when policy authority changes during the gateway wait (#9833)", async () => {
    let nowMs = 0;
    const sleepSeconds = vi.fn((seconds: number) => {
      nowMs += seconds * 1000;
    });
    const runCaptureOpenshell = vi
      .fn<OnboardContext["runCaptureOpenshell"]>(() => "ok")
      .mockReturnValueOnce("NEMOCLAW_AGENT_BINARY_CHECK:ok")
      .mockReturnValueOnce("");
    const refuseCompletion = () => {
      throw new Error("policy authority changed");
    };
    const policyChecks = new Map([
      ["record completed agent setup for sandbox 'sandbox-x'", refuseCompletion],
    ]);
    const revalidatePolicyRequirements = vi.fn((operation: string) =>
      policyChecks.get(operation)?.(),
    );
    const { context } = createAgentSetupContext(
      runCaptureOpenshell,
      { now: () => nowMs, sleepSeconds },
      { revalidatePolicyRequirements },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      handleAgentSetup(
        "sandbox-x",
        "model-x",
        "provider-x",
        makeAgent({
          healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 1 },
        }),
        false,
        null,
        context,
      ),
    ).rejects.toThrow("policy authority changed");

    expect(sleepSeconds).toHaveBeenCalledWith(0.25);
    expect(context.recordStepComplete).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("gateway is healthy");
  });

  it("records gateway failure when the configured deadline expires", async () => {
    let nowMs = 0;
    const sleepSeconds = vi.fn((seconds: number) => {
      nowMs += seconds * 1000;
    });
    const runCaptureOpenshell = vi
      .fn<OnboardContext["runCaptureOpenshell"]>(() => "")
      .mockReturnValueOnce("NEMOCLAW_AGENT_BINARY_CHECK:ok");
    const { context } = createAgentSetupContext(runCaptureOpenshell, {
      now: () => nowMs,
      sleepSeconds,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);

    await expect(
      handleAgentSetup(
        "sandbox-x",
        "model-x",
        "provider-x",
        makeAgent({
          healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 1 },
        }),
        false,
        null,
        context,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(
      runCaptureOpenshell.mock.calls.filter(([args]) => args.includes("curl")).length,
    ).toBeGreaterThan(1);
    expect(sleepSeconds).toHaveBeenCalledWith(0.25);
    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      "Agent gateway did not respond within 1s",
    );
    expect(context.recordStepComplete).not.toHaveBeenCalled();
  });

  // The manifest names 8642; a second sandbox is allocated its own port (#9739).
  const hermesProbeAgent = makeAgent({
    name: "hermes",
    displayName: "Hermes Agent",
    healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 1 },
  });

  function probeUrlsFrom(
    runCaptureOpenshell: ReturnType<typeof vi.fn<OnboardContext["runCaptureOpenshell"]>>,
  ): string[] {
    return runCaptureOpenshell.mock.calls
      .map(([args]) => args)
      .filter((args) => args.includes("curl"))
      .map((args) => String(args[args.length - 1]));
  }

  it("probes the sandbox's own Hermes API port instead of the manifest default (#9739)", async () => {
    getSandboxMock.mockReturnValue({ hermesApiPort: 8643 });
    const runCaptureOpenshell = vi
      .fn<OnboardContext["runCaptureOpenshell"]>(() => "ok")
      .mockReturnValueOnce("NEMOCLAW_AGENT_BINARY_CHECK:ok");
    const { context } = createAgentSetupContext(runCaptureOpenshell);

    await handleAgentSetup(
      "hermes-core-test",
      "model-x",
      "provider-x",
      hermesProbeAgent,
      false,
      null,
      context,
    );

    expect(probeUrlsFrom(runCaptureOpenshell)).toEqual(["http://localhost:8643/health"]);
    expect(context.recordStepFailed).not.toHaveBeenCalled();
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "hermes-core-test",
      provider: "provider-x",
      model: "model-x",
    });
  });

  it("keeps the manifest probe port for a sandbox that owns the default API port (#9739)", async () => {
    getSandboxMock.mockReturnValue({ hermesApiPort: 8642 });
    const runCaptureOpenshell = vi
      .fn<OnboardContext["runCaptureOpenshell"]>(() => "ok")
      .mockReturnValueOnce("NEMOCLAW_AGENT_BINARY_CHECK:ok");
    const { context } = createAgentSetupContext(runCaptureOpenshell);

    await handleAgentSetup(
      "hermes-first",
      "model-x",
      "provider-x",
      hermesProbeAgent,
      false,
      null,
      context,
    );

    expect(probeUrlsFrom(runCaptureOpenshell)).toEqual(["http://localhost:8642/health"]);
    expect(context.recordStepFailed).not.toHaveBeenCalled();
  });

  it("leaves a non-Hermes probe URL on its manifest port when the registry records a Hermes API port (#9739)", async () => {
    getSandboxMock.mockReturnValue({ hermesApiPort: 8643 });
    const runCaptureOpenshell = vi
      .fn<OnboardContext["runCaptureOpenshell"]>(() => "ok")
      .mockReturnValueOnce("NEMOCLAW_AGENT_BINARY_CHECK:ok");
    const { context } = createAgentSetupContext(runCaptureOpenshell);

    await handleAgentSetup(
      "not-hermes",
      "model-x",
      "provider-x",
      makeAgent({
        healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 1 },
      }),
      false,
      null,
      context,
    );

    expect(probeUrlsFrom(runCaptureOpenshell)).toEqual(["http://localhost:8642/health"]);
    expect(context.recordStepFailed).not.toHaveBeenCalled();
  });

  it("retargets the resume health probe at the sandbox's own API port (#9739)", async () => {
    getSandboxMock.mockReturnValue({ hermesApiPort: 8643 });
    const runCaptureOpenshell = vi.fn<OnboardContext["runCaptureOpenshell"]>(() => "ok");
    const { context } = createAgentSetupContext(runCaptureOpenshell);

    await handleAgentSetup(
      "hermes-core-test",
      "model-x",
      "provider-x",
      hermesProbeAgent,
      true,
      null,
      context,
    );

    expect(probeUrlsFrom(runCaptureOpenshell)).toEqual(["http://localhost:8643/health"]);
    expect(context.skippedStepMessage).toHaveBeenCalledWith("agent_setup", "hermes-core-test");
    expect(context.startRecordedStep).not.toHaveBeenCalled();
  });
});

describe("handleAgentSetup guards", () => {
  it("accepts an executable configured binary path when PATH lookup is empty", () => {
    let script = "";
    const result = verifyAgentBinaryAvailable(
      "alpha",
      makeAgent({ name: "hermes", binary_path: "/usr/local/bin/hermes" }),
      (args) => {
        script = String(args[7] || "");
        return "openshell noise\nNEMOCLAW_AGENT_BINARY_CHECK:ok";
      },
    );

    expect(result).toEqual({ available: true });
    expect(script).toContain("if [ -x '/usr/local/bin/hermes' ]; then");
    expect(script).toContain("NEMOCLAW_AGENT_BINARY_CHECK:ok");
  });

  it("does not reject a configured binary when PATH resolves the symlink target", () => {
    let script = "";
    const result = verifyAgentBinaryAvailable(
      "alpha",
      makeAgent({ name: "hermes", binary_path: "/usr/local/bin/hermes" }),
      (args) => {
        script = String(args[7] || "");
        return "openshell noise\nNEMOCLAW_AGENT_BINARY_CHECK:ok";
      },
    );

    expect(result).toEqual({ available: true });
    expect(script).toContain("NEMOCLAW_AGENT_BINARY_CHECK:ok");
  });

  it("reports a configured binary path that exists but is not executable", () => {
    let script = "";
    const result = verifyAgentBinaryAvailable(
      "alpha",
      makeAgent({ name: "hermes", binary_path: "/usr/local/bin/hermes" }),
      (args) => {
        script = String(args[7] || "");
        return "openshell noise\nNEMOCLAW_AGENT_BINARY_CHECK:not_executable";
      },
    );

    expect(result).toEqual({
      available: false,
      reason: "not_executable",
      binaryPath: "/usr/local/bin/hermes",
    });
    expect(script).toContain("[ -e '/usr/local/bin/hermes' ] && [ ! -x '/usr/local/bin/hermes' ]");
  });
});

describe("collectHermesStartupDiagnostics", () => {
  it("includes Tirith marker content and binary state when the marker is present", () => {
    const runCapture = vi.fn(() =>
      [
        "tirith marker: download_failed",
        "tirith binary: missing (/sandbox/.hermes/bin/tirith)",
        "--- tail: /tmp/nemoclaw-start.log ---",
        "[tirith-bootstrap] Retrying Tirith install after download_failed marker",
      ].join("\n"),
    );

    const diagnostics = collectHermesStartupDiagnostics("alpha", runCapture);

    expect(runCapture).toHaveBeenCalledWith(
      [
        "sandbox",
        "exec",
        "-n",
        "alpha",
        "--",
        "sh",
        "-lc",
        expect.stringContaining("/sandbox/.hermes/.tirith-install-failed"),
      ],
      { ignoreError: true },
    );
    expect(diagnostics.join("\n")).toContain("Hermes startup diagnostics:");
    expect(diagnostics.join("\n")).toContain("tirith marker: download_failed");
    expect(diagnostics.join("\n")).toContain(
      "tirith binary: missing (/sandbox/.hermes/bin/tirith)",
    );
  });

  it("returns no extra lines when the Tirith marker is absent", () => {
    const runCapture = vi.fn(() => "tirith marker: absent\n");

    expect(collectHermesStartupDiagnostics("alpha", runCapture)).toEqual([]);
  });

  it("redacts sensitive values from log tails", () => {
    const slackToken = ["xoxb", "123456789012", "abcdefghijkl"].join("-");
    const runCapture = vi.fn(() =>
      [
        "tirith marker: download_failed",
        "tirith binary: present but not executable (/sandbox/.hermes/bin/tirith)",
        "--- tail: /tmp/gateway.log ---",
        `SLACK_BOT_TOKEN=${slackToken}`,
      ].join("\n"),
    );

    const output = collectHermesStartupDiagnostics("alpha", runCapture).join("\n");

    expect(output).toContain("SLACK_BOT_TOKEN=");
    expect(output).not.toContain(slackToken);
  });
});

describe("printDashboardUi announces per-sandbox Hermes API ports (#8543)", () => {
  let logSpy: MockInstance<typeof console.log>;
  const noteSpy = vi.fn();

  const hermesShipped = makeAgent({
    name: "hermes",
    displayName: "Hermes Agent",
    forwardPort: 18789,
    forward_ports: [18789, 8642],
    healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 90 },
    dashboard: {
      kind: "ui",
      label: "Dashboard",
      path: "/",
      healthPath: "/api/status",
      auth: "session",
    },
  });

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    noteSpy.mockReset();
    getSandboxMock.mockReturnValue(null);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("announces the sandbox's own API port instead of the manifest default", () => {
    getSandboxMock.mockReturnValue({ hermesApiPort: 8643 });

    printDashboardUi("hermes-clone", null, hermesShipped, {
      note: noteSpy,
      effectiveDashboardPort: 18790,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Port 8643 must be forwarded before connecting.");
    expect(output).toContain("http://127.0.0.1:8643/v1");
    expect(output).not.toContain("Port 8642 must be forwarded before connecting.");
  });

  it("announces the sandbox's own API port from an API-kind dashboard", () => {
    const hermesApiDashboard = makeAgent({
      name: "hermes",
      displayName: "Hermes Agent",
      forwardPort: 18789,
      forward_ports: [18789, 8642],
      healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 90 },
      dashboard: {
        kind: "api",
        label: "OpenAI-compatible API",
        path: "/v1",
        healthPath: "/health",
        auth: "none",
      },
    });
    getSandboxMock.mockReturnValue({ hermesApiPort: 8645 });

    printDashboardUi("hermes-api-box", null, hermesApiDashboard, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Hermes Agent OpenAI-compatible API");
    expect(output).toContain("Port 8645 must be forwarded before connecting.");
    expect(output).toContain("http://127.0.0.1:8645/");
    expect(output).not.toContain("http://127.0.0.1:8642/");
  });

  it("keeps the declared port for an agent that has no per-sandbox API port", () => {
    getSandboxMock.mockReturnValue({ hermesApiPort: 8643 });
    const dualAgent = makeAgent({
      name: "experimental",
      displayName: "Experimental",
      forwardPort: 18789,
      forward_ports: [18789, 9100],
      healthProbe: { url: "http://localhost:9100/health", port: 9100, timeout_seconds: 30 },
    });

    printDashboardUi("other-box", null, dualAgent, {
      note: noteSpy,
      effectiveDashboardPort: 18790,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Port 9100 must be forwarded before connecting.");
    expect(output).not.toContain("8643");
  });
});
