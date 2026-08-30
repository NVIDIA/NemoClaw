// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `nemoclaw <sandbox> channels status [--channel <name>] [--json]` —
 * surface bounded, channel-specific diagnostics so the operator can tell
 * apart QR/session state, WebSocket state, inbound event delivery, and
 * policy/config coverage. Issue #4386: a paired WhatsApp channel with a
 * live Noise WebSocket and zero inbound events used to render as
 * "healthy" because the existing `doctor` check only inspected the
 * registry list. The diagnostic below has to fail loud for paired-but-idle.
 */

import { type AgentDefinition, loadAgent } from "../../agent/defs";
import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { B, D, G, R, RD, YW } from "../../cli/terminal-style";
import {
  createBuiltInChannelManifestRegistry,
  getMessagingManifestAvailabilityContext,
} from "../../messaging";
import {
  type ChannelHealthReport,
  type ChannelReadiness,
  type ChannelReadinessCategory,
  channelHealthProbeInputs,
  DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS,
  type DiagnosticSeverity,
  type DiagnosticSignal,
} from "../../messaging/channels/channel-health";
import {
  collectBuiltInMessagingChannelDiagnostics,
  type MessagingChannelDiagnosticSpec,
} from "../../messaging/diagnostics";
import { createBuiltInMessagingHookRegistry } from "../../messaging/hooks";
import {
  readChannelHealthOutputs,
  runMessagingStatusHooks,
} from "../../messaging/hooks/status-runner";
import * as policies from "../../policy";
import * as registry from "../../state/registry";
import { buildConfigStatusSignals } from "./channel-status-config";

// runner.ts (which process-recovery transitively depends on) uses a few CJS
// `require()` calls that vitest's CLI-test project cannot resolve at import
// time. The default in-sandbox exec implementation lives in this lazy loader
// so unit tests can inject an `execSandbox` mock without pulling the runner.
function loadProcessRecovery(): typeof import("./process-recovery") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./process-recovery") as typeof import("./process-recovery");
}

type ExecRunner = (
  sandboxName: string,
  command: string,
  timeoutMs?: number,
) => {
  status: number;
  stdout: string;
  stderr: string;
} | null;

type StatusDeps = {
  loadAgent?: (name: string) => AgentDefinition;
  getSandbox?: typeof registry.getSandbox;
  getAppliedPresets?: (sandboxName: string) => string[];
  getGatewayPresets?: (sandboxName: string, timeoutMs?: number) => string[] | null;
  execSandbox?: ExecRunner;
  now?: () => Date;
  nowMs?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  out?: (line: string) => void;
};

export type ChannelStatusOptions = {
  channel?: string;
  asJson?: boolean;
  wait?: boolean;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
  // When true the action returns the report instead of printing JSON to
  // stdout. The oclif wrapper sets this so the framework's --json handler
  // owns serialization; without it we would print JSON twice.
  quietJson?: boolean;
  deps?: StatusDeps;
};

type ChannelStatusDetailedReport = {
  schemaVersion: 1;
  sandbox: string;
  channel: string;
  report: ChannelHealthReport;
};

type ChannelStatusBasicReport = {
  schemaVersion: 1;
  sandbox: string;
  channel: string;
  verdict: "info";
  signals: DiagnosticSignal[];
};

type ChannelStatusSingleReport = ChannelStatusDetailedReport | ChannelStatusBasicReport;

type ChannelStatusSnapshotReport =
  | ChannelStatusSingleReport
  | {
      schemaVersion: 1;
      sandbox: string;
      channels: ChannelStatusSingleReport[];
    };

export type ChannelStatusWaitState = "ready" | "terminal" | "timeout";

export type ChannelStatusWaitReport = {
  schemaVersion: 1;
  sandbox: string;
  channel: string;
  status: ChannelStatusSingleReport;
  readiness: {
    state: ChannelStatusWaitState;
    category: ChannelReadinessCategory | "timeout" | null;
    reason: string;
    retryable: boolean;
    attempts: number;
    elapsedMs: number;
    lastTransitionAt: string | null;
    lastObserved: ChannelReadiness;
  };
};

export type ChannelStatusReport = ChannelStatusSnapshotReport | ChannelStatusWaitReport;

