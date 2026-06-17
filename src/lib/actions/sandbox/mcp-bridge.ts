// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP bridge: manage stdio-to-HTTP proxies that expose host-side MCP servers
 * to sandboxes via egress policies and host.docker.internal.
 *
 * The host runs the compiled dist/mcp-proxy.js per registered server. The
 * sandbox reaches the proxy through OpenShell's egress proxy after a per-port
 * rule is approved.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import * as registry from "../../state/registry";
import type { McpBridgeEntry } from "../../state/registry";

export const MCP_PORT_START = 3100;
export const MCP_PORT_END = 3199;
// The sandbox reaches the host proxy through host.docker.internal. The proxy
// binds 127.0.0.1 (it holds host API keys, so it must stay off the LAN / other
// containers) and is additionally bearer-token gated. This relies on Docker
// Desktop's host-loopback mapping, so the bridge targets a Docker Desktop host
// running the sandbox locally; native Linux Docker maps host.docker.internal to
// the bridge gateway, not the host loopback. See docs/deployment/set-up-mcp-bridge.
export const MCP_HOST = "host.docker.internal";

// This module compiles to dist/lib/actions/sandbox/mcp-bridge.js, so the
// compiled proxy entry (src/mcp-proxy.ts -> dist/mcp-proxy.js) is three levels
// up. Kept out of dist/lib/** so it stays off the CLI coverage ratchet.
const PROXY_SCRIPT = path.join(__dirname, "..", "..", "..", "mcp-proxy.js");
const VALID_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const VALID_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_SANDBOX_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface AddOptions {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  port?: number;
}

// ── Validation ──────────────────────────────────────────────────

/**
 * Validate an MCP server identifier. Accepts the same characters as the
 * legacy CLI (mixed case + hyphens/underscores) but is local to this module
 * because sandbox names use a stricter RFC 1123 grammar elsewhere.
 */
export function validateMcpName(name: string, label = "name"): void {
  if (!name || !VALID_NAME_RE.test(name) || name.length > 64) {
    console.error(`  Invalid ${label} '${String(name).slice(0, 64)}'.`);
    console.error(
      "  Names must start with a letter and contain only letters, digits, hyphens, and underscores.",
    );
    process.exit(1);
  }
}

function validateEnvName(name: string): void {
  if (!name || !VALID_ENV_RE.test(name) || name.length > 128) {
    console.error(`  Invalid environment variable name '${String(name).slice(0, 128)}'.`);
    console.error("  Names must match [A-Za-z_][A-Za-z0-9_]* (e.g., GITHUB_TOKEN).");
    process.exit(1);
  }
}

/**
 * Reject sandbox names that could escape PID directory paths or break ssh aliases.
 * Defense-in-depth: even though `add()` looks the entry up in the registry first,
 * `restart`/`list`/`remove` operate on whatever is already on disk, so any value
 * that survives a write here flows through `pidDir()` and `ssh openshell-${name}`.
 * Mirrors the rule used by the tunnel services lifecycle.
 */
function validateSandboxName(name: string): string {
  if (!name || !SAFE_SANDBOX_RE.test(name) || name.includes("..") || name.length > 64) {
    // Print + exit like validateMcpName/validateEnvName rather than throwing:
    // these command paths don't wrap the call, so a throw would surface as an
    // uncaught stack trace instead of a clean CLI diagnostic.
    console.error(`  Invalid sandbox name '${String(name).slice(0, 64)}'.`);
    console.error(
      "  Names must start with a letter and contain only letters, digits, hyphens, and underscores.",
    );
    process.exit(1);
  }
  return name;
}

// ── PID file helpers ────────────────────────────────────────────

function pidDir(sandboxName: string): string {
  return `/tmp/nemoclaw-services-${sandboxName}`;
}

function pidFile(sandboxName: string, serverName: string): string {
  return path.join(pidDir(sandboxName), `mcp-${serverName}.pid`);
}

function logFile(sandboxName: string, serverName: string): string {
  return path.join(pidDir(sandboxName), `mcp-${serverName}.log`);
}

function writePidFile(filePath: string, pid: number): void {
  fs.writeFileSync(filePath, `${pid}\n${Date.now()}`);
}

