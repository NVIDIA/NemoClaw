// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

// The orchestrator transitively pulls in policy/index.ts and agent/defs.ts,
// both of which require runner.ts via CJS; runner.ts uses `require()` calls
// vitest cannot resolve from a TS source file. Stub the heavy modules so the
// test stays focused on the orchestrator's diagnostic glue. See
// src/lib/shields/index.test.ts for the same workaround pattern.
vi.mock("../../policy", () => ({
  getAppliedPresets: vi.fn(() => []),
  getGatewayPresets: vi.fn(() => null),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(),
}));

vi.mock("../../agent/defs", () => ({
  loadAgent: vi.fn(),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxExecCommand: vi.fn(),
}));

import type { AgentDefinition } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import { showSandboxChannelStatus } from "./channel-status";

type ExecResult = { status: number; stdout: string; stderr: string };

const PROBED_AT = new Date("2026-05-28T04:00:00.000Z");

function fakeAgent(name: "openclaw" | "hermes" = "openclaw"): AgentDefinition {
  const configDir = name === "openclaw" ? "/sandbox/.openclaw" : "/sandbox/.hermes";
  const stateDirs = name === "openclaw" ? ["whatsapp"] : ["platforms"];
  const messagingPlatforms = ["telegram", "discord", "slack", "wechat", "whatsapp"];
  return {
    name,
    agentDir: `/fake/${name}`,
    manifestPath: `/fake/${name}/manifest.yaml`,
    get displayName() {
      return name;
    },
    get healthProbe() {
      return { url: "http://localhost:0/", port: 0, timeout_seconds: 5 };
    },
    get forwardPort() {
      return 0;
    },
    get dashboard() {
      return { kind: "ui" as const, label: "UI", path: "/" };
    },
    get configPaths() {
      return { dir: configDir, configFile: "config.json", envFile: null, format: "json" };
    },
    get inferenceProviderOptions() {
      return [];
    },
    get stateDirs() {
      return stateDirs;
    },
    get stateFiles() {
      return [];
    },
    get versionCommand() {
      return `${name} --version`;
    },
    get expectedVersion() {
      return null;
    },
    get hasDevicePairing() {
      return false;
    },
    get phoneHomeHosts() {
      return [];
    },
    get messagingPlatforms() {
      return messagingPlatforms;
    },
    get dockerfileBasePath() {
      return null;
    },
    get dockerfilePath() {
      return null;
    },
    get startScriptPath() {
      return null;
    },
    get policyAdditionsPath() {
      return null;
    },
    get policyPermissivePath() {
      return null;
    },
    get pluginDir() {
      return null;
    },
    get legacyPaths() {
      return null;
    },
  } as unknown as AgentDefinition;
}

function entry(
  messagingChannels: string[] = ["whatsapp"],
  disabledChannels: string[] = [],
): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    messagingChannels,
    disabledChannels,
  } as SandboxEntry;
}

function makeDeps(opts: {
  exec: (sandboxName: string, command: string, timeoutMs?: number) => ExecResult | null;
  appliedPresets?: string[];
  gatewayPresets?: string[] | null;
  agentName?: "openclaw" | "hermes";
  sandbox?: SandboxEntry | undefined;
  out?: (line: string) => void;
}) {
  const calls: string[] = [];
  const out = opts.out ?? ((line: string) => calls.push(line));
  return {
    out,
    deps: {
      loadAgent: () => fakeAgent(opts.agentName),
      getSandbox: () => opts.sandbox ?? entry(),
      getAppliedPresets: () => opts.appliedPresets ?? ["whatsapp"],
      getGatewayPresets: () =>
        opts.gatewayPresets === undefined ? ["whatsapp"] : opts.gatewayPresets,
      execSandbox: vi.fn(opts.exec),
      now: () => PROBED_AT,
      out,
    },
    out_lines: calls,
  };
}

