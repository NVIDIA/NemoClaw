// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadAgent } from "../src/lib/agent/defs";
import { printDashboardUi } from "../src/lib/agent/onboard";
import type { OnboardDashboardDeps, OnboardDashboardHelpers } from "../src/lib/onboard/dashboard";

const { getPortConflictServiceHints } = require("../src/lib/onboard") as {
  getPortConflictServiceHints: (platform?: string) => string[];
};
const { createOnboardDashboardHelpers } = require("../src/lib/onboard/dashboard") as {
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

describe("onboard dashboard helpers", () => {
  it("prints platform-appropriate service hints for port conflicts", () => {
    expect(getPortConflictServiceHints("darwin").join("\n")).toMatch(/launchctl unload/);
    expect(getPortConflictServiceHints("darwin").join("\n")).not.toMatch(/systemctl --user/);
    expect(getPortConflictServiceHints("linux").join("\n")).toMatch(
      /systemctl --user stop openclaw-gateway.service/,
    );
  });

  it("uses sandbox-scoped forward stops for same-sandbox dashboard cleanup", () => {
    const forwardList =
      "SANDBOX BIND PORT PID STATUS\n" +
      "my-sandbox 127.0.0.1 18789 12345 running\n" +
      "my-sandbox 127.0.0.1 19000 12346 running";
    const runOpenshell = vi.fn((_args: string[], _opts?: Record<string, unknown>) => ({
      status: 0,
    }));
    const runCaptureOpenshell = vi.fn((args: string[], _opts?: Record<string, unknown>) =>
      args.join(" ") === "forward list" ? forwardList : "",
    );
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell,
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    expect(helpers.ensureDashboardForward("my-sandbox", "http://127.0.0.1:18789")).toBe(18789);

    const stopArgs = runOpenshell.mock.calls.map(([args]) => args);
    expect(stopArgs).toContainEqual(["forward", "stop", "18789", "my-sandbox"]);
    expect(stopArgs).toContainEqual(["forward", "stop", "19000", "my-sandbox"]);
    expect(
      stopArgs.some(
        (args) =>
          Array.isArray(args) && args[0] === "forward" && args[1] === "stop" && args.length === 3,
      ),
    ).toBe(false);
  });

  it("retries dashboard forward cleanup when the first owner lookup fails", () => {
    const forwardList =
      "SANDBOX BIND PORT PID STATUS\n" + "my-sandbox 127.0.0.1 18789 12345 running";
    const runOpenshell = vi.fn((_args: string[], _opts?: Record<string, unknown>) => ({
      status: 0,
    }));
    let ownerLookupCount = 0;
    const runCaptureOpenshell = vi.fn((args: string[], opts?: Record<string, unknown>) => {
      if (args.join(" ") !== "forward list") return "";
      if (opts && "timeout" in opts) {
        ownerLookupCount += 1;
        if (ownerLookupCount === 1) throw new Error("gateway timed out");
      }
      return forwardList;
    });
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell,
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    expect(helpers.ensureDashboardForward("my-sandbox", "http://127.0.0.1:18789")).toBe(18789);

    expect(ownerLookupCount).toBeGreaterThanOrEqual(2);
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789", "my-sandbox"], {
      ignoreError: true,
      suppressOutput: true,
    });
  });

  it("starts declared non-dashboard agent port forwards without cleaning up the dashboard forward", () => {
    const forwardList =
      "SANDBOX BIND PORT PID STATUS\n" +
      "my-sandbox 127.0.0.1 18789 12345 running\n" +
      "my-sandbox 127.0.0.1 8642 12346 running";
    const runOpenshell = vi.fn((_args: string[], _opts?: Record<string, unknown>) => ({
      status: 0,
    }));
    const runCaptureOpenshell = vi.fn((args: string[], _opts?: Record<string, unknown>) =>
      args.join(" ") === "forward list" ? forwardList : "",
    );
    const helpers = createOnboardDashboardHelpers({
      runOpenshell,
      runCaptureOpenshell,
      openshellArgv: (args: string[]) => [process.execPath, "-e", "", ...args],
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    expect(
      helpers.ensureAgentDashboardForward("my-sandbox", {
        forwardPort: 18789,
        forward_ports: [18789, 8642],
      }),
    ).toBe(18789);

    const stopArgs = runOpenshell.mock.calls.map(([args]) => args);
    expect(stopArgs).toContainEqual(["forward", "stop", "18789", "my-sandbox"]);
    expect(stopArgs).toContainEqual(["forward", "stop", "8642", "my-sandbox"]);
    expect(
      stopArgs.filter((args) => args.join(" ") === "forward stop 18789 my-sandbox"),
    ).toHaveLength(1);
  });

  it("skips dashboard forwarding for terminal agents without declared ports", () => {
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
      helpers.ensureAgentDashboardForward("my-sandbox", {
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
    expect(output).toContain("then run: openclaw tui");
  });
});
