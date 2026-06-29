// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific runtime logic — called from nemoclaw.ts when the active
// sandbox uses a non-OpenClaw agent. Reads the agent from the onboard session
// and provides agent-aware health probes, recovery scripts, and display names.
// When the session agent is openclaw (or absent), all functions return
// defaults that match the hardcoded OpenClaw values on main.

import { DASHBOARD_PORT } from "../core/ports";
import { shellQuote } from "../runner";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { type AgentDefinition, isTerminalAgent, loadAgent } from "./defs";
import {
  buildHermesEnvFileBoundaryGuard,
  buildHermesRuntimeEnvBoundaryGuard,
} from "./hermes-recovery-boundary";
import { buildGatewayGuardRecoveryLines } from "./runtime-recovery-preload";

export const TERMINAL_AGENT_RECOVERY_SCRIPT = Object.freeze({ kind: "terminal" } as const);

export type AgentRecoveryScript = string | typeof TERMINAL_AGENT_RECOVERY_SCRIPT | null;

export function isTerminalAgentRecoveryScript(
  script: AgentRecoveryScript,
): script is typeof TERMINAL_AGENT_RECOVERY_SCRIPT {
  return script === TERMINAL_AGENT_RECOVERY_SCRIPT;
}

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
  if (isTerminalAgent(agent)) return "";
  return agent.healthProbe?.url || `http://127.0.0.1:${DASHBOARD_PORT}/health`;
}

export function hasGatewayRuntime(
  agent: { runtime?: { kind?: unknown } | null } | null | undefined,
): boolean {
  return !isTerminalAgent(agent);
}

