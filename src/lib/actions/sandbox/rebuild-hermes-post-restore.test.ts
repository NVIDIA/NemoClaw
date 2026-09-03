// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import {
  ensureHermesGatewayAfterStateRestore,
  ensureHermesGatewayAfterStateRestoreForCronGate,
  restartHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestoreForCronGate,
} from "./rebuild-hermes-post-restore";

const RESTART_SUCCEEDED = {
  ok: true,
  restarted: true,
  healthPassed: true,
  forwardRecovered: false,
} as const;
const RESTART_FAILED = {
  ok: false,
  failureLayer: "health timeout",
  detail: "gateway did not become healthy",
} as const;
const RESTARTED_WITH_MCP_MISMATCH = {
  ok: false,
  failureLayer: "MCP reconciliation refusal",
  detail: "Hermes MCP config does not match persisted managed intent",
  restarted: true,
  healthPassed: true,
} as const;
const MCP_REFUSED_BEFORE_RESTART = {
  ok: false,
  failureLayer: "MCP reconciliation refusal",
  detail: "supervisor refused the restart before replacing the gateway",
} as const;

describe("binding the Hermes gateway to restored state", () => {
  it("restarts the gateway before reading its health (#8184)", () => {
    const order: string[] = [];
    const state = ensureHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: () => {
        order.push("restart");
        return RESTART_SUCCEEDED;
      },
      checkAndRecoverSandboxProcesses: () => {
        order.push("check");
        return { checked: true, wasRunning: true, recovered: false };
      },
    });

    expect(state).toBe("healthy");
    expect(order).toEqual(["restart", "check"]);
  });

  // The bug this replaces: the gateway read its durable state at startup, the
  // restore replaced that state afterwards, and a live process satisfied the
  // old liveness check while still serving what it read before the restore.
  it("refuses a gateway that stayed up through a failed restart (#8184)", () => {
    const state = ensureHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: () => RESTART_FAILED,
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: true,
        recovered: false,
      }),
    });

    expect(state).toBe("unverified");
  });

  it("accepts a gateway the recovery check replaced after a failed restart (#8184)", () => {
    const state = ensureHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: () => RESTART_FAILED,
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: false,
        recovered: true,
      }),
    });

    expect(state).toBe("recovered");
  });

  it("keeps restart evidence while rebuild restores the managed MCP projection (#8671)", () => {
    const restartState = restartHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: () => RESTARTED_WITH_MCP_MISMATCH,
    });

    expect(restartState).toBe("restarted");
    expect(
      verifyHermesGatewayAfterStateRestore("alpha", "hermes", restartState, {
        checkAndRecoverSandboxProcesses: () => ({
          checked: true,
          wasRunning: true,
          recovered: false,
        }),
      }),
    ).toBe("healthy");
  });

  it("rejects managed MCP drift that remains after rebuild restoration (#8671)", () => {
    const restartState = restartHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: () => RESTARTED_WITH_MCP_MISMATCH,
    });

    expect(
      verifyHermesGatewayAfterStateRestore("alpha", "hermes", restartState, {
        checkAndRecoverSandboxProcesses: () => ({
          checked: true,
          wasRunning: true,
          recovered: false,
          mcpReconciliationRefused: true,
        }),
      }),
    ).toBe("unverified");
  });

  it("preserves an MCP refusal before gateway replacement (#8671)", () => {
    const restartState = restartHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: () => MCP_REFUSED_BEFORE_RESTART,
    });

    expect(restartState).toBe("restart-failed");
    expect(
      verifyHermesGatewayAfterStateRestore("alpha", "hermes", restartState, {
        checkAndRecoverSandboxProcesses: () => ({
          checked: true,
          wasRunning: true,
          recovered: false,
        }),
      }),
    ).toBe("unverified");
  });

  it("leaves a non-Hermes rebuild without a gateway restart (#8184)", () => {
    const restartSandboxGateway = vi.fn(() => RESTART_SUCCEEDED);
    const checkAndRecoverSandboxProcesses = vi.fn(() => ({
      checked: true,
      wasRunning: true,
      recovered: false,
    }));

    const state = ensureHermesGatewayAfterStateRestore("alpha", "openclaw", {
      restartSandboxGateway,
      checkAndRecoverSandboxProcesses,
    });

    expect(state).toBe("not-applicable");
    expect(restartSandboxGateway).not.toHaveBeenCalled();
    expect(checkAndRecoverSandboxProcesses).not.toHaveBeenCalled();
  });

  it("binds managed health to one observed replacement identity (#8472)", () => {
    const order: string[] = [];
    const replacement = { pid: 77, start_time: 903, drain_token: "restore-token" };
    const verification = ensureHermesGatewayAfterStateRestoreForCronGate(
      "alpha",
      "hermes",
      { pid: 41, start_time: 902, drain_token: "restore-token" },
      {
        restartSandboxGateway: () => {
          order.push("restart");
          return RESTART_SUCCEEDED;
        },
        observeHermesCronReplacement: () => {
          order.push("observe");
          return replacement;
        },
        checkAndRecoverSandboxProcesses: () => {
          order.push("health");
          return { checked: true, wasRunning: true, recovered: false };
        },
      },
    );

    expect(verification).toEqual({ state: "healthy", replacementIdentity: replacement });
    expect(order).toEqual(["restart", "observe", "health", "observe"]);
  });

  it("binds a recovered cron-gated gateway to its observed replacement identity (#8472)", () => {
    const replacement = { pid: 77, start_time: 903, drain_token: "restore-token" };
    const observeHermesCronReplacement = vi.fn(() => replacement);
    const checkAndRecoverSandboxProcesses = vi
      .fn()
      .mockReturnValueOnce({ checked: true, wasRunning: false, recovered: true })
      .mockReturnValueOnce({ checked: true, wasRunning: true, recovered: false });

    expect(
      ensureHermesGatewayAfterStateRestoreForCronGate(
        "alpha",
        "hermes",
        { pid: 41, start_time: 902, drain_token: "restore-token" },
        {
          restartSandboxGateway: () => RESTART_FAILED,
          observeHermesCronReplacement,
          checkAndRecoverSandboxProcesses,
        },
      ),
    ).toEqual({ state: "recovered", replacementIdentity: replacement });
    expect(checkAndRecoverSandboxProcesses).toHaveBeenCalledTimes(2);
    expect(observeHermesCronReplacement).toHaveBeenCalledTimes(3);
  });

  it("fails closed when another gateway replaces the process during health verification (#8472)", () => {
    const observeHermesCronReplacement = vi
      .fn()
      .mockReturnValueOnce({ pid: 77, start_time: 903, drain_token: "restore-token" })
      .mockReturnValueOnce({ pid: 88, start_time: 904, drain_token: "restore-token" });

    expect(
      ensureHermesGatewayAfterStateRestoreForCronGate(
        "alpha",
        "hermes",
        { pid: 41, start_time: 902, drain_token: "restore-token" },
        {
          restartSandboxGateway: () => RESTART_SUCCEEDED,
          observeHermesCronReplacement,
          checkAndRecoverSandboxProcesses: () => ({
            checked: true,
            wasRunning: true,
            recovered: false,
          }),
        },
      ),
    ).toEqual({ state: "unverified" });
    expect(observeHermesCronReplacement).toHaveBeenCalledTimes(2);
  });

  it("verifies the final cron-bound gateway without restarting after MCP restoration (#8472)", () => {
    const original = { pid: 41, start_time: 902, drain_token: "restore-token" };
    const replacement = { pid: 77, start_time: 903, drain_token: "restore-token" };
    const restartSandboxGateway = vi.fn(() => RESTART_SUCCEEDED);
    const observeHermesCronReplacement = vi.fn(() => replacement);

    expect(
      verifyHermesGatewayAfterStateRestoreForCronGate("alpha", "hermes", "restarted", original, {
        restartSandboxGateway,
        observeHermesCronReplacement,
        checkAndRecoverSandboxProcesses: () => ({
          checked: true,
          wasRunning: true,
          recovered: false,
        }),
      }),
    ).toEqual({ state: "healthy", replacementIdentity: replacement });
    expect(restartSandboxGateway).not.toHaveBeenCalled();
    expect(observeHermesCronReplacement).toHaveBeenCalledTimes(2);
  });

  it("rejects unstable final cron identity without restarting after MCP restoration (#8472)", () => {
    const restartSandboxGateway = vi.fn(() => RESTART_SUCCEEDED);
    const observeHermesCronReplacement = vi
      .fn()
      .mockReturnValueOnce({ pid: 77, start_time: 903, drain_token: "restore-token" })
      .mockReturnValueOnce({ pid: 88, start_time: 904, drain_token: "restore-token" });

    expect(
      verifyHermesGatewayAfterStateRestoreForCronGate(
        "alpha",
        "hermes",
        "restarted",
        { pid: 41, start_time: 902, drain_token: "restore-token" },
        {
          restartSandboxGateway,
          observeHermesCronReplacement,
          checkAndRecoverSandboxProcesses: () => ({
            checked: true,
            wasRunning: true,
            recovered: false,
          }),
        },
      ),
    ).toEqual({ state: "unverified" });
    expect(restartSandboxGateway).not.toHaveBeenCalled();
  });

  it("preserves MCP reconciliation refusal during restart-free final verification (#7084)", () => {
    const restartSandboxGateway = vi.fn(() => RESTART_SUCCEEDED);

    expect(
      verifyHermesGatewayAfterStateRestore("alpha", "hermes", "restarted", {
        restartSandboxGateway,
        checkAndRecoverSandboxProcesses: () => ({
          checked: true,
          wasRunning: true,
          recovered: false,
          mcpReconciliationRefused: true,
        }),
      }),
    ).toBe("unverified");
    expect(restartSandboxGateway).not.toHaveBeenCalled();
  });
});