const DEFAULT_WAIT_TIMEOUT_SECONDS = 180;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 5_000;
const CHANNEL_STATUS_DIAGNOSTICS = collectBuiltInMessagingChannelDiagnostics();
const channelManifestRegistry = createBuiltInChannelManifestRegistry();

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function severityLabel(severity: DiagnosticSeverity): string {
  switch (severity) {
    case "ok":
      return `${G}[ok]${R}`;
    case "warn":
      return `${YW}[warn]${R}`;
    case "fail":
      return `${RD}[fail]${R}`;
    case "info":
    default:
      return `${D}[info]${R}`;
  }
}

function defaultExec(
  sandboxName: string,
  command: string,
  timeoutMs?: number,
): { status: number; stdout: string; stderr: string } | null {
  return loadProcessRecovery().executeSandboxExecCommand(sandboxName, command, timeoutMs);
}

function defaultDeps(deps: StatusDeps | undefined): Required<StatusDeps> {
  return {
    loadAgent: deps?.loadAgent ?? loadAgent,
    getSandbox: deps?.getSandbox ?? registry.getSandbox,
    getAppliedPresets: deps?.getAppliedPresets ?? policies.getAppliedPresets,
    getGatewayPresets: deps?.getGatewayPresets ?? policies.getGatewayPresets,
    execSandbox: deps?.execSandbox ?? defaultExec,
    now: deps?.now ?? (() => new Date()),
    nowMs: deps?.nowMs ?? Date.now,
    sleep:
      deps?.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    out: deps?.out ?? ((line: string) => console.log(line)),
  };
}

function getChannelStatusDiagnostic(channelName: string): MessagingChannelDiagnosticSpec | null {
  return (
    CHANNEL_STATUS_DIAGNOSTICS.find((diagnostic) => diagnostic.channelId === channelName) ?? null
  );
}

function diagnosticChannelNames(): string[] {
  return CHANNEL_STATUS_DIAGNOSTICS.map((diagnostic) => diagnostic.channelId);
}

function renderReport(
  report: ChannelStatusReport,
  asJson: boolean,
  deps: Required<StatusDeps>,
): void {
  if (asJson) {
    deps.out(JSON.stringify(report, null, 2));
    return;
  }
  if ("readiness" in report) {
    renderWaitReport(report, deps);
    return;
  }
  if ("channels" in report) {
    renderAllChannelReport(report, deps);
    return;
  }
  deps.out("");
  deps.out(`  ${B}${CLI_DISPLAY_NAME} channels status:${R} ${report.sandbox} / ${report.channel}`);
  renderSingleChannelSignals(report, deps, { includeDeepDiagnostics: true });
}

function renderWaitReport(report: ChannelStatusWaitReport, deps: Required<StatusDeps>): void {
  deps.out("");
  deps.out(
    `  ${B}${CLI_DISPLAY_NAME} channels readiness:${R} ${report.sandbox} / ${report.channel}`,
  );
  renderSingleChannelSignals(report.status, deps, { includeDeepDiagnostics: true });
  const color = report.readiness.state === "ready" ? G : RD;
  deps.out(`  Readiness: ${color}${report.readiness.state}${R}`);
  deps.out(
    `    ${D}${report.readiness.reason}; attempts=${report.readiness.attempts}; elapsedMs=${report.readiness.elapsedMs}${R}`,
  );
  deps.out("");
}

function renderAllChannelReport(
  report: Extract<ChannelStatusReport, { channels: ChannelStatusSingleReport[] }>,
  deps: Required<StatusDeps>,
): void {
  deps.out("");
  deps.out(`  ${B}${CLI_DISPLAY_NAME} channels status:${R} ${report.sandbox}`);
  if (report.channels.length === 0) {
    deps.out(`    ${severityLabel("info")} Configured channels: none`);
    deps.out(`         ${D}hint: run \`${CLI_NAME} ${report.sandbox} channels add <channel>\`${R}`);
    deps.out("");
    return;
  }
  for (const channelReport of report.channels) {
    deps.out(`  ${B}${channelReport.channel}${R}`);
    renderSingleChannelSignals(channelReport, deps, { includeDeepDiagnostics: false });
  }
}

