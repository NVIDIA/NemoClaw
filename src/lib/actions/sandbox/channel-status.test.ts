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
  getMessagingPlanFromEntry: vi.fn((entry) => entry?.messaging?.plan ?? null),
  getConfiguredMessagingChannelsFromEntry: vi.fn((entry) => {
    const channels = entry?.messaging?.plan?.channels;
    return Array.isArray(channels)
      ? channels
          .filter((channel) => channel?.configured === true)
          .map((channel) => channel.channelId)
      : [];
  }),
  getDisabledMessagingChannelsFromEntry: vi.fn((entry) => {
    const disabled = entry?.messaging?.plan?.disabledChannels;
    return Array.isArray(disabled) ? [...disabled] : [];
  }),
}));

vi.mock("../../agent/defs", () => ({
  loadAgent: vi.fn(),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxExecCommand: vi.fn(),
}));

import type { AgentDefinition } from "../../agent/defs";
import type { SandboxMessagingInputReference } from "../../messaging/manifest";
import type { SandboxEntry } from "../../state/registry";
import { showSandboxChannelStatus } from "./channel-status";

type ExecResult = { status: number; stdout: string; stderr: string };

const PROBED_AT = new Date("2026-05-28T04:00:00.000Z");

function fakeAgent(name: "openclaw" | "hermes" = "openclaw"): AgentDefinition {
  const configDir = name === "openclaw" ? "/sandbox/.openclaw" : "/sandbox/.hermes";
  const stateDirs = name === "openclaw" ? ["whatsapp"] : ["platforms"];
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
      return {
        dir: configDir,
        configFile: name === "openclaw" ? "openclaw.json" : "config.yaml",
        envFile: name === "hermes" ? ".env" : null,
        format: name === "openclaw" ? "json" : "yaml",
      };
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
  channelInputs: Record<string, SandboxMessagingInputReference[]> = {},
  agentName: "openclaw" | "hermes" = "openclaw",
): SandboxEntry {
  const disabled = new Set(disabledChannels);
  return {
    name: "alpha",
    agent: agentName,
    messaging: {
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName: "alpha",
        agent: agentName,
        workflow: "onboard",
        channels: messagingChannels.map((channelId) => ({
          channelId,
          displayName: channelId,
          authMode: channelId === "whatsapp" ? "in-sandbox-qr" : "token-paste",
          active: !disabled.has(channelId),
          selected: true,
          configured: true,
          disabled: disabled.has(channelId),
          inputs: channelInputs[channelId] ?? [],
          hooks: [],
        })),
        disabledChannels,
        credentialBindings: [],
        networkPolicy: { presets: [], entries: [] },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      },
    },
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
    const result = await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    expect(result && "report" in result && result.report.verdict).toBe("healthy");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Verdict:.*healthy/);
  });

  it("returns probe_failed when openshell exec produces no marker", async () => {
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
    const stdout = [
      "NEMOCLAW_WA_DIAG_OK",
      "DIR /sandbox/.openclaw/whatsapp MISSING",
      "NEMOCLAW_WA_LOG_BEGIN",
      "NEMOCLAW_WA_LOG_END",
    ].join("\n");
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

  it("uses the hermes pairing hint when the agent is hermes", async () => {
    const stdout = [
      "NEMOCLAW_WA_DIAG_OK",
      "DIR /sandbox/.hermes/platforms/whatsapp/session MISSING",
      "NEMOCLAW_WA_LOG_BEGIN",
      "NEMOCLAW_WA_LOG_END",
    ].join("\n");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout, stderr: "" }),
      agentName: "hermes",
    });
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
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
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    try {
      const { deps: depsNoMatch, out_lines: linesNoMatch } = makeDeps({
        exec: () => ({ status: 0, stdout: stdoutNoMatch, stderr: "" }),
      });
      try {
        await showSandboxChannelStatus("alpha", { deps: depsNoMatch, channel: "whatsapp" });
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
      await showSandboxChannelStatus("alpha", { deps: depsTimeout, channel: "whatsapp" });
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
      return {
        status: 0,
        stdout: "NEMOCLAW_WA_DIAG_OK\nDIR /sandbox/.openclaw/whatsapp MISSING\n",
        stderr: "",
      };
    };
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps } = makeDeps({ exec });
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
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
    const result = await showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" });
    expect(execSpy).not.toHaveBeenCalled();
    expect(result && "verdict" in result && result.verdict).toBe("info");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/registered but currently paused/);
  });

  it("emits a compact all-channel report when no channel is selected", async () => {
    const commands: string[] = [];
    const { deps, out_lines } = makeDeps({
      exec: (_sandbox, command) => {
        commands.push(command);
        return command.includes("/sandbox/.openclaw/openclaw.json")
          ? {
              status: 0,
              stdout: JSON.stringify({
                channels: {
                  telegram: {
                    accounts: {
                      default: {
                        groupPolicy: "open",
                      },
                    },
                  },
                },
              }),
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "" };
      },
      sandbox: entry(["telegram", "whatsapp"], [], {
        telegram: [
          {
            channelId: "telegram",
            inputId: "groupPolicy",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_GROUP_POLICY",
            statePath: "telegramConfig.groupPolicy",
            value: "open",
          },
        ],
      }),
      appliedPresets: ["telegram", "whatsapp"],
    });
    const result = await showSandboxChannelStatus("alpha", { deps });

    expect(
      result && "channels" in result && result.channels.map((channel) => channel.channel),
    ).toEqual(["telegram", "whatsapp"]);
    expect(commands.join("\n")).not.toMatch(/NEMOCLAW_WA_DIAG_OK/);
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/NemoClaw channels status:.*alpha/);
    expect(dump).toMatch(/\btelegram\b/);
    expect(dump).toMatch(/\bwhatsapp\b/);
    expect(dump).toMatch(/Telegram group policy \(TELEGRAM_GROUP_POLICY\):\s+open/);
    expect(dump).not.toMatch(/Deep diagnostics/);
    expect(dump).not.toMatch(/Probed at/);
  });

  it("prints an empty-state hint when no channels are configured", async () => {
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: entry([]),
      appliedPresets: [],
    });
    const result = await showSandboxChannelStatus("alpha", { deps });

    expect(result && "channels" in result && result.channels).toEqual([]);
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Configured channels: none/);
    expect(dump).toMatch(/channels add <channel>/);
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

  it("marks rendered config ok when the sandbox config matches the sandbox entry", async () => {
    const { deps, out_lines } = makeDeps({
      exec: (_sandbox, command) =>
        command.includes("/sandbox/.openclaw/openclaw.json")
          ? {
              status: 0,
              stdout: JSON.stringify({
                channels: {
                  telegram: {
                    accounts: {
                      default: {
                        groupPolicy: "allowlist",
                      },
                    },
                  },
                },
              }),
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "" },
      sandbox: entry(["telegram"], [], {
        telegram: [
          {
            channelId: "telegram",
            inputId: "botToken",
            kind: "secret",
            required: true,
            sourceEnv: "TELEGRAM_BOT_TOKEN",
            credentialAvailable: true,
          },
          {
            channelId: "telegram",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_REQUIRE_MENTION",
            statePath: "telegramConfig.requireMention",
            value: "1",
          },
          {
            channelId: "telegram",
            inputId: "groupPolicy",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_GROUP_POLICY",
            statePath: "telegramConfig.groupPolicy",
            value: "allowlist",
          },
        ],
      }),
      appliedPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });

    expect(result && "verdict" in result && result.verdict).toBe("info");
    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find((signal) => signal.label === "Telegram group policy (TELEGRAM_GROUP_POLICY)"),
    ).toMatchObject({
      severity: "ok",
      detail: "allowlist",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Telegram group mention mode (TELEGRAM_REQUIRE_MENTION)",
      ),
    ).toBeUndefined();
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Telegram group policy \(TELEGRAM_GROUP_POLICY\):\s+allowlist/);
    expect(dump).not.toMatch(/Telegram Bot Token/);
    expect(dump).not.toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  it("warns when rendered config differs from the sandbox entry", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            telegram: {
              accounts: {
                default: {
                  groupPolicy: "open",
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["telegram"], [], {
        telegram: [
          {
            channelId: "telegram",
            inputId: "groupPolicy",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_GROUP_POLICY",
            statePath: "telegramConfig.groupPolicy",
            value: "allowlist",
          },
        ],
      }),
      appliedPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find((signal) => signal.label === "Telegram group policy (TELEGRAM_GROUP_POLICY)"),
    ).toMatchObject({
      severity: "warn",
      detail: "expected allowlist; rendered open",
    });
  });

  it("warns once when a shared rendered config source is unreadable", async () => {
    const { deps, out_lines } = makeDeps({
      exec: () => ({
        status: 1,
        stdout: "",
        stderr: "cat: /sandbox/.openclaw/openclaw.json: No such file or directory",
      }),
      sandbox: entry(["teams"], [], {
        teams: [
          {
            channelId: "teams",
            inputId: "appId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_APP_ID",
            statePath: "teamsConfig.appId",
            value: "2542103c-7a1e-408a-b2f3-667e09e86783",
          },
          {
            channelId: "teams",
            inputId: "tenantId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_TENANT_ID",
            statePath: "teamsConfig.tenantId",
            value: "43083d15-7273-40c1-b7db-39efd9ccc17a",
          },
          {
            channelId: "teams",
            inputId: "allowedUsers",
            kind: "config",
            required: false,
            sourceEnv: "TEAMS_ALLOWED_USERS",
            statePath: "allowedIds.teams",
            value: "205f29da-231e-4a0e-a0b2-b398e6302087",
          },
          {
            channelId: "teams",
            inputId: "webhookPort",
            kind: "config",
            required: false,
            sourceEnv: "MSTEAMS_PORT",
            statePath: "teamsConfig.webhookPort",
            value: "3978",
          },
          {
            channelId: "teams",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "TEAMS_REQUIRE_MENTION",
            statePath: "teamsConfig.requireMention",
            value: "1",
          },
        ],
      }),
      appliedPresets: ["teams"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "teams",
    });

    const signals = result && "signals" in result ? result.signals : [];
    const sourceWarnings = signals.filter((signal) => signal.label === "Rendered config source");
    expect(sourceWarnings).toHaveLength(1);
    expect(sourceWarnings[0]).toMatchObject({
      severity: "warn",
      detail: "could not read /sandbox/.openclaw/openclaw.json; config comparisons not checked",
    });
    expect(
      signals.find((signal) => signal.label === "Microsoft Teams Client ID (MSTEAMS_APP_ID)"),
    ).toMatchObject({
      severity: "info",
      detail: "2542103c-7a1e-408a-b2f3-667e09e86783 (not checked)",
    });
    expect(
      signals.find(
        (signal) =>
          signal.label ===
          "Microsoft Teams AAD Object IDs (comma-separated allowlist) (TEAMS_ALLOWED_USERS)",
      ),
    ).toMatchObject({
      severity: "info",
      detail: "205f29da-231e-4a0e-a0b2-b398e6302087 (not checked)",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Microsoft Teams mention mode (TEAMS_REQUIRE_MENTION)",
      ),
    ).toMatchObject({
      severity: "info",
      detail: "1 (not checked)",
    });
    const sourceReadFailures = out_lines
      .join("\n")
      .match(/could not read \/sandbox\/\.openclaw\/openclaw\.json/g);
    expect(sourceReadFailures).toHaveLength(1);
  });

  it("treats 0/1 registry config as matching boolean rendered config", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            msteams: {
              requireMention: true,
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["teams"], [], {
        teams: [
          {
            channelId: "teams",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "TEAMS_REQUIRE_MENTION",
            statePath: "teamsConfig.requireMention",
            value: "1",
          },
        ],
      }),
      appliedPresets: ["teams"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "teams",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) => signal.label === "Microsoft Teams mention mode (TEAMS_REQUIRE_MENTION)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "1",
    });
  });

  it("compares manifest-derived allowlist render values", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            msteams: {
              allowFrom: ["205f29da-231e-4a0e-a0b2-b398e6302087"],
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["teams"], [], {
        teams: [
          {
            channelId: "teams",
            inputId: "allowedUsers",
            kind: "config",
            required: false,
            sourceEnv: "TEAMS_ALLOWED_USERS",
            statePath: "allowedIds.teams",
            value: "205f29da-231e-4a0e-a0b2-b398e6302087",
          },
        ],
      }),
      appliedPresets: ["teams"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "teams",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) =>
          signal.label ===
          "Microsoft Teams AAD Object IDs (comma-separated allowlist) (TEAMS_ALLOWED_USERS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "205f29da-231e-4a0e-a0b2-b398e6302087",
    });
  });

  it("compares Discord guild-derived render values", async () => {
    const { deps, out_lines } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            discord: {
              guilds: {
                "1504155275899437177": {
                  requireMention: true,
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["discord"], [], {
        discord: [
          {
            channelId: "discord",
            inputId: "serverId",
            kind: "config",
            required: false,
            sourceEnv: "DISCORD_SERVER_ID",
            statePath: "discordGuilds.serverId",
            value: "1504155275899437177",
          },
          {
            channelId: "discord",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "DISCORD_REQUIRE_MENTION",
            statePath: "discordGuilds.requireMention",
            value: "1",
          },
        ],
      }),
      appliedPresets: ["discord"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "discord",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) =>
          signal.label === "Discord Server ID (for guild workspace access) (DISCORD_SERVER_ID)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "1504155275899437177",
    });
    expect(
      signals.find((signal) => signal.label === "Discord mention mode (DISCORD_REQUIRE_MENTION)"),
    ).toMatchObject({
      severity: "ok",
      detail: "1",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Discord User ID (optional guild allowlist) (DISCORD_USER_ID)",
      ),
    ).toBeUndefined();
    const dump = out_lines.join("\n");
    expect(dump).toMatch(
      /Discord Server ID \(for guild workspace access\) \(DISCORD_SERVER_ID\):\s+1504155275899437177/,
    );
    expect(dump).toMatch(/Discord mention mode \(DISCORD_REQUIRE_MENTION\):\s+1/);
  });

  it("compares Slack OpenClaw allowlist render values", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            slack: {
              accounts: {
                default: {
                  allowFrom: ["U01ABC2DEF3"],
                  channels: {
                    C012AB3CD: {
                      enabled: true,
                      requireMention: true,
                      users: ["U01ABC2DEF3"],
                    },
                  },
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["slack"], [], {
        slack: [
          {
            channelId: "slack",
            inputId: "allowedUsers",
            kind: "config",
            required: false,
            sourceEnv: "SLACK_ALLOWED_USERS",
            statePath: "allowedIds.slack",
            value: "U01ABC2DEF3",
          },
          {
            channelId: "slack",
            inputId: "allowedChannels",
            kind: "config",
            required: false,
            sourceEnv: "SLACK_ALLOWED_CHANNELS",
            statePath: "slackConfig.allowedChannels",
            value: "C012AB3CD",
          },
        ],
      }),
      appliedPresets: ["slack"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "slack",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) =>
          signal.label === "Slack Member IDs (comma-separated allowlist) (SLACK_ALLOWED_USERS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "U01ABC2DEF3",
    });
    expect(
      signals.find(
        (signal) =>
          signal.label === "Slack Channel IDs (comma-separated allowlist) (SLACK_ALLOWED_CHANNELS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "C012AB3CD",
    });
  });

  it("does not treat Slack wildcard channel policy as configured channel IDs", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            slack: {
              accounts: {
                default: {
                  allowFrom: ["U0B5BQABTL4"],
                  channels: {
                    "*": {
                      enabled: true,
                      requireMention: true,
                      users: ["U0B5BQABTL4"],
                    },
                  },
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["slack"], [], {
        slack: [
          {
            channelId: "slack",
            inputId: "allowedUsers",
            kind: "config",
            required: false,
            sourceEnv: "SLACK_ALLOWED_USERS",
            statePath: "allowedIds.slack",
            value: "U0B5BQABTL4",
          },
        ],
      }),
      appliedPresets: ["slack"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "slack",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) =>
          signal.label === "Slack Member IDs (comma-separated allowlist) (SLACK_ALLOWED_USERS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "U0B5BQABTL4",
    });
    expect(
      signals.find(
        (signal) =>
          signal.label === "Slack Channel IDs (comma-separated allowlist) (SLACK_ALLOWED_CHANNELS)",
      ),
    ).toBeUndefined();
  });

  it("compares OpenClaw WeChat account render values", async () => {
    const { deps } = makeDeps({
      exec: (_sandbox, command) => {
        if (command.includes("/sandbox/.openclaw/openclaw.json")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              channels: {
                "openclaw-weixin": {
                  accounts: {
                    "wechat-account": {
                      enabled: true,
                    },
                  },
                },
              },
            }),
            stderr: "",
          };
        }
        if (command.includes("/sandbox/.openclaw/openclaw-weixin/accounts/wechat-account.json")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              baseUrl: "https://ilinkai.wechat.com",
              userId: "wechat-user",
            }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: "" };
      },
      sandbox: entry(["wechat"], [], {
        wechat: [
          {
            channelId: "wechat",
            inputId: "accountId",
            kind: "config",
            required: true,
            sourceEnv: "WECHAT_ACCOUNT_ID",
            statePath: "wechatConfig.accountId",
            value: "wechat-account",
          },
          {
            channelId: "wechat",
            inputId: "baseUrl",
            kind: "config",
            required: false,
            sourceEnv: "WECHAT_BASE_URL",
            statePath: "wechatConfig.baseUrl",
            value: "https://ilinkai.wechat.com",
          },
          {
            channelId: "wechat",
            inputId: "userId",
            kind: "config",
            required: false,
            sourceEnv: "WECHAT_USER_ID",
            statePath: "wechatConfig.userId",
            value: "wechat-user",
          },
          {
            channelId: "wechat",
            inputId: "allowedIds",
            kind: "config",
            required: false,
            sourceEnv: "WECHAT_ALLOWED_IDS",
            statePath: "allowedIds.wechat",
            value: "wechat-user",
          },
        ],
      }),
      appliedPresets: ["wechat"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "wechat",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(signals.find((signal) => signal.label === "WECHAT_ACCOUNT_ID")).toMatchObject({
      severity: "ok",
      detail: "wechat-account",
    });
    expect(signals.find((signal) => signal.label === "WECHAT_BASE_URL")).toMatchObject({
      severity: "ok",
      detail: "https://ilinkai.wechat.com",
    });
    expect(signals.find((signal) => signal.label === "WECHAT_USER_ID")).toMatchObject({
      severity: "ok",
      detail: "wechat-user",
    });
    expect(
      signals.find(
        (signal) => signal.label === "WeChat User ID(s) (DM allowlist) (WECHAT_ALLOWED_IDS)",
      ),
    ).toBeUndefined();
  });

  it("compares Hermes WeChat values through rendered WEIXIN env keys", async () => {
    const { deps } = makeDeps({
      exec: (_sandbox, command) =>
        command.includes("/sandbox/.hermes/.env")
          ? {
              status: 0,
              stdout: [
                "WEIXIN_ACCOUNT_ID=wxid_abc",
                "WEIXIN_BASE_URL=https://wechat.example.test",
                "WEIXIN_ALLOWED_USERS=wxid_abc,wxid_def",
              ].join("\n"),
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "" },
      agentName: "hermes",
      sandbox: entry(
        ["wechat"],
        [],
        {
          wechat: [
            {
              channelId: "wechat",
              inputId: "accountId",
              kind: "config",
              required: true,
              sourceEnv: "WECHAT_ACCOUNT_ID",
              statePath: "wechatConfig.accountId",
              value: "wxid_abc",
            },
            {
              channelId: "wechat",
              inputId: "baseUrl",
              kind: "config",
              required: false,
              sourceEnv: "WECHAT_BASE_URL",
              statePath: "wechatConfig.baseUrl",
              value: "https://wechat.example.test",
            },
            {
              channelId: "wechat",
              inputId: "userId",
              kind: "config",
              required: false,
              sourceEnv: "WECHAT_USER_ID",
              statePath: "wechatConfig.userId",
              value: "wxid_abc",
            },
            {
              channelId: "wechat",
              inputId: "allowedIds",
              kind: "config",
              required: false,
              sourceEnv: "WECHAT_ALLOWED_IDS",
              statePath: "allowedIds.wechat",
              value: "wxid_abc,wxid_def",
            },
          ],
        },
        "hermes",
      ),
      appliedPresets: ["wechat"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "wechat",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(signals.find((signal) => signal.label === "WECHAT_ACCOUNT_ID")).toMatchObject({
      severity: "ok",
      detail: "wxid_abc",
    });
    expect(signals.find((signal) => signal.label === "WECHAT_BASE_URL")).toMatchObject({
      severity: "ok",
      detail: "https://wechat.example.test",
    });
    expect(
      signals.find(
        (signal) => signal.label === "WeChat User ID(s) (DM allowlist) (WECHAT_ALLOWED_IDS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "wxid_abc,wxid_def",
    });
    expect(signals.find((signal) => signal.label === "WECHAT_USER_ID")).toBeUndefined();
  });

  it("uses manifest defaults when no stored config value exists", async () => {
    const { deps, out_lines } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            telegram: {
              accounts: {
                default: {
                  groupPolicy: "open",
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["telegram"]),
      appliedPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find((signal) => signal.label === "Telegram group policy (TELEGRAM_GROUP_POLICY)"),
    ).toMatchObject({
      severity: "ok",
      detail: "open (default)",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Telegram group mention mode (TELEGRAM_REQUIRE_MENTION)",
      ),
    ).toBeUndefined();
    const dump = out_lines.join("\n");
    expect(dump).not.toMatch(/Telegram User ID \(for DM access\)/);
    expect(dump).toMatch(/Telegram group policy \(TELEGRAM_GROUP_POLICY\):\s+open \(default\)/);
  });
});
