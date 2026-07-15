// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

// The orchestrator transitively pulls in policy/index.ts and agent/defs.ts,
// both of which require runner.ts via CJS; runner.ts uses `require()` calls
// vitest cannot resolve from a TS source file. Stub the heavy modules so the
// tests stay focused on the orchestrator's diagnostic glue. See
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
import type { DiagnosticSignal } from "../../messaging/channels/channel-health";
import type { SandboxEntry } from "../../state/registry";

type ShowSandboxChannelStatus = typeof import("./channel-status").showSandboxChannelStatus;

export const showSandboxChannelStatus = (async (...args: Parameters<ShowSandboxChannelStatus>) => {
  const mod = await import("./channel-status");
  return mod.showSandboxChannelStatus(...args);
}) as ShowSandboxChannelStatus;

export type ExecResult = { status: number; stdout: string; stderr: string };

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

export function entry(
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

export function makeDeps(opts: {
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

// A telegram log-tail probe stdout that yields the "unknown" verdict
// (reachable + gateway process alive + no conclusive breadcrumbs) so a
// config-focused telegram test does not trip the health exit code. Pair it
// with `gatewayPresets: ["telegram"]` so the policy signal is not a gap.
export const TELEGRAM_PROBE_UNKNOWN_STDOUT = [
  "NEMOCLAW_TG_DIAG_OK",
  "NEMOCLAW_TG_LOG_BEGIN",
  "NEMOCLAW_TG_LOG_END",
  "PROC 42 node /opt/openclaw gateway",
  "NEMOCLAW_TG_PROC_DONE",
].join("\n");

// Wrap a config-read exec so the telegram log-tail probe command (which tails
// /tmp/gateway.log) returns a benign probe response instead of the config
// payload. Everything else falls through to the provided config exec.
export function withTelegramProbe(
  configExec: (sandboxName: string, command: string, timeoutMs?: number) => ExecResult | null,
  probeStdout: string = TELEGRAM_PROBE_UNKNOWN_STDOUT,
): (sandboxName: string, command: string, timeoutMs?: number) => ExecResult | null {
  return (sandboxName, command, timeoutMs) =>
    command.includes("/tmp/gateway.log")
      ? { status: 0, stdout: probeStdout, stderr: "" }
      : configExec(sandboxName, command, timeoutMs);
}

// Read signals from either channel-status report shape: the basic
// `{ verdict, signals }` report or the deep `{ report: { signals } }` report.
export function reportSignals(
  result: Awaited<ReturnType<ShowSandboxChannelStatus>>,
): DiagnosticSignal[] {
  if (!result) return [];
  if ("signals" in result) return result.signals;
  if ("report" in result) return result.report.signals;
  return [];
}
