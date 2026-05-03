// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
// Import from compiled dist/ so coverage is attributed correctly.
import { printDashboardUi, verifyAgentBinaryAvailable } from "../../dist/lib/agent-onboard";
import type { AgentDefinition } from "./agent-defs";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "agent",
    displayName: "Agent",
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/" },
    configPaths: {
      dir: "/tmp/agent",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
    },
    stateDirs: [],
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
  dashboard: { kind: "api", label: "OpenAI-compatible API", path: "/v1" },
});

const uiAgent = makeAgent({
  name: "ficticious-ui",
  displayName: "Ficticious",
  forwardPort: 19000,
  dashboard: { kind: "ui", label: "UI", path: "/" },
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

describe("handleAgentSetup guards", () => {
  it("fails onboarding instead of completing when the agent binary or health probe is missing", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "agent-onboard.ts"), "utf-8");

    expect(source).toContain("verifyAgentBinaryAvailable");
    expect(source).toContain("AGENT_BINARY_CHECK_PREFIX");
    expect(source).toContain("if [ -x ${shellQuote(binaryPath)} ]; then");
    expect(source).toContain("exit 0");
    expect(source).toContain(".find((line) => line.startsWith(AGENT_BINARY_CHECK_PREFIX))");
    expect(source).toMatch(
      /"sandbox",\s*"exec",\s*"-n",\s*sandboxName,\s*"--",\s*"sh",\s*"-lc",\s*script/,
    );
    expect(source).not.toMatch(/\["sandbox",\s*"exec",\s*sandboxName,\s*"sh"/);
    expect(source).toContain("failAgentSetup");
    expect(source).toContain('onboardSession.markStepFailed("agent_setup"');
    expect(source).toContain("gateway did not respond within");
    expect(source).not.toContain("gateway may still be starting");
  });

  it("accepts Hermes JSON health responses without substring false positives", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "agent-onboard.ts"), "utf-8");

    expect(source).toContain("function isHealthProbeOk");
    expect(source).toContain("JSON.parse(body)");
    expect(source).toContain('parsed.status === "ok"');
    expect(source).not.toContain('.includes("ok")');
  });

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
