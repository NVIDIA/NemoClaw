// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  collectHermesStartupDiagnostics,
  handleAgentSetup,
  printDashboardUi,
  verifyAgentBinaryAvailable,
} from "../../../dist/lib/agent/onboard";
import type { AgentDefinition } from "./defs";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "agent",
    displayName: "Agent",
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/", healthPath: "/health", auth: "url_token" },
    configPaths: {
      dir: "/tmp/agent",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
    },
    inferenceProviderOptions: [],
    stateDirs: [],
    stateFiles: [],
    versionCommand: "agent --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    messagingPlatforms: [],
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

describe("printDashboardUi — regression for #2078 (port 8642 is not a chat UI)", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const noteSpy = vi.fn();

  beforeEach(() => {
    logSpy.mockClear();
    noteSpy.mockReset();
  });

  afterEach(() => {
    logSpy.mockClear();
    delete process.env.NEMOCLAW_HERMES_DASHBOARD;
    delete process.env.NEMOCLAW_HERMES_DASHBOARD_PORT;
  });

  afterAll(() => {
    logSpy.mockRestore();
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
    process.env.NEMOCLAW_HERMES_DASHBOARD_PORT = "9120";

    printDashboardUi("sandbox-x", null, apiAgent, {
      note: noteSpy,
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
  function createAgentSetupContext(runCaptureOpenshell = vi.fn(() => "")) {
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
      },
    };
  }

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