/**
 * Read the PID file and return the process id if the proxy is alive,
 * or false otherwise. Treats PID files older than 30 days as stale to
 * guard against PID recycling across long-running hosts.
 */
export function isRunning(pidPath: string): number | false {
  try {
    const content = fs.readFileSync(pidPath, "utf-8").trim();
    const lines = content.split("\n");
    const pid = Number.parseInt(lines[0] ?? "", 10);
    const startTime = Number.parseInt(lines[1] ?? "", 10) || 0;
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    if (startTime && Date.now() - startTime > 30 * 24 * 60 * 60 * 1000) {
      return false;
    }
    return pid;
  } catch {
    return false;
  }
}

// ── SSH into sandbox ────────────────────────────────────────────

interface SshExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a shell command inside the sandbox via openshell's ssh-config.
 * Returns null when openshell or the ssh-config call fails — callers
 * should treat that as "sandbox unreachable, give up".
 */
function sshExec(
  sandboxName: string,
  command: string,
  timeoutMs: number = 30000,
): SshExecResult | null {
  const openshell = resolveOpenshell();
  if (!openshell) return null;

  const sshConfigResult = spawnSync(openshell, ["sandbox", "ssh-config", sandboxName], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (sshConfigResult.status !== 0 || !sshConfigResult.stdout) return null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-ssh-"));
  const confPath = path.join(tmpDir, "config");
  fs.writeFileSync(confPath, sshConfigResult.stdout, { mode: 0o600 });
  try {
    const result = spawnSync(
      "ssh",
      [
        "-T",
        "-F",
        confPath,
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        `openshell-${sandboxName}`,
        command,
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      },
    );
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } finally {
    try {
      fs.unlinkSync(confPath);
      fs.rmdirSync(tmpDir);
    } catch {
      /* best effort */
    }
  }
}

// ── Egress rule approval ────────────────────────────────────────

// `openshell rule get` always emits ANSI styling regardless of TTY/NO_COLOR,
// so strip them before regex matching.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function captureOpenshellRules(openshell: string, sandboxName: string): string {
  const result = spawnSync(openshell, ["rule", "get", sandboxName], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return (result.stdout || "").replace(ANSI_RE, "");
}

function findPendingChunkIds(rulesOutput: string, exactEndpoint: string): string[] {
  const ids: string[] = [];
  const chunks = rulesOutput.split(/\n\s*Chunk:\s*/);
  for (const chunk of chunks) {
    if (!/Status:.*pending/i.test(chunk)) continue;
    const endpointsMatch = chunk.match(/Endpoints:\s*(.+)/);
    if (!endpointsMatch || endpointsMatch[1].trim() !== exactEndpoint) continue;
    const idMatch = chunk.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (idMatch) ids.push(idMatch[1]);
  }
  return ids;
}

function endpointApproved(rulesOutput: string, exactEndpoint: string): boolean {
  const chunks = rulesOutput.split(/\n\s*Chunk:\s*/);
  return chunks.some((chunk) => {
    const ep = chunk.match(/Endpoints:\s*(.+)/);
    return ep != null && ep[1].trim() === exactEndpoint && /Status:.*approved/i.test(chunk);
  });
}

/**
 * Trigger a sandbox connection to host.docker.internal:port and approve the
 * resulting pending egress rule. Best-effort: prints a manual fallback
 * message if approval fails after a few attempts.
 */
export function approveEgressRule(sandboxName: string, port: number): void {
  const openshell = resolveOpenshell();
  if (!openshell) return;

  const exactEndpoint = `${MCP_HOST}:${port}`;

  // Trigger a connection so the egress proxy generates a pending rule.
  sshExec(sandboxName, `curl -s --max-time 3 http://${MCP_HOST}:${port} 2>/dev/null || true`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const rules = captureOpenshellRules(openshell, sandboxName);
    if (rules) {
      const ids = findPendingChunkIds(rules, exactEndpoint);
      for (const id of ids) {
        const approve = spawnSync(openshell, ["rule", "approve", "--chunk-id", id, sandboxName], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const out = `${approve.stdout || ""}${approve.stderr || ""}`;
        if (out && /approved/i.test(out)) {
          console.log(`  Egress rule approved for ${exactEndpoint}.`);
        }
      }

      const updated = captureOpenshellRules(openshell, sandboxName);
      if (updated && endpointApproved(updated, exactEndpoint)) return;
    }

    // Brief pause before retry — spawnSync sleep avoids importing setTimeout/await.
    spawnSync("sleep", ["1"]);
  }

  console.log(`  Note: egress rule for ${exactEndpoint} may need manual approval.`);
  console.log(`  Run: openshell rule get "${sandboxName}"`);
  console.log(`  Then: openshell rule approve --chunk-id <id> "${sandboxName}"`);
}

/**
 * Best-effort revoke of all egress rules whose endpoint matches the given
 * port. Used during `mcp remove` so a future bridge on the same port can't
 * inherit the prior approval. Quiet on failure — manual cleanup via
 * `openshell rule reject` is always available.
 */
function rejectEgressRule(sandboxName: string, port: number): void {
  const openshell = resolveOpenshell();
  if (!openshell) return;

  const exactEndpoint = `${MCP_HOST}:${port}`;
  const rules = captureOpenshellRules(openshell, sandboxName);
  if (!rules) return;

  const ids: string[] = [];
  for (const chunk of rules.split(/\n\s*Chunk:\s*/)) {
    const ep = chunk.match(/Endpoints:\s*(.+)/);
    if (!ep || ep[1].trim() !== exactEndpoint) continue;
    const idMatch = chunk.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (idMatch) ids.push(idMatch[1]);
  }

  for (const id of ids) {
    spawnSync(
      openshell,
      ["rule", "reject", "--chunk-id", id, "--reason", "mcp bridge removed", sandboxName],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }
}

// ── mcporter bootstrap ──────────────────────────────────────────

/**
 * Verify that `mcporter` is available on PATH inside the sandbox.
 * mcporter is pre-baked into the sandbox image (see Dockerfile.base); a missing
 * binary means the image is older than this NemoClaw release.
 */
export function ensureMcporter(sandboxName: string): boolean {
  const check = sshExec(sandboxName, "command -v mcporter");
  if (check && check.status === 0 && check.stdout) return true;

  console.error("  mcporter not found in sandbox.");
  console.error("  This sandbox image predates the MCP bridge feature.");
  console.error(`  Rebuild it (workspace files are preserved): nemoclaw "${sandboxName}" rebuild`);
  return false;
}

// ── Proxy lifecycle ─────────────────────────────────────────────

interface SpawnedProxy {
  pid: number;
}

function spawnProxy(
  sandboxName: string,
  serverName: string,
  exe: string,
  cmdArgs: string[],
  envValues: Record<string, string>,
  port: number,
  token: string | undefined,
): SpawnedProxy {
  const dir = pidDir(sandboxName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const proxyArgs = ["--exe", exe, "--port", String(port)];
  for (const arg of cmdArgs) {
    proxyArgs.push("--arg", arg);
  }
  for (const v of Object.keys(envValues)) {
    proxyArgs.push("--env", v);
  }
  if (token) {
    // Token name only; the value flows through env to keep it out of `ps` output.
    proxyArgs.push("--token-env", "MCP_PROXY_TOKEN");
  }

  // Minimal env for the proxy — values come from stored config, not the host.
  const proxyEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  for (const [k, v] of Object.entries(envValues)) {
    proxyEnv[k] = v;
  }
  if (token) {
    proxyEnv.MCP_PROXY_TOKEN = token;
  }

  const logPath = logFile(sandboxName, serverName);
  const logFd = fs.openSync(logPath, "a");
  const proc = spawn("node", [PROXY_SCRIPT, ...proxyArgs], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: proxyEnv,
  });
  proc.unref();
  fs.closeSync(logFd);

  if (!proc.pid) {
    throw new Error("Failed to spawn MCP proxy");
  }
  writePidFile(pidFile(sandboxName, serverName), proc.pid);
  return { pid: proc.pid };
}

function stopProxy(sandboxName: string, serverName: string): void {
  const file = pidFile(sandboxName, serverName);
  const runningPid = isRunning(file);
  if (runningPid) {
    try {
      process.kill(runningPid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* no pid file */
  }
}

/**
 * Block until a freshly spawned proxy confirms it bound the port (or failed),
 * by tailing its log. spawnProxy records the PID the instant `spawn()` returns,
 * but the proxy may still be binding — or fail to bind (e.g. EADDRINUSE when a
 * non-MCP process grabbed the port after the registry reserved it) — or bind
 * and then immediately exit because the MCP child command was bad. Finalizing
 * the egress rule and mcporter config against such a proxy leaves a broken
 * bridge, so `add`/`restart` gate on this.
 *
 * Only log bytes written after `sinceOffset` are inspected, so a reused log
 * file from a previous bridge of the same name can't match a stale line.
 * Returns "ready" once bound and still alive, "failed" on a bind error or an
 * early child exit, or "timeout" if neither is observed in time.
 *
 * Async (non-blocking `setTimeout` polling) rather than a synchronous spin so
 * it never freezes the event loop while waiting.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForProxyReady(
  sandboxName: string,
  serverName: string,
  port: number,
  sinceOffset: number,
  timeoutMs = 5000,
): Promise<"ready" | "failed" | "timeout"> {
  const logPath = logFile(sandboxName, serverName);
  const pidPath = pidFile(sandboxName, serverName);
  const listening = `listening on 127.0.0.1:${port}`;
  const readTail = (): string => {
    try {
      const buf = fs.readFileSync(logPath);
      return buf.subarray(Math.min(sinceOffset, buf.length)).toString("utf-8");
    } catch {
      return "";
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = readTail();
    if (tail.includes("failed to listen")) return "failed";
    if (tail.includes(listening)) {
      // Bound OK. Settle briefly and confirm the MCP child didn't immediately
      // die (bad --command, ENOENT, ...) — the proxy exits when its child does.
      await sleep(300);
      if (readTail().includes("child exited") || !isRunning(pidPath)) return "failed";
      return "ready";
    }
    // Proxy process gone before reporting either outcome.
    if (!isRunning(pidPath)) return readTail().includes(listening) ? "ready" : "failed";
    await sleep(100);
  }
  return "timeout";
}

// ── Add ─────────────────────────────────────────────────────────

export async function add(sandboxName: string, opts: AddOptions): Promise<void> {
  validateSandboxName(sandboxName);
  const { name, command, args: cmdArgs = [], env = {}, port: requestedPort } = opts;

  if (!name) {
    console.error("  Name is required: nemoclaw <sb> mcp add --name <name> -- <command> [args...]");
    process.exit(1);
  }
  validateMcpName(name, "server name");

  if (!command) {
    console.error("  Command is required: pass it after -- (e.g. -- npx -y <server>).");
    process.exit(1);
  }

  // `command` is spawned as a single executable (shell:false), so a value with
  // whitespace — e.g. someone passing --command "npx -y @scope/server" — would
  // try to exec a file literally named with spaces and fail with a confusing
  // ENOENT. Reject it early with the correct grammar.
  if (/\s/.test(command)) {
    console.error("  --command takes a single executable, not a command line.");
    console.error("  Put the command and its arguments after -- instead:");
    console.error(`    nemoclaw ${sandboxName} mcp add --name ${name} -- ${command}`);
    process.exit(1);
  }

  for (const v of Object.keys(env)) {
    validateEnvName(v);
  }

  if (
    requestedPort !== undefined &&
    (requestedPort < MCP_PORT_START || requestedPort > MCP_PORT_END)
  ) {
    console.error(
      `  Port ${requestedPort} is outside the MCP range ${MCP_PORT_START}-${MCP_PORT_END}.`,
    );
    process.exit(1);
  }

  const token = crypto.randomBytes(32).toString("hex");

  // Reserve the port + write a placeholder entry under the registry lock so a
  // concurrent `mcp add` can't pick the same port. If anything below fails we
  // roll back the entry under the lock too.
  let port: number;
  try {
    port = registry.withLock(() => {
      const data = registry.load();
      const sandbox = data.sandboxes[sandboxName];
      if (!sandbox) throw new Error(`Sandbox '${sandboxName}' not found.`);
      if (sandbox.mcp?.[name]) {
        throw new Error(
          `MCP server '${name}' already exists on sandbox '${sandboxName}'. ` +
            `Run 'nemoclaw ${sandboxName} mcp remove ${name}' first.`,
        );
      }

      // Compute used ports inside the lock.
      const used = new Set<number>();
      for (const sb of Object.values(data.sandboxes)) {
        if (!sb.mcp) continue;
        for (const entry of Object.values(sb.mcp)) {
          if (entry.port) used.add(entry.port);
        }
      }

      let chosen: number | null = null;
      if (requestedPort !== undefined) {
        if (used.has(requestedPort)) {
          throw new Error(`Port ${requestedPort} is already in use by another MCP bridge.`);
        }
        chosen = requestedPort;
      } else {
        for (let p = MCP_PORT_START; p <= MCP_PORT_END; p++) {
          if (!used.has(p)) {
            chosen = p;
            break;
          }
        }
      }
      if (chosen === null) {
        throw new Error(`No available ports in range ${MCP_PORT_START}-${MCP_PORT_END}.`);
      }

      const mcp: Record<string, McpBridgeEntry> = { ...(sandbox.mcp ?? {}) };
      mcp[name] = {
        command,
        args: cmdArgs,
        env,
        port: chosen,
        token,
        addedAt: new Date().toISOString(),
      };
      sandbox.mcp = mcp;
      registry.save(data);
      return chosen;
    });
  } catch (err) {
    console.error(`  ${(err as Error).message}`);
    process.exit(1);
  }

  const rollback = () => {
    registry.withLock(() => {
      const data = registry.load();
      const sandbox = data.sandboxes[sandboxName];
      if (sandbox?.mcp?.[name]) {
        const mcp = { ...sandbox.mcp };
        delete mcp[name];
        sandbox.mcp = Object.keys(mcp).length > 0 ? mcp : undefined;
        registry.save(data);
      }
    });
  };

  console.log(`  Starting MCP proxy for '${name}' on port ${port}...`);
  // Record the log size before spawning so the readiness probe only inspects
  // lines this proxy writes, not a stale "listening" line from a prior bridge.
  let logOffset = 0;
  try {
    logOffset = fs.statSync(logFile(sandboxName, name)).size;
  } catch {
    /* no prior log */
  }
  let proxy: SpawnedProxy;
  try {
    proxy = spawnProxy(sandboxName, name, command, cmdArgs, env, port, token);
  } catch (err) {
    console.error(`  Failed to start proxy: ${(err as Error).message}`);
    rollback();
    process.exit(1);
  }
  console.log(`  Proxy started (PID ${proxy.pid}).`);

  // Don't approve egress / register mcporter until the proxy actually bound the
  // port and survived child startup — otherwise a port collision or a bad
  // command leaves an approved rule and a saved entry pointing at a dead proxy.
  const ready = await waitForProxyReady(sandboxName, name, port, logOffset);
  if (ready !== "ready") {
    console.error(
      ready === "timeout"
        ? `  Proxy did not start listening within the timeout. See ${logFile(sandboxName, name)}.`
        : `  Proxy exited during startup (check the command). See ${logFile(sandboxName, name)}.`,
    );
    stopProxy(sandboxName, name);
    rollback();
    process.exit(1);
  }

  console.log(`  Approving egress rule for ${MCP_HOST}:${port}...`);
  approveEgressRule(sandboxName, port);

  console.log("  Registering server in sandbox...");
  if (!ensureMcporter(sandboxName)) {
    console.error("  Could not bootstrap mcporter. Rolling back...");
    stopProxy(sandboxName, name);
    rollback();
    return;
  }

  // Both name (validateMcpName) and token (hex from crypto.randomBytes) are
  // safe to embed in single-quoted shell strings — no `'`, no shell meta-chars.
  const configResult = sshExec(
    sandboxName,
    `mcporter config add '${name}' --url 'http://${MCP_HOST}:${port}' --header 'Authorization=Bearer ${token}' --scope home 2>&1`,
  );
  const configOut = configResult ? `${configResult.stdout}\n${configResult.stderr}`.trim() : "";
  const configFailed =
    !configResult || configResult.status !== 0 || !configOut || /error/i.test(configOut);
  if (configFailed) {
    console.error("  mcporter config add failed. Rolling back...");
    if (configOut) console.error(`  ${configOut}`);
    stopProxy(sandboxName, name);
    rollback();
    return;
  }

  console.log(`  MCP server '${name}' added to sandbox '${sandboxName}'.`);
}

// ── Remove ──────────────────────────────────────────────────────

export function remove(sandboxName: string, serverName: string): void {
  validateSandboxName(sandboxName);
  if (!serverName) {
    console.error("  Server name is required.");
    process.exit(1);
  }
  validateMcpName(serverName, "server name");

  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox || !sandbox.mcp || !sandbox.mcp[serverName]) {
    console.error(`  MCP server '${serverName}' not found on sandbox '${sandboxName}'.`);
    process.exit(1);
  }

  const port = sandbox.mcp[serverName].port;
  const file = pidFile(sandboxName, serverName);
  const runningPid = isRunning(file);
  stopProxy(sandboxName, serverName);
  if (runningPid) {
    console.log(`  Proxy stopped (PID ${runningPid}).`);
  }

  // Best-effort cleanup of the sandbox-side mcporter entry.
  sshExec(sandboxName, `mcporter config remove '${serverName}' 2>&1 || true`);

  // Best-effort revoke of the egress rule so a future bridge on the same port
  // doesn't inherit the prior approval.
  rejectEgressRule(sandboxName, port);

  const mcp = { ...sandbox.mcp };
  delete mcp[serverName];
  registry.updateSandbox(sandboxName, {
    mcp: Object.keys(mcp).length > 0 ? mcp : undefined,
  });

  console.log(`  MCP server '${serverName}' removed from sandbox '${sandboxName}'.`);
}

// ── List ────────────────────────────────────────────────────────

export function list(sandboxName: string): void {
  validateSandboxName(sandboxName);
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox || !sandbox.mcp || Object.keys(sandbox.mcp).length === 0) {
    console.log("");
    console.log(`  No MCP bridges for sandbox '${sandboxName}'.`);
    console.log("");
    return;
  }

  console.log("");
  console.log(`  MCP Bridges for sandbox "${sandboxName}":`);
  console.log("");

  for (const [name, entry] of Object.entries(sandbox.mcp)) {
    const running = isRunning(pidFile(sandboxName, name));
    const marker = running ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m";
    const status = running ? "" : "  (stopped)";
    const envKeys = Object.keys(entry.env || {});
    const envStr = envKeys.length > 0 ? `env: ${envKeys.join(", ")}` : "env: (none)";
    const cmdDisplay = [entry.command, ...(entry.args || [])].join(" ");
    console.log(
      `    ${marker} ${name.padEnd(14)} :${entry.port}  ${cmdDisplay.slice(0, 45).padEnd(45)}  ${envStr}${status}`,
    );
  }
  console.log("");
}

// ── Restart ─────────────────────────────────────────────────────

export async function restart(sandboxName: string, serverName?: string): Promise<void> {
  validateSandboxName(sandboxName);
  if (serverName) validateMcpName(serverName, "server name");
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox || !sandbox.mcp) {
    console.log("  No MCP bridges to restart.");
    return;
  }

  const targets: Record<string, McpBridgeEntry | undefined> = serverName
    ? { [serverName]: sandbox.mcp[serverName] }
    : sandbox.mcp;

  for (const [name, entry] of Object.entries(targets)) {
    if (!entry) {
      console.error(`  MCP server '${name}' not found.`);
      continue;
    }

    // Re-validate registry contents — defense in depth against a tampered
    // sandboxes.json. validateMcpName/validateEnvName both `process.exit(1)`
    // on failure, so a bad entry stops the whole restart batch.
    validateMcpName(name, "server name");
    for (const v of Object.keys(entry.env ?? {})) {
      validateEnvName(v);
    }
    if (
      typeof entry.command !== "string" ||
      entry.command.includes("\0") ||
      entry.command.includes("\n")
    ) {
      console.error(`    Invalid command for '${name}'; skipping.`);
      continue;
    }
    if (!Number.isFinite(entry.port) || entry.port < MCP_PORT_START || entry.port > MCP_PORT_END) {
      console.error(`    Invalid port ${entry.port} for '${name}'; skipping.`);
      continue;
    }

    console.log(`  Restarting '${name}'...`);
    stopProxy(sandboxName, name);

    let logOffset = 0;
    try {
      logOffset = fs.statSync(logFile(sandboxName, name)).size;
    } catch {
      /* no prior log */
    }

    let proxy: SpawnedProxy;
    try {
      proxy = spawnProxy(
        sandboxName,
        name,
        entry.command,
        entry.args ?? [],
        entry.env ?? {},
        entry.port,
        entry.token,
      );
    } catch (err) {
      console.error(`    Failed to start proxy: ${(err as Error).message}`);
      continue;
    }

    const ready = await waitForProxyReady(sandboxName, name, entry.port, logOffset);
    if (ready !== "ready") {
      console.error(
        `    Proxy for '${name}' ${ready === "timeout" ? "did not bind in time" : "exited during startup"}; skipping egress approval. See ${logFile(sandboxName, name)}.`,
      );
      stopProxy(sandboxName, name);
      continue;
    }

    approveEgressRule(sandboxName, entry.port);
    console.log(`    Started (PID ${proxy.pid}, port ${entry.port}).`);
  }
}