function renderSingleChannelSignals(
  report: ChannelStatusSingleReport,
  deps: Required<StatusDeps>,
  options: { readonly includeDeepDiagnostics: boolean },
): void {
  if ("report" in report) {
    deps.out(`  Probed at ${report.report.probedAt} (agent: ${report.report.agent})`);
    deps.out("");
    for (const signal of report.report.signals) {
      deps.out(`    ${severityLabel(signal.severity)} ${signal.label}: ${signal.detail}`);
      if (signal.hint) deps.out(`         ${D}hint: ${signal.hint}${R}`);
    }
    deps.out("");
    const verdictColor =
      report.report.verdict === "healthy"
        ? G
        : report.report.verdict === "idle" || report.report.verdict === "unpaired"
          ? YW
          : report.report.verdict === "info"
            ? D
            : RD;
    deps.out(`  Verdict: ${verdictColor}${report.report.verdict}${R}`);
    for (const hint of report.report.hints) {
      deps.out(`    ${D}- ${hint}${R}`);
    }
    deps.out("");
    return;
  }
  for (const signal of report.signals) {
    if (!options.includeDeepDiagnostics && signal.label === "Deep diagnostics") continue;
    deps.out(`    ${severityLabel(signal.severity)} ${signal.label}: ${signal.detail}`);
    if (signal.hint) deps.out(`         ${D}hint: ${signal.hint}${R}`);
  }
  deps.out("");
}

export function exitCodeFor(report: ChannelStatusReport): number {
  if ("readiness" in report) return report.readiness.state === "ready" ? 0 : 1;
  if ("channels" in report) return 0;
  if ("report" in report) {
    switch (report.report.verdict) {
      case "healthy":
      case "info":
      case "unknown":
        return 0;
      default:
        return 1;
    }
  }
  return 0;
}

function buildBasicChannelReport(
  sandboxName: string,
  channelName: string,
  agent: AgentDefinition,
  deps: Required<StatusDeps>,
  diagnostic: MessagingChannelDiagnosticSpec,
  options: { readonly includeDeepDiagnostics?: boolean; readonly channelPaused?: boolean } = {},
): ChannelStatusBasicReport {
  const entry = deps.getSandbox(sandboxName);
  const enabled = registry.getConfiguredMessagingChannelsFromEntry(entry).includes(channelName);
  const disabled = registry.getDisabledMessagingChannelsFromEntry(entry).includes(channelName);
  const appliedPresets = deps.getAppliedPresets(sandboxName);
  const policyPresets =
    diagnostic.policyPresets.length > 0 ? diagnostic.policyPresets : [channelName];
  const presetApplied = policyPresets.some((preset) => appliedPresets.includes(preset));
  const policyLabel = policyPresets.join(", ");
  const signals: DiagnosticSignal[] = [];
  signals.push({
    label: "Channel registration",
    severity: enabled ? (disabled ? "warn" : "ok") : "info",
    detail: enabled
      ? disabled
        ? `${channelName} registered but currently paused`
        : `${channelName} registered`
      : `${channelName} not registered`,
    hint: enabled
      ? undefined
      : `run \`${CLI_NAME} ${sandboxName} channels add ${channelName}\` to enable it`,
  });
  signals.push({
    label: "Policy coverage",
    severity: presetApplied ? "ok" : enabled ? "warn" : "info",
    detail: presetApplied ? `${policyLabel} preset applied` : `${policyLabel} preset not applied`,
    hint: presetApplied
      ? undefined
      : `run \`${CLI_NAME} ${sandboxName} policy add ${policyPresets[0]}\``,
  });
  if (enabled) {
    signals.push(...buildConfigStatusSignals(sandboxName, channelName, entry, agent, deps));
  }
  if (diagnostic.deepProbe !== undefined) {
    // Channel has a deep probe this path does not run: the summary view never
    // runs it, and a paused channel is not probed in detail view. Say so instead
    // of leaving a silent all-[ok] that reads as healthy (#6743).
    signals.push({
      label: "Runtime health",
      severity: "info",
      detail: options.channelPaused
        ? `not checked — ${channelName} is currently paused`
        : "not checked in summary view",
      hint: options.channelPaused
        ? undefined
        : `run \`${CLI_NAME} ${sandboxName} channels status --channel ${channelName}\` for detailed status`,
    });
  } else if (options.includeDeepDiagnostics ?? true) {
    signals.push({
      label: "Deep diagnostics",
      severity: "info",
      detail: `not implemented for ${channelName}; see \`${CLI_NAME} ${sandboxName} doctor\` and \`${CLI_NAME} ${sandboxName} logs --follow\``,
    });
  }
  // Reference the agent in a hint so the deep-diagnostic section is
  // discoverable per agent without needing extra plumbing.
  if (!channelSupportedByAgent(channelName, agent)) {
    signals.unshift({
      label: "Agent support",
      severity: "warn",
      detail: `channel '${channelName}' does not support agent '${agent.name}'`,
    });
  }
  return {
    schemaVersion: 1,
    sandbox: sandboxName,
    channel: channelName,
    verdict: "info",
    signals,
  };
}