export function getTerminalCommand(
  agent: AgentDefinition | null,
  mode: "interactive" | "headless" = "interactive",
): string | null {
  if (!agent || !isTerminalAgent(agent)) return null;
  if (mode === "headless") return agent.runtime?.headless_command ?? null;
  return agent.runtime?.interactive_command ?? agent.runtime?.headless_command ?? null;
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

function gatewayGuardRefusalCommand(): string {
  return '[ "$_GUARDS_MISSING" = "1" ] && { _E="[gateway-recovery] ERROR: NODE_OPTIONS missing safety-net preload or ciao preload after trusted recovery - refusing unguarded gateway relaunch (#2478/#2701)"; echo "$_E" >&2; echo "$_E" >> "$_GATEWAY_LOG"; exit 1; };';
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
  return "HERMES_HOME=/sandbox/.hermes";
}

const HERMES_SERVICE_MANAGER_PATH = "/usr/local/bin/nemoclaw-start";
const HERMES_ROOT_LIFECYCLE_MARKER = "/run/nemoclaw/hermes-root-lifecycle";

function buildHermesTrustedPythonSelection(): string {
  return '_HERMES_RECOVERY_PYTHON=; for _HERMES_PYTHON_CANDIDATE in /usr/bin/python3 /usr/local/bin/python3 /opt/hermes/.venv/bin/python3; do if [ -x "$_HERMES_PYTHON_CANDIDATE" ]; then _HERMES_RECOVERY_PYTHON="$_HERMES_PYTHON_CANDIDATE"; break; fi; done; [ -n "$_HERMES_RECOVERY_PYTHON" ] || { echo HERMES_RECOVERY_PYTHON_MISSING; exit 1; };';
}

function hermesServiceManagerSafetyPythonLines(): string[] {
  return [
    "def manager_is_safe(path):",
    "    try:",
    "        metadata = os.lstat(path)",
    "    except OSError:",
    "        return False",
    "    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_uid not in {0, os.geteuid()}:",
    "        return False",
    "    if not metadata.st_mode & 0o111 or metadata.st_mode & 0o022:",
    "        return False",
    "    if metadata.st_uid == os.geteuid() and not metadata.st_mode & stat.S_IWUSR:",
    "        return False",
    "    flags = os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)",
    "    try:",
    "        descriptor = os.open(path, flags)",
    "    except OSError as error:",
    "        return error.errno in {errno.EACCES, errno.EPERM, errno.EROFS}",
    "    else:",
    "        os.close(descriptor)",
    "        return False",
  ];
}

export function buildHermesManagedGatewayProbe(): string {
  const probe = [
    "import os, sys",
    "manager_path = sys.argv[1]",
    "manager_bytes = os.fsencode(manager_path)",
    "def read_argv(pid):",
    "    try:",
    "        with open(f'/proc/{pid}/cmdline', 'rb') as command_line:",
    "            return [arg for arg in command_line.read(16384).split(b'\\0') if arg]",
    "    except OSError:",
    "        return []",
    "def is_manager(argv):",
    "    if not argv:",
    "        return False",
    "    if argv == [manager_bytes]:",
    "        return True",
    "    return os.path.basename(argv[0]) in {b'bash', b'sh'} and len(argv) == 2 and argv[1] == manager_bytes",
    "def is_gateway(argv):",
    "    return any(os.path.basename(argv[index]) in {b'hermes', b'hermes.real'} and argv[index + 1:index + 3] == [b'gateway', b'run'] for index in range(max(0, len(argv) - 2)))",
    "def parent_pid(pid):",
    "    try:",
    "        with open(f'/proc/{pid}/status', encoding='utf-8') as status_file:",
    "            for line in status_file:",
    "                if line.startswith('PPid:'):",
    "                    return int(line.split()[1])",
    "    except (OSError, ValueError, IndexError):",
    "        pass",
    "    return None",
    "try:",
    "    pids = [int(name) for name in os.listdir('/proc/') if name.isdigit()]",
    "except OSError:",
    "    pids = []",
    "managers = [pid for pid in pids if is_manager(read_argv(pid))]",
    "manager_set = set(managers)",
    "top_level_managers = [pid for pid in managers if parent_pid(pid) not in manager_set]",
    "gateways = [pid for pid in pids if is_gateway(read_argv(pid))]",
    "managed = len(top_level_managers) == 1 and len(gateways) == 1 and parent_pid(gateways[0]) == top_level_managers[0]",
    "print('1' if managed else '0')",
  ].join("\n");
  return [
    buildHermesTrustedPythonSelection(),
    `_HERMES_MANAGED_GATEWAY="$("$_HERMES_RECOVERY_PYTHON" -c ${shellQuote(probe)} ${shellQuote(HERMES_SERVICE_MANAGER_PATH)} 2>/dev/null || printf '0')";`,
    'case "$_HERMES_MANAGED_GATEWAY" in 1) ;; *) _HERMES_MANAGED_GATEWAY=0 ;; esac;',
  ].join(" ");
}

function buildHermesRootLifecycleRefusal(): string {
  return `[ ! -e ${shellQuote(HERMES_ROOT_LIFECYCLE_MARKER)} ] && [ ! -L ${shellQuote(HERMES_ROOT_LIFECYCLE_MARKER)} ] || { echo HERMES_ROOT_LIFECYCLE_UNSUPPORTED; exit 1; };`;
}

function buildHermesServiceManagerValidation(): string {
  const validator = [
    "import errno, os, stat, sys",
    ...hermesServiceManagerSafetyPythonLines(),
    "raise SystemExit(0 if manager_is_safe(sys.argv[1]) else 1)",
  ].join("\n");
  return [
    `"$_HERMES_RECOVERY_PYTHON" -c ${shellQuote(validator)} ${shellQuote(HERMES_SERVICE_MANAGER_PATH)} || { echo HERMES_SERVICE_MANAGER_UNSAFE; exit 1; };`,
  ].join(" ");
}

function buildHermesServiceManagerShutdown(): string {
  const shutdown = [
    "import os, signal, sys, time",
    "manager = os.fsencode(sys.argv[1])",
    "def read_argv(pid):",
    "    try:",
    "        with open(f'/proc/{pid}/cmdline', 'rb') as command_line:",
    "            return [arg for arg in command_line.read(16384).split(b'\\0') if arg]",
    "    except OSError:",
    "        return []",
    "def is_manager(argv):",
    "    if not argv:",
    "        return False",
    "    if argv == [manager]:",
    "        return True",
    "    return os.path.basename(argv[0]) in {b'bash', b'sh'} and len(argv) == 2 and argv[1] == manager",
    "def parent_pid(pid):",
    "    try:",
    "        with open(f'/proc/{pid}/status', encoding='utf-8') as status_file:",
    "            for line in status_file:",
    "                if line.startswith('PPid:'):",
    "                    return int(line.split()[1])",
    "    except (OSError, ValueError, IndexError):",
    "        pass",
    "    return None",
    "def start_time(pid):",
    "    try:",
    "        with open(f'/proc/{pid}/stat', encoding='utf-8') as stat_file:",
    "            text = stat_file.read()",
    "        return text[text.rfind(')') + 2:].split()[19]",
    "    except (OSError, IndexError):",
    "        return None",
    "def same_process(pid, started):",
    "    return started is not None and start_time(pid) == started and is_manager(read_argv(pid))",
    "try:",
    "    pids = [int(name) for name in os.listdir('/proc/') if name.isdigit()]",
    "except OSError:",
    "    pids = []",
    "manager_pids = [pid for pid in pids if pid not in {os.getpid(), os.getppid()} and is_manager(read_argv(pid))]",
    "manager_set = set(manager_pids)",
    "top_level_managers = [pid for pid in manager_pids if parent_pid(pid) not in manager_set]",
    "identities = [(pid, start_time(pid)) for pid in top_level_managers]",
    "identities = [(pid, started) for pid, started in identities if started is not None]",
    "for pid, started in identities:",
    "    if same_process(pid, started):",
    "        try: os.kill(pid, signal.SIGTERM)",
    "        except ProcessLookupError: pass",
    "deadline = time.monotonic() + 5",
    "while identities and time.monotonic() < deadline:",
    "    identities = [(pid, started) for pid, started in identities if same_process(pid, started)]",
    "    if identities: time.sleep(0.1)",
    "for pid, started in identities:",
    "    if same_process(pid, started):",
    "        try: os.kill(pid, signal.SIGKILL)",
    "        except ProcessLookupError: pass",
    "deadline = time.monotonic() + 2",
    "while identities and time.monotonic() < deadline:",
    "    identities = [(pid, started) for pid, started in identities if same_process(pid, started)]",
    "    if identities: time.sleep(0.1)",
    "raise SystemExit(1 if identities else 0)",
  ].join("\n");
  return `"$_HERMES_RECOVERY_PYTHON" -c ${shellQuote(shutdown)} ${shellQuote(HERMES_SERVICE_MANAGER_PATH)} || { echo HERMES_SERVICE_MANAGER_STALE; exit 1; };`;
}

export interface AgentRecoveryOptions {
  hermesDashboard?: HermesDashboardRecoveryConfig | null;
  hermesPrimaryDashboardPort?: number | null;
}

export function usesManagedHermesLifecycle(agent: AgentDefinition | null): boolean {
  if (agent?.name !== "hermes" || isTerminalAgent(agent)) return false;
  const binaryPath = agent.binary_path || "/usr/local/bin/hermes";
  const binaryName = binaryPath.split("/").pop() ?? "hermes";
  const gatewayCommand = agent.gateway_command?.trim() || `${binaryName} gateway run`;
  return gatewayCommand === `${binaryName} gateway run`;
}

function buildHermesServiceManagerLaunch(options: AgentRecoveryOptions): string {
  const primaryDashboardPort =
    typeof options.hermesPrimaryDashboardPort === "number" &&
    Number.isInteger(options.hermesPrimaryDashboardPort) &&
    options.hermesPrimaryDashboardPort >= 1024 &&
    options.hermesPrimaryDashboardPort <= 65535
      ? options.hermesPrimaryDashboardPort
      : DASHBOARD_PORT;
  const environment = [`NEMOCLAW_DASHBOARD_PORT=${primaryDashboardPort}`];
  const config = options.hermesDashboard;
  if (config) {
    environment.push(
      "NEMOCLAW_HERMES_DASHBOARD=1",
      `NEMOCLAW_HERMES_DASHBOARD_PORT=${config.publicPort}`,
      `NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT=${config.internalPort}`,
      `NEMOCLAW_HERMES_DASHBOARD_TUI=${config.tuiEnabled ? "1" : "0"}`,
    );
  }
  // nemoclaw-start owns its own restricted logs. Sending its output back to
  // gateway.log would feed its gateway-log tail into itself.
  return `nohup env ${environment.join(" ")} ${shellQuote(HERMES_SERVICE_MANAGER_PATH)} </dev/null >/dev/null 2>&1 &`;
}

function hermesDashboardEnvPrefix(): string {
  return 'HERMES_HOME="$_HERMES_DASHBOARD_HOME" GATEWAY_HEALTH_URL="http://127.0.0.1:$_HERMES_DASHBOARD_GATEWAY_PORT"';
}

export interface HermesDashboardRecoveryConfig {
  publicPort: number;
  internalPort: number;
  tuiEnabled?: boolean;
}

function buildHermesDashboardRecoveryLines(config: HermesDashboardRecoveryConfig): string[] {
  const tuiFlag = config.tuiEnabled ? " --tui" : "";
  const dashboardLogSelection =
    '_DASHBOARD_LOG=/tmp/hermes-dashboard.log; if ! : >> "$_DASHBOARD_LOG" 2>/dev/null; then _DASHBOARD_LOG=/tmp/hermes-dashboard-recovery.log; : >> "$_DASHBOARD_LOG" 2>/dev/null || true; fi;';
  return [
    "_HERMES_DASHBOARD_HOME=/sandbox/.hermes/dashboard-home;",
    `_HERMES_DASHBOARD_GATEWAY_PORT=${config.internalPort};`,
    '_HERMES_PYTHON=/opt/hermes/.venv/bin/python; [ -x "$_HERMES_PYTHON" ] || _HERMES_PYTHON="$(command -v python3 || echo python3)";',
    "_HERMES_DASHBOARD_CONFIG_SEEDER=/usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py;",
    `_DASH_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${config.internalPort}/ 2>/dev/null || echo 000); case "$_DASH_CODE" in 200|301|302|307|308) echo DASHBOARD_ALREADY_RUNNING; ;; *)`,
    `${buildNoFollowLogSetupCommand("/tmp/hermes-dashboard.log")} || exit 1;`,
    dashboardLogSelection,
    '[ -f "$_HERMES_DASHBOARD_CONFIG_SEEDER" ] || { echo "[dashboard-recovery] ERROR: dashboard config seeder missing"; exit 1; };',
    'if [ -L "$_HERMES_DASHBOARD_HOME" ]; then echo "[dashboard-recovery] ERROR: refusing symlinked dashboard home"; exit 1; fi;',
    'mkdir -p "$_HERMES_DASHBOARD_HOME"; if [ -L "$_HERMES_DASHBOARD_HOME" ] || [ ! -d "$_HERMES_DASHBOARD_HOME" ]; then echo "[dashboard-recovery] ERROR: unsafe dashboard home"; exit 1; fi;',
    'chmod 700 "$_HERMES_DASHBOARD_HOME"; rm -f "${_HERMES_DASHBOARD_HOME}/gateway_state.json" 2>/dev/null || true;',
    '"$_HERMES_PYTHON" "$_HERMES_DASHBOARD_CONFIG_SEEDER" /sandbox/.hermes/config.yaml "${_HERMES_DASHBOARD_HOME}/config.yaml" /sandbox/.hermes/.env "${_HERMES_DASHBOARD_HOME}/.env" || { echo "[dashboard-recovery] ERROR: config seed failed"; exit 1; };',
    "_DASHBOARD_PROC_PATTERN='[h]ermes[[:space:]]+dashboard([[:space:]]|$)';",
    'pkill -TERM -f "$_DASHBOARD_PROC_PATTERN" 2>/dev/null || true; sleep 1; pkill -KILL -f "$_DASHBOARD_PROC_PATTERN" 2>/dev/null || true;',
    `${hermesDashboardEnvPrefix()} nohup "$AGENT_BIN" dashboard --host 127.0.0.1 --port ${config.internalPort} --skip-build --no-open${tuiFlag} >> "$_DASHBOARD_LOG" 2>&1 &`,
    "DPID=$!; sleep 2;",
    'if kill -0 "$DPID" 2>/dev/null; then echo "DASHBOARD_PID=$DPID"; else echo DASHBOARD_FAILED; tail -5 "$_DASHBOARD_LOG" 2>/dev/null; exit 1; fi ;; esac;',
  ];
}

export function buildHermesDashboardProcessRecoveryScript(
  config: HermesDashboardRecoveryConfig,
): string {
  return [
    "export HERMES_HOME=/sandbox/.hermes;",
    buildHermesEnvFileBoundaryGuard(),
    ...buildGatewayGuardRecoveryLines(),
    '[ "$_GUARDS_MISSING" = "1" ] && { _E="[gateway-recovery] ERROR: NODE_OPTIONS missing safety-net preload or ciao preload after trusted recovery - refusing unguarded dashboard relaunch (#2478/#2701)"; echo "$_E" >&2; exit 1; };',
    "[ -f ~/.bashrc ] && . ~/.bashrc;",
    buildHermesRuntimeEnvBoundaryGuard(),
    'AGENT_BIN=/usr/local/bin/hermes; if [ ! -x "$AGENT_BIN" ]; then AGENT_BIN="$(command -v hermes)"; fi;',
    'if [ -z "$AGENT_BIN" ]; then echo AGENT_MISSING; exit 1; fi;',
    ...buildHermesDashboardRecoveryLines(config),
  ].join(" ");
}

/**
 * Build the OpenClaw recovery shell script used by the default sandbox.
 */
export function buildOpenClawRecoveryScript(port: number): string {
  const staleGatewayPattern = "[o]penclaw([ -]gateway| gateway run|$)";
  return [
    ...buildGatewayLogSetup(true, "gateway"),
    buildGatewayLogSelection(),
    ...buildGatewayGuardRecoveryLines(),
    gatewayGuardRefusalCommand(),
    "[ -f ~/.bashrc ] && . ~/.bashrc;",
    `_GW_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${port}/health 2>/dev/null || echo 000); case "$_GW_CODE" in 200|401) echo ALREADY_RUNNING; exit 0 ;; esac;`,
    "rm -rf /tmp/openclaw-*/gateway.*.lock 2>/dev/null;",
    `_GATEWAY_PROC_PATTERN=${shellQuote(staleGatewayPattern)};`,
    'if [ -n "$_GATEWAY_PROC_PATTERN" ]; then pkill -TERM -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; pkill -KILL -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; if pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1; then echo GATEWAY_STALE_PROCESSES; exit 1; fi; fi;',
    'OPENCLAW="$(command -v openclaw)";',
    'if [ -z "$OPENCLAW" ]; then echo OPENCLAW_MISSING; exit 1; fi;',
    gatewayLaunchCommand('"$OPENCLAW" gateway run --port ' + port, "gateway"),
    "GPID=$!; sleep 2;",
    'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; tail -5 "$_GATEWAY_LOG" 2>/dev/null; fi',
  ].join(" ");
}

/**
 * Build the recovery shell script for a non-OpenClaw agent.
 * Returns the script string, null if agent is null (use existing inline
 * OpenClaw script instead), or a terminal sentinel for agents without a
 * gateway process.
 */
export function buildRecoveryScript(
  agent: AgentDefinition & { runtime: { kind: "terminal" } },
  port: number,
  options?: AgentRecoveryOptions,
): typeof TERMINAL_AGENT_RECOVERY_SCRIPT;
export function buildRecoveryScript(
  agent: AgentDefinition | null,
  port: number,
  options?: AgentRecoveryOptions,
): string | null;
export function buildRecoveryScript(
  agent: AgentDefinition | null,
  port: number,
  options: AgentRecoveryOptions = {},
): AgentRecoveryScript {
  if (!agent) return null;
  if (isTerminalAgent(agent)) return TERMINAL_AGENT_RECOVERY_SCRIPT;

  const probeUrl = getHealthProbeUrl(agent);
  const binaryPath = agent.binary_path || "/usr/local/bin/openclaw";
  const binaryName = binaryPath.split("/").pop() ?? "openclaw";
  const defaultGatewayCommand = `${binaryName} gateway run`;
  const configuredGatewayCommand = agent.gateway_command?.trim() || defaultGatewayCommand;
  const usesValidatedBinary = configuredGatewayCommand === defaultGatewayCommand;
  const isHermes = agent.name === "hermes";
  const usesHermesServiceManager = usesManagedHermesLifecycle(agent) && usesValidatedBinary;
  const customGatewayExecutable = configuredGatewayCommand.split(/\s+/)[0] ?? binaryName;
  const gatewayProcessPattern = selfSafeGatewayProcessPattern(configuredGatewayCommand);
  const staleGatewayPattern = usesHermesServiceManager
    ? `(${gatewayProcessPattern}|[h]ermes\\.real[[:space:]]+gateway[[:space:]]+run([[:space:]]|$)|[h]ermes[[:space:]]+dashboard([[:space:]]|$))`
    : gatewayProcessPattern;
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
  const hermesHome = isHermes ? "export HERMES_HOME=/sandbox/.hermes; " : "";
  const hermesLaunchEnv = isHermes ? `env ${hermesGatewayEnvPrefix()} ` : "";
  const launchCommand = usesHermesServiceManager
    ? buildHermesServiceManagerLaunch(options)
    : usesValidatedBinary
      ? gatewayLaunchCommand(
          `${hermesLaunchEnv}"$AGENT_BIN" gateway run${isHermes ? "" : ` --port ${port}`}`,
        )
      : gatewayLaunchCommand(
          `${hermesLaunchEnv}${configuredGatewayCommand}${isHermes ? "" : ` --port ${port}`}`,
        );
  const healthFastPath = usesHermesServiceManager
    ? `${buildHermesManagedGatewayProbe()} _GW_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$_GW_CODE:$_HERMES_MANAGED_GATEWAY" in 200:1|401:1) echo ALREADY_RUNNING; exit 0 ;; esac;`
    : `_GW_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$_GW_CODE" in 200|401) echo ALREADY_RUNNING; exit 0 ;; esac;`;

  // Validate or rebuild /tmp/nemoclaw-proxy-env.sh before shell init and the
  // health fast path so a healthy gateway cannot leave a wiped guard chain
  // unrepaired. Recovery also stops stale launcher/gateway processes that may
  // have respawned between the health probe and relaunch.
  return [
    ...(usesHermesServiceManager
      ? [
          buildHermesRootLifecycleRefusal(),
          buildHermesTrustedPythonSelection(),
          buildHermesServiceManagerValidation(),
        ]
      : []),
    hermesHome,
    ...(isHermes ? [buildHermesEnvFileBoundaryGuard()] : []),
    ...buildGatewayLogSetup(false),
    buildGatewayLogSelection(),
    ...buildGatewayGuardRecoveryLines(),
    gatewayGuardRefusalCommand(),
    "[ -f ~/.bashrc ] && . ~/.bashrc;",
    healthFastPath,
    ...(usesHermesServiceManager ? [buildHermesServiceManagerShutdown()] : []),
    `_GATEWAY_PROC_PATTERN=${shellQuote(staleGatewayPattern)};`,
    'if [ -n "$_GATEWAY_PROC_PATTERN" ]; then pkill -TERM -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; pkill -KILL -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; if pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1; then echo GATEWAY_STALE_PROCESSES; exit 1; fi; fi;',
    ...validationSteps,
    ...(isHermes ? [buildHermesRuntimeEnvBoundaryGuard()] : []),
    launchCommand,
    usesHermesServiceManager ? "SERVICE_PID=$!; sleep 2;" : "GPID=$!; sleep 2;",
    usesHermesServiceManager
      ? 'if kill -0 "$SERVICE_PID" 2>/dev/null; then echo "SERVICE_PID=$SERVICE_PID"; else echo HERMES_SERVICE_MANAGER_FAILED; tail -20 /tmp/nemoclaw-start.log 2>/dev/null; exit 1; fi'
      : 'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; tail -5 "$_GATEWAY_LOG" 2>/dev/null; exit 1; fi',
    ...(isHermes && !usesHermesServiceManager && options.hermesDashboard
      ? buildHermesDashboardRecoveryLines(options.hermesDashboard)
      : []),
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
  if (agent && isTerminalAgent(agent)) return getTerminalCommand(agent) ?? agent.versionCommand;
  return agent?.gateway_command || "openclaw gateway run";
}

/**
 * Build a single copy-pasteable command for the user to run when automatic
 * gateway recovery fails. Unlike the raw gateway command, this keeps the
 * process alive after disconnect and preserves the agent-specific launch shape.
 */
export function buildManualRecoveryCommand(
  agent: AgentDefinition | null,
  port: number,
  options: AgentRecoveryOptions = {},
): string {
  if (agent && isTerminalAgent(agent)) return getTerminalCommand(agent) ?? agent.versionCommand;
  const binaryPath = agent?.binary_path || "/usr/local/bin/openclaw";
  const defaultGatewayCommand = `${shellQuote(binaryPath)} gateway run`;
  const gatewayCmd = agent?.gateway_command?.trim() || defaultGatewayCommand;
  const isHermes = agent?.name === "hermes";
  const usesHermesServiceManager = usesManagedHermesLifecycle(agent);
  if (usesHermesServiceManager) {
    const managedRecovery = buildRecoveryScript(agent, port, options);
    if (typeof managedRecovery === "string") return managedRecovery;
  }
  const envPrefix = isHermes ? `${hermesGatewayEnvPrefix()} ` : "";
  const portFlag = isHermes ? "" : ` --port ${port}`;
  const hermesHome = isHermes ? "export HERMES_HOME=/sandbox/.hermes;" : "";
  return [
    hermesHome,
    ...(isHermes ? [buildHermesEnvFileBoundaryGuard()] : []),
    ...buildGatewayLogSetup(false),
    buildGatewayLogSelection(),
    ...buildGatewayGuardRecoveryLines(),
    gatewayGuardRefusalCommand(),
    "[ -f ~/.bashrc ] && . ~/.bashrc;",
    ...(isHermes ? [buildHermesRuntimeEnvBoundaryGuard()] : []),
    `${envPrefix}nohup ${gatewayCmd}${portFlag} >> "$_GATEWAY_LOG" 2>&1 &`,
  ]
    .filter(Boolean)
    .join(" ");
}
