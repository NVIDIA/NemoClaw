// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/lib/agent/defs";
import { loadAgent } from "../../src/lib/agent/defs";
import { printDashboardUi } from "../../src/lib/agent/onboard";
import type { OnboardDashboardDeps, OnboardDashboardHelpers } from "../../src/lib/onboard/dashboard";

const { getPortConflictServiceHints } = require("../../src/lib/onboard") as {
  getPortConflictServiceHints: (platform?: string) => string[];
};
const { createOnboardDashboardHelpers } = require("../../src/lib/onboard/dashboard") as {
  createOnboardDashboardHelpers: (deps: OnboardDashboardDeps) => OnboardDashboardHelpers;
};

function createTokenDownloadRunOpenshell() {
  return vi.fn((args: string[], _opts?: Record<string, unknown>) => {
    if (args.join(" ").startsWith("sandbox download ")) {
      const destDir = args[4];
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(
        path.join(destDir, "openclaw.json"),
        JSON.stringify({ gateway: { auth: { token: "secret-token" } } }),
      );
    }
    return { status: 0 };
  });
}

function captureReadySummary(
  agent: AgentDefinition | null,
  { sandboxName, cliName }: { sandboxName: string; cliName: string },
): string {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const helpers = createOnboardDashboardHelpers({
    runOpenshell: createTokenDownloadRunOpenshell(),
    runCaptureOpenshell: vi.fn(() => ""),
    runCapture: vi.fn(() => ""),
    openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
    cliName: () => cliName,
    agentProductName: () => "NemoClaw",
    getProviderLabel: (provider: string) => provider,
    nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
    shouldShowNimLine: vi.fn(() => false),
    note: vi.fn(),
    isWsl: () => false,
    redact: (value: unknown) => String(value),
    sleep: vi.fn(),
    printAgentDashboardUi: vi.fn(),
    listSandboxes: () => ({ sandboxes: [] }),
  });

  try {
    helpers.printDashboard(sandboxName, "gpt-oss:20b", "ollama", null, agent);
    return logSpy.mock.calls.map(([line]) => String(line)).join("\n");
  } finally {
    logSpy.mockRestore();
  }
}

