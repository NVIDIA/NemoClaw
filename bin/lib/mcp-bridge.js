// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// MCP bridge: manage stdio-to-HTTP proxies that expose host-side MCP servers
// to sandboxes via OpenShell port forwarding.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ROOT, SCRIPTS, run, runCapture } = require("./runner");
const { resolveOpenshell } = require("./resolve-openshell");
const registry = require("./registry");

const MCP_PORT_START = 3100;
const MCP_PORT_END = 3199;
const PROXY_SCRIPT = path.join(SCRIPTS, "mcp-proxy.js");
const VALID_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function validateName(name) {
  if (!name || !VALID_NAME_RE.test(name) || name.length > 64) {
    console.error(`  Invalid server name '${String(name).slice(0, 64)}'.`);
    console.error(
      "  Names must start with a letter and contain only letters, digits, hyphens, and underscores.",
    );
    process.exit(1);
  }
}

// ── PID file helpers ────────────────────────────────────────────

function pidDir(sandboxName) {
  return `/tmp/nemoclaw-services-${sandboxName}`;
}

function pidFile(sandboxName, serverName) {
  return path.join(pidDir(sandboxName), `mcp-${serverName}.pid`);
}

function isRunning(pidPath) {
  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return pid;
  } catch {
    return false;
  }
}

// ── Port management ─────────────────────────────────────────────

function getAllUsedPorts() {
  const data = registry.load();
  const used = new Set();
  for (const sb of Object.values(data.sandboxes)) {
    if (!sb.mcp) continue;
    for (const entry of Object.values(sb.mcp)) {
      if (entry.port) used.add(entry.port);
    }
  }
  return used;
}

function nextAvailablePort() {
  const used = getAllUsedPorts();
  for (let p = MCP_PORT_START; p <= MCP_PORT_END; p++) {
    if (!used.has(p)) return p;
  }
  return null;
}

function validatePort(port) {
  if (port < MCP_PORT_START || port > MCP_PORT_END) {
    console.error(
      `  Port ${port} is outside the MCP range ${MCP_PORT_START}-${MCP_PORT_END}.`,
    );
    process.exit(1);
  }
  const used = getAllUsedPorts();
  if (used.has(port)) {
    console.error(`  Port ${port} is already in use by another MCP bridge.`);
    process.exit(1);
  }
}

// ── SSH into sandbox ────────────────────────────────────────────

function sshExec(sandboxName, command) {
  const openshell = resolveOpenshell();
  if (!openshell) {
    console.error("  openshell not found.");
    process.exit(1);
  }
  const sshConfig = runCapture(
    `"${openshell}" sandbox ssh-config "${sandboxName}"`,
  );
  const confPath = `/tmp/nemoclaw-mcp-ssh-${sandboxName}.conf`;
  fs.writeFileSync(confPath, sshConfig);
  try {
    return runCapture(
      `ssh -T -F "${confPath}" -o ConnectTimeout=10 "openshell-${sandboxName}" '${command.replace(/'/g, "'\\''")}'`,
      { ignoreError: true },
    );
  } finally {
    try {
      fs.unlinkSync(confPath);
    } catch {}
  }
}

// ── mcporter bootstrap ──────────────────────────────────────────

function ensureMcporter(sandboxName) {
  const check = sshExec(sandboxName, "command -v mcporter");
  if (check && check.trim()) return true;

  console.log("  Installing mcporter in sandbox...");
  sshExec(sandboxName, "npm install --prefix /sandbox/.local mcporter 2>&1");

  // Ensure PATH includes mcporter
  const profileLine = 'export PATH="/sandbox/.local/node_modules/.bin:$PATH"';
  sshExec(
    sandboxName,
    `grep -qF '${profileLine}' /sandbox/.bash_profile 2>/dev/null || echo '${profileLine}' >> /sandbox/.bash_profile`,
  );

  const verify = sshExec(
    sandboxName,
    "/sandbox/.local/node_modules/.bin/mcporter --version",
  );
  if (verify && verify.trim()) {
    console.log(`  mcporter ${verify.trim()} installed.`);
    return true;
  }

  console.error("  Failed to install mcporter in sandbox.");
  return false;
}

// ── Add ─────────────────────────────────────────────────────────

