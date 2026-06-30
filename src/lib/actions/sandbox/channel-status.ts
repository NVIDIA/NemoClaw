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

import YAML from "yaml";
import { type AgentDefinition, loadAgent } from "../../agent/defs";
import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { B, D, G, R, RD, YW } from "../../cli/terminal-style";
import type {
  RenderedChannelConfigParser,
  RenderedConfigSource,
  RenderedConfigVisibilityKey,
} from "../../messaging";
import {
  createBuiltInChannelManifestRegistry,
  getBuiltInRenderedConfigParser,
  getMessagingManifestAvailabilityContext,
  tryGetMessagingAgentId,
} from "../../messaging";
import {
  collectBuiltInMessagingChannelDiagnostics,
  type MessagingChannelDiagnosticSpec,
} from "../../messaging/diagnostics";
import type {
  ChannelConfigInputSpec,
  MessagingAgentId,
  MessagingSerializableValue,
  SandboxMessagingInputReference,
} from "../../messaging/manifest";
import * as policies from "../../policy";
import {
  type DiagnosticSeverity,
  type DiagnosticSignal,
  evaluateWhatsappDiagnostics,
  parseWhatsappHeartbeat,
  summarizeWhatsappLogLines,
  type WhatsappDiagnosticReport,
  type WhatsappHeartbeat,
  type WhatsappProbeInput,
} from "../../sandbox/whatsapp-diagnostics";
import * as registry from "../../state/registry";

// runner.ts (which process-recovery transitively depends on) uses a few CJS
// `require()` calls that vitest's CLI-test project cannot resolve at import
// time. The default in-sandbox exec implementation lives in this lazy loader
// so unit tests can inject an `execSandbox` mock without pulling the runner.
function loadProcessRecovery(): typeof import("./process-recovery") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./process-recovery") as typeof import("./process-recovery");
}