// ── CLI argument parsing ────────────────────────────────────────

export interface ParsedAddArgs {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  port?: number;
}

/**
 * Parse `mcp add` flags. Adopts the same `-e KEY=VALUE` shape as Claude
 * Code's `claude mcp add` so users can copy-paste configurations:
 *
 *   nemoclaw <sb> mcp add --name github -e GITHUB_TOKEN=$TOKEN \
 *     -- npx -y @modelcontextprotocol/server-github
 *
 * `--command` takes a single executable and `--arg` adds one argument each;
 * everything after `--` is the command and its arguments. The bridge stores
 * env values inline in the registry (mode-600 file) rather than reading them
 * from the host environment at restart time.
 */
export function parseAddArgs(argv: string[]): ParsedAddArgs {
  const out: ParsedAddArgs = { name: "", command: "", args: [], env: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--name") {
      out.name = argv[++i] ?? "";
    } else if (flag === "--command") {
      out.command = argv[++i] ?? "";
    } else if (flag === "--port") {
      const raw = argv[++i] ?? "";
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        console.error(`  Invalid --port value: ${raw}`);
        process.exit(1);
      }
      out.port = parsed;
    } else if (flag === "-e" || flag === "--env") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        console.error(`  --env expects KEY=VALUE (got '${pair}').`);
        process.exit(1);
      }
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      out.env[key] = value;
    } else if (flag === "--arg") {
      // Note: --arg values land in proxy logs (mcp-<name>.log). Never put
      // secrets here — use -e KEY=VALUE for tokens, which only ever exposes
      // the env-var name, not the value.
      out.args.push(argv[++i] ?? "");
    } else if (flag === "--") {
      // Everything after -- is the command + args
      const rest = argv.slice(i + 1);
      if (rest.length > 0) {
        out.command = rest[0];
        out.args.push(...rest.slice(1));
      }
      break;
    } else if (flag && !flag.startsWith("--") && !out.command) {
      // Allow `mcp add <name> -- <command> [args...]` legacy form when
      // -- separator is used.
      out.command = flag;
    } else if (flag) {
      console.error(`  Unknown flag: ${flag}`);
      process.exit(1);
    }
  }
  return out;
}

// ── Top-level dispatch ──────────────────────────────────────────

/**
 * Dispatch `nemoclaw <sandbox> mcp <subcommand> [args]`. Centralised here
 * so the oclif command only has to forward `actionArgs` plus the sandbox name.
 */
export async function dispatch(sandboxName: string, actionArgs: string[]): Promise<void> {
  const sub = actionArgs[0];
  const rest = actionArgs.slice(1);

  switch (sub) {
    case "add": {
      const opts = parseAddArgs(rest);
      await add(sandboxName, opts);
      break;
    }
    case "remove": {
      const target = rest[0] ?? "";
      remove(sandboxName, target);
      break;
    }
    case "list":
    case undefined:
    case "":
      list(sandboxName);
      break;
    case "restart":
      await restart(sandboxName, rest[0]);
      break;
    default:
      console.error(`  Unknown mcp subcommand: ${sub}`);
      console.error("  Usage: nemoclaw <name> mcp <add|remove|list|restart> [args]");
      console.error("    add --name <id> [-e KEY=VALUE ...] [--port PORT] -- <command> [args...]");
      console.error("    remove <id>");
      console.error("    list");
      console.error("    restart [<id>]");
      process.exit(1);
  }
}
