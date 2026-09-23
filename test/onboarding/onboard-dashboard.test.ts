// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/lib/agent/defs";
import { loadAgent } from "../../src/lib/agent/defs";
import { printDashboardUi } from "../../src/lib/agent/onboard";
import type {
  OpenShellSandboxTransferExecutor,
  OpenShellSandboxTransferOutcome,
  OpenShellSandboxTransferRequest,
} from "../../src/lib/adapters/openshell/sandbox-transfer";
import type {
  OnboardDashboardDeps,
  OnboardDashboardHelpers,
} from "../../src/lib/onboard/dashboard";

const { createOnboardDashboardHelpers } = require("../../src/lib/onboard/dashboard") as {
  createOnboardDashboardHelpers: (deps: OnboardDashboardDeps) => OnboardDashboardHelpers;
};

function createTokenDownloadTransferExecutor(
  outcome: OpenShellSandboxTransferOutcome = { kind: "completed", exitCode: 0 },
): OpenShellSandboxTransferExecutor {
  return {
    run: vi.fn(async (request) => {
      if (outcome.kind === "completed" && outcome.exitCode === 0) {
        fs.mkdirSync(request.destination, { recursive: true });
        fs.writeFileSync(
          path.join(request.destination, "openclaw.json"),
          JSON.stringify({ gateway: { auth: { token: "secret-token" } } }),
        );
      }
      return { outcome, wasInterrupted: () => false, release: vi.fn() };
    }),
  };
}

async function captureReadySummary(
  agent: AgentDefinition | null,
  { sandboxName, cliName }: { sandboxName: string; cliName: string },
): Promise<string> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const helpers = createOnboardDashboardHelpers({
    runCaptureOpenshell: vi.fn(() => ""),
    runCapture: vi.fn(() => ""),
    cliName: () => cliName,
    agentProductName: () => "NemoClaw",
    getProviderLabel: (provider: string) => provider,
    nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
    shouldShowNimLine: vi.fn(() => false),
    note: vi.fn(),
    isWsl: () => false,
    redact: (value: unknown) => String(value),
    sleep: vi.fn(),
    sandboxTransferExecutor: createTokenDownloadTransferExecutor(),
    printAgentDashboardUi: vi.fn(),
    listSandboxes: () => ({ sandboxes: [] }),
  });

  try {
    await helpers.printDashboard(sandboxName, "gpt-oss:20b", "ollama", null, agent);
    return logSpy.mock.calls.map(([line]) => String(line)).join("\n");
  } finally {
    logSpy.mockRestore();
  }
}

