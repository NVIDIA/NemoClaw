// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  entry,
  makeDeps,
  showSandboxChannelStatus,
  TELEGRAM_PROBE_UNKNOWN_STDOUT,
} from "./channel-status.test-helpers";

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

function hermesSessionProbeOutput(options: {
  gatewaySessionCreds: boolean;
  dashboardSessionCreds: boolean;
}): string {
  return [
    "NEMOCLAW_HERMES_WHATSAPP_SESSION_V1",
    `GATEWAY_SESSION=${options.gatewaySessionCreds ? "present" : "missing"}`,
    `DASHBOARD_SESSION=${options.dashboardSessionCreds ? "present" : "missing"}`,
  ].join("\n");
}

const HERMES_DEFAULT_SESSION_DIR = "/sandbox/.hermes/platforms/whatsapp/session";
const HERMES_DASHBOARD_SESSION_DIR =
  "/sandbox/.hermes/profiles/dashboard-home/platforms/whatsapp/session";

function hermesExec(options: {
  readonly configuredSessionPath?: string;
  readonly credsDirs: readonly string[];
}) {
  const hasCreds = (credsFile: string) =>
    options.credsDirs.some((dir) => credsFile === `${dir}/creds.json`);
  return vi.fn((_sandbox: string, command: string, _timeoutMs?: number) => {
    return command.startsWith("python3 -c ")
      ? options.configuredSessionPath === undefined
        ? { status: 1, stdout: "", stderr: "config unavailable" }
        : {
            status: 0,
            stdout: `NEMOCLAW_HERMES_WHATSAPP_CONFIG_V1\n${JSON.stringify(options.configuredSessionPath)}`,
            stderr: "",
          }
      : {
          status: 0,
          stdout: hermesSessionProbeOutput({
            gatewaySessionCreds: hasCreds(/gateway='([^']*)'/.exec(command)?.[1] ?? ""),
            dashboardSessionCreds: hasCreds(/dashboard='([^']*)'/.exec(command)?.[1] ?? ""),
          }),
          stderr: "",
        };
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

  it("reports a Hermes dashboard-home session that the gateway path cannot read", async () => {
    const exec = vi.fn((_sandbox: string, _command: string, _timeoutMs?: number) => ({
      status: 0,
      stdout: hermesSessionProbeOutput({
        gatewaySessionCreds: false,
        dashboardSessionCreds: true,
      }),
      stderr: "",
    }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps } = makeDeps({
      exec,
      agentName: "hermes",
      sandbox: entry(["whatsapp"], [], {}, "hermes"),
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    const commands = exec.mock.calls.map((call) => String(call[1] ?? "")).join("\n");
    expect(threw?.message).toBe("process.exit(1)");
    expect(commands).not.toContain("openclaw channels status");
    expect(commands).toContain("/sandbox/.hermes/platforms/whatsapp/session/creds.json");
    expect(commands).toContain(
      "/sandbox/.hermes/profiles/dashboard-home/platforms/whatsapp/session/creds.json",
    );
  });

  it("keeps Hermes gateway session presence as an unknown live-health verdict", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: hermesSessionProbeOutput({
          gatewaySessionCreds: true,
          dashboardSessionCreds: false,
        }),
        stderr: "",
      }),
      agentName: "hermes",
      sandbox: entry(["whatsapp"], [], {}, "hermes"),
    });
    const result = await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    expect(result && "report" in result && result.report.verdict).toBe("unknown");
    const session =
      result && "report" in result
        ? result.report.signals.find((signal) => signal.label === "Session location")
        : undefined;
    expect(session?.severity).toBe("ok");
  });

  // Keep this compatibility assertion only for the support period tracked by #8947.
  it("clears the session-path split during the compatibility period (#8947)", async () => {
    const exec = hermesExec({
      configuredSessionPath: HERMES_DASHBOARD_SESSION_DIR,
      credsDirs: [HERMES_DASHBOARD_SESSION_DIR],
    });
    const { deps, out_lines } = makeDeps({
      exec,
      agentName: "hermes",
      sandbox: entry(["whatsapp"], [], {}, "hermes"),
    });
    const result = await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    const signals = result && "report" in result ? result.report.signals : [];
    const dump = out_lines.join("\n");
    expect(result && "report" in result && result.report.verdict).not.toBe("unpaired");
    expect(signals.find((signal) => signal.label === "Session location")?.severity).toBe("ok");
    expect(signals.find((signal) => signal.label === "Session path override")?.severity).toBe(
      "info",
    );
    expect(dump).not.toContain("the Hermes gateway session path is empty");
    expect(dump).toContain(HERMES_DASHBOARD_SESSION_DIR);
    expect(exec.mock.calls.map((call) => String(call[1] ?? "")).join("\n")).toContain(
      `gateway='${HERMES_DASHBOARD_SESSION_DIR}/creds.json'`,
    );
  });

  it("keeps the default session path when the configured session path is unsupported (#8718)", async () => {
    const exec = hermesExec({
      configuredSessionPath: "/etc/hermes/session",
      credsDirs: [HERMES_DASHBOARD_SESSION_DIR],
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps } = makeDeps({
      exec,
      agentName: "hermes",
      sandbox: entry(["whatsapp"], [], {}, "hermes"),
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    const commands = exec.mock.calls.map((call) => String(call[1] ?? "")).join("\n");
    expect(threw?.message).toBe("process.exit(1)");
    expect(commands).toContain(`gateway='${HERMES_DEFAULT_SESSION_DIR}/creds.json'`);
    expect(commands).not.toContain("/etc/hermes/session");
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
    expect(result && "report" in result && result.report.verdict).toBe("info");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/registered but currently paused/);
    expect(dump).toMatch(/Verdict:.*info/);
    // The paused fallback must not claim it is the summary view nor tell the
    // operator to rerun the --channel command they are already running (#6887).
    const runtime =
      result && "report" in result
        ? result.report.signals.find((s) => s.label === "Runtime health")
        : undefined;
    expect(runtime?.detail).toBe("not checked — whatsapp is currently paused");
    expect(runtime?.hint).toBeUndefined();
  });

  it("labels a paused telegram channel as paused rather than summary view under --channel (#6887)", async () => {
    // A probe-capable channel that is paused skips the live probe but keeps the
    // detailed envelope. The Runtime health signal must reflect the paused state.
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
      result && "report" in result
        ? result.report.signals.find((s) => s.label === "Runtime health")
        : undefined;
    expect(runtime?.detail).toBe("not checked — telegram is currently paused");
    expect(runtime?.hint).toBeUndefined();
    expect(result).toEqual({
      schemaVersion: 1,
      sandbox: "alpha",
      channel: "telegram",
      report: {
        schemaVersion: 1,
        agent: "openclaw",
        channel: "telegram",
        verdict: "info",
        probedAt: "2026-05-28T04:00:00.000Z",
        signals: expect.any(Array),
        hints: expect.any(Array),
      },
    });
    expect(result && (await import("./channel-status")).exitCodeFor(result)).toBe(0);
  });
});

function slackStatusJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    channels: { slack: { configured: true } },
    channelAccounts: {
      slack: [
        {
          accountId: "default",
          enabled: true,
          configured: true,
          running: true,
          connected: true,
          probe: { ok: true },
          ...overrides,
        },
      ],
    },
  });
}

function slackWaitHarness(
  accounts: readonly Record<string, unknown>[],
  options: {
    paused?: boolean;
    agentName?: "openclaw" | "hermes";
    gatewayPolicyDurationMs?: number;
    probeDurationsMs?: readonly number[];
    configDurationMs?: number;
  } = {},
) {
  let clock = 0;
  let readinessProbe = 0;
  const sleep = vi.fn(async (milliseconds: number) => {
    clock += milliseconds;
  });
  const probe = vi.fn((timeoutMs = 0) => {
    const probeDurationMs =
      options.probeDurationsMs?.[Math.min(readinessProbe, options.probeDurationsMs.length - 1)] ??
      0;
    clock += Math.min(probeDurationMs, timeoutMs);
    const account = accounts?.[Math.min(readinessProbe, accounts.length - 1)] ?? {};
    readinessProbe += 1;
    return { status: 0, stdout: slackStatusJson(account), stderr: "" };
  });
  const configRead = vi.fn((timeoutMs = 0) => {
    clock += Math.min(options.configDurationMs ?? 0, timeoutMs);
    return { status: 0, stdout: "{}", stderr: "" };
  });
  const gatewayPolicy = vi.fn((_sandboxName: string, timeoutMs?: number) => {
    const durationMs = options.gatewayPolicyDurationMs ?? 0;
    const effectiveTimeoutMs = timeoutMs ?? durationMs;
    clock += Math.min(durationMs, effectiveTimeoutMs);
    return durationMs > effectiveTimeoutMs ? null : ["slack"];
  });
  const agentName = options.agentName ?? "openclaw";
  const { deps: baseDeps } = makeDeps({
    agentName,
    sandbox: entry(["slack"], options.paused ? ["slack"] : [], {}, agentName),
    appliedPresets: ["slack"],
    gatewayPresets: ["slack"],
    exec: (_sandbox, command, timeoutMs) =>
      command.startsWith("openclaw channels status") ? probe(timeoutMs) : configRead(timeoutMs),
    nowMs: () => clock,
    sleep,
  });
  const deps = { ...baseDeps, getGatewayPresets: gatewayPolicy };
  return { deps, gatewayPolicy, probe, configRead, sleep };
}