describe("Hermes gateway post-restore recheck", () => {
  it("accepts a gateway that becomes healthy after an inconclusive recovery check (#7084)", () => {
    const checkAndRecoverSandboxProcesses = vi
      .fn()
      .mockReturnValueOnce({
        checked: false,
        wasRunning: null,
        recovered: false,
      })
      .mockReturnValueOnce({
        checked: true,
        wasRunning: true,
        recovered: false,
      });

    expect(
      ensureHermesGatewayAfterStateRestore("alpha", "hermes", {
        restartSandboxGateway: () => RESTART_SUCCEEDED,
        checkAndRecoverSandboxProcesses,
      }),
    ).toBe("healthy");

    expect(checkAndRecoverSandboxProcesses).toHaveBeenCalledTimes(2);
  });

  it.each(["forwardRecoveryFailed", "secretBoundaryRefused", "mcpReconciliationRefused"] as const)(
    "fails immediately when recovery reports %s (#7084)",
    (failureFlag) => {
      const checkAndRecoverSandboxProcesses = vi.fn(() => ({
        checked: true,
        wasRunning: true,
        recovered: false,
        [failureFlag]: true,
      }));

      expect(
        ensureHermesGatewayAfterStateRestore("alpha", "hermes", {
          restartSandboxGateway: () => RESTART_SUCCEEDED,
          checkAndRecoverSandboxProcesses,
        }),
      ).toBe("unverified");

      expect(checkAndRecoverSandboxProcesses).toHaveBeenCalledOnce();
    },
  );

  it("fails closed after the bounded gateway recheck remains inconclusive (#7084)", () => {
    const checkAndRecoverSandboxProcesses = vi.fn(() => ({
      checked: true,
      wasRunning: false,
      recovered: false,
    }));

    expect(
      ensureHermesGatewayAfterStateRestore("alpha", "hermes", {
        restartSandboxGateway: () => RESTART_SUCCEEDED,
        checkAndRecoverSandboxProcesses,
      }),
    ).toBe("unverified");

    expect(checkAndRecoverSandboxProcesses).toHaveBeenCalledTimes(2);
  });
});