function buildUnknownConfiguredChannelReport(
  sandboxName: string,
  channelName: string,
): ChannelStatusBasicReport {
  return {
    schemaVersion: 1,
    sandbox: sandboxName,
    channel: channelName,
    verdict: "info",
    signals: [
      {
        label: "Channel registration",
        severity: "warn",
        detail: `${channelName} registered but not recognized by this CLI build`,
      },
    ],
  };
}

function channelSupportedByAgent(channelName: string, agent: AgentDefinition): boolean {
  return channelManifestRegistry
    .listAvailable(getMessagingManifestAvailabilityContext(agent, channelManifestRegistry.list()))
    .some((manifest) => manifest.id === channelName);
}

function channelHealthStatusHook(channelName: string, agent: AgentDefinition) {
  const agentId = agent.name === "hermes" ? "hermes" : "openclaw";
  const manifest = channelManifestRegistry
    .listAvailable(getMessagingManifestAvailabilityContext(agent, channelManifestRegistry.list()))
    .find((candidate) => candidate.id === channelName);
  return manifest?.hooks.find(
    (hook) =>
      hook.phase === "status" &&
      (!hook.agents || hook.agents.includes(agentId)) &&
      hook.outputs?.some((output) => output.id === "channelHealth") === true,
  );
}

// Runs a deep-probe channel's `phase:"status"` health hook through the
// generic status-hook runner and returns its channel-health report. All
// channel-specific probing + classification lives in the channel's own hook
// (e.g. channels/telegram/hooks/status-health.ts, channels/whatsapp/hooks);
// this stays channel-agnostic. The hook's own `agents` gate skips channels
// with no breadcrumb producer for the requested agent (e.g. Hermes
// telegram), so the caller falls back to the basic report when no health
// output is returned.
function runChannelHealthHook(
  sandboxName: string,
  channelName: string,
  agent: AgentDefinition,
  deps: Required<StatusDeps>,
  diagnostic: MessagingChannelDiagnosticSpec,
  probeTimeoutMs?: number,
): ChannelHealthReport | undefined {
  const entry = deps.getSandbox(sandboxName);
  const channelEnabledInRegistry = registry
    .getConfiguredMessagingChannelsFromEntry(entry)
    .includes(channelName);
  const policyPresets =
    diagnostic.policyPresets.length > 0 ? diagnostic.policyPresets : [channelName];
  const appliedPresets = deps.getAppliedPresets(sandboxName);
  const presetApplied = policyPresets.some((preset) => appliedPresets.includes(preset));
  let presetOnGateway: boolean | null = null;
  try {
    const gatewayPresets = deps.getGatewayPresets(sandboxName);
    presetOnGateway =
      gatewayPresets === null
        ? null
        : policyPresets.some((preset) => gatewayPresets.includes(preset));
  } catch {
    presetOnGateway = null;
  }

  const results = runMessagingStatusHooks({
    agent: agent.name === "hermes" ? "hermes" : "openclaw",
    channels: new Set([channelName]),
    currentSandbox: sandboxName,
    hookRegistry: createBuiltInMessagingHookRegistry({
      statusHealth: {
        executeSandboxCommand: deps.execSandbox,
        timeoutMs: probeTimeoutMs,
      },
    }),
    extraInputs: channelHealthProbeInputs({
      currentSandbox: sandboxName,
      agent: agent.name,
      probedAt: deps.now().toISOString(),
      channelEnabledInRegistry,
      presetApplied,
      presetOnGateway,
    }),
  });
  return results.flatMap(readChannelHealthOutputs)[0];
}