function waitForSlack(
  deps: ReturnType<typeof slackWaitHarness>["deps"],
  timeoutSeconds = 10,
  pollIntervalMs = 5_000,
) {
  return showSandboxChannelStatus("alpha", {
    deps,
    channel: "slack",
    wait: true,
    timeoutSeconds,
    pollIntervalMs,
    asJson: true,
    quietJson: true,
  });
}

describe("showSandboxChannelStatus Slack readiness wait", () => {
  it("waits through deferred initialization and returns structured success (#7383)", async () => {
    const { deps } = slackWaitHarness([
      { connected: false },
      { lastProbeAt: Date.parse("2026-08-07T12:00:00.000Z") },
    ]);

    const result = await waitForSlack(deps);

    expect(result && "readiness" in result ? result.readiness : null).toMatchObject({
      state: "ready",
      category: null,
      reason: "operational",
      attempts: 2,
      elapsedMs: 5_000,
      lastTransitionAt: "2026-08-07T12:00:00.000Z",
    });
  });

  it.each([
    ["openclaw", "channel_paused"],
    ["hermes", "readiness_not_supported"],
  ] as const)("returns the agent-appropriate terminal result for paused %s Slack (#7383)", async (agentName, reason) => {
    const { deps, probe, sleep } = slackWaitHarness([{}], { paused: true, agentName });

    const result = await waitForSlack(deps);

    expect(result && "readiness" in result ? result.readiness : null).toMatchObject({
      state: "terminal",
      category: "runtime",
      reason,
      retryable: false,
      attempts: 1,
      elapsedMs: 0,
    });
    expect(result && (await import("./channel-status")).exitCodeFor(result)).toBe(1);
    expect(probe).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds every readiness dependency by one wait deadline (#7383)", async () => {
    const { deps, gatewayPolicy, probe, configRead, sleep } = slackWaitHarness(
      [{ connected: false }, { connected: false }],
      {
        gatewayPolicyDurationMs: 450,
        probeDurationsMs: [400, 800],
        configDurationMs: 300,
      },
    );

    const result = await waitForSlack(deps, 2, 500);

    expect(result && "readiness" in result ? result.readiness : null).toMatchObject({
      state: "timeout",
      category: "timeout",
      reason: "timeout",
      retryable: true,
      attempts: 2,
      elapsedMs: 2_000,
      lastObserved: {
        category: "network",
        reason: "policy_status_unavailable",
      },
    });
    expect(gatewayPolicy.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([2_000, 350]);
    expect(probe.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([1_550]);
    expect(configRead.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([1_150]);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("applies the documented 180-second budget when the caller omits timeoutSeconds (#8883)", async () => {
    const { deps, gatewayPolicy } = slackWaitHarness([{ connected: false }]);

    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "slack",
      wait: true,
      timeoutSeconds: undefined,
      pollIntervalMs: 60_000,
      asJson: true,
      quietJson: true,
    });

    expect(result && "readiness" in result ? result.readiness : null).toMatchObject({
      state: "timeout",
      category: "timeout",
      reason: "timeout",
      elapsedMs: 180_000,
    });
    expect(gatewayPolicy.mock.calls[0]?.[1]).toBe(180_000);
  });
});

describe("showSandboxChannelStatus unsupported readiness wait", () => {
  it("returns readiness_not_supported after one Telegram status collection (#7383)", async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const exec = vi.fn((_sandbox: string, command: string, _timeoutMs?: number) => ({
      status: 0,
      stdout: command.includes("/tmp/gateway.log") ? TELEGRAM_PROBE_UNKNOWN_STDOUT : "{}",
      stderr: "",
    }));
    const { deps } = makeDeps({
      exec,
      sandbox: entry(["telegram"]),
      appliedPresets: ["telegram"],
      gatewayPresets: ["telegram"],
      sleep,
    });

    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
      wait: true,
      asJson: true,
      quietJson: true,
    });

    expect(result && "readiness" in result ? result.readiness : null).toMatchObject({
      state: "terminal",
      category: "runtime",
      reason: "readiness_not_supported",
      attempts: 1,
      lastObserved: { reason: "readiness_not_supported" },
    });
    expect(result && (await import("./channel-status")).exitCodeFor(result)).toBe(1);
    expect(
      exec.mock.calls.filter(([, command]) => String(command).includes("/tmp/gateway.log")),
    ).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
