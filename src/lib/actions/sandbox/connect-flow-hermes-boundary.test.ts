// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("connectSandbox Hermes secret-boundary refusals", () => {
  let exitSpy: MockInstance;
  const originalStdinIsTty = process.stdin.isTTY;
  const originalStdinSetRawMode = (
    process.stdin as typeof process.stdin & { setRawMode?: (mode: boolean) => unknown }
  ).setRawMode;
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinIsTty,
    });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: originalStdinSetRawMode,
    });
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("exits probe-only mode with raw-secret remediation", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        secretBoundaryRefused: true,
        secretBoundaryReason: "raw-secret",
      },
    });
    const agentRuntime = requireDist("../../src/lib/agent/runtime.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "hermes" });
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("Hermes");

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("Probe failed: refused to confirm Hermes gateway in 'alpha'");
    expect(errorOutput).toContain("/sandbox/.hermes/.env contains raw secret-shaped values");
    expect(errorOutput).toContain(
      "Replace raw secret values with openshell:resolve:env:<name> placeholders and re-run.",
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Probe complete");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails closed on Hermes MCP drift with restart and rebuild guidance", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        mcpReconciliationRefused: true,
        mcpReconciliationReason: "Hermes MCP config does not match persisted managed intent",
      },
    });
    const agentRuntime = requireDist("../../src/lib/agent/runtime.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "hermes" });
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("Hermes");

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("Probe failed: refused to confirm Hermes gateway in 'alpha'");
    expect(errorOutput).toContain("nemoclaw alpha mcp restart");
    expect(errorOutput).toContain("nemoclaw alpha rebuild --yes");
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("refuses an HTTP-healthy Hermes gateway while MCP integrity is pending", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        // Process recovery normalizes both HTTP 200 and authenticated HTTP 401
        // health probes to this positive running state before reconciliation.
        wasRunning: true,
        recovered: false,
        forwardRecovered: true,
        mcpReconciliationRefused: true,
        mcpReconciliationReason:
          "\x1b[31mHermes MCP integrity is pending\x1b[0m\nFORGED SUCCESS ghp_0123456789abcdefghij",
      },
    });
    const agentRuntime = requireDist("../../src/lib/agent/runtime.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "hermes" });
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("Hermes");

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    const failureLine = harness.errorSpy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .find((line) => line.includes("Connect failed:"));
    expect(failureLine).toContain("Hermes MCP integrity is pending FORGED SUCCESS <REDACTED>");
    expect(failureLine).not.toMatch(/[\r\n\x1b]/);
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("nemoclaw alpha mcp restart");
    expect(errorOutput).toContain("nemoclaw alpha rebuild --yes");
    expect(errorOutput).not.toContain("ghp_0123456789abcdefghij");
    expect(harness.ensureOllamaAuthProxySpy).not.toHaveBeenCalled();
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([
    [
      "raw-secret",
      "refused to confirm Hermes gateway in 'alpha'",
      "Replace raw secret values with openshell:resolve:env:<name> placeholders",
    ],
    [
      "validator-missing",
      "the secret-boundary validator is missing from Hermes gateway in 'alpha'",
      "Re-image the sandbox with a current Hermes build before connecting",
    ],
  ] as const)("stops non-probe connect before downstream setup when the boundary refuses with %s", async (reason, summary, guidance) => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        secretBoundaryRefused: true,
        secretBoundaryReason: reason,
      },
    });
    const agentRuntime = requireDist("../../src/lib/agent/runtime.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "hermes" });
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("Hermes");

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(harness.ensureOllamaAuthProxySpy).not.toHaveBeenCalled();
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(`Connect failed: ${summary}`);
    expect(errorOutput).toContain(guidance);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([
    [
      "unexpected-marker",
      "secret-boundary check did not complete for Hermes gateway in 'alpha'",
      "Inspect the validator output above and re-run `nemoclaw <sandbox> recover`.",
    ],
    [
      "exec-failed",
      "could not execute the secret-boundary check for Hermes gateway in 'alpha'",
      "Check sandbox connectivity, then re-run `nemoclaw <sandbox> recover` before connecting.",
    ],
    [
      "validator-missing",
      "the secret-boundary validator is missing from Hermes gateway in 'alpha'",
      "Re-image the sandbox with a current Hermes build before connecting.",
    ],
    [
      "agent-missing",
      "the Hermes agent definition is unavailable for sandbox 'alpha'",
      "Repair the NemoClaw installation, then re-run recovery before connecting.",
    ],
  ] as const)("reports refusal reason %s with distinct guidance", async (reason, summary, guidance) => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        secretBoundaryRefused: true,
        secretBoundaryReason: reason,
      },
    });
    const agentRuntime = requireDist("../../src/lib/agent/runtime.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "hermes" });
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("Hermes");

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(`Probe failed: ${summary}.`);
    expect(errorOutput).toContain(guidance);
    expect(errorOutput).not.toContain("raw secret-shaped values");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