// Inline single-quote shell quoting — the probe script only ever quotes
// trusted path strings derived from the agent manifest (`configDir/...`),
// so we don't need the full quoting matrix from `runner.shellQuote`. Keep
// the implementation tiny and avoid the runner import so the orchestrator
// stays loadable from unit tests.
function quotePath(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  | { schemaVersion: 1; sandbox: string; channel: string; report: WhatsappDiagnosticReport }
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

// Bound how long we are willing to block inside an `openshell sandbox exec`
// for the inline diagnostic snippet. WhatsApp's bridge sometimes goes
// unresponsive when the Noise WebSocket is stuck; a fast hard cap keeps
// channels status from inheriting that hang.
const WHATSAPP_PROBE_TIMEOUT_MS = 8_000;
const CHANNEL_STATUS_DIAGNOSTICS = collectBuiltInMessagingChannelDiagnostics();
const channelManifestRegistry = createBuiltInChannelManifestRegistry();

const SHELL_OK = "NEMOCLAW_WA_DIAG_OK";
const HEARTBEAT_BEGIN = "NEMOCLAW_WA_HEARTBEAT_BEGIN";
const HEARTBEAT_END = "NEMOCLAW_WA_HEARTBEAT_END";
const LOG_BEGIN = "NEMOCLAW_WA_LOG_BEGIN";
const LOG_END = "NEMOCLAW_WA_LOG_END";
const PROC_DONE = "NEMOCLAW_WA_PROC_DONE";
const CONFIG_STATUS_TIMEOUT_MS = 5_000;

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

function resolveStateDirs(agent: AgentDefinition): string[] {
  const configDir = agent.configPaths?.dir;
  if (!configDir) return [];
  const stateDirs = new Set(agent.stateDirs ?? []);
  // The two known WhatsApp bridge layouts:
  //   OpenClaw: <configDir>/whatsapp
  //   Hermes:   <configDir>/platforms/whatsapp/session
  // We probe the session subdirectory for Hermes because the agent manifest
  // pre-creates the parent `platforms/whatsapp` directory at provisioning
  // time so the state_dirs backup can preserve it across rebuilds. A fresh
  // unpaired sandbox therefore already has a non-empty `platforms/whatsapp`
  // directory — only the `session` subdir is created after a successful
  // QR pairing.
  const candidates: string[] = [];
  if (stateDirs.has("whatsapp")) candidates.push(`${configDir}/whatsapp`);
  if (stateDirs.has("platforms")) candidates.push(`${configDir}/platforms/whatsapp/session`);
  if (candidates.length === 0) {
    // Fallback: probe both shapes even when the manifest does not declare
    // the dir — best-effort but safe because non-existent paths just yield
    // "missing" probe output.
    candidates.push(`${configDir}/whatsapp`, `${configDir}/platforms/whatsapp/session`);
  }
  return Array.from(new Set(candidates));
}

function buildProbeScript(stateDirs: readonly string[]): string {
  // The script:
  //  1. Marks success with SHELL_OK so we can disambiguate "exec failed" from
  //     "exec succeeded but produced nothing".
  //  2. Lists each candidate state directory and emits a single "POPULATED"
  //     or "EMPTY" / "MISSING" line per dir.
  //  3. Cats the first heartbeat-shaped file it finds, wrapped in begin/end
  //     markers so the parser can extract it without parsing find output.
  //  4. Tails up to 200 lines of bridge log files and forwards only short
  //     lines that match the diagnostic regex set. The host parser further
  //     filters to summary phrases.
  //  5. Runs pgrep for known bridge process names, then filters out the probe
  //     shell itself and the pgrep call so the diagnostic does not report a
  //     bridge as "running" when the only match is our own command line.
  // The script is joined with newlines so the embedded `for` / `if`
  // constructs parse as compound statements. Joining the whole thing with
  // ` && ` corrupts the grammar (e.g. `do && if`), which `/bin/sh` rejects
  // before the SHELL_OK marker prints and every live probe gets misread as
  // unreachable. The leading `set +e` makes the probe survive missing log
  // files and empty pgrep matches without aborting at the first non-zero
  // exit.
  const quotedDirs = stateDirs.map(quotePath).join(" ");
  return [
    `set +e`,
    `printf '%s\\n' ${quotePath(SHELL_OK)}`,
    `for dir in ${quotedDirs}; do`,
    `  if [ ! -d "$dir" ]; then printf 'DIR %s MISSING\\n' "$dir"; continue; fi`,
    `  if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then`,
    `    printf 'DIR %s EMPTY\\n' "$dir"`,
    `  else`,
    `    printf 'DIR %s POPULATED\\n' "$dir"`,
    `  fi`,
    `done`,
    `for dir in ${quotedDirs}; do`,
    `  for candidate in heartbeat.json status.json health.json bridge-status.json; do`,
    `    if [ -f "$dir/$candidate" ]; then`,
    `      printf '%s\\n' ${quotePath(HEARTBEAT_BEGIN)}`,
    `      cat "$dir/$candidate" 2>/dev/null | head -c 8192`,
    `      printf '\\n%s\\n' ${quotePath(HEARTBEAT_END)}`,
    `      break 2`,
    `    fi`,
    `  done`,
    `done`,
    `printf '%s\\n' ${quotePath(LOG_BEGIN)}`,
    `for dir in ${quotedDirs}; do`,
    `  for log in "$dir"/*.log "$dir"/logs/*.log; do`,
    `    [ -f "$log" ] || continue`,
    `    tail -n 200 "$log" 2>/dev/null | grep -E 'connection\\.(open|close|update|update.*restart)|ws (open|close)|401|unauthorized|qr.*(expired|timeout)|restartRequired|loggedOut|logged out|getMessage' | tail -n 20`,
    `  done`,
    `done`,
    `printf '%s\\n' ${quotePath(LOG_END)}`,
    `__nemoclaw_wa_self_pid=$$`,
    // Match both process-name-with-whatsapp and processes whose argv
    // mentions the WhatsApp state directory or known plugin paths. A
    // bridge that runs inside the parent agent process (e.g. an OpenClaw
    // plugin loaded via a generic `node` entry point) usually carries the
    // platforms/whatsapp path on its command line via `--state-dir` or
    // similar.
    `pgrep -fa 'whatsapp|baileys|platforms/whatsapp|openclaw-whatsapp|hermes.*whatsapp' 2>/dev/null | awk -v self="$__nemoclaw_wa_self_pid" '$1 != self && $0 !~ /pgrep -fa/ && $0 !~ /NEMOCLAW_WA_DIAG_OK/ { print "PROC " $0 }' | head -n 5`,
    // Always emit PROC_DONE after the pgrep pipeline so the parser can tell
    // apart "pgrep completed with no matches" (the bridge runs under a
    // process name that does not contain `whatsapp` or `baileys`, or has
    // crashed) from "the probe never reached pgrep" (script aborted
    // mid-flight). Without this marker both cases collapse to `null`.
    `printf '%s\\n' ${quotePath(PROC_DONE)}`,
  ].join("\n");
}

type ParsedProbe = {
  reachable: boolean;
  stateDirPopulated: boolean | null;
  heartbeatRaw: string | null;
  logLines: string[];
  bridgeProcessAlive: boolean | null;
};

function parseProbeOutput(stdout: string): ParsedProbe {
  const lines = stdout.split(/\r?\n/);
  if (!lines.includes(SHELL_OK)) {
    return {
      reachable: false,
      stateDirPopulated: null,
      heartbeatRaw: null,
      logLines: [],
      bridgeProcessAlive: null,
    };
  }
  let stateDirPopulated: boolean | null = false;
  let sawAnyDir = false;
  let heartbeatRaw: string | null = null;
  let inHeartbeat = false;
  let inLogs = false;
  const heartbeatBuf: string[] = [];
  const logLines: string[] = [];
  let sawProcMatch = false;
  let sawProcDone = false;

  for (const line of lines) {
    if (line === HEARTBEAT_BEGIN) {
      inHeartbeat = true;
      continue;
    }
    if (line === HEARTBEAT_END) {
      inHeartbeat = false;
      heartbeatRaw = heartbeatBuf.join("\n").trim();
      continue;
    }
    if (line === LOG_BEGIN) {
      inLogs = true;
      continue;
    }
    if (line === LOG_END) {
      inLogs = false;
      continue;
    }
    if (inHeartbeat) {
      heartbeatBuf.push(line);
      continue;
    }
    if (inLogs) {
      const trimmed = line.trim();
      if (trimmed.length > 0) logLines.push(trimmed);
      continue;
    }
    const dirMatch = line.match(/^DIR\s+\S+\s+(MISSING|EMPTY|POPULATED)$/);
    if (dirMatch) {
      sawAnyDir = true;
      if (dirMatch[1] === "POPULATED") stateDirPopulated = true;
      continue;
    }
    if (line.startsWith("PROC ")) {
      sawProcMatch = true;
      continue;
    }
    if (line === PROC_DONE) {
      sawProcDone = true;
      continue;
    }
  }
  // Three states:
  //   true  → pgrep printed at least one matching process
  //   false → pgrep completed with no matches; either the bridge is dead
  //           OR it runs inside the parent agent process under a name that
  //           does not contain `whatsapp`/`baileys`. The evaluator resolves
  //           that ambiguity using heartbeat freshness.
  //   null  → the probe aborted before reaching pgrep (timeout, exec
  //           failure); we cannot infer anything about the bridge state.
  let bridgeProcessAliveOut: boolean | null;
  if (sawProcMatch) {
    bridgeProcessAliveOut = true;
  } else if (sawProcDone) {
    bridgeProcessAliveOut = false;
  } else {
    bridgeProcessAliveOut = null;
  }
  return {
    reachable: true,
    stateDirPopulated: sawAnyDir ? stateDirPopulated : null,
    heartbeatRaw,
    logLines,
    bridgeProcessAlive: bridgeProcessAliveOut,
  };
}

function buildWhatsappProbeInput(
  sandboxName: string,
  agent: AgentDefinition,
  deps: Required<StatusDeps>,
): WhatsappProbeInput {
  const stateDirs = resolveStateDirs(agent);
  const script = buildProbeScript(stateDirs);
  const probedAt = deps.now().toISOString();
  const exec = deps.execSandbox(sandboxName, script, WHATSAPP_PROBE_TIMEOUT_MS);
  const parsed = exec
    ? parseProbeOutput(exec.stdout)
    : {
        reachable: false,
        stateDirPopulated: null,
        heartbeatRaw: null,
        logLines: [],
        bridgeProcessAlive: null,
      };

  let heartbeat: WhatsappHeartbeat | null = null;
  let heartbeatParseError: string | null = null;
  if (parsed.heartbeatRaw) {
    const parseResult = parseWhatsappHeartbeat(parsed.heartbeatRaw);
    if ("heartbeat" in parseResult) {
      heartbeat = parseResult.heartbeat;
    } else {
      heartbeatParseError = parseResult.parseError;
    }
  }

  const entry = deps.getSandbox(sandboxName);
  const channelEnabledInRegistry = registry
    .getConfiguredMessagingChannelsFromEntry(entry)
    .includes("whatsapp");

  const appliedPresets = deps.getAppliedPresets(sandboxName);
  const presetInRegistry = appliedPresets.includes("whatsapp");
  let presetOnGateway: boolean | null = null;
  try {
    const gatewayPresets = deps.getGatewayPresets(sandboxName);
    presetOnGateway = gatewayPresets === null ? null : gatewayPresets.includes("whatsapp");
  } catch {
    presetOnGateway = null;
  }

  return {
    agent: agent.name,
    stateDirs,
    stateDirPopulated: parsed.stateDirPopulated,
    heartbeat,
    heartbeatParseError,
    bridgeProcessAlive: parsed.bridgeProcessAlive,
    recentLogSignals: summarizeWhatsappLogLines(parsed.logLines),
    probeReachable: parsed.reachable,
    probedAt,
    presetInRegistry,
    presetOnGateway,
    channelEnabledInRegistry,
  };
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
  options: { readonly includeDeepDiagnostics?: boolean } = {},
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
  if (options.includeDeepDiagnostics ?? true) {
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

function buildConfigStatusSignals(
  sandboxName: string,
  channelName: string,
  entry: ReturnType<typeof registry.getSandbox>,
  agent: AgentDefinition,
  deps: Required<StatusDeps>,
): DiagnosticSignal[] {
  const plan = registry.getMessagingPlanFromEntry(entry);
  const channelPlan = plan?.channels.find((channel) => channel.channelId === channelName);
  if (!channelPlan?.configured) return [];

  const manifest = channelManifestRegistry.get(channelName);
  const agentId = tryGetMessagingAgentId(
    { name: plan?.agent ?? agent.name },
    channelManifestRegistry.list(),
  );
  const parser = manifest ? getBuiltInRenderedConfigParser(manifest.id) : null;
  const renderSources =
    parser && manifest && agentId
      ? resolveRenderedConfigSources(
          parser.listConfigVisibilityKeys({ manifest, agentId, inputs: channelPlan.inputs }),
          agentId,
          agent,
        )
      : [];
  const sourceReads = parser
    ? readConfigSourceValues(sandboxName, renderSources, parser, deps)
    : emptyConfigSourceReads();
  const configInputs = new Map(
    channelPlan.inputs
      .filter((input) => input.kind === "config")
      .map((input) => [input.inputId, input] as const),
  );
  const signals: DiagnosticSignal[] = configSourceReadSignals(sandboxName, sourceReads.targetReads);

  for (const input of manifest?.inputs ?? []) {
    if (input.kind !== "config") continue;
    const signal = configInputSignal(input, configInputs.get(input.id), renderSources, sourceReads);
    if (signal) signals.push(signal);
  }

  return signals;
}

function configInputSignal(
  input: ChannelConfigInputSpec,
  planInput: SandboxMessagingInputReference | undefined,
  renderSources: readonly ConfigRenderSource[],
  sourceReads: ConfigSourceReads,
): DiagnosticSignal | null {
  const label = configInputLabel(input, planInput);
  const expected = expectedConfigValue(input, planInput);
  const sources = renderSources.filter((source) => source.inputId === input.id);
  if (sources.length === 0) {
    return null;
  }

  const comparisons = sources.map((source) =>
    compareConfigSource(expected, source, sourceReads.sourceValues),
  );
  const checkedComparisons = comparisons.filter((comparison) => comparison.checked);
  const hasMismatch = checkedComparisons.some((comparison) => !comparison.matches);
  if (!expected.hasValue && !hasMismatch) return null;
  const allSourcesChecked =
    checkedComparisons.length === comparisons.length && checkedComparisons.length > 0;
  return {
    label,
    severity: hasMismatch ? "warn" : allSourcesChecked ? "ok" : "info",
    detail: Array.from(new Set(comparisons.map((comparison) => comparison.detail))).join("; "),
  };
}

type SandboxMessagingInputWithValue = SandboxMessagingInputReference & {
  readonly value: Exclude<MessagingSerializableValue, null | undefined>;
};

function planInputHasValue(
  input: SandboxMessagingInputReference | undefined,
): input is SandboxMessagingInputWithValue {
  return input?.value !== undefined && input.value !== null;
}

function configInputLabel(
  input: ChannelConfigInputSpec,
  planInput: SandboxMessagingInputReference | undefined,
): string {
  const label = input.prompt?.label ?? input.envKey ?? input.id;
  const envKey = input.envKey ?? planInput?.sourceEnv;
  if (!envKey || label === envKey) return label;
  return `${label} (${envKey})`;
}

function configInputDetail(value: MessagingSerializableValue | undefined): string {
  if (value === undefined || value === null) return "not set";
  return formatConfigValue(value);
}

type ExpectedConfigValue = {
  readonly value: MessagingSerializableValue | undefined;
  readonly detail: string;
  readonly hasValue: boolean;
};

function expectedConfigValue(
  input: ChannelConfigInputSpec,
  planInput: SandboxMessagingInputReference | undefined,
): ExpectedConfigValue {
  if (planInputHasValue(planInput)) {
    return {
      value: planInput.value,
      detail: configInputDetail(planInput.value),
      hasValue: true,
    };
  }

  const defaultValue = input.defaultValue?.trim();
  if (defaultValue) {
    return {
      value: defaultValue,
      detail: `${configInputDetail(defaultValue)} (default)`,
      hasValue: true,
    };
  }

  return {
    value: undefined,
    detail: configInputDetail(undefined),
    hasValue: false,
  };
}

function formatConfigValue(value: MessagingSerializableValue): string {
  if (typeof value === "string") return value.length === 0 ? '""' : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map(formatConfigValue).join(", ");
  }
  return JSON.stringify(value);
}

interface ConfigRenderSource extends RenderedConfigVisibilityKey {
  readonly resolvedTarget: string;
}

type ConfigSourceRead =
  | {
      readonly ok: true;
      readonly value: MessagingSerializableValue | undefined;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type ConfigTargetRead =
  | {
      readonly ok: true;
      readonly contents: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type ConfigSourceReads = {
  readonly sourceValues: ReadonlyMap<string, ConfigSourceRead>;
  readonly targetReads: ReadonlyMap<string, ConfigTargetRead>;
};

type ParsedConfigSourceRead =
  | {
      readonly ok: true;
      readonly source: RenderedConfigSource;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

function configSourceReadSignals(
  sandboxName: string,
  targetReads: ReadonlyMap<string, ConfigTargetRead>,
): DiagnosticSignal[] {
  const signals: DiagnosticSignal[] = [];
  for (const [target, read] of targetReads.entries()) {
    if (read.ok) continue;
    signals.push({
      label: "Rendered config source",
      severity: "warn",
      detail: `${read.error}; config comparisons not checked`,
      hint: `inspect \`${target}\` with \`${CLI_NAME} ${sandboxName} exec -- cat ${target}\`, then re-run \`${CLI_NAME} ${sandboxName} rebuild\` if the channel block needs to be regenerated`,
    });
  }
  return signals;
}

function emptyConfigSourceReads(): ConfigSourceReads {
  return { sourceValues: new Map(), targetReads: new Map() };
}

function resolveRenderedConfigSources(
  sources: readonly RenderedConfigVisibilityKey[],
  agentId: MessagingAgentId,
  agent: AgentDefinition,
): ConfigRenderSource[] {
  return sources.flatMap((source) => {
    const resolvedTarget = resolveConfigTarget(source.target, agentId, agent);
    return resolvedTarget ? [{ ...source, resolvedTarget }] : [];
  });
}

function resolveConfigTarget(
  target: string,
  agentId: MessagingAgentId,
  agent: AgentDefinition,
): string | null {
  if (agentId === "openclaw" && target === "openclaw.json") {
    return `${agent.configPaths.dir}/${agent.configPaths.configFile}`;
  }
  const configDir = agent.configPaths.dir.replace(/\/+$/, "");
  if (agentId === "openclaw" && target.startsWith("~/.openclaw/")) {
    return `${configDir}/${target.slice("~/.openclaw/".length)}`;
  }
  if (agentId === "hermes" && target.startsWith("~/.hermes/")) {
    return `${configDir}/${target.slice("~/.hermes/".length)}`;
  }
  if (target.startsWith("/sandbox/")) return target;
  return null;
}

function readConfigSourceValues(
  sandboxName: string,
  sources: readonly ConfigRenderSource[],
  parser: RenderedChannelConfigParser,
  deps: Required<StatusDeps>,
): ConfigSourceReads {
  const targetReads = new Map<string, ConfigTargetRead>();
  for (const target of new Set(sources.map((source) => source.resolvedTarget))) {
    const result = deps.execSandbox(
      sandboxName,
      `cat ${quotePath(target)}`,
      CONFIG_STATUS_TIMEOUT_MS,
    );
    targetReads.set(
      target,
      result && result.status === 0
        ? { ok: true, contents: result.stdout }
        : { ok: false, error: `could not read ${target}` },
    );
  }

  const reads = new Map<string, ConfigSourceRead>();
  for (const source of sources) {
    const targetRead = targetReads.get(source.resolvedTarget);
    const key = configSourceKey(source);
    if (!targetRead?.ok) {
      reads.set(key, {
        ok: false,
        error: `${source.resolvedTarget} unavailable`,
      });
      continue;
    }
    const parsed = parseRenderedConfigSource(
      targetRead.contents,
      source.resolvedTarget,
      source.kind,
    );
    reads.set(
      key,
      parsed.ok ? { ok: true, value: parser.getValue(source, parsed.source) } : parsed,
    );
  }
  return { sourceValues: reads, targetReads };
}

function parseEnvLines(raw: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    entries.set(key, unquoteEnvValue(value));
  }
  return entries;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseRenderedConfigSource(
  raw: string,
  target: string,
  kind: ConfigRenderSource["kind"],
): ParsedConfigSourceRead {
  if (kind === "env") return { ok: true, source: { kind: "env", entries: parseEnvLines(raw) } };
  try {
    const value =
      target.endsWith(".yaml") || target.endsWith(".yml") ? YAML.parse(raw) : JSON.parse(raw);
    return { ok: true, source: { kind: "structured", value } };
  } catch {
    return { ok: false, error: `could not parse ${target}` };
  }
}

function compareConfigSource(
  expected: ExpectedConfigValue,
  source: ConfigRenderSource,
  sourceValues: ReadonlyMap<string, ConfigSourceRead>,
): { readonly checked: boolean; readonly matches: boolean; readonly detail: string } {
  const actual = sourceValues.get(configSourceKey(source));
  if (!actual) {
    return {
      checked: false,
      matches: false,
      detail: `${expected.detail} (not checked)`,
    };
  }
  if (!actual.ok) {
    return {
      checked: false,
      matches: false,
      detail: `${expected.detail} (not checked)`,
    };
  }
  const matches = configValuesEqual(expected.value, actual.value);
  return {
    checked: true,
    matches,
    detail: matches
      ? expected.detail
      : `expected ${expected.detail}; rendered ${configInputDetail(actual.value)}`,
  };
}

function configSourceKey(source: ConfigRenderSource): string {
  return `${source.resolvedTarget}:${source.kind}:${source.key}`;
}

function configValuesEqual(
  expected: MessagingSerializableValue | undefined,
  actual: MessagingSerializableValue | undefined,
): boolean {
  if (expected === undefined || expected === null) return actual === undefined || actual === null;
  if (actual === undefined || actual === null) return false;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const expectedList = listConfigValues(expected);
    const actualList = listConfigValues(actual);
    return (
      expectedList.length === actualList.length &&
      expectedList.every((value, index) => value === actualList[index])
    );
  }
  const expectedBoolean = booleanConfigValue(expected);
  const actualBoolean = booleanConfigValue(actual);
  if (expectedBoolean !== null && actualBoolean !== null) return expectedBoolean === actualBoolean;
  return formatConfigValue(expected) === formatConfigValue(actual);
}

function listConfigValues(value: MessagingSerializableValue): string[] {
  const values = Array.isArray(value) ? value : String(value).split(",");
  return values
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0)
    .sort();
}

function booleanConfigValue(value: MessagingSerializableValue): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return null;
}

function channelSupportedByAgent(channelName: string, agent: AgentDefinition): boolean {
  return channelManifestRegistry
    .listAvailable(getMessagingManifestAvailabilityContext(agent, channelManifestRegistry.list()))
    .some((manifest) => manifest.id === channelName);
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

  let report: ChannelStatusReport;
  if (diagnostic.deepProbe === "in-sandbox-qr" && !channelIsPaused) {
    const input = buildWhatsappProbeInput(sandboxName, agent, deps);
    const whatsappReport = evaluateWhatsappDiagnostics(input);
    report = {
      schemaVersion: 1,
      sandbox: sandboxName,
      channel: channelName,
      report: whatsappReport,
    };
  } else {
    report = buildBasicChannelReport(sandboxName, channelName, agent, deps, diagnostic);
  }

  if (!(asJson && quietJson)) {
    renderReport(report, asJson, deps);
  }

  const code = exitCodeFor(report);
  if (asJson) return report;
  if (code !== 0) process.exit(code);
  return report;
}