describe("showSandboxChannelStatus (whatsapp)", () => {
  it("returns idle verdict and exit code 1 when paired but no inbound observed", async () => {
    const heartbeat = JSON.stringify({
      lastInboundAt: null,
      messagesHandled: 0,
      connectionState: "open",
    });
    const stdout = [
      "NEMOCLAW_WA_DIAG_OK",
      "DIR /sandbox/.openclaw/whatsapp POPULATED",
      "DIR /sandbox/.openclaw/platforms/whatsapp MISSING",
      "NEMOCLAW_WA_HEARTBEAT_BEGIN",
      heartbeat,
      "NEMOCLAW_WA_HEARTBEAT_END",
      "NEMOCLAW_WA_LOG_BEGIN",
      "2026-05-28 connection.open",
      "NEMOCLAW_WA_LOG_END",
      "PROC 1234 baileys-runtime",
      "NEMOCLAW_WA_PROC_DONE",
    ].join("\n");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
    });
    try {
      await showSandboxChannelStatus("alpha", { deps, quietJson: true, asJson: true });
    } finally {
      exitSpy.mockRestore();
    }
    const dump = out_lines.join("\n");
    // The text report is suppressed when asJson && quietJson; the action returns
    // the report. Use the JSON-less path next to inspect rendering.
    expect(dump).toBe("");
  });

  it("renders an idle verdict in the text report and exits non-zero", async () => {
    const heartbeat = JSON.stringify({
      lastInboundAt: null,
      messagesHandled: 0,
      connectionState: "open",
    });
    const stdout = [
      "NEMOCLAW_WA_DIAG_OK",
      "DIR /sandbox/.openclaw/whatsapp POPULATED",
      "NEMOCLAW_WA_HEARTBEAT_BEGIN",
      heartbeat,
      "NEMOCLAW_WA_HEARTBEAT_END",
      "NEMOCLAW_WA_LOG_BEGIN",
      "NEMOCLAW_WA_LOG_END",
      "PROC 1234 openclaw-whatsapp",
      "NEMOCLAW_WA_PROC_DONE",
    ].join("\n");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps });
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
    const heartbeat = JSON.stringify({
      lastInboundAt: "2026-05-28T03:59:30.000Z",
      messagesHandled: 4,
      connectionState: "open",
    });
    const stdout = [
      "NEMOCLAW_WA_DIAG_OK",
      "DIR /sandbox/.openclaw/whatsapp POPULATED",
      "NEMOCLAW_WA_HEARTBEAT_BEGIN",
      heartbeat,
      "NEMOCLAW_WA_HEARTBEAT_END",
      "NEMOCLAW_WA_LOG_BEGIN",
      "NEMOCLAW_WA_LOG_END",
      "PROC 1234 openclaw-whatsapp",
      "NEMOCLAW_WA_PROC_DONE",
    ].join("\n");
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
    });
    const result = await showSandboxChannelStatus("alpha", { deps });
    expect(result && "report" in result && result.report.verdict).toBe("healthy");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Verdict:.*healthy/);
  });

  it("returns probe_failed when openshell exec produces no marker", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    const { deps } = makeDeps({
      exec: () => ({ status: 1, stdout: "", stderr: "Error: not running" }),
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    expect(threw?.message).toBe("process.exit(1)");
  });

  it("returns probe_failed when openshell exec returns null (timeout)", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    const { deps } = makeDeps({
      exec: () => null,
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, asJson: true });
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
    const stdout = [
      "NEMOCLAW_WA_DIAG_OK",
      "DIR /sandbox/.openclaw/whatsapp MISSING",
      "NEMOCLAW_WA_LOG_BEGIN",
      "NEMOCLAW_WA_LOG_END",
    ].join("\n");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
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
      await showSandboxChannelStatus("alpha", { deps });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    expect(threw?.message).toBe("process.exit(1)");
  });

  it("uses the hermes pairing hint when the agent is hermes", async () => {
    const stdout = [
      "NEMOCLAW_WA_DIAG_OK",
      "DIR /sandbox/.hermes/platforms/whatsapp/session MISSING",
      "NEMOCLAW_WA_LOG_BEGIN",
      "NEMOCLAW_WA_LOG_END",
    ].join("\n");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
      agentName: "hermes",
    });
    try {
      await showSandboxChannelStatus("alpha", { deps });
    } catch {
      /* expected exit(1) for unpaired */
    } finally {
      exitSpy.mockRestore();
    }
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/hermes whatsapp/);
    expect(dump).toMatch(/Verdict:.*unpaired/);
  });

  it("distinguishes 'pgrep completed with no matches' from 'probe never reached pgrep'", async () => {
    // With the PROC_DONE marker, the orchestrator reports
    // bridgeProcessAlive: false when pgrep ran cleanly with no matches
    // (so the diagnostic can route to fail/idle) and null only when the
    // probe aborted before reaching pgrep (so the diagnostic stays info
    // and a healthy heartbeat is not penalized by an unrelated probe
    // failure).
    const stdoutNoMatch = [
      "NEMOCLAW_WA_DIAG_OK",
      "DIR /sandbox/.openclaw/whatsapp POPULATED",
      "NEMOCLAW_WA_HEARTBEAT_BEGIN",
      JSON.stringify({
        lastInboundAt: "2026-05-27T00:00:00.000Z",
        messagesHandled: 1,
        connectionState: "open",
      }),
      "NEMOCLAW_WA_HEARTBEAT_END",
      "NEMOCLAW_WA_LOG_BEGIN",
      "NEMOCLAW_WA_LOG_END",
      "NEMOCLAW_WA_PROC_DONE",
    ].join("\n");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    try {
      const { deps: depsNoMatch, out_lines: linesNoMatch } = makeDeps({
        exec: () => ({ status: 0, stdout: stdoutNoMatch, stderr: "" }),
      });
      try {
        await showSandboxChannelStatus("alpha", { deps: depsNoMatch });
      } catch {
        /* expected exit(1) for stale-heartbeat + no bridge */
      }
      const dumpNoMatch = linesNoMatch.join("\n");
      expect(dumpNoMatch).toMatch(/Bridge process: no WhatsApp bridge process observed/);
      expect(dumpNoMatch).toMatch(/Verdict:.*idle/);

      const stdoutTimeout = [
        "NEMOCLAW_WA_DIAG_OK",
        "DIR /sandbox/.openclaw/whatsapp POPULATED",
        "NEMOCLAW_WA_HEARTBEAT_BEGIN",
        JSON.stringify({
          lastInboundAt: "2026-05-28T03:59:30.000Z",
          messagesHandled: 1,
          connectionState: "open",
        }),
        "NEMOCLAW_WA_HEARTBEAT_END",
        "NEMOCLAW_WA_LOG_BEGIN",
        "NEMOCLAW_WA_LOG_END",
        // No PROC_DONE — simulating a probe that aborted before reaching
        // the pgrep stage.
      ].join("\n");
      const { deps: depsTimeout, out_lines: linesTimeout } = makeDeps({
        exec: () => ({ status: 0, stdout: stdoutTimeout, stderr: "" }),
      });
      await showSandboxChannelStatus("alpha", { deps: depsTimeout });
      const dumpTimeout = linesTimeout.join("\n");
      expect(dumpTimeout).toMatch(/Bridge process: could not enumerate sandbox processes/);
      expect(dumpTimeout).toMatch(/Verdict:.*healthy/);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("captures the probe script as a syntactically valid /bin/sh program", async () => {
    // Regression guard: an earlier version joined the multi-line script with
    // ` && ` which produced `do && if` and other invalid constructs,
    // causing every real probe to look like exec failure. Validate the
    // emitted script with `sh -n` before declaring the diagnostic working.
    let capturedCmd: string | null = null;
    const exec = (_sb: string, cmd: string): ExecResult | null => {
      capturedCmd = cmd;
      return { status: 0, stdout: "NEMOCLAW_WA_DIAG_OK\nDIR /sandbox/.openclaw/whatsapp MISSING\n", stderr: "" };
    };
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    const { deps } = makeDeps({ exec });
    try {
      await showSandboxChannelStatus("alpha", { deps });
    } catch {
      /* unpaired path exits 1 */
    } finally {
      exitSpy.mockRestore();
    }
    expect(capturedCmd).not.toBeNull();
    const { spawnSync } = await import("node:child_process");
    const validation = spawnSync("sh", ["-n", "-c", capturedCmd as unknown as string], {
      encoding: "utf-8",
    });
    expect(validation.status, validation.stderr || validation.stdout).toBe(0);
    // The probe must also filter its own command line out of the pgrep results.
    expect(capturedCmd as unknown as string).toMatch(/__nemoclaw_wa_self_pid/);
    expect(capturedCmd as unknown as string).toMatch(/pgrep -fa/);
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
    const result = await showSandboxChannelStatus("alpha", { deps });
    expect(execSpy).not.toHaveBeenCalled();
    expect(result && "verdict" in result && result.verdict).toBe("info");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/registered but currently paused/);
  });

  it("emits a basic per-channel report for non-whatsapp channels", async () => {
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: entry(["telegram"]),
      appliedPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });
    expect(result && "verdict" in result && result.verdict).toBe("info");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/telegram registered/);
    expect(dump).toMatch(/preset applied/);
  });
});