function collectChannelReport(
  sandboxName: string,
  channelName: string,
  agent: AgentDefinition,
  deps: Required<StatusDeps>,
  diagnostic: MessagingChannelDiagnosticSpec,
  hasHealthHook: boolean,
  deadlineMs?: number,
): ChannelStatusSingleReport {
  const collectionDeps = deadlineMs === undefined ? deps : withStatusDeadline(deps, deadlineMs);
  const probeTimeoutMs =
    deadlineMs === undefined
      ? undefined
      : Math.max(1, Math.min(DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS, deadlineMs - deps.nowMs()));
  const disabledChannels = new Set(
    registry.getDisabledMessagingChannelsFromEntry(collectionDeps.getSandbox(sandboxName)),
  );
  const channelIsPaused = disabledChannels.has(channelName);
  const healthReport =
    hasHealthHook && !channelIsPaused
      ? runChannelHealthHook(
          sandboxName,
          channelName,
          agent,
          collectionDeps,
          diagnostic,
          probeTimeoutMs,
        )
      : undefined;
  if (!healthReport) {
    const basicReport = buildBasicChannelReport(
      sandboxName,
      channelName,
      agent,
      collectionDeps,
      diagnostic,
      { channelPaused: channelIsPaused },
    );
    if (!hasHealthHook) return basicReport;
    return {
      schemaVersion: 1,
      sandbox: sandboxName,
      channel: channelName,
      report: {
        schemaVersion: 1,
        agent: agent.name,
        channel: channelName,
        verdict: basicReport.verdict,
        probedAt: collectionDeps.now().toISOString(),
        signals: basicReport.signals,
        hints: basicReport.signals.flatMap((signal) => (signal.hint ? [signal.hint] : [])),
      },
    };
  }
  const configSignals = buildConfigStatusSignals(
    sandboxName,
    channelName,
    collectionDeps.getSandbox(sandboxName),
    agent,
    collectionDeps,
  );
  return {
    schemaVersion: 1,
    sandbox: sandboxName,
    channel: channelName,
    report: { ...healthReport, signals: [...healthReport.signals, ...configSignals] },
  };
}

function withStatusDeadline(deps: Required<StatusDeps>, deadlineMs: number): Required<StatusDeps> {
  const boundedTimeoutMs = (requestedTimeoutMs?: number): number | null => {
    const remainingMs = deadlineMs - deps.nowMs();
    if (remainingMs <= 0) return null;
    return Math.min(requestedTimeoutMs ?? remainingMs, remainingMs);
  };
  return {
    ...deps,
    getGatewayPresets: (sandboxName, requestedTimeoutMs) => {
      const timeoutMs = boundedTimeoutMs(requestedTimeoutMs);
      return timeoutMs === null ? null : deps.getGatewayPresets(sandboxName, timeoutMs);
    },
    execSandbox: (sandboxName, command, requestedTimeoutMs) => {
      const timeoutMs = boundedTimeoutMs(requestedTimeoutMs);
      return timeoutMs === null ? null : deps.execSandbox(sandboxName, command, timeoutMs);
    },
  };
}

async function waitForChannelReadiness(
  sandboxName: string,
  channelName: string,
  readinessSupported: boolean,
  collect: (deadlineMs?: number) => ChannelStatusSingleReport,
  options: ChannelStatusOptions,
  deps: Required<StatusDeps>,
): Promise<ChannelStatusWaitReport> {
  const startedAt = deps.nowMs();
  const timeoutMs = positiveNumber(options.timeoutSeconds, DEFAULT_WAIT_TIMEOUT_SECONDS) * 1_000;
  const deadlineMs = startedAt + timeoutMs;
  const pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_WAIT_POLL_INTERVAL_MS);
  const channelPaused = registry
    .getDisabledMessagingChannelsFromEntry(deps.getSandbox(sandboxName))
    .includes(channelName);
  const pausedReadiness: ChannelReadiness | undefined =
    channelPaused && readinessSupported
      ? {
          state: "terminal",
          category: "runtime",
          reason: "channel_paused",
          retryable: false,
          lastTransitionAt: null,
        }
      : undefined;
  const readReadiness = (status: ChannelStatusSingleReport): ChannelReadiness =>
    pausedReadiness ??
    ("report" in status ? status.report.readiness : undefined) ?? {
      state: "terminal",
      category: "runtime",
      reason: "readiness_not_supported",
      retryable: false,
      lastTransitionAt: null,
    };

  let attempts = 1;
  let status = collect(deadlineMs);
  let lastObserved = readReadiness(status);
  let elapsedMs = Math.max(0, deps.nowMs() - startedAt);
  while (lastObserved.state === "waiting" && elapsedMs < timeoutMs) {
    await deps.sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
    elapsedMs = Math.max(0, deps.nowMs() - startedAt);
    if (elapsedMs >= timeoutMs) break;
    attempts += 1;
    status = collect(deadlineMs);
    lastObserved = readReadiness(status);
    elapsedMs = Math.max(0, deps.nowMs() - startedAt);
  }
  const state: ChannelStatusWaitState =
    lastObserved.state === "waiting" ? "timeout" : lastObserved.state;
  return {
    schemaVersion: 1,
    sandbox: sandboxName,
    channel: channelName,
    status,
    readiness: {
      state,
      category: state === "timeout" ? "timeout" : lastObserved.category,
      reason: state === "timeout" ? "timeout" : lastObserved.reason,
      retryable: lastObserved.retryable,
      attempts,
      elapsedMs,
      lastTransitionAt: lastObserved.lastTransitionAt,
      lastObserved,
    },
  };
}

