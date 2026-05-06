// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific runtime logic — called from nemoclaw.ts when the active
// sandbox uses a non-OpenClaw agent. Reads the agent from the onboard session
// and provides agent-aware health probes, recovery scripts, and display names.
// When the session agent is openclaw (or absent), all functions return
// defaults that match the hardcoded OpenClaw values on main.

import * as registry from "./state/registry";
import { DASHBOARD_PORT } from "./ports";
import * as onboardSession from "./onboard-session";
import { loadAgent, type AgentDefinition } from "./agent-defs";
import { shellQuote } from "./runner";

/**
 * Resolve the agent for a sandbox. Checks the per-sandbox registry first
 * (so status/connect/recovery use the right agent even when multiple
 * sandboxes exist), then falls back to the global onboard session.
 * Returns the loaded agent definition for non-OpenClaw agents, or null.
 */
export function getSessionAgent(sandboxName?: string): AgentDefinition | null {
  try {
    if (sandboxName) {
      const sb = registry.getSandbox(sandboxName);
      if (sb?.agent && sb.agent !== "openclaw") {
        return loadAgent(sb.agent);
      }
      if (sb?.agent === "openclaw" || (sb && !sb.agent)) {
        return null;
      }
    }
    const session = onboardSession.loadSession();
    const name = session?.agent || "openclaw";
    if (name === "openclaw") return null;
    return loadAgent(name);
  } catch {
    return null;
  }
}

/**
 * Get the health probe URL for the agent.
 * Returns the agent's configured probe URL, or the OpenClaw /health endpoint.
 *
 * Uses /health (not /) because /health returns 200 regardless of device auth
 * state, while / returns 401 when device auth is enabled. This ensures
 * health probes work correctly in all configurations. Fixes #2342.
 */
export function getHealthProbeUrl(agent: AgentDefinition | null): string {
  if (!agent) return `http://127.0.0.1:${DASHBOARD_PORT}/health`;
  return agent.healthProbe?.url || `http://127.0.0.1:${DASHBOARD_PORT}/health`;
}

