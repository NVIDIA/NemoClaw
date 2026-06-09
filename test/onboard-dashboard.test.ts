// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OnboardDashboardDeps, OnboardDashboardHelpers } from "../src/lib/onboard/dashboard";

const { getPortConflictServiceHints } = require("../dist/lib/onboard") as {
  getPortConflictServiceHints: (platform?: string) => string[];
};
const { createOnboardDashboardHelpers } = require("../dist/lib/onboard/dashboard") as {
  createOnboardDashboardHelpers: (deps: OnboardDashboardDeps) => OnboardDashboardHelpers;
};

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

  it("prints the dashboard-url command instead of raw gateway-token guidance", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const nimStatus = vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" }));
    const shouldShowNimLine = vi.fn(() => false);
    const runOpenshell = vi.fn((args: string[], _opts?: Record<string, unknown>) => {
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