/**
 * Run the WhatsApp diagnostic or a thin per-channel summary for the named
 * sandbox. The function never throws: any unexpected condition is rendered
 * as a `probe_failed` verdict so a paired-but-idle channel does not get
 * silently marked healthy because a probe step blew up.
 */
export async function showSandboxChannelStatus(
  sandboxName: string,
  options: ChannelStatusOptions = {},
): Promise<ChannelStatusReport | undefined> {
  const deps = defaultDeps(options.deps);
  const channelArg = options.channel?.trim().toLowerCase();
  const asJson = Boolean(options.asJson);
  const quietJson = Boolean(options.quietJson);

  const entry = deps.getSandbox(sandboxName);
  if (!entry) {
    if (asJson) {
      deps.out(
        JSON.stringify(
          { schemaVersion: 1, sandbox: sandboxName, error: "sandbox not registered" },
          null,
          2,
        ),
      );
    } else {
      deps.out(`  Sandbox '${sandboxName}' is not registered.`);
    }
    process.exit(1);
  }

  const agent = deps.loadAgent(entry.agent || "openclaw");

  if (!channelArg) {
    const configuredChannels = registry.getConfiguredMessagingChannelsFromEntry(entry);
    const report: ChannelStatusReport = {
      schemaVersion: 1,
      sandbox: sandboxName,
      channels: configuredChannels.map((channelName) => {
        const diagnostic = getChannelStatusDiagnostic(channelName);
        return diagnostic
          ? buildBasicChannelReport(sandboxName, channelName, agent, deps, diagnostic, {
              includeDeepDiagnostics: false,
            })
          : buildUnknownConfiguredChannelReport(sandboxName, channelName);
      }),
    };
    if (!(asJson && quietJson)) {
      renderReport(report, asJson, deps);
    }
    return report;
  }

  const channelName = channelArg;
  const diagnostic = getChannelStatusDiagnostic(channelName);
  if (!diagnostic) {
    const known = diagnosticChannelNames().join(", ");
    if (asJson) {
      deps.out(
        JSON.stringify(
          { schemaVersion: 1, sandbox: sandboxName, error: `unknown channel '${channelName}'` },
          null,
          2,
        ),
      );
    } else {
      deps.out(`  Unknown channel '${channelName}'. Valid channels: ${known}.`);
    }
    process.exit(1);
  }

  const statusHook = channelHealthStatusHook(channelName, agent);
  const collect = (deadlineMs?: number) =>
    collectChannelReport(
      sandboxName,
      channelName,
      agent,
      deps,
      diagnostic,
      Boolean(statusHook),
      deadlineMs,
    );
  const report: ChannelStatusReport = options.wait
    ? await waitForChannelReadiness(
        sandboxName,
        channelName,
        statusHook?.providesReadiness === true,
        collect,
        options,
        deps,
      )
    : collect();

  if (!(asJson && quietJson)) {
    renderReport(report, asJson, deps);
  }

  const code = exitCodeFor(report);
  if (asJson) return report;
  if (code !== 0) process.exit(code);
  return report;
}
