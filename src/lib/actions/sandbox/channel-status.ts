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
  channelHealthProbeInputs,
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
  getGatewayPresets?: (sandboxName: string) => string[] | null;
  execSandbox?: ExecRunner;
  now?: () => Date;
  out?: (line: string) => void;
};

export type ChannelStatusOptions = {
  channel?: string;
  asJson?: boolean;
  // When true the action returns the report instead of printing JSON to
  // stdout. The oclif wrapper sets this so the framework's --json handler
  // owns serialization; without it we would print JSON twice.
  quietJson?: boolean;
  deps?: StatusDeps;
};

type ChannelStatusSingleReport =
  | {
      schemaVersion: 1;
      sandbox: string;
      channel: string;
      report: ChannelHealthReport;
    }
  | {
      schemaVersion: 1;
      sandbox: string;
      channel: string;
      verdict: "info";
      signals: DiagnosticSignal[];
    };

export type ChannelStatusReport =
  | ChannelStatusSingleReport
  | {
      schemaVersion: 1;
      sandbox: string;
      channels: ChannelStatusSingleReport[];
    };

const CHANNEL_STATUS_DIAGNOSTICS = collectBuiltInMessagingChannelDiagnostics();
const channelManifestRegistry = createBuiltInChannelManifestRegistry();

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
  if ("channels" in report) {
    renderAllChannelReport(report, deps);
    return;
  }
  deps.out("");
  deps.out(`  ${B}${CLI_DISPLAY_NAME} channels status:${R} ${report.sandbox} / ${report.channel}`);
  renderSingleChannelSignals(report, deps, { includeDeepDiagnostics: true });
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

function exitCodeFor(report: ChannelStatusReport): number {
  if ("channels" in report) return 0;
  if ("report" in report) {
    switch (report.report.verdict) {
      case "healthy":
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
): ChannelStatusSingleReport {
  const entry = deps.getSandbox(sandboxName);
  const enabled = registry.getConfiguredMessagingChannelsFromEntry(entry).includes(channelName);
  const disabled = registry.getDisabledMessagingChannelsFromEntry(entry).includes(channelName);
  const appliedPresets = deps.getAppliedPresets(sandboxName);
  const policyPresets =
    diagnostic.policyPresets.length > 0 ? diagnostic.policyPresets : [channelName];
  const presetInRegistry = policyPresets.some((preset) => appliedPresets.includes(preset));
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
    severity: presetInRegistry ? "ok" : enabled ? "warn" : "info",
    detail: presetInRegistry
      ? `${policyLabel} preset applied`
      : `${policyLabel} preset not applied`,
    hint: presetInRegistry
      ? undefined
      : `run \`${CLI_NAME} ${sandboxName} policy-add ${policyPresets[0]}\``,
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
        : `run \`${CLI_NAME} ${sandboxName} channels status --channel ${channelName}\` to probe live health`,
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
): ChannelStatusSingleReport {
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

// Manifest-first gate for `runChannelHealthHook`: returns true when the
// channel declares a `phase: "status"` hook that emits a `channelHealth`
// output. That is the output id `readChannelHealthOutputs` looks for, so
// keying the gate off it keeps orchestration + hook wiring in sync without
// hard-coding channel names or `deepProbe` strings.
function channelHasChannelHealthStatusHook(channelName: string): boolean {
  const manifest = channelManifestRegistry.get(channelName);
  if (!manifest) return false;
  return manifest.hooks.some(
    (hook) =>
      hook.phase === "status" &&
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
): ChannelHealthReport | undefined {
  const entry = deps.getSandbox(sandboxName);
  const channelEnabledInRegistry = registry
    .getConfiguredMessagingChannelsFromEntry(entry)
    .includes(channelName);
  const policyPresets =
    diagnostic.policyPresets.length > 0 ? diagnostic.policyPresets : [channelName];
  const appliedPresets = deps.getAppliedPresets(sandboxName);
  const presetInRegistry = policyPresets.some((preset) => appliedPresets.includes(preset));
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
      statusHealth: { executeSandboxCommand: deps.execSandbox },
    }),
    extraInputs: channelHealthProbeInputs({
      currentSandbox: sandboxName,
      agent: agent.name,
      probedAt: deps.now().toISOString(),
      channelEnabledInRegistry,
      presetInRegistry,
      presetOnGateway,
    }),
  });
  return results.flatMap(readChannelHealthOutputs)[0];
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

  const disabledChannels = new Set(registry.getDisabledMessagingChannelsFromEntry(entry));
  const channelIsPaused = disabledChannels.has(channelName);

  // Manifest-first gating: a channel opts into a deep runtime probe by
  // declaring a `phase: "status"` hook whose output includes a
  // `channelHealth`-shaped status. The generic status-hook runner then owns
  // dispatch, and this orchestrator stays channel-agnostic. Keeping the
  // check tied to the `channelHealth` output id (rather than "any status
  // hook") preserves the existing target set — whatsapp and telegram — so
  // slack/teams status hooks that produce different output kinds do not get
  // pulled in here.
  const healthReport =
    channelHasChannelHealthStatusHook(channelName) && !channelIsPaused
      ? runChannelHealthHook(sandboxName, channelName, agent, deps, diagnostic)
      : undefined;
  let report: ChannelStatusReport;
  if (healthReport) {
    // Append the config-value signals (#5691/#5695: group policy, mention mode,
    // allowed IDs) the basic report shows, so `--channel <ch>` reports both the
    // channel config and live runtime health.
    const configSignals = buildConfigStatusSignals(
      sandboxName,
      channelName,
      deps.getSandbox(sandboxName),
      agent,
      deps,
    );
    report = {
      schemaVersion: 1,
      sandbox: sandboxName,
      channel: channelName,
      report: { ...healthReport, signals: [...healthReport.signals, ...configSignals] },
    };
  } else {
    report = buildBasicChannelReport(sandboxName, channelName, agent, deps, diagnostic, {
      channelPaused: channelIsPaused,
    });
  }

  if (!(asJson && quietJson)) {
    renderReport(report, asJson, deps);
  }

  const code = exitCodeFor(report);
  if (asJson) return report;
  if (code !== 0) process.exit(code);
  return report;
}