describe("Hermes rebuild post-restore verification", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("fails instead of reporting readiness when restored state leaves the gateway down (#7084)", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
      }),
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      sandboxEntry: { agent: "hermes" },
    });
    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Hermes post-restore verification failed");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("rebuilt but some post-restore steps were incomplete");
    expect(output).toContain("Hermes gateway health was not verified after state restore");
    expect(output).not.toContain("MCP bridge definitions were preserved but not fully refreshed");
    expect(output).not.toContain("rebuilt successfully");
    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
  });

  it("restores MCP after gateway restart and before final health verification (#7084)", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
      }),
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
    expect(harness.restartSandboxGatewaySpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.restoreMcpBridgesAfterRebuildSpy.mock.invocationCallOrder[0],
    );
    expect(harness.restoreMcpBridgesAfterRebuildSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.checkAndRecoverSandboxProcessesSpy.mock.invocationCallOrder[0],
    );
    expect(harness.logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Hermes gateway restarted and verified after state restore"),
    );
  });

  it("returns a failed rebuild when managed Hermes MCP restoration is incomplete (#7084)", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      sandboxEntry: { agent: "hermes" },
    });
    harness.restoreMcpBridgesAfterRebuildSpy.mockRejectedValueOnce(new Error("reload failed"));

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Hermes post-restore verification failed");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("MCP bridge definitions were preserved but not fully refreshed");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("fails when the final gateway check refuses MCP reconciliation (#7084)", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        mcpReconciliationRefused: true,
      }),
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Hermes post-restore verification failed");

    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });

  it.each(["forwardRecoveryFailed", "secretBoundaryRefused"] as const)(
    "fails when the final gateway check reports %s (#7084)",
    async (failureFlag) => {
      const harness = createRebuildFlowHarness({
        agentName: "hermes",
        checkAndRecoverSandboxProcesses: () => ({
          checked: true,
          wasRunning: true,
          recovered: false,
          forwardRecovered: false,
          [failureFlag]: true,
        }),
        sandboxEntry: { agent: "hermes" },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Hermes post-restore verification failed");

      expect(harness.logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("rebuilt successfully"),
      );
    },
  );

  it("fails when the final gateway health probe is unavailable (#7084)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: false,
        wasRunning: null,
        recovered: false,
        forwardRecovered: false,
      }),
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Hermes post-restore verification failed");

    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });

  it("fails before recovery when recreated Hermes identity is missing (#7084)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sessionAgentName: null,
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow(
      "Recreated sandbox agent identity did not match the authoritative rebuild target",
    );

    expect(harness.checkAndRecoverSandboxProcessesSpy).not.toHaveBeenCalled();
    expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });

  it("restarts the gateway between the state restore and the health check (#8184)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.restartSandboxGatewaySpy).toHaveBeenCalledWith("alpha", { quiet: true });
    expect(harness.restoreSandboxStateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.restartSandboxGatewaySpy.mock.invocationCallOrder[0],
    );
    expect(harness.restartSandboxGatewaySpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.checkAndRecoverSandboxProcessesSpy.mock.invocationCallOrder[0],
    );
    expect(harness.logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Hermes gateway restarted and verified after state restore"),
    );
  });

  it("fails before recovery when recreated Hermes identity mismatches (#7084)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sessionAgentName: "langchain-deepagents-code",
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow(
      "Recreated sandbox agent identity did not match the authoritative rebuild target",
    );

    expect(harness.checkAndRecoverSandboxProcessesSpy).not.toHaveBeenCalled();
    expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });
});