function escapeEre(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function escapeCharClass(value: string): string {
  return value.replace(/[\\\]\[\^\-]/g, "\\$&");
}

function selfSafeGatewayProcessPattern(command: string): string {
  const [executable = "", ...args] = command.trim().split(/\s+/).filter(Boolean);
  const [first = "", ...rest] = Array.from(executable);
  if (!first) return "";
  const executablePattern = `[${escapeCharClass(first)}]${escapeEre(rest.join(""))}`;
  const commandPattern = [executablePattern, ...args.map(escapeEre)].join("[[:space:]]+");
  return `${commandPattern}([[:space:]]|$)`;
}

function buildNoFollowLogSetupCommand(
  path: string,
  logOwnerUser?: string,
  ownerMode = "0o644",
): string {
  const displayPath = path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const prepareLog = [
    "import errno, os, pwd, stat, sys",
    "path = sys.argv[1]",
    "owner = sys.argv[2] if len(sys.argv) > 2 else ''",
    `owner_mode = ${ownerMode}`,
    "fallback_mode = 0o600",
    "flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0)",
    "try:",
    "    fd = os.open(path, flags, 0o644)",
    "except OSError as exc:",
    "    if exc.errno == errno.ELOOP:",
    `        print('[gateway-recovery] ERROR: refusing to prepare symlinked ${displayPath}', file=sys.stderr)`,
    "        sys.exit(1)",
    "    if exc.errno in (errno.EACCES, errno.EPERM):",
    `        print('[gateway-recovery] ERROR: ${displayPath} is not writable by recovery user', file=sys.stderr)`,
    "        sys.exit(0)",
    `    print(f'[gateway-recovery] ERROR: cannot prepare ${displayPath}: {exc}', file=sys.stderr)`,
    "    sys.exit(1)",
    "try:",
    "    if not stat.S_ISREG(os.fstat(fd).st_mode):",
    `        print('[gateway-recovery] ERROR: ${displayPath} is not a regular file', file=sys.stderr)`,
    "        sys.exit(1)",
    "    if owner and os.geteuid() == 0:",
    "        try:",
    "            pw = pwd.getpwnam(owner)",
    "        except KeyError:",
    "            os.fchmod(fd, fallback_mode)",
    "        else:",
    "            os.fchown(fd, pw.pw_uid, pw.pw_gid)",
    "            os.fchmod(fd, owner_mode)",
    "    else:",
    "        os.fchmod(fd, fallback_mode)",
    "finally:",
    "    os.close(fd)",
  ].join("\n");
  return [
    "python3",
    "-c",
    shellQuote(prepareLog),
    path,
    ...(logOwnerUser ? [shellQuote(logOwnerUser)] : []),
  ].join(" ");
}

function buildGatewayLogSetup(includeAutoPairLog = false, logOwnerUser?: string): string[] {
  const lines = [`${buildNoFollowLogSetupCommand("/tmp/gateway.log", logOwnerUser)} || exit 1;`];
  if (includeAutoPairLog) {
    lines.push(
      `${buildNoFollowLogSetupCommand("/tmp/auto-pair.log", "sandbox", "0o600")} || exit 1;`,
    );
  }
  return lines;
}

function buildGatewayLogSelection(): string {
  return '_GATEWAY_LOG=/tmp/gateway.log; if ! : >> "$_GATEWAY_LOG" 2>/dev/null; then _GATEWAY_LOG=/tmp/gateway-recovery.log; : >> "$_GATEWAY_LOG" 2>/dev/null || true; fi;';
}

function gatewayLaunchCommand(command: string, runAsUser?: string): string {
  const logSelection = buildGatewayLogSelection();
  const userLaunch = `nohup ${command} >> "$_GATEWAY_LOG" 2>&1 &`;
  if (!runAsUser) {
    return `${logSelection} ${userLaunch}`;
  }
  return `${logSelection} if [ "$(id -u)" = "0" ] && command -v gosu >/dev/null 2>&1 && id ${shellQuote(runAsUser)} >/dev/null 2>&1; then nohup gosu ${shellQuote(runAsUser)} ${command} >> "$_GATEWAY_LOG" 2>&1 & else ${userLaunch} fi;`;
}

function hermesGatewayEnvPrefix(): string {
  const decodeProxy = "http://127.0.0.1:3129";
  return [
    "HERMES_HOME=/sandbox/.hermes",
    `HTTPS_PROXY=${decodeProxy}`,
    `HTTP_PROXY=${decodeProxy}`,
    `https_proxy=${decodeProxy}`,
    `http_proxy=${decodeProxy}`,
  ].join(" ");
}

function hermesDecodeProxyRecoveryCommand(): string {
  return 'if ! command -v ss >/dev/null 2>&1 || ! ss -tln 2>/dev/null | grep -q "127.0.0.1:3129"; then nohup python3 /usr/local/bin/nemoclaw-decode-proxy >/dev/null 2>&1 & for _i in 1 2 3 4 5 6 7 8 9 10; do ! command -v ss >/dev/null 2>&1 || ss -tln 2>/dev/null | grep -q "127.0.0.1:3129" && break; sleep 0.5; done; fi;';
}

/**
 * Build the OpenClaw recovery shell script used by the default sandbox.
 */
export function buildOpenClawRecoveryScript(port: number): string {
  const staleGatewayPattern = "[o]penclaw([ -]gateway| gateway run|$)";
  return [
    "if [ -r /tmp/nemoclaw-proxy-env.sh ]; then . /tmp/nemoclaw-proxy-env.sh; _PE_MISSING=0; else _PE_MISSING=1; fi;",
    "[ -f ~/.bashrc ] && . ~/.bashrc;",
    'if [ "$_PE_MISSING" = "0" ]; then case "${NODE_OPTIONS:-}" in *nemoclaw-sandbox-safety-net*) _SN_MISSING=0 ;; *) _SN_MISSING=1 ;; esac; case "${NODE_OPTIONS:-}" in *nemoclaw-ciao-network-guard*) _CIAO_MISSING=0 ;; *) _CIAO_MISSING=1 ;; esac; if [ "$_SN_MISSING" = "0" ] && [ "$_CIAO_MISSING" = "0" ]; then _GUARDS_MISSING=0; else _GUARDS_MISSING=1; fi; else _GUARDS_MISSING=0; fi;',
    `_GW_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${port}/health 2>/dev/null || echo 000); case "$_GW_CODE" in 200|401) echo ALREADY_RUNNING; exit 0 ;; esac;`,
    "rm -rf /tmp/openclaw-*/gateway.*.lock 2>/dev/null;",
    ...buildGatewayLogSetup(true, "gateway"),
    buildGatewayLogSelection(),
    `_GATEWAY_PROC_PATTERN=${shellQuote(staleGatewayPattern)};`,
    'if [ -n "$_GATEWAY_PROC_PATTERN" ]; then pkill -TERM -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; pkill -KILL -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; if pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1; then echo GATEWAY_STALE_PROCESSES; exit 1; fi; fi;',
    '[ "$_PE_MISSING" = "1" ] && { _W="[gateway-recovery] WARNING: /tmp/nemoclaw-proxy-env.sh missing - gateway launching without library guards (#2478)"; echo "$_W" >&2; echo "$_W" >> "$_GATEWAY_LOG"; };',
    '[ "$_PE_MISSING" = "0" ] && [ "$_GUARDS_MISSING" = "1" ] && { _E="[gateway-recovery] ERROR: /tmp/nemoclaw-proxy-env.sh present but NODE_OPTIONS missing safety-net preload or ciao preload - refusing unguarded gateway relaunch (#2478)"; echo "$_E" >&2; echo "$_E" >> "$_GATEWAY_LOG"; exit 1; };',
    'OPENCLAW="$(command -v openclaw)";',
    'if [ -z "$OPENCLAW" ]; then echo OPENCLAW_MISSING; exit 1; fi;',
    gatewayLaunchCommand('"$OPENCLAW" gateway run --port ' + port, "gateway"),
    "GPID=$!; sleep 2;",
    'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; tail -5 "$_GATEWAY_LOG" 2>/dev/null; fi',
  ].join(" ");
}

/**
 * Build the recovery shell script for a non-OpenClaw agent.
 * Returns the script string, or null if agent is null (use existing inline
 * OpenClaw script instead).
 */
export function buildRecoveryScript(agent: AgentDefinition | null, port: number): string | null {
  if (!agent) return null;

  const probeUrl = getHealthProbeUrl(agent);
  const binaryPath = agent.binary_path || "/usr/local/bin/openclaw";
  const binaryName = binaryPath.split("/").pop() ?? "openclaw";
  const defaultGatewayCommand = `${binaryName} gateway run`;
  const configuredGatewayCommand = agent.gateway_command?.trim() || defaultGatewayCommand;
  const usesValidatedBinary = configuredGatewayCommand === defaultGatewayCommand;
  const customGatewayExecutable = configuredGatewayCommand.split(/\s+/)[0] ?? binaryName;
  const staleGatewayPattern = selfSafeGatewayProcessPattern(configuredGatewayCommand);
  const validationSteps = usesValidatedBinary
    ? [
        `AGENT_BIN=${shellQuote(binaryPath)}; if [ ! -x "$AGENT_BIN" ]; then AGENT_BIN="$(command -v ${shellQuote(binaryName)})"; fi;`,
        'if [ -z "$AGENT_BIN" ]; then echo AGENT_MISSING; exit 1; fi;',
      ]
    : [
        `GATEWAY_CMD_BIN=${shellQuote(customGatewayExecutable)};`,
        'case "$GATEWAY_CMD_BIN" in */*) [ -x "$GATEWAY_CMD_BIN" ] || { echo AGENT_MISSING; exit 1; } ;; *) command -v "$GATEWAY_CMD_BIN" >/dev/null 2>&1 || { echo AGENT_MISSING; exit 1; } ;; esac;',
      ];
  // Append (>>) rather than truncate (>) so the [gateway-recovery] WARNING
  // lines that the recovery script writes to gateway.log moments earlier
  // survive past the gateway launch — otherwise the warning explaining
  // *why* the gateway is about to crash gets wiped by the same launch
  // that's about to crash on a missing guard. (#2478)
  const isHermes = agent.name === "hermes";
  const hermesHome = isHermes ? "export HERMES_HOME=/sandbox/.hermes; " : "";
  const hermesLaunchEnv = isHermes ? `env ${hermesGatewayEnvPrefix()} ` : "";
  const launchCommand = usesValidatedBinary
    ? gatewayLaunchCommand(`${hermesLaunchEnv}"$AGENT_BIN" gateway run${isHermes ? "" : ` --port ${port}`}`)
    : gatewayLaunchCommand(
        `${hermesLaunchEnv}${configuredGatewayCommand}${isHermes ? "" : ` --port ${port}`}`,
      );

  // Source /tmp/nemoclaw-proxy-env.sh immediately before launching. That file
  // is the single source of truth for NODE_OPTIONS preload guards (safety-net,
  // ciao networkInterfaces, slack, http-proxy, ws-proxy, nemotron). Recovery
  // also stops stale launcher/gateway processes that may have respawned
  // between the health probe and relaunch. A missing env file remains warning-
  // only; a present env file that does not install required guards is a hard
  // failure because launching would create an unguarded gateway.
  return [
    "[ -f ~/.bashrc ] && . ~/.bashrc;",
    hermesHome,
    `_GW_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$_GW_CODE" in 200|401) echo ALREADY_RUNNING; exit 0 ;; esac;`,
    ...buildGatewayLogSetup(false),
    buildGatewayLogSelection(),
    `_GATEWAY_PROC_PATTERN=${shellQuote(staleGatewayPattern)};`,
    'if [ -n "$_GATEWAY_PROC_PATTERN" ]; then pkill -TERM -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; pkill -KILL -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; if pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1; then echo GATEWAY_STALE_PROCESSES; exit 1; fi; fi;',
    ...validationSteps,
    "if [ -r /tmp/nemoclaw-proxy-env.sh ]; then . /tmp/nemoclaw-proxy-env.sh; _PE_MISSING=0; else _PE_MISSING=1; fi;",
    'if [ "$_PE_MISSING" = "0" ]; then case "${NODE_OPTIONS:-}" in *nemoclaw-sandbox-safety-net*) _SN_MISSING=0 ;; *) _SN_MISSING=1 ;; esac; case "${NODE_OPTIONS:-}" in *nemoclaw-ciao-network-guard*) _CIAO_MISSING=0 ;; *) _CIAO_MISSING=1 ;; esac; if [ "$_SN_MISSING" = "0" ] && [ "$_CIAO_MISSING" = "0" ]; then _GUARDS_MISSING=0; else _GUARDS_MISSING=1; fi; else _GUARDS_MISSING=0; fi;',
    '[ "$_PE_MISSING" = "1" ] && { _W="[gateway-recovery] WARNING: /tmp/nemoclaw-proxy-env.sh missing - gateway launching without library guards (#2478)"; echo "$_W" >&2; echo "$_W" >> "$_GATEWAY_LOG"; };',
    '[ "$_PE_MISSING" = "0" ] && [ "$_GUARDS_MISSING" = "1" ] && { _E="[gateway-recovery] ERROR: /tmp/nemoclaw-proxy-env.sh present but NODE_OPTIONS missing safety-net preload or ciao preload - refusing unguarded gateway relaunch (#2478)"; echo "$_E" >&2; echo "$_E" >> "$_GATEWAY_LOG"; exit 1; };',
    isHermes ? hermesDecodeProxyRecoveryCommand() : "",
    launchCommand,
    "GPID=$!; sleep 2;",
    'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; tail -5 "$_GATEWAY_LOG" 2>/dev/null; fi',
  ].join(" ");
}

/**
 * Get the display name for the current agent.
 */
export function getAgentDisplayName(agent: AgentDefinition | null): string {
  return agent ? agent.displayName : "OpenClaw";
}

/**
 * Get the gateway command for the current agent.
 */
export function getGatewayCommand(agent: AgentDefinition | null): string {
  return agent?.gateway_command || "openclaw gateway run";
}

/**
 * Build a single copy-pasteable command for the user to run when automatic
 * gateway recovery fails. Unlike the raw gateway command, this keeps the
 * process alive after disconnect and preserves the agent-specific launch shape.
 */
export function buildManualRecoveryCommand(agent: AgentDefinition | null, port: number): string {
  const binaryPath = agent?.binary_path || "/usr/local/bin/openclaw";
  const defaultGatewayCommand = `${shellQuote(binaryPath)} gateway run`;
  const gatewayCmd = agent?.gateway_command?.trim() || defaultGatewayCommand;
  const isHermes = agent?.name === "hermes";
  const envPrefix = isHermes ? `${hermesGatewayEnvPrefix()} ` : "";
  const portFlag = isHermes ? "" : ` --port ${port}`;
  const decodeProxySetup = isHermes ? `${hermesDecodeProxyRecoveryCommand()} ` : "";
  return `${buildGatewayLogSelection()} ${decodeProxySetup}${envPrefix}nohup ${gatewayCmd}${portFlag} >> "$_GATEWAY_LOG" 2>&1 &`;
}