describe("onboard dashboard helpers", () => {
  it("builds a Hermes verification chain with the sandbox's allocated API port (#9290)", () => {
    const getSandbox = vi.fn(() => ({ hermesApiPort: 8643 }));
    const helpers = createOnboardDashboardHelpers({
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell: vi.fn(() => ""),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemohermes",
      agentProductName: () => "NemoHermes",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
      getSandbox,
    });

    expect(
      helpers.buildAgentVerifyChain(
        "http://127.0.0.1:18789",
        "my-hermes",
        loadAgent("hermes"),
      ),
    ).toMatchObject({
      port: 18789,
      dashboardHealthEndpoint: "/api/status",
      gatewayPort: 8643,
      gatewayHealthEndpoint: "/health",
    });
    expect(getSandbox).toHaveBeenCalledWith("my-hermes");
  });

  it("prints platform-appropriate service hints for port conflicts", () => {
    expect(getPortConflictServiceHints("darwin").join("\n")).toMatch(/launchctl unload/);
    expect(getPortConflictServiceHints("darwin").join("\n")).not.toMatch(/systemctl --user/);
    expect(getPortConflictServiceHints("linux").join("\n")).toMatch(
      /systemctl --user stop openclaw-gateway.service/,
    );
  });

  it("launches a direct ForwardTcp service for the allocated dashboard port", () => {
    const launch = vi.fn();
    const helpers = createOnboardDashboardHelpers({
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell: vi.fn(() => ""),
      openshellArgv: (args: string[]) => ["/usr/local/bin/openshell", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
      isPortBoundOnHost: () => false,
      forwardService: {
        executable: () => "/usr/local/bin/openshell",
        launch,
        resolveGatewayName: () => "nemoclaw",
        retireLegacy: vi.fn(() => 0),
      },
    });

    expect(helpers.ensureDashboardForward("my-sandbox")).toBe(18_789);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "my-sandbox",
        localPort: 18_789,
        targetPort: 18_789,
      }),
    );
  });

  it("does not reallocate or adopt an occupied persisted dashboard port", () => {
    const launch = vi.fn();
    const helpers = createOnboardDashboardHelpers({
      runOpenshell: vi.fn(() => ({ status: 0 })),
      runCaptureOpenshell: vi.fn(() => ""),
      openshellArgv: (args: string[]) => ["/usr/local/bin/openshell", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({
        sandboxes: [{ name: "my-sandbox", dashboardPort: 18_789, scopeGatewayPort: 8_080 }],
      }),
      isPortBoundOnHost: () => true,
      forwardService: {
        executable: () => "/usr/local/bin/openshell",
        launch,
        resolveGatewayName: () => "nemoclaw",
        retireLegacy: vi.fn(() => 0),
      },
    });

    expect(() => helpers.ensureDashboardForward("my-sandbox")).toThrow(
      /cannot be reallocated or adopted/u,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("skips dashboard forwarding for terminal agents without declared ports", async () => {
    const runOpenshell = vi.fn((_args: string[], _opts?: Record<string, unknown>) => ({
      status: 0,
    }));
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell: vi.fn(() => ""),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
    });

    expect(
      await helpers.ensureAgentDashboardForward("my-sandbox", {
        runtime: { kind: "terminal" },
        forwardPort: 0,
        forward_ports: [],
      } as never),
    ).toBe(0);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("prints the dashboard-url command instead of raw gateway-token guidance", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const nimStatus = vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" }));
    const shouldShowNimLine = vi.fn(() => false);
    const runOpenshell = createTokenDownloadRunOpenshell();
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => ""),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus,
      shouldShowNimLine,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    let output = "";
    try {
      helpers.printDashboard("my-gpt-claw", "gpt-oss:20b", "ollama");
      output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toContain("NemoClaw is ready");
    expect(output.indexOf("Start chatting")).toBeLessThan(output.indexOf("Manage later"));
    expect(output).toMatch(/Browser:\n\s+https?:\/\/\S+/);
    expect(output).toContain("Authenticated dashboard URL, if needed:");
    expect(output).toContain("nemoclaw my-gpt-claw dashboard-url --quiet");
    expect(output).not.toContain("#token=");
    expect(output).not.toContain("gateway-token --quiet");
    expect(output).not.toContain("append  #token=<token>");
    expect(output).not.toMatch(/secret[-_]?token/);
    expect(output).toContain("nemoclaw credentials reset <PROVIDER> && nemoclaw onboard");
    expect(output).not.toContain("credentials reset <KEY>");
    expect(nimStatus).toHaveBeenCalledWith("my-gpt-claw");
  });

  it("shows the loopback dashboard URL with a WSL host-IP fallback under WSL", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runOpenshell = createTokenDownloadRunOpenshell();
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => "172.22.1.1 10.0.0.2\n"),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
      shouldShowNimLine: vi.fn(() => false),
      note: vi.fn(),
      isWsl: () => true,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    let output = "";
    try {
      helpers.printDashboard("my-gpt-claw", "gpt-oss:20b", "ollama");
      output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toContain("http://127.0.0.1:");
    expect(output).toContain("WSL fallback");
    expect(output).toContain("http://172.22.1.1:");
    // Loopback stays the primary browser URL; the WSL host IP follows it.
    expect(output.indexOf("http://127.0.0.1:")).toBeLessThan(output.indexOf("http://172.22.1.1:"));
    expect(output).not.toMatch(/secret[-_]?token/);
  });

  it("gives the agent dashboard both primary and port-rewritten WSL fallback URLs", () => {
    const runOpenshell = createTokenDownloadRunOpenshell();
    const printAgentDashboardUi = vi.fn();
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => "172.22.1.1 10.0.0.2\n"),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
      shouldShowNimLine: vi.fn(() => false),
      note: vi.fn(),
      isWsl: () => true,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi,
      listSandboxes: () => ({ sandboxes: [] }),
    });
    const agent = { dashboard: { auth: "url_token" } } as never;

    helpers.printDashboard("my-hermes", "gpt-oss:20b", "ollama", null, agent);

    const [, , , agentDeps] = printAgentDashboardUi.mock.calls[0];
    const urls: string[] = agentDeps.buildControlUiUrls("secret-token", 8642);

    expect(urls).toContain("http://127.0.0.1:8642/#token=secret-token");
    expect(urls.some((url) => url.startsWith("http://172.22.1.1:8642/"))).toBe(true);
    expect(urls.some((url) => url.includes(":18789"))).toBe(false);
  });

  it.each<[string, number, () => void]>([
    [
      "NEMOCLAW_DASHBOARD_PORT",
      9120,
      () => {
        process.env.NEMOCLAW_DASHBOARD_PORT = "9120";
      },
    ],
    [
      "--control-ui-port",
      9121,
      () => {
        delete process.env.NEMOCLAW_DASHBOARD_PORT;
      },
    ],
  ])("prints the effective Hermes dashboard URL selected by %s (#6277)", (_source, port, configurePort) => {
    const previousChatUiUrl = process.env.CHAT_UI_URL;
    const previousDashboardPort = process.env.NEMOCLAW_DASHBOARD_PORT;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const helpers = createOnboardDashboardHelpers({
      runOpenshell: vi.fn(() => ({ status: 1 })),
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => ""),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemohermes",
      agentProductName: () => "NemoHermes",
      getProviderLabel: (provider: string) => provider,
      nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
      shouldShowNimLine: vi.fn(() => false),
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: printDashboardUi,
      listSandboxes: () => ({ sandboxes: [] }),
    });

    let output = "";
    try {
      process.env.CHAT_UI_URL = `http://127.0.0.1:${String(port)}`;
      configurePort();
      helpers.printDashboard("my-hermes", "gpt-oss:20b", "ollama", null, loadAgent("hermes"));
      output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    } finally {
      previousChatUiUrl === undefined
        ? delete process.env.CHAT_UI_URL
        : (process.env.CHAT_UI_URL = previousChatUiUrl);
      previousDashboardPort === undefined
        ? delete process.env.NEMOCLAW_DASHBOARD_PORT
        : (process.env.NEMOCLAW_DASHBOARD_PORT = previousDashboardPort);
      logSpy.mockRestore();
    }

    expect(output).toContain("Hermes Agent Dashboard");
    expect(output).toContain(`Port ${String(port)} must be forwarded before opening this URL.`);
    expect(output).toContain(`http://127.0.0.1:${String(port)}/`);
    expect(output).not.toContain("http://127.0.0.1:9119/");
    expect(output).not.toContain("http://127.0.0.1:18789/");
  });

  it("prints a token-free browser URL when the dashboard token is unavailable", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const note = vi.fn();
    const helpers = createOnboardDashboardHelpers({
      runOpenshell: vi.fn(() => ({ status: 1 })),
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => ""),
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
      shouldShowNimLine: vi.fn(() => false),
      note,
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    let output = "";
    try {
      helpers.printDashboard("my-gpt-claw", "gpt-oss:20b", "ollama");
      output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(note).toHaveBeenCalledWith(
      "  Could not read gateway token from the sandbox (download failed).",
    );
    expect(output).toMatch(/Browser:\n\s+https?:\/\/\S+/);
    expect(output).not.toContain("#token=");
    expect(output).not.toContain("dashboard-url --quiet");
    expect(output).toContain("then run the configured interactive agent command");
  });

  it("offers launch first and keeps connect in the OpenClaw ready summary (#6006)", () => {
    const output = captureReadySummary(null, { sandboxName: "my-gpt-claw", cliName: "nemoclaw" });

    expect(output).toContain(
      [
        "    Terminal:",
        "      nemoclaw launch my-gpt-claw",
        "",
        "      Or open a sandbox shell first:",
        "        nemoclaw my-gpt-claw connect",
        "        then run the configured interactive agent command",
      ].join("\n"),
    );
    expect(output.indexOf("nemoclaw launch my-gpt-claw")).toBeLessThan(
      output.indexOf("nemoclaw my-gpt-claw connect"),
    );
  });

  it("prints the Hermes interactive command instead of the OpenClaw TUI (#6006)", () => {
    const output = captureReadySummary(loadAgent("hermes"), {
      sandboxName: "my-hermes",
      cliName: "nemohermes",
    });

    expect(output).toContain(
      [
        "  Terminal:",
        "    nemohermes launch my-hermes",
        "",
        "    Or open a sandbox shell first:",
        "      nemohermes my-hermes connect",
        "      then run the configured interactive agent command",
      ].join("\n"),
    );
    expect(output).not.toContain("openclaw tui");
  });

  it("prints the Deep Agents Code interactive command in the ready summary (#6006)", () => {
    const output = captureReadySummary(loadAgent("langchain-deepagents-code"), {
      sandboxName: "my-dcode",
      cliName: "nemoclaw",
    });

    expect(output).toContain(
      [
        "  Terminal:",
        "    nemoclaw launch my-dcode",
        "",
        "    Or open a sandbox shell first:",
        "      nemoclaw my-dcode connect",
        "      then run the configured interactive agent command",
      ].join("\n"),
    );
    expect(output).not.toContain("openclaw tui");
  });
});
