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

import { loadAgent, type AgentDefinition } from "../../agent/defs";
import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { B, D, G, R, RD, YW } from "../../cli/terminal-style";
import * as policies from "../../policy";
import {
  KNOWN_CHANNELS,
  knownChannelNames,
} from "../../sandbox/channels";
import {
  evaluateWhatsappDiagnostics,
  parseWhatsappHeartbeat,
  summarizeWhatsappLogLines,
  type DiagnosticSeverity,
  type DiagnosticSignal,
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

type ExecRunner = (sandboxName: string, command: string, timeoutMs?: number) => {
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

export type ChannelStatusReport =
  | { schemaVersion: 1; sandbox: string; channel: "whatsapp"; report: WhatsappDiagnosticReport }
  | {
      schemaVersion: 1;
      sandbox: string;
      channel: string;
      verdict: "info";
      signals: DiagnosticSignal[];
    };

// Bound how long we are willing to block inside an `openshell sandbox exec`
// for the inline diagnostic snippet. WhatsApp's bridge sometimes goes
// unresponsive when the Noise WebSocket is stuck; a fast hard cap keeps
// channels status from inheriting that hang.
const WHATSAPP_PROBE_TIMEOUT_MS = 8_000;

const SHELL_OK = "NEMOCLAW_WA_DIAG_OK";
const HEARTBEAT_BEGIN = "NEMOCLAW_WA_HEARTBEAT_BEGIN";
const HEARTBEAT_END = "NEMOCLAW_WA_HEARTBEAT_END";
const LOG_BEGIN = "NEMOCLAW_WA_LOG_BEGIN";
const LOG_END = "NEMOCLAW_WA_LOG_END";
const PROC_DONE = "NEMOCLAW_WA_PROC_DONE";

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
    candidates.push(
      `${configDir}/whatsapp`,
      `${configDir}/platforms/whatsapp/session`,
    );
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
  const parsed = exec ? parseProbeOutput(exec.stdout) : { reachable: false, stateDirPopulated: null, heartbeatRaw: null, logLines: [], bridgeProcessAlive: null };

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
  const channelEnabledInRegistry = (entry?.messagingChannels ?? []).includes("whatsapp");

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

function renderReport(report: ChannelStatusReport, asJson: boolean, deps: Required<StatusDeps>): void {
  if (asJson) {
    deps.out(JSON.stringify(report, null, 2));
    return;
  }
  deps.out("");
  deps.out(`  ${B}${CLI_DISPLAY_NAME} channels status:${R} ${report.sandbox} / ${report.channel}`);
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
    deps.out(`    ${severityLabel(signal.severity)} ${signal.label}: ${signal.detail}`);
    if (signal.hint) deps.out(`         ${D}hint: ${signal.hint}${R}`);
  }
  deps.out("");
}

function exitCodeFor(report: ChannelStatusReport): number {
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
): ChannelStatusReport {
  const entry = deps.getSandbox(sandboxName);
  const enabled = (entry?.messagingChannels ?? []).includes(channelName);
  const disabled = (entry?.disabledChannels ?? []).includes(channelName);
  const appliedPresets = deps.getAppliedPresets(sandboxName);
  const presetInRegistry = appliedPresets.includes(channelName);
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
      ? `${channelName} preset applied`
      : `${channelName} preset not applied`,
    hint: presetInRegistry
      ? undefined
      : `run \`${CLI_NAME} ${sandboxName} policy-add ${channelName}\``,
  });
  signals.push({
    label: "Deep diagnostics",
    severity: "info",
    detail: `not implemented for ${channelName}; see \`${CLI_NAME} ${sandboxName} doctor\` and \`${CLI_NAME} ${sandboxName} logs --follow\``,
  });
  // Reference the agent in a hint so the deep-diagnostic section is
  // discoverable per agent without needing extra plumbing.
  if (!agent.messagingPlatforms.includes(channelName)) {
    signals.unshift({
      label: "Agent support",
      severity: "warn",
      detail: `agent '${agent.name}' does not declare support for ${channelName}`,
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

  let channelName = channelArg;
  if (!channelName) {
    const enabled = (entry.messagingChannels ?? []).filter(
      (name: string) => name === "whatsapp",
    );
    if (enabled.length > 0) {
      channelName = "whatsapp";
    } else if ((entry.messagingChannels ?? []).length > 0) {
      channelName = entry.messagingChannels?.[0];
    } else {
      channelName = "whatsapp";
    }
  }

  if (!channelName || !knownChannelNames().includes(channelName)) {
    const known = knownChannelNames().join(", ");
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

  const agent = deps.loadAgent(entry.agent || "openclaw");

  const disabledChannels = new Set(entry.disabledChannels ?? []);
  const channelIsPaused = disabledChannels.has(channelName);

  let report: ChannelStatusReport;
  if (channelName === "whatsapp" && channelIsPaused) {
    // The operator stopped this channel with `channels stop whatsapp`; the
    // bridge and policy are intentionally absent after the rebuild. Skip
    // the deep probe so the diagnostic does not flag the deliberate gap as
    // an unhealthy bridge. The non-WhatsApp path already covers paused
    // channels via buildBasicChannelReport, so route through it.
    report = buildBasicChannelReport(sandboxName, channelName, agent, deps);
  } else if (channelName === "whatsapp") {
    const input = buildWhatsappProbeInput(sandboxName, agent, deps);
    const whatsappReport = evaluateWhatsappDiagnostics(input);
    report = {
      schemaVersion: 1,
      sandbox: sandboxName,
      channel: "whatsapp",
      report: whatsappReport,
    };
  } else {
    if (!KNOWN_CHANNELS[channelName]) {
      // Defensive — already validated above, but keeps type narrowing happy.
      report = buildBasicChannelReport(sandboxName, channelName, agent, deps);
    } else {
      report = buildBasicChannelReport(sandboxName, channelName, agent, deps);
    }
  }

  if (!(asJson && quietJson)) {
    renderReport(report, asJson, deps);
  }

  const code = exitCodeFor(report);
  if (asJson) return report;
  if (code !== 0) process.exit(code);
  return report;
}
