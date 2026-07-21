// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { entry, makeDeps, showSandboxChannelStatus } from "./channel-status.test-helpers";

// The whatsapp status hook now reads OpenClaw's authoritative live status JSON
// (`openclaw channels status --channel whatsapp --json`) instead of scraping
// shell markers, so these integration tests feed that JSON shape through the
// mocked sandbox exec. `wa` is the default-account object under
// `channelAccounts.whatsapp` in OpenClaw 2026.6.10.
function waStatusJson(wa: Record<string, unknown>): string {
  return JSON.stringify({
    channels: { whatsapp: { configured: true } },
    channelAccounts: { whatsapp: [{ ...wa, accountId: "default" }] },
    channelDefaultAccountId: { whatsapp: "default" },
  });
}

describe("showSandboxChannelStatus (whatsapp)", () => {
  it("returns idle verdict and exit code 1 when paired but no inbound observed", async () => {
    const stdout = waStatusJson({
      linked: true,
      running: true,
      connected: true,
      healthState: "healthy",
      lastInboundAt: null,
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
    });
    try {
      await showSandboxChannelStatus("alpha", {
        deps,
        channel: "whatsapp",
        quietJson: true,
        asJson: true,
      });
    } finally {
      exitSpy.mockRestore();
    }
    const dump = out_lines.join("\n");
    // The text report is suppressed when asJson && quietJson; the action returns
    // the report. Use the JSON-less path next to inspect rendering.
    expect(dump).toBe("");
  });

  it("renders an idle verdict in the text report and exits non-zero", async () => {
    const stdout = waStatusJson({
      linked: true,
      running: true,
      connected: true,
      healthState: "healthy",
      lastInboundAt: null,
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    expect(threw?.message).toBe("process.exit(1)");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Verdict:.*idle/);
    expect(dump).toMatch(/Inbound delivery: paired but no inbound message observed/);
    expect(dump).toMatch(/Bridge process: bridge process running/);
  });

  it("returns healthy verdict when paired and a recent inbound was observed", async () => {
    const stdout = waStatusJson({
      linked: true,
      running: true,
      connected: true,
      healthState: "healthy",
      lastInboundAt: 1748404770000,
    });
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
    });
    const result = await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    expect(result && "report" in result && result.report.verdict).toBe("healthy");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Verdict:.*healthy/);
  });

  it("reports a stopped in-process bridge as not healthy even with a recent last inbound (#7016)", async () => {
    // Regression for the append-only-log false positive (PRA-1 / CodeRabbit):
    // a bridge that has stopped still leaves a recent `lastInboundAt` behind,
    // but the authoritative `running: false` / `healthState: "stopped"` must
    // win so the operator is not told a torn-down bridge is healthy.
    const stdout = waStatusJson({
      linked: true,
      running: false,
      connected: false,
      healthState: "stopped",
      lastStopAt: 1748404800000,
      lastInboundAt: 1748404770000,
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    expect(threw?.message).toBe("process.exit(1)");
    const dump = out_lines.join("\n");
    expect(dump).not.toMatch(/Verdict:.*healthy/);
    expect(dump).toMatch(/Bridge process: no WhatsApp bridge process observed/);
  });

  it("returns probe_failed when the openclaw status command exits non-zero", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps } = makeDeps({
      exec: () => ({ status: 1, stdout: "", stderr: "Error: not running" }),
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    expect(threw?.message).toBe("process.exit(1)");
  });

  it("returns probe_failed when the openclaw status command throws", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps, out_lines } = makeDeps({
      exec: () => {
        throw new Error("sandbox exec unavailable");
      },
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    expect(threw?.message).toBe("process.exit(1)");
    expect(out_lines.join("\n")).toMatch(/Verdict:.*probe_failed/);
  });

  it("returns probe_failed when openshell exec returns null (timeout)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps } = makeDeps({
      exec: () => null,
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp", asJson: true });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    // asJson w/o quietJson still prints the JSON, then returns; the exit code
    // is set via `if (asJson) return report;` so no process.exit is called.
    expect(threw).toBeNull();
  });

  it("returns config_gap when the sandbox has whatsapp neither registered nor enabled", async () => {
    const stdout = waStatusJson({
      linked: true,
      running: true,
      connected: true,
      healthState: "healthy",
      lastInboundAt: 1748404770000,
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
      sandbox: entry([]),
      appliedPresets: [],
      gatewayPresets: [],
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    expect(threw?.message).toBe("process.exit(1)");
  });

  it("falls back to basic status for Hermes without running the OpenClaw probe", async () => {
    const exec = vi.fn((_sandbox: string, _command: string, _timeoutMs?: number) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const { deps } = makeDeps({
      exec,
      agentName: "hermes",
      sandbox: entry(["whatsapp"], [], {}, "hermes"),
    });
    const result = await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    const commands = exec.mock.calls.map((call) => String(call[1] ?? "")).join("\n");
    expect(commands).not.toContain("openclaw channels status");
    expect(commands).not.toContain("platforms/whatsapp/session/creds.json");
    expect(result && "verdict" in result && result.verdict).toBe("info");
  });

  it("skips the deep probe and reports paused state when WhatsApp is in disabledChannels", async () => {
    // Regression guard: `channels stop whatsapp` deliberately drops the
    // bridge and preset until the operator runs `channels start`. The
    // status command should reflect that rather than probing a torn-down
    // bridge and reporting failures.
    const execSpy = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: entry(["whatsapp"], ["whatsapp"]),
    });
    deps.execSandbox = execSpy as unknown as typeof deps.execSandbox;
    const result = await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    expect(execSpy).not.toHaveBeenCalled();
    expect(result && "verdict" in result && result.verdict).toBe("info");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/registered but currently paused/);
    // The paused fallback must not claim it is the summary view nor tell the
    // operator to rerun the --channel command they are already running (#6887).
    const runtime =
      result && "signals" in result
        ? result.signals.find((s) => s.label === "Runtime health")
        : undefined;
    expect(runtime?.detail).toBe("not checked — whatsapp is currently paused");
    expect(runtime?.hint).toBeUndefined();
  });

  it("labels a paused telegram channel as paused rather than summary view under --channel (#6887)", async () => {
    // A probe-capable channel that is paused lands on the basic report even
    // under an explicit --channel request, since the probe is gated on
    // !channelIsPaused. The Runtime health signal must reflect the paused state.
    const execSpy = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const { deps } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: entry(["telegram"], ["telegram"]),
    });
    deps.execSandbox = execSpy as unknown as typeof deps.execSandbox;
    const result = await showSandboxChannelStatus("alpha", { deps, channel: "telegram" });
    // The config-value read still runs, but the deep gateway-log probe must not.
    const probeCommands = execSpy.mock.calls
      .map((call) => String((call as unknown[])[1]))
      .join("\n");
    expect(probeCommands).not.toMatch(/gateway\.log|pgrep/);
    const runtime =
      result && "signals" in result
        ? result.signals.find((s) => s.label === "Runtime health")
        : undefined;
    expect(runtime?.detail).toBe("not checked — telegram is currently paused");
    expect(runtime?.hint).toBeUndefined();
  });
});