describe("onboard dashboard helpers", () => {
  function createTokenHelpers(sandboxTransferExecutor: OpenShellSandboxTransferExecutor) {
    return createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      sandboxTransferExecutor,
      printAgentDashboardUi: vi.fn(),
    });
  }

  it("downloads the gateway token through the selected gateway and cleans up custody", async () => {
    let transferRequest: OpenShellSandboxTransferRequest | undefined;
    const release = vi.fn(() => {
      expect(fs.existsSync(transferRequest?.destination ?? "")).toBe(false);
    });
    const executor: OpenShellSandboxTransferExecutor = {
      run: vi.fn(async (request) => {
        transferRequest = request;
        fs.mkdirSync(request.destination, { recursive: true });
        fs.writeFileSync(
          path.join(request.destination, "openclaw.json"),
          JSON.stringify({ gateway: { auth: { token: "secret-token" } } }),
        );
        return {
          outcome: { kind: "completed" as const, exitCode: 0 },
          wasInterrupted: () => false,
          release,
        };
      }),
    };
    const helpers = createTokenHelpers(executor);

    await expect(helpers.fetchGatewayAuthTokenFromSandbox("alpha")).resolves.toBe("secret-token");
    expect(transferRequest).toMatchObject({
      direction: "download",
      sandboxName: "alpha",
      target: { kind: "selected" },
      source: "/sandbox/.openclaw/openclaw.json",
      output: "suppress",
    });
    expect(transferRequest?.destination.endsWith(path.sep)).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns null and cleans up a partial download after transfer failure", async () => {
    let destination = "";
    const release = vi.fn(() => {
      expect(fs.existsSync(destination)).toBe(false);
    });
    const executor: OpenShellSandboxTransferExecutor = {
      run: vi.fn(async (request) => {
        destination = request.destination;
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, "partial"), "credential fragment");
        return {
          outcome: { kind: "completed" as const, exitCode: 1 },
          wasInterrupted: () => false,
          release,
        };
      }),
    };
    const helpers = createTokenHelpers(executor);

    await expect(helpers.fetchGatewayAuthTokenFromSandbox("alpha")).resolves.toBeNull();
    expect(vi.mocked(executor.run).mock.calls[0]?.[0].target).toEqual({ kind: "selected" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("builds a remotely bound Hermes verification chain with its allocated API port", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const getSandbox = vi.fn(() => ({ hermesApiPort: 8643 }));
    const helpers = createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
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

    try {
      expect(
        helpers.buildAgentVerifyChain("http://127.0.0.1:18789", "my-hermes", loadAgent("hermes")),
      ).toMatchObject({
        port: 18789,
        forwardTarget: "0.0.0.0:18789",
        bindAddress: "0.0.0.0",
        dashboardHealthEndpoint: "/api/status",
        gatewayPort: 8643,
        gatewayHealthEndpoint: "/health",
      });
      expect(getSandbox).toHaveBeenCalledWith("my-hermes");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a malformed dashboard bind override in the verification chain", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0; rm -rf");
    const helpers = createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
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

    try {
      expect(
        helpers.buildAgentVerifyChain(
          "http://127.0.0.1:18789",
          "my-openclaw",
          loadAgent("openclaw"),
        ),
      ).toMatchObject({
        forwardTarget: "18789",
        bindAddress: "127.0.0.1",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves the WSL host fallback in the verification chain", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", undefined);
    const runCapture = vi.fn(() => "172.24.80.1 10.0.0.2\n");
    const helpers = createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture,
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => true,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    try {
      expect(
        helpers.buildAgentVerifyChain(
          "http://127.0.0.1:18789",
          "my-openclaw",
          loadAgent("openclaw"),
        ),
      ).toMatchObject({
        fallbackUrls: ["http://172.24.80.1:18789"],
        forwardTarget: "0.0.0.0:18789",
        bindAddress: "0.0.0.0",
      });
      expect(runCapture).toHaveBeenCalledWith(["hostname", "-I"], { ignoreError: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves listed legacy forwards for gateway teardown instead of stopping by shared PID record", () => {
    const helpers = createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(
        () => "SANDBOX BIND PORT PID STATUS\nmy-sandbox 127.0.0.1 18789 4242 running",
      ),
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      printAgentDashboardUi: vi.fn(),
      productionForwardService: true,
      listSandboxes: () => ({
        sandboxes: [{ name: "my-sandbox", dashboardPort: 18_789, scopeGatewayPort: 8_080 }],
      }),
    });

    helpers.stopAllDashboardForwards();
  });

  it("skips dashboard forwarding for terminal agents without declared ports", async () => {
    const helpers = createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
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
  });

  it("prints the dashboard-url command instead of raw gateway-token guidance", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const nimStatus = vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" }));
    const shouldShowNimLine = vi.fn(() => false);
    const helpers = createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => ""),
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus,
      shouldShowNimLine,
      note: vi.fn(),
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      sandboxTransferExecutor: createTokenDownloadTransferExecutor(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    let output = "";
    try {
      await helpers.printDashboard("my-gpt-claw", "gpt-oss:20b", "ollama");
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

  it("shows the loopback dashboard URL with a WSL host-IP fallback under WSL", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const helpers = createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => "172.22.1.1 10.0.0.2\n"),
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
      shouldShowNimLine: vi.fn(() => false),
      note: vi.fn(),
      isWsl: () => true,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      sandboxTransferExecutor: createTokenDownloadTransferExecutor(),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    let output = "";
    try {
      await helpers.printDashboard("my-gpt-claw", "gpt-oss:20b", "ollama");
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

  it("gives the agent dashboard both primary and port-rewritten WSL fallback URLs", async () => {
    const printAgentDashboardUi = vi.fn();
    const helpers = createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => "172.22.1.1 10.0.0.2\n"),
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
      shouldShowNimLine: vi.fn(() => false),
      note: vi.fn(),
      isWsl: () => true,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      sandboxTransferExecutor: createTokenDownloadTransferExecutor(),
      printAgentDashboardUi,
      listSandboxes: () => ({ sandboxes: [] }),
    });
    const agent = { dashboard: { auth: "url_token" } } as never;

    await helpers.printDashboard("my-hermes", "gpt-oss:20b", "ollama", null, agent);

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
  ])(
    "prints the effective Hermes dashboard URL selected by %s (#6277)",
    async (_source, port, configurePort) => {
      const previousChatUiUrl = process.env.CHAT_UI_URL;
      const previousDashboardPort = process.env.NEMOCLAW_DASHBOARD_PORT;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const helpers = createOnboardDashboardHelpers({
        runCaptureOpenshell: vi.fn(() => ""),
        runCapture: vi.fn(() => ""),
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
        await helpers.printDashboard(
          "my-hermes",
          "gpt-oss:20b",
          "ollama",
          null,
          loadAgent("hermes"),
        );
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
    },
  );

  it("prints a token-free browser URL when the dashboard token is unavailable", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const note = vi.fn();
    const helpers = createOnboardDashboardHelpers({
      runCaptureOpenshell: vi.fn(() => ""),
      runCapture: vi.fn(() => ""),
      cliName: () => "nemoclaw",
      agentProductName: () => "NemoClaw",
      getProviderLabel: (provider: string) => provider,
      nimStatus: vi.fn(() => ({ running: false, container: "nemoclaw-nim-test" })),
      shouldShowNimLine: vi.fn(() => false),
      note,
      isWsl: () => false,
      redact: (value: unknown) => String(value),
      sleep: vi.fn(),
      sandboxTransferExecutor: createTokenDownloadTransferExecutor({
        kind: "failed",
        reason: "invocation",
      }),
      printAgentDashboardUi: vi.fn(),
      listSandboxes: () => ({ sandboxes: [] }),
    });

    let output = "";
    try {
      await helpers.printDashboard("my-gpt-claw", "gpt-oss:20b", "ollama");
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

  it("offers launch first and keeps connect in the OpenClaw ready summary (#6006)", async () => {
    const output = await captureReadySummary(null, {
      sandboxName: "my-gpt-claw",
      cliName: "nemoclaw",
    });

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

  it("prints the Hermes interactive command instead of the OpenClaw TUI (#6006)", async () => {
    const output = await captureReadySummary(loadAgent("hermes"), {
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

  it("prints the Deep Agents Code interactive command in the ready summary (#6006)", async () => {
    const output = await captureReadySummary(loadAgent("langchain-deepagents-code"), {
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