function add(sandboxName, opts) {
  const { name, command, env = [], port: requestedPort } = opts;

  if (!name) {
    console.error("  --name is required.");
    process.exit(1);
  }
  validateName(name);

  if (!command) {
    console.error("  --command is required.");
    process.exit(1);
  }

  // Validate sandbox exists
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) {
    console.error(`  Sandbox '${sandboxName}' not found.`);
    process.exit(1);
  }

  // Check for duplicate
  if (sandbox.mcp && sandbox.mcp[name]) {
    console.error(
      `  MCP server '${name}' already exists on sandbox '${sandboxName}'.`,
    );
    console.error(`  Use 'nemoclaw ${sandboxName} mcp remove ${name}' first.`);
    process.exit(1);
  }

  // Validate env vars are set
  for (const v of env) {
    if (!process.env[v]) {
      console.error(`  Environment variable ${v} is not set.`);
      process.exit(1);
    }
  }

  // Assign port
  if (requestedPort) validatePort(requestedPort);
  const port = requestedPort || nextAvailablePort();
  if (!port) {
    console.error(
      `  No available ports in range ${MCP_PORT_START}-${MCP_PORT_END}.`,
    );
    process.exit(1);
  }

  // Start the proxy
  console.log(`  Starting MCP proxy for '${name}' on port ${port}...`);
  const dir = pidDir(sandboxName);
  fs.mkdirSync(dir, { recursive: true });

  const proxyArgs = ["--command", command, "--port", String(port)];
  for (const v of env) {
    proxyArgs.push("--env", v);
  }

  const logPath = path.join(dir, `mcp-${name}.log`);
  const logFd = fs.openSync(logPath, "a");
  const proc = spawn("node", [PROXY_SCRIPT, ...proxyArgs], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  proc.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(pidFile(sandboxName, name), String(proc.pid));
  console.log(`  Proxy started (PID ${proc.pid}).`);

  // Forward port into sandbox
  console.log(`  Forwarding port ${port} into sandbox...`);
  run(
    `openshell forward stop ${port} 2>/dev/null; openshell forward start --background ${port} "${sandboxName}" 2>/dev/null || true`,
    { ignoreError: true },
  );

  // Bootstrap mcporter and register server
  console.log("  Registering server in sandbox...");
  if (!ensureMcporter(sandboxName)) {
    console.error("  Could not bootstrap mcporter. Rolling back...");
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {}
    try {
      fs.unlinkSync(pidFile(sandboxName, name));
    } catch {}
    run(`openshell forward stop ${port} 2>/dev/null || true`, {
      ignoreError: true,
    });
    return;
  }

  sshExec(
    sandboxName,
    `/sandbox/.local/node_modules/.bin/mcporter config add ${name} --url http://localhost:${port} --scope home 2>&1 || true`,
  );

  // Save to registry
  const mcp = sandbox.mcp || {};
  mcp[name] = {
    type: "stdio",
    command,
    env,
    port,
    addedAt: new Date().toISOString(),
  };
  registry.updateSandbox(sandboxName, { mcp });

  console.log(`  MCP server '${name}' added to sandbox '${sandboxName}'.`);
}

// ── Remove ──────────────────────────────────────────────────────

function remove(sandboxName, serverName) {
  if (!serverName) {
    console.error("  Server name is required.");
    process.exit(1);
  }
  validateName(serverName);

  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox || !sandbox.mcp || !sandbox.mcp[serverName]) {
    console.error(
      `  MCP server '${serverName}' not found on sandbox '${sandboxName}'.`,
    );
    process.exit(1);
  }

  const entry = sandbox.mcp[serverName];

  // Stop proxy
  const pid = pidFile(sandboxName, serverName);
  const runningPid = isRunning(pid);
  if (runningPid) {
    try {
      process.kill(runningPid, "SIGTERM");
      console.log(`  Proxy stopped (PID ${runningPid}).`);
    } catch {}
  }
  try {
    fs.unlinkSync(pid);
  } catch {}

  // Stop port forward
  run(`openshell forward stop ${entry.port} 2>/dev/null || true`, {
    ignoreError: true,
  });

  // Remove from sandbox mcporter config
  sshExec(
    sandboxName,
    `/sandbox/.local/node_modules/.bin/mcporter config remove ${serverName} 2>&1 || true`,
  );

  // Remove from registry
  delete sandbox.mcp[serverName];
  registry.updateSandbox(sandboxName, { mcp: sandbox.mcp });

  console.log(
    `  MCP server '${serverName}' removed from sandbox '${sandboxName}'.`,
  );
}

// ── List ────────────────────────────────────────────────────────

function list(sandboxName) {
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
    const pid = pidFile(sandboxName, name);
    const running = isRunning(pid);
    const marker = running ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m";
    const status = running ? "" : "  (stopped)";
    const envStr =
      entry.env && entry.env.length > 0
        ? `env: ${entry.env.join(", ")}`
        : "env: (none)";
    const source = entry.type === "http" ? entry.url : entry.command;
    console.log(
      `    ${marker} ${name.padEnd(14)} :${entry.port}  ${source.slice(0, 45).padEnd(45)}  ${envStr}${status}`,
    );
  }
  console.log("");
}

// ── Restart ─────────────────────────────────────────────────────

function restart(sandboxName, serverName) {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox || !sandbox.mcp) {
    console.log("  No MCP bridges to restart.");
    return;
  }

  const servers = serverName
    ? { [serverName]: sandbox.mcp[serverName] }
    : sandbox.mcp;

  for (const [name, entry] of Object.entries(servers)) {
    if (!entry) {
      console.error(`  MCP server '${name}' not found.`);
      continue;
    }

    console.log(`  Restarting '${name}'...`);

    // Stop existing proxy if running
    const pid = pidFile(sandboxName, name);
    const runningPid = isRunning(pid);
    if (runningPid) {
      try {
        process.kill(runningPid, "SIGTERM");
      } catch {}
      try {
        fs.unlinkSync(pid);
      } catch {}
    }

    // Validate env vars
    let envOk = true;
    for (const v of entry.env || []) {
      if (!process.env[v]) {
        console.error(
          `    Environment variable ${v} is not set. Skipping '${name}'.`,
        );
        envOk = false;
        break;
      }
    }
    if (!envOk) continue;

    // Start proxy
    const dir = pidDir(sandboxName);
    fs.mkdirSync(dir, { recursive: true });

    const proxyArgs = [
      "--command",
      entry.command,
      "--port",
      String(entry.port),
    ];
    for (const v of entry.env || []) {
      proxyArgs.push("--env", v);
    }

    const logPath = path.join(dir, `mcp-${name}.log`);
    const logFd = fs.openSync(logPath, "a");
    const proc = spawn("node", [PROXY_SCRIPT, ...proxyArgs], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    proc.unref();
    fs.closeSync(logFd);
    fs.writeFileSync(pidFile(sandboxName, name), String(proc.pid));

    // Forward port
    run(
      `openshell forward stop ${entry.port} 2>/dev/null; openshell forward start --background ${entry.port} "${sandboxName}" 2>/dev/null || true`,
      { ignoreError: true },
    );

    console.log(`    Started (PID ${proc.pid}, port ${entry.port}).`);
  }
}

module.exports = { add, remove, list, restart, ensureMcporter };
