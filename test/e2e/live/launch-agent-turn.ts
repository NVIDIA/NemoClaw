// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export const OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT =
  'if [ -r "/tmp/nemoclaw-proxy-env.sh" ]; then builtin source "/tmp/nemoclaw-proxy-env.sh" || exit $?; fi; builtin unset OPENCLAW_GATEWAY_TOKEN; builtin exec -- "$@"';

// OpenShell creates the PTY before it drops to the sandbox user. This child
// process inherits fd 0, so it can observe PTY input mode without reopening the
// root-owned device path from a separate sandbox command.
export const OPENCLAW_PTY_INPUT_MODE_MONITOR_SCRIPT = String.raw`
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const [role, parentPidText, runId, publicKeyBase64, runRoot, ttyPath, dev, ino, rdev, sttyCommand] =
  process.argv.slice(1);
const socketPath = path.join(runRoot, "pty-input-mode.sock");
const MAX_REQUEST_BYTES = 1024;
const MAX_RESPONSE_BYTES = 1024;
const MAX_STDERR_BYTES = 256;
const parentPid = Number(parentPidText);
const clients = new Set();
let pendingClient;
let ready = false;
let retired = false;
let socketDev;
let socketIno;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function response(requestId, state, result = null, fallbackCode = null) {
  const status =
    Number.isInteger(result && result.status) && result.status >= 0 && result.status <= 255
      ? result.status
      : null;
  const resultSignal = result && result.signal;
  const signal =
    typeof resultSignal === "string" && /^SIG[A-Z0-9]{1,24}$/.test(resultSignal)
      ? resultSignal
      : null;
  const resultCode = result && result.error && result.error.code;
  const errorCode =
    typeof resultCode === "string" && /^[A-Z0-9_]{1,64}$/.test(resultCode)
      ? resultCode
      : fallbackCode;
  const unsigned = {
    schemaVersion: 1,
    runId,
    requestId,
    ttyPath,
    dev,
    ino,
    rdev,
    state,
    status,
    signal,
    errorCode,
    stderr: String((result && result.stderr) || "")
      .replace(/[^\x20-\x7e]/g, " ")
      .trim()
      .slice(0, MAX_STDERR_BYTES),
  };
  return {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(JSON.stringify(unsigned)), privateKey).toString("base64"),
  };
}

function closeInput() {
  try {
    fs.closeSync(0);
  } catch {}
}

function sameRoot() {
  try {
    const stats = fs.lstatSync(runRoot, { bigint: true });
    return (
      stats.isDirectory() &&
      !stats.isSymbolicLink() &&
      stats.uid === BigInt(process.getuid()) &&
      (stats.mode & 0o777n) === 0o700n &&
      stats.dev === rootStats.dev &&
      stats.ino === rootStats.ino
    );
  } catch {
    return false;
  }
}

function sameSocket() {
  try {
    const stats = fs.lstatSync(socketPath, { bigint: true });
    return (
      stats.isSocket() &&
      stats.uid === BigInt(process.getuid()) &&
      (stats.mode & 0o777n) === 0o600n &&
      stats.nlink === 1n &&
      stats.dev === socketDev &&
      stats.ino === socketIno
    );
  } catch {
    return false;
  }
}

function sameTty() {
  try {
    const stats = fs.fstatSync(0, { bigint: true });
    return (
      stats.isCharacterDevice() &&
      stats.dev.toString() === dev &&
      stats.ino.toString() === ino &&
      stats.rdev.toString() === rdev
    );
  } catch {
    return false;
  }
}

function retire() {
  if (retired) return;
  retired = true;
  pendingClient?.destroy();
  pendingClient = undefined;
  closeInput();
}

function send(client, observation) {
  if (process.ppid !== parentPid) return client.destroy();
  const body = JSON.stringify(observation) + "\n";
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    client.destroy();
    return retire();
  }
  client.end(body);
  if (observation.state !== "canonical") retire();
}

function observeRequest(client, requestId) {
  if (process.ppid !== parentPid || retired || !sameRoot() || !sameSocket()) {
    return client.destroy();
  }
  if (!sameTty()) {
    return send(client, response(requestId, "unavailable", null, "PTY_IDENTITY_CHANGED"));
  }
  const result = childProcess.spawnSync(sttyCommand, ["-a"], {
    encoding: "utf8",
    env: { LC_ALL: "C" },
    stdio: [0, "pipe", "pipe"],
    timeout: 1_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
  if (process.ppid !== parentPid) return client.destroy();
  if (!sameTty()) {
    return send(client, response(requestId, "unavailable", null, "PTY_IDENTITY_CHANGED"));
  }
  if (result.error) {
    return send(client, response(requestId, "unavailable", result, "PTY_TERMIOS_QUERY_FAILED"));
  }
  if (result.status !== 0) return send(client, response(requestId, "unavailable", result));
  if (/(^|[\s;])-icanon([\s;]|$)/.test(result.stdout)) {
    return send(client, response(requestId, "noncanonical"));
  }
  if (/(^|[\s;])icanon([\s;]|$)/.test(result.stdout)) {
    return send(client, response(requestId, "canonical"));
  }
  return send(client, response(requestId, "unavailable", result, "PTY_TERMIOS_OUTPUT_INVALID"));
}

function observe(client) {
  clients.add(client);
  client.once("close", () => clients.delete(client));
  client.on("error", () => {});
  client.setEncoding("utf8");
  client.setTimeout(3_000, () => client.destroy());
  let raw = "";
  client.on("data", (chunk) => {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) return client.destroy();
    if (!raw.endsWith("\n")) return;
    let request;
    try {
      request = JSON.parse(raw);
    } catch {
      return client.destroy();
    }
    if (
      !exactKeys(request, ["schemaVersion", "runId", "requestId"]) ||
      request.schemaVersion !== 1 ||
      request.runId !== runId ||
      !/^[0-9a-f]{32}$/.test(request.requestId || "")
    ) {
      return client.destroy();
    }
    client.removeAllListeners("data");
    observeRequest(client, request.requestId);
  });
  client.resume();
}

function accept(client) {
  client.on("error", () => {});
  if (ready) return observe(client);
  if (pendingClient) return client.destroy();
  pendingClient = client;
}

if (role !== "nemoclaw-pty-input-mode-monitor") process.exit(74);
if (!Number.isSafeInteger(parentPid) || parentPid < 2) process.exit(74);
if (!/^[0-9a-f]{32}$/.test(runId || "")) process.exit(74);
if (!/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(publicKeyBase64 || "")) process.exit(74);
if (runRoot !== "/tmp/nemoclaw-launch-turn-" + runId) process.exit(74);
if (!/^\/dev\/pts\/\d+$/.test(ttyPath || "")) process.exit(74);
if (![dev, ino, rdev].every((value) => /^(0|[1-9]\d{0,24})$/.test(value || ""))) {
  process.exit(74);
}
if (sttyCommand !== "/usr/bin/stty" && !path.isAbsolute(sttyCommand || "")) process.exit(74);

let privateKey;
try {
  const privateKeyBase64 = fs.readFileSync(3, "utf8").trim();
  fs.closeSync(3);
  privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const derivedPublicKey = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");
  if (derivedPublicKey !== publicKeyBase64) process.exit(74);
} catch {
  process.exit(74);
}

const rootStats = fs.lstatSync(runRoot, { bigint: true });
if (
  !rootStats.isDirectory() ||
  rootStats.isSymbolicLink() ||
  rootStats.uid !== BigInt(process.getuid()) ||
  (rootStats.mode & 0o777n) !== 0o700n
) {
  process.exit(74);
}
try {
  fs.lstatSync(socketPath);
  process.exit(74);
} catch (error) {
  if (!error || error.code !== "ENOENT") process.exit(74);
}

const server = net.createServer({ pauseOnConnect: true }, accept);
server.on("error", retire);
process.umask(0o177);
server.listen(socketPath, () => {
  try {
    fs.chmodSync(socketPath, 0o600);
    const stats = fs.lstatSync(socketPath, { bigint: true });
    if (
      !stats.isSocket() ||
      stats.uid !== BigInt(process.getuid()) ||
      (stats.mode & 0o777n) !== 0o600n ||
      stats.nlink !== 1n
    ) {
      return retire();
    }
    socketDev = stats.dev;
    socketIno = stats.ino;
    ready = true;
    if (pendingClient) {
      const client = pendingClient;
      pendingClient = undefined;
      observe(client);
    }
    process.stdout.write("READY\n");
  } catch {
    retire();
  }
});
const parentWatcher = setInterval(() => {
  if (process.ppid === parentPid) return;
  clearInterval(parentWatcher);
  pendingClient?.destroy();
  for (const client of clients) client.destroy();
  closeInput();
  if (!server.listening || !sameRoot() || !sameSocket()) process.exit(0);
  server.close(() => process.exit(0));
}, 25);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {});
}
`;

// The host sends the private key through this process's standard input. The
// starter opens and unlinks the resulting file before candidate code runs.
export const OPENCLAW_PTY_MONITOR_KEY_WRITER_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");

const [runId, runRoot, publicKeyBase64] = process.argv.slice(1);
const privateKeyPath = path.join(runRoot, "pty-monitor-private-key");

function fail(reason) {
  process.stderr.write(JSON.stringify({ reason }) + "\n");
  process.exit(74);
}

function exactMode(stats, mode) {
  return (stats.mode & 0o777) === mode;
}

if (!/^[0-9a-f]{32}$/.test(runId || "")) fail("pty_run_id_invalid");
if (runRoot !== "/tmp/nemoclaw-launch-turn-" + runId) fail("pty_monitor_root_invalid");
if (!/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(publicKeyBase64 || "")) {
  fail("pty_public_key_invalid");
}

let privateKeyBase64;
try {
  privateKeyBase64 = fs.readFileSync(0, "utf8");
} catch {
  fail("pty_private_key_read_failed");
}
if (!/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(privateKeyBase64 || "")) {
  fail("pty_private_key_invalid");
}

try {
  fs.mkdirSync(runRoot, { mode: 0o700 });
  fs.chmodSync(runRoot, 0o700);
  const rootStats = fs.lstatSync(runRoot);
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    rootStats.uid !== process.getuid() ||
    !exactMode(rootStats, 0o700)
  ) {
    fail("pty_monitor_root_invalid");
  }
  fs.writeFileSync(privateKeyPath, privateKeyBase64, { flag: "wx", mode: 0o600 });
  fs.chmodSync(privateKeyPath, 0o600);
} catch {
  fail("pty_private_key_write_failed");
}
`;

// This starter and its monitor both inherit PTY fd 0. The starter then replaces
// itself with the unchanged production command while the monitor retains its
// descriptor.
export const OPENCLAW_PTY_MONITOR_STARTER_SCRIPT = String.raw`
const childProcess = require("node:child_process");
const fs = require("node:fs");

const monitorScript = ${JSON.stringify(OPENCLAW_PTY_INPUT_MODE_MONITOR_SCRIPT)};
const termiosCommand = "/usr/bin/stty";

const [runId, runRoot, publicKeyBase64, privateKeyPath, ...originalArgv] =
  process.argv.slice(1);

function fail(reason) {
  process.stderr.write(JSON.stringify({ reason }) + "\n");
  process.exit(72);
}

function exactMode(stats, mode) {
  return (stats.mode & 0o777) === mode;
}

function validateRunRoot() {
  let stats;
  try {
    stats = fs.lstatSync(runRoot);
  } catch {
    fail("pty_monitor_root_unavailable");
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.getuid() ||
    !exactMode(stats, 0o700)
  ) {
    fail("pty_monitor_root_invalid");
  }
}

if (!/^[0-9a-f]{32}$/.test(runId || "")) fail("pty_run_id_invalid");
if (!/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(publicKeyBase64 || "")) {
  fail("pty_public_key_invalid");
}
if (runRoot !== "/tmp/nemoclaw-launch-turn-" + runId) fail("pty_monitor_root_invalid");
if (privateKeyPath !== runRoot + "/pty-monitor-private-key") {
  fail("pty_private_key_path_invalid");
}
if (originalArgv.length === 0) fail("pty_original_argv_invalid");
if (typeof process.execve !== "function") fail("pty_execve_unavailable");

validateRunRoot();

let privateKeyBase64;
let privateKeyFd;
try {
  privateKeyFd = fs.openSync(
    privateKeyPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  const privateKeyStats = fs.fstatSync(privateKeyFd);
  if (
    !privateKeyStats.isFile() ||
    privateKeyStats.uid !== process.getuid() ||
    !exactMode(privateKeyStats, 0o600) ||
    privateKeyStats.nlink !== 1 ||
    privateKeyStats.size < 40 ||
    privateKeyStats.size > 256
  ) {
    fail("pty_private_key_file_invalid");
  }
  privateKeyBase64 = fs.readFileSync(privateKeyFd, "utf8");
  fs.unlinkSync(privateKeyPath);
} catch {
  fail("pty_private_key_file_invalid");
} finally {
  if (privateKeyFd !== undefined) {
    try {
      fs.closeSync(privateKeyFd);
    } catch {}
  }
}
if (!/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(privateKeyBase64 || "")) {
  fail("pty_private_key_invalid");
}

let ttyPath;
let ttyStats;
try {
  ttyPath = fs.realpathSync("/proc/self/fd/0");
  ttyStats = fs.fstatSync(0, { bigint: true });
} catch {
  fail("pty_stdin_unavailable");
}
if (!/^\/dev\/pts\/\d+$/.test(ttyPath)) fail("pty_stdin_not_pty");
if (!ttyStats.isCharacterDevice()) fail("pty_stdin_not_character_device");

const monitor = childProcess.spawn(
  process.execPath,
  [
    "-e",
    monitorScript,
    "nemoclaw-pty-input-mode-monitor",
    process.pid.toString(),
    runId,
    publicKeyBase64,
    runRoot,
    ttyPath,
    ttyStats.dev.toString(),
    ttyStats.ino.toString(),
    ttyStats.rdev.toString(),
    termiosCommand,
  ],
  {
    detached: false,
    env: { LC_ALL: "C" },
    stdio: [0, "pipe", "ignore", "pipe"],
  },
);
if (!Number.isSafeInteger(monitor.pid) || monitor.pid < 2) fail("pty_monitor_spawn_failed");
monitor.stdio[3].end(privateKeyBase64);
let ready = "";
let started = false;
const startupTimer = setTimeout(() => fail("pty_monitor_start_timeout"), 3_000);
monitor.stdout.setEncoding("utf8");
monitor.stdout.on("data", (chunk) => {
  if (started) return;
  ready += chunk;
  if (Buffer.byteLength(ready) > 64 || !"READY\n".startsWith(ready)) {
    fail("pty_monitor_start_invalid");
  }
  if (ready !== "READY\n") return;
  started = true;
  clearTimeout(startupTimer);
  monitor.stdout.destroy();
  monitor.unref();
  process.execve("/usr/bin/env", ["/usr/bin/env", ...originalArgv], process.env);
  fail("pty_execve_failed");
});
monitor.on("error", () => fail("pty_monitor_spawn_failed"));
monitor.on("exit", () => {
  if (!started) fail("pty_monitor_start_failed");
});
`;

// The host shim replaces argv only for the matching OpenClaw launch. It removes
// its private launch variables before every call to the pinned OpenShell binary.
export const OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT = String.raw`#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
// Direct CLI exec paths can inherit launch authority that filtered helpers omit.
const authorityNames = Object.keys(process.env).filter(
  (name) =>
    name === "NEMOCLAW_OPENSHELL_BIN" ||
    name === "NEMOCLAW_OPENSHELL_COMMAND" ||
    name.startsWith("NEMOCLAW_LAUNCH_") ||
    name.startsWith("OPENSHELL_NEMOCLAW_LAUNCH_"),
);
const realOpenShell = process.env.OPENSHELL_NEMOCLAW_LAUNCH_REAL_COMMAND;
const sandboxName = process.env.OPENSHELL_NEMOCLAW_LAUNCH_SANDBOX;
const runId = process.env.OPENSHELL_NEMOCLAW_LAUNCH_RUN_ID;
const interceptPath = process.env.OPENSHELL_NEMOCLAW_LAUNCH_INTERCEPT_PATH;
const monitorStarterScript = process.env.OPENSHELL_NEMOCLAW_LAUNCH_PTY_MONITOR_STARTER_SCRIPT;
const runtimeEnvScript = process.env.OPENSHELL_NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT;
const keyPath = process.env.OPENSHELL_NEMOCLAW_LAUNCH_PTY_MONITOR_KEY_PATH;
const keyWriterScript = ${JSON.stringify(OPENCLAW_PTY_MONITOR_KEY_WRITER_SCRIPT)};

function fail(reason) {
  process.stderr.write(JSON.stringify({ reason }) + "\n");
  process.exit(73);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invokeRealOpenShell(nextArgv, input) {
  const env = { ...process.env };
  for (const name of authorityNames) delete env[name];
  const result = childProcess.spawnSync(realOpenShell, nextArgv, {
    env,
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    timeout: 240_000,
    killSignal: "SIGKILL",
  });
  if (result.error) fail("openshell_shim_invocation_failed");
  if (result.status === null) fail("openshell_shim_signaled");
  return result.status;
}

function runRealOpenShell(nextArgv) {
  process.exit(invokeRealOpenShell(nextArgv));
}

if (!path.isAbsolute(realOpenShell || "")) fail("openshell_shim_authority_invalid");
if (!/^[0-9a-f]{32}$/.test(runId || "")) fail("openshell_shim_run_id_invalid");
if (!path.isAbsolute(interceptPath || "")) fail("openshell_shim_intercept_path_invalid");
if (!monitorStarterScript || !runtimeEnvScript) fail("openshell_shim_script_missing");
if (!path.isAbsolute(keyPath || "")) fail("openshell_shim_key_path_invalid");
let keyRecord;
try {
  const stats = fs.lstatSync(keyPath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.getuid() ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.nlink !== 1 ||
    stats.size < 2 ||
    stats.size > 1024
  ) {
    fail("openshell_shim_key_file_invalid");
  }
  keyRecord = JSON.parse(fs.readFileSync(keyPath, "utf8"));
} catch {
  fail("openshell_shim_key_file_invalid");
}
if (
  !keyRecord ||
  JSON.stringify(Object.keys(keyRecord).sort()) !== JSON.stringify(["privateKey", "publicKey"])
) {
  fail("openshell_shim_key_file_invalid");
}
const publicKeyBase64 = keyRecord.publicKey;
const privateKeyBase64 = keyRecord.privateKey;
if (!/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(publicKeyBase64 || "")) {
  fail("openshell_shim_public_key_invalid");
}
if (!/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(privateKeyBase64 || "")) {
  fail("openshell_shim_private_key_invalid");
}

const sameSandbox =
  argv[0] === "sandbox" &&
  argv[1] === "exec" &&
  argv[2] === "--name" &&
  argv[3] === sandboxName;
const separator = argv.indexOf("--");
const remoteArgv = separator === -1 ? [] : argv.slice(separator + 1);
const expectedTail = ["bash", "-lc", "openclaw tui"];
const hasExpectedTail = arraysEqual(remoteArgv.slice(-expectedTail.length), expectedTail);
const launchLike = sameSandbox && hasExpectedTail;

if (!launchLike) runRealOpenShell(argv);

let optionIndex = 4;
if (argv[optionIndex] === "-g") {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(argv[optionIndex + 1] || "")) {
    fail("openshell_launch_invocation_invalid");
  }
  optionIndex += 2;
}
const expectedOptions = ["--tty", "--timeout", "0", "--"];
const expectedRemote = [
  "/bin/bash",
  "--noprofile",
  "--norc",
  "-p",
  "-c",
  runtimeEnvScript,
  "nemoclaw-runtime-env",
  ...expectedTail,
];
if (
  !arraysEqual(argv.slice(optionIndex, optionIndex + expectedOptions.length), expectedOptions) ||
  optionIndex + expectedOptions.length !== separator + 1 ||
  !arraysEqual(remoteArgv, expectedRemote)
) {
  fail("openshell_launch_invocation_invalid");
}

try {
  fs.writeFileSync(interceptPath, JSON.stringify({ schemaVersion: 1, runId }) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  if (error && error.code === "EEXIST") fail("openshell_launch_intercept_duplicate");
  fail("openshell_launch_intercept_failed");
}

const monitorRoot = "/tmp/nemoclaw-launch-turn-" + runId;
const privateKeyPath = monitorRoot + "/pty-monitor-private-key";
const keyWriterArgv = [
  ...argv.slice(0, optionIndex),
  "--",
  "node",
  "-e",
  keyWriterScript,
  runId,
  monitorRoot,
  publicKeyBase64,
];
if (invokeRealOpenShell(keyWriterArgv, privateKeyBase64) !== 0) {
  fail("openshell_shim_private_key_write_failed");
}
const replacement = [
  ...argv.slice(0, separator + 1),
  "node",
  "-e",
  monitorStarterScript,
  runId,
  monitorRoot,
  publicKeyBase64,
  privateKeyPath,
  ...remoteArgv,
];
runRealOpenShell(replacement);
`;

// OpenClaw owns the JSONL session store and does not expose a structured
// result from `nemoclaw launch`. This verifier records an in-sandbox baseline,
// then qualifies only complete user and assistant records appended after that
// baseline. Session content never moves to the host.
export const OPENCLAW_SESSION_EVIDENCE_SCRIPT = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const [mode, sessionRoot, baselinePath, expectedTurnsText, ptyMonitorRoot, runId, publicKeyBase64] =
  process.argv.slice(1);
const baselineTemporaryPath = baselinePath + ".tmp";
const ptyMonitorSocketPath = path.join(ptyMonitorRoot, "pty-input-mode.sock");
const MAX_BASELINE_BYTES = 1024 * 1024;
const MAX_PTY_RESPONSE_BYTES = 1024;
const PTY_RESPONSE_TIMEOUT_MS = 3_000;

function finish(exitCode, reason, detail = {}) {
  if (reason) process.stderr.write(JSON.stringify({ reason, ...detail }) + "\n");
  process.exit(exitCode);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function exactMode(stats, mode) {
  return (stats.mode & 0o777) === mode;
}

function validPtyResponse(response, requestId) {
  if (
    !exactKeys(response, [
      "schemaVersion",
      "runId",
      "requestId",
      "ttyPath",
      "dev",
      "ino",
      "rdev",
      "state",
      "status",
      "signal",
      "errorCode",
      "stderr",
      "signature",
    ]) ||
    response.schemaVersion !== 1 ||
    response.runId !== runId ||
    response.requestId !== requestId ||
    !/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(response.signature || "") ||
    !["canonical", "noncanonical", "unavailable"].includes(response.state) ||
    !/^\/dev\/pts\/\d+$/.test(response.ttyPath || "") ||
    ![response.dev, response.ino, response.rdev].every(
      (value) => typeof value === "string" && /^(0|[1-9]\d{0,24})$/.test(value),
    )
  ) {
    return false;
  }
  if (
    response.status !== null &&
    (!Number.isInteger(response.status) || response.status < 0 || response.status > 255)
  ) {
    return false;
  }
  if (response.signal !== null && !/^SIG[A-Z0-9]{1,24}$/.test(response.signal)) return false;
  if (response.errorCode !== null && !/^[A-Z0-9_]{1,64}$/.test(response.errorCode)) return false;
  if (
    typeof response.stderr !== "string" ||
    Buffer.byteLength(response.stderr) > 256 ||
    !/^[\x20-\x7e]*$/.test(response.stderr)
  ) {
    return false;
  }
  const diagnosticIsEmpty =
    response.status === null &&
    response.signal === null &&
    response.errorCode === null &&
    response.stderr === "";
  if (response.state === "unavailable" ? diagnosticIsEmpty : !diagnosticIsEmpty) return false;
  const unsigned = {
    schemaVersion: response.schemaVersion,
    runId: response.runId,
    requestId: response.requestId,
    ttyPath: response.ttyPath,
    dev: response.dev,
    ino: response.ino,
    rdev: response.rdev,
    state: response.state,
    status: response.status,
    signal: response.signal,
    errorCode: response.errorCode,
    stderr: response.stderr,
  };
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(JSON.stringify(unsigned)),
      publicKey,
      Buffer.from(response.signature, "base64"),
    );
  } catch {
    return false;
  }
}

function validateRunContext() {
  if (!/^[0-9a-f]{32}$/.test(runId || "")) finish(2, "run_id_invalid");
  if (!/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(publicKeyBase64 || "")) {
    finish(2, "pty_public_key_invalid");
  }
  if (baselinePath !== "/tmp/nemoclaw-launch-session-" + runId + ".json") {
    finish(2, "baseline_path_invalid");
  }
  if (ptyMonitorRoot !== "/tmp/nemoclaw-launch-turn-" + runId) {
    finish(2, "pty_monitor_root_invalid");
  }
}

function readPrivateJson(filePath, maximumBytes, unavailableReason, invalidReason, missingReason) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (missingReason && error && error.code === "ENOENT") finish(1, missingReason);
    finish(2, unavailableReason);
  }
  let raw;
  try {
    const stats = fs.fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.uid !== process.getuid() ||
      !exactMode(stats, 0o600) ||
      stats.nlink !== 1 ||
      stats.size < 2 ||
      stats.size > maximumBytes
    ) {
      finish(2, invalidReason);
    }
    raw = fs.readFileSync(fd, "utf8");
  } catch {
    finish(2, unavailableReason);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
  try {
    return JSON.parse(raw);
  } catch {
    finish(2, invalidReason);
  }
}

function writePrivateJsonAtomic(filePath, temporaryPath, value, maximumBytes, reason) {
  const body = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(body) > maximumBytes) finish(2, reason);
  let fd;
  let created = false;
  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, filePath);
    const directoryFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (created) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
    }
    finish(2, reason);
  }
}

function completeOffset(raw) {
  return raw.endsWith("\n") ? raw.length : raw.lastIndexOf("\n") + 1;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sessionFileNames() {
  try {
    return fs
      .readdirSync(sessionRoot)
      .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl"))
      .sort();
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    finish(2, "session_store_unreadable");
  }
}

function validatePtyIdentity(response) {
  let ttyStats;
  try {
    ttyStats = fs.lstatSync(response.ttyPath, { bigint: true });
  } catch {
    finish(2, "pty_identity_changed");
  }
  if (!ttyStats.isCharacterDevice()) finish(2, "pty_not_character_device");
  if (
    ttyStats.dev.toString() !== response.dev ||
    ttyStats.ino.toString() !== response.ino ||
    ttyStats.rdev.toString() !== response.rdev
  ) {
    finish(2, "pty_identity_changed");
  }
}

function readPtyMonitorRoot(startup) {
  let stats;
  try {
    stats = fs.lstatSync(ptyMonitorRoot, { bigint: true });
  } catch (error) {
    if (startup && error && error.code === "ENOENT") finish(1, "pty_socket_missing");
    finish(2, "pty_monitor_root_unavailable");
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== BigInt(process.getuid()) ||
    (stats.mode & 0o777n) !== 0o700n
  ) {
    finish(2, "pty_monitor_root_invalid");
  }
  return stats;
}

function readPtyMonitorSocket(startup) {
  let stats;
  try {
    stats = fs.lstatSync(ptyMonitorSocketPath, { bigint: true });
  } catch (error) {
    if (startup && error && error.code === "ENOENT") finish(1, "pty_socket_missing");
    finish(2, "pty_socket_unavailable");
  }
  if (
    !stats.isSocket() ||
    stats.uid !== BigInt(process.getuid()) ||
    (stats.mode & 0o777n) !== 0o600n ||
    stats.nlink !== 1n
  ) {
    finish(2, "pty_socket_invalid");
  }
  return stats;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function qualifyPtyResponse(raw, rootBefore, socketBefore, requestId) {
  if (
    Buffer.byteLength(raw) < 2 ||
    Buffer.byteLength(raw) > MAX_PTY_RESPONSE_BYTES ||
    !raw.endsWith("\n") ||
    raw.slice(0, -1).includes("\n")
  ) {
    finish(2, "pty_termios_response_invalid");
  }
  let response;
  try {
    response = JSON.parse(raw);
  } catch {
    finish(2, "pty_termios_response_invalid");
  }
  if (!validPtyResponse(response, requestId)) finish(2, "pty_termios_response_invalid");
  const rootAfter = readPtyMonitorRoot(false);
  const socketAfter = readPtyMonitorSocket(false);
  if (!sameIdentity(rootBefore, rootAfter) || !sameIdentity(socketBefore, socketAfter)) {
    finish(2, "pty_socket_identity_changed");
  }
  validatePtyIdentity(response);
  if (response.state === "canonical") finish(1, "pty_input_canonical");
  if (response.state === "noncanonical") finish(0);
  if (response.state === "unavailable") {
    finish(2, "pty_termios_unavailable", {
      sttyStatus: response.status,
      sttySignal: response.signal,
      sttyErrorCode: response.errorCode,
      sttyStderr: response.stderr,
    });
  }
  finish(2, "pty_termios_response_invalid");
}

function qualifyTuiInputMode() {
  const rootBefore = readPtyMonitorRoot(true);
  const socketBefore = readPtyMonitorSocket(true);
  const requestId = crypto.randomBytes(16).toString("hex");
  let raw = "";
  const client = net.createConnection({ path: ptyMonitorSocketPath });
  const responseDeadline = setTimeout(
    () => finish(1, "pty_termios_response_timeout"),
    PTY_RESPONSE_TIMEOUT_MS,
  );
  client.setEncoding("utf8");
  client.on("connect", () => {
    client.write(JSON.stringify({ schemaVersion: 1, runId, requestId }) + "\n");
  });
  client.on("data", (chunk) => {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_PTY_RESPONSE_BYTES) {
      finish(2, "pty_termios_response_invalid");
    }
  });
  client.on("end", () => {
    clearTimeout(responseDeadline);
    qualifyPtyResponse(raw, rootBefore, socketBefore, requestId);
  });
  client.on("error", () => finish(1, "pty_socket_unavailable"));
}

function readCompleteSession(fileName) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(sessionRoot, fileName), "utf8");
  } catch {
    finish(2, "session_unreadable", { sessionId: fileName.slice(0, -6) });
  }
  const offset = completeOffset(raw);
  return { offset, complete: raw.slice(0, offset), raw };
}

function recordBaseline() {
  const sessions = {};
  for (const fileName of sessionFileNames()) {
    const { offset, complete } = readCompleteSession(fileName);
    sessions[fileName] = { offset, digest: digest(complete) };
  }
  writePrivateJsonAtomic(
    baselinePath,
    baselineTemporaryPath,
    { schemaVersion: 1, sessions },
    MAX_BASELINE_BYTES,
    "baseline_write_failed",
  );
  finish(0);
}

function readBaseline() {
  const value = readPrivateJson(
    baselinePath,
    MAX_BASELINE_BYTES,
    "baseline_unreadable",
    "baseline_invalid",
  );
  if (
    !exactKeys(value, ["schemaVersion", "sessions"]) ||
    value.schemaVersion !== 1 ||
    !value.sessions ||
    typeof value.sessions !== "object" ||
    Array.isArray(value.sessions)
  ) {
    finish(2, "baseline_invalid");
  }
  for (const [fileName, entry] of Object.entries(value.sessions)) {
    if (
      !/^[^/]+\.jsonl$/.test(fileName) ||
      !exactKeys(entry, ["offset", "digest"]) ||
      !Number.isSafeInteger(entry.offset) ||
      entry.offset < 0 ||
      typeof entry.digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.digest)
    ) {
      finish(2, "baseline_invalid");
    }
  }
  return value.sessions;
}

function validateCleanupFile(filePath, maximumBytes, reason) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    finish(2, reason);
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.getuid() ||
    !exactMode(stats, 0o600) ||
    stats.nlink !== 1 ||
    stats.size > maximumBytes
  ) {
    finish(2, reason);
  }
  return true;
}

function fsyncParent(filePath) {
  const fd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeBaseline() {
  const baselineExists = validateCleanupFile(
    baselinePath,
    MAX_BASELINE_BYTES,
    "baseline_cleanup_failed",
  );
  if (baselineExists) {
    readBaseline();
    try {
      fs.unlinkSync(baselinePath);
      fsyncParent(baselinePath);
    } catch {
      finish(2, "baseline_cleanup_failed");
    }
  }
  const temporaryExists = validateCleanupFile(
    baselineTemporaryPath,
    MAX_BASELINE_BYTES,
    "baseline_cleanup_failed",
  );
  if (temporaryExists) {
    try {
      fs.unlinkSync(baselineTemporaryPath);
      fsyncParent(baselineTemporaryPath);
    } catch {
      finish(2, "baseline_cleanup_failed");
    }
  }
  finish(0);
}

function removePtyMonitorRoot() {
  let before;
  try {
    before = fs.lstatSync(ptyMonitorRoot, { bigint: true });
  } catch (error) {
    if (error && error.code === "ENOENT") finish(0);
    finish(2, "pty_monitor_cleanup_failed");
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== BigInt(process.getuid()) ||
    (before.mode & 0o777n) !== 0o700n
  ) {
    finish(2, "pty_monitor_cleanup_failed");
  }
  let names;
  try {
    names = fs.readdirSync(ptyMonitorRoot).sort();
  } catch {
    finish(2, "pty_monitor_cleanup_failed");
  }
  const privateKeyName = "pty-monitor-private-key";
  const allowedNames = ["pty-input-mode.sock", privateKeyName];
  if (names.some((name) => !allowedNames.includes(name))) {
    finish(2, "pty_monitor_cleanup_unknown_entry");
  }
  if (names.includes(privateKeyName)) {
    const privateKeyPath = path.join(ptyMonitorRoot, privateKeyName);
    try {
      const stats = fs.lstatSync(privateKeyPath, { bigint: true });
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.uid !== BigInt(process.getuid()) ||
        (stats.mode & 0o777n) !== 0o600n ||
        stats.nlink !== 1n ||
        stats.size < 40n ||
        stats.size > 256n
      ) {
        finish(2, "pty_monitor_cleanup_failed");
      }
      fs.unlinkSync(privateKeyPath);
      fsyncParent(privateKeyPath);
      names = names.filter((name) => name !== privateKeyName);
    } catch {
      finish(2, "pty_monitor_cleanup_failed");
    }
  }
  if (names.length !== 0) finish(2, "pty_monitor_cleanup_failed");
  let after;
  try {
    after = fs.lstatSync(ptyMonitorRoot, { bigint: true });
  } catch {
    finish(2, "pty_monitor_cleanup_failed");
  }
  if (after.dev !== before.dev || after.ino !== before.ino) {
    finish(2, "pty_monitor_cleanup_failed");
  }
  try {
    fs.rmdirSync(ptyMonitorRoot);
    fsyncParent(ptyMonitorRoot);
  } catch {
    finish(2, "pty_monitor_cleanup_failed");
  }
  finish(0);
}

function hasStructuredContent(message) {
  if (typeof message.content === "string") return message.content.length > 0;
  return Array.isArray(message.content) && message.content.length > 0;
}

function appendedMessages(fileName, baseline) {
  const { offset, complete, raw } = readCompleteSession(fileName);
  const prior = baseline[fileName];
  const priorOffset = prior ? prior.offset : 0;
  if (raw.length !== offset) {
    finish(2, "session_record_incomplete", { sessionId: fileName.slice(0, -6) });
  }
  if (offset < priorOffset) finish(2, "session_truncated", { sessionId: fileName.slice(0, -6) });
  if (prior && digest(raw.slice(0, priorOffset)) !== prior.digest) {
    finish(2, "session_rewritten", { sessionId: fileName.slice(0, -6) });
  }

  const messages = [];
  for (const line of complete.slice(priorOffset).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      finish(2, "malformed_session", { sessionId: fileName.slice(0, -6) });
    }
    if (!record || record.type !== "message" || !record.message) continue;
    const role = record.message.role;
    if (role !== "user" && role !== "assistant") continue;
    messages.push({ role, hasStructuredContent: hasStructuredContent(record.message) });
  }
  return messages;
}

function qualifyTurns() {
  const expectedTurns = Number(expectedTurnsText);
  if (!Number.isSafeInteger(expectedTurns) || expectedTurns < 1) {
    finish(2, "expected_turn_count_invalid");
  }

  const baseline = readBaseline();
  const currentFiles = sessionFileNames();
  for (const fileName of Object.keys(baseline)) {
    if (!currentFiles.includes(fileName)) {
      finish(2, "session_removed", { sessionId: fileName.slice(0, -6) });
    }
  }

  const changedSessions = currentFiles
    .map((fileName) => ({
      sessionId: fileName.slice(0, -6),
      messages: appendedMessages(fileName, baseline),
    }))
    .filter((session) => session.messages.length > 0);
  if (changedSessions.length === 0) finish(1);
  if (changedSessions.length > 1) finish(2, "multiple_sessions_changed");

  const { messages, sessionId } = changedSessions[0];
  const expectedRoles = Array.from({ length: expectedTurns }, () => ["user", "assistant"]).flat();
  for (const [index, message] of messages.entries()) {
    if (index >= expectedRoles.length) finish(2, "extra_message", { sessionId });
    if (message.role !== expectedRoles[index]) {
      finish(2, "message_order_invalid", { sessionId });
    }
    if (!message.hasStructuredContent) finish(2, "message_content_empty", { sessionId });
  }
  if (messages.length < expectedRoles.length) finish(1);
  finish(0);
}

try {
  validateRunContext();
  if (mode === "baseline") recordBaseline();
  else if (mode === "input-mode") qualifyTuiInputMode();
  else if (mode === "qualify") qualifyTurns();
  else if (mode === "cleanup-baseline") removeBaseline();
  else if (mode === "cleanup-pty") removePtyMonitorRoot();
  else finish(2, "mode_invalid");
} catch {
  finish(2, "verifier_failed");
}
`;

export const LAUNCH_TURN_SCRIPT = String.raw`set -euo pipefail
umask 077
command -v script >/dev/null 2>&1
command -v timeout >/dev/null 2>&1

read -r pty_monitor_public_key pty_monitor_private_key < <(
  node -e '
    const crypto = require("node:crypto");
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    process.stdout.write(
      publicKey.export({ format: "der", type: "spki" }).toString("base64") + " " +
      privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") + "\n",
    );
  '
)
[[ "$pty_monitor_public_key" =~ ^[A-Za-z0-9+/]{40,256}={0,2}$ ]]
[[ "$pty_monitor_private_key" =~ ^[A-Za-z0-9+/]{40,256}={0,2}$ ]]

openshell_command="$NEMOCLAW_OPENSHELL_COMMAND"
openshell_environment=(env)
while IFS= read -r authority_name; do
  openshell_environment+=(-u "$authority_name")
done < <(
  printf '%s\n' NEMOCLAW_OPENSHELL_BIN NEMOCLAW_OPENSHELL_COMMAND
  compgen -e NEMOCLAW_LAUNCH_ || true
  compgen -e OPENSHELL_NEMOCLAW_LAUNCH_ || true
)

session_dir="$(mktemp -d "$NEMOCLAW_LAUNCH_HOST_TMP_ROOT/nemoclaw-launch-host.XXXXXX")"
pty_monitor_key_path="$session_dir/pty-monitor-key.json"
printf '{"publicKey":"%s","privateKey":"%s"}\n' \
  "$pty_monitor_public_key" "$pty_monitor_private_key" >"$pty_monitor_key_path"
chmod 600 "$pty_monitor_key_path"
unset pty_monitor_private_key
capture="$session_dir/terminal.log"
driver_error="$session_dir/pty-driver.err"
evidence_error="$session_dir/session-evidence.err"
input="$session_dir/input"
openshell_shim="$session_dir/openshell-launch-shim"
intercept_path="$session_dir/launch-intercept.json"
baseline_path="/tmp/nemoclaw-launch-session-$NEMOCLAW_LAUNCH_RUN_ID.json"
pty_monitor_root="/tmp/nemoclaw-launch-turn-$NEMOCLAW_LAUNCH_RUN_ID"
session_pid=""
session_deadline=""

remove_session_baseline() {
  session_evidence cleanup-baseline
}

remove_pty_monitor() {
  session_evidence cleanup-pty
}

wait_for_pty_monitor_exit() {
  for _ in {1..20}; do
    if [[ ! -S "$pty_monitor_root/pty-input-mode.sock" ]]; then
      return 0
    fi
    sleep 0.05
  done
  return 0
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT
  exec 3>&- 2>/dev/null || true
  if [[ -n "$session_pid" ]] && kill -0 "$session_pid" 2>/dev/null; then
    kill -TERM "$session_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$session_pid" 2>/dev/null || true
  fi
  if [[ -n "$session_pid" ]]; then
    wait "$session_pid" 2>/dev/null || true
  fi
  wait_for_pty_monitor_exit
  if ! remove_pty_monitor >/dev/null 2>&1; then
    echo "launch PTY monitor cleanup failed" >&2
    cleanup_status=1
  fi
  if ! remove_session_baseline >/dev/null 2>&1; then
    echo "structured session baseline cleanup failed" >&2
    cleanup_status=1
  fi
  if ! rm -rf -- "$session_dir"; then
    echo "launch host session cleanup failed" >&2
    cleanup_status=1
  fi
  if [[ "$original_status" != 0 ]]; then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT

terminal_diagnostic() {
  if [[ -f "$capture" ]]; then
    echo "bounded terminal diagnostic (last 4096 bytes):" >&2
    tail -c 4096 "$capture" >&2 || true
  fi
  if [[ -s "$driver_error" ]]; then
    echo "bounded PTY driver diagnostic (last 2048 bytes):" >&2
    tail -c 2048 "$driver_error" >&2 || true
  fi
}

fail_launch_session() {
  echo "$1" >&2
  if [[ -s "$evidence_error" ]]; then
    tail -c 2048 "$evidence_error" >&2 || true
  fi
  terminal_diagnostic
  exit 1
}

session_evidence() {
  local mode="$1"
  local expected_turns=""
  local command_timeout=10
  if [[ "$#" -gt 1 ]]; then
    expected_turns="$2"
  fi
  if [[ -n "$session_deadline" && "$mode" != cleanup-* ]]; then
    local remaining=$((session_deadline - SECONDS))
    if (( remaining <= 0 )); then
      return 1
    fi
    if (( remaining < command_timeout )); then
      command_timeout="$remaining"
    fi
  fi
  timeout --kill-after=1s "$command_timeout"s \
    "${"$"}{openshell_environment[@]}" "$openshell_command" sandbox exec \
    --name "$NEMOCLAW_LAUNCH_SANDBOX" -- \
    node -e "$NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT" \
    "$mode" \
    "$NEMOCLAW_LAUNCH_SESSION_ROOT" \
    "$baseline_path" \
    "$expected_turns" \
    "$pty_monitor_root" \
    "$NEMOCLAW_LAUNCH_RUN_ID" \
    "$pty_monitor_public_key"
}

wait_for_turn_count() {
  local expected_turns="$1"
  local evidence_status
  while (( SECONDS < session_deadline )); do
    if session_evidence qualify "$expected_turns" >/dev/null 2>"$evidence_error"; then
      return 0
    else
      evidence_status=$?
    fi
    if [[ "$evidence_status" != 1 ]]; then
      fail_launch_session "structured session evidence was invalid or unavailable (status $evidence_status)"
    fi
    if ! kill -0 "$session_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  fail_launch_session "launch did not record the required structured session turns"
}

wait_for_pty_input_mode() {
  local evidence_status
  while (( SECONDS < session_deadline )); do
    if session_evidence input-mode >/dev/null 2>"$evidence_error"; then
      return 0
    else
      evidence_status=$?
    fi
    if [[ "$evidence_status" != 1 ]]; then
      fail_launch_session "OpenClaw TUI input-mode evidence was invalid or unavailable (status $evidence_status)"
    fi
    if ! kill -0 "$session_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  fail_launch_session "launch did not observe noncanonical PTY input mode before the session deadline or before the PTY child process exited"
}

if ! session_evidence baseline >/dev/null 2>"$evidence_error"; then
  fail_launch_session "launch could not record the structured session baseline"
fi

printf '%s' "$NEMOCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT" >"$openshell_shim"
chmod 700 "$openshell_shim"

mkfifo -m 600 "$input"
if [[ -n "$NEMOCLAW_LAUNCH_ENTRYPOINT" ]]; then
  printf -v launch_command '%q %q %q %q' \
    "$NEMOCLAW_LAUNCH_COMMAND" "$NEMOCLAW_LAUNCH_ENTRYPOINT" \
    launch "$NEMOCLAW_LAUNCH_SANDBOX"
else
  printf -v launch_command '%q %q %q' \
    "$NEMOCLAW_LAUNCH_COMMAND" launch "$NEMOCLAW_LAUNCH_SANDBOX"
fi

NEMOCLAW_OPENSHELL_BIN="$openshell_shim" \
OPENSHELL_NEMOCLAW_LAUNCH_REAL_COMMAND="$NEMOCLAW_OPENSHELL_COMMAND" \
OPENSHELL_NEMOCLAW_LAUNCH_SANDBOX="$NEMOCLAW_LAUNCH_SANDBOX" \
OPENSHELL_NEMOCLAW_LAUNCH_RUN_ID="$NEMOCLAW_LAUNCH_RUN_ID" \
OPENSHELL_NEMOCLAW_LAUNCH_INTERCEPT_PATH="$intercept_path" \
OPENSHELL_NEMOCLAW_LAUNCH_PTY_MONITOR_STARTER_SCRIPT="$NEMOCLAW_LAUNCH_PTY_MONITOR_STARTER_SCRIPT" \
OPENSHELL_NEMOCLAW_LAUNCH_PTY_MONITOR_KEY_PATH="$pty_monitor_key_path" \
OPENSHELL_NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT="$NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT" \
timeout --kill-after=5s 250s \
  script --quiet --return --flush --command "$launch_command" "$capture" \
  <"$input" >/dev/null 2>"$driver_error" &
session_pid=$!
exec 3>"$input"
session_budget_seconds="$NEMOCLAW_LAUNCH_SESSION_BUDGET_SECONDS"
session_deadline=$((SECONDS + session_budget_seconds))

capture_ready=0
while (( SECONDS < session_deadline )); do
  if [[ -f "$capture" ]]; then
    capture_ready=1
    break
  fi
  if ! kill -0 "$session_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [[ "$capture_ready" != 1 ]]; then
  fail_launch_session "launch did not create a PTY diagnostic capture"
fi

wait_for_pty_input_mode
if ! printf '%s\r' "$NEMOCLAW_LAUNCH_FIRST_INPUT" >&3; then
  fail_launch_session "launch exited before the first PTY input was submitted"
fi
wait_for_turn_count 1
if ! printf '%s\r' "$NEMOCLAW_LAUNCH_SECOND_INPUT" >&3; then
  fail_launch_session "launch exited before the second PTY input was submitted"
fi
wait_for_turn_count 2

if [[ -n "$NEMOCLAW_LAUNCH_EXIT_COMMAND" ]]; then
  printf '%s\r' "$NEMOCLAW_LAUNCH_EXIT_COMMAND" >&3
else
  # Some TUIs have no exit command. They may close the FIFO after the first
  # interrupt, so ignore SIGPIPE while sending the second one.
  trap '' PIPE
  printf '\003' >&3 2>/dev/null || true
  sleep 1
  printf '\003' >&3 2>/dev/null || true
  trap - PIPE
fi
exec 3>&-

if wait "$session_pid"; then
  launch_status=0
else
  launch_status=$?
fi
session_pid=""

if [[ "$launch_status" != 0 ]]; then
  echo "launch exited with status $launch_status" >&2
  terminal_diagnostic
  exit "$launch_status"
fi
if session_evidence qualify 2 >/dev/null 2>"$evidence_error"; then
  :
else
  evidence_status=$?
  fail_launch_session "launch final structured session evidence did not qualify (status $evidence_status)"
fi
if ! remove_session_baseline >/dev/null 2>"$evidence_error"; then
  fail_launch_session "launch could not remove the structured session baseline"
fi
wait_for_pty_monitor_exit
if ! remove_pty_monitor >/dev/null 2>"$evidence_error"; then
  fail_launch_session "launch could not remove the PTY monitor"
fi
`;

export interface OpenClawLaunchSessionOptions {
  artifactName: string;
  cliCommand: string;
  cliEntrypoint?: string;
  env: NodeJS.ProcessEnv;
  exitCommand?: string;
  host: HostCliClient;
  redactionValues: string[];
  sandboxName: string;
  beforeLaunchTurns?: () => Promise<void> | void;
}

function uniqueTurnInputs(): { first: string; second: string } {
  const fragment = randomUUID().replaceAll("-", "");
  return {
    first: `Reply briefly without using tools. Request identifier: ${fragment.slice(0, 16)}.`,
    second: `Reply briefly again without using tools. Request identifier: ${fragment.slice(16)}.`,
  };
}

export async function runOpenClawLaunchSession(
  options: OpenClawLaunchSessionOptions,
): Promise<ShellProbeResult> {
  if (process.platform !== "linux") {
    throw new Error("launch session coverage requires the Linux util-linux PTY driver");
  }
  if (!options.host.openshellCommandPath.startsWith("/")) {
    throw new Error("launch session coverage requires an absolute OpenShell command path");
  }
  const inputs = uniqueTurnInputs();
  const result = await options.host.command("bash", ["-lc", LAUNCH_TURN_SCRIPT], {
    artifactName: options.artifactName,
    env: {
      ...options.env,
      NEMOCLAW_LAUNCH_COMMAND: options.cliCommand,
      NEMOCLAW_LAUNCH_ENTRYPOINT: options.cliEntrypoint ?? "",
      NEMOCLAW_LAUNCH_EXIT_COMMAND: options.exitCommand ?? "",
      NEMOCLAW_LAUNCH_FIRST_INPUT: inputs.first,
      NEMOCLAW_LAUNCH_HOST_TMP_ROOT: resolve(options.env.TMPDIR || "/tmp"),
      NEMOCLAW_LAUNCH_RUN_ID: randomUUID().replaceAll("-", ""),
      NEMOCLAW_LAUNCH_SANDBOX: options.sandboxName,
      NEMOCLAW_LAUNCH_SESSION_BUDGET_SECONDS: "230",
      NEMOCLAW_LAUNCH_SECOND_INPUT: inputs.second,
      NEMOCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT: OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT,
      NEMOCLAW_LAUNCH_PTY_MONITOR_STARTER_SCRIPT: OPENCLAW_PTY_MONITOR_STARTER_SCRIPT,
      NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT: OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT,
      NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT: OPENCLAW_SESSION_EVIDENCE_SCRIPT,
      NEMOCLAW_LAUNCH_SESSION_ROOT: "/sandbox/.openclaw/agents/main/sessions",
      NEMOCLAW_OPENSHELL_COMMAND: options.host.openshellCommandPath,
      TERM: "xterm-256color",
    },
    redactionValues: options.redactionValues,
    timeoutMs: 280_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`launch session failed: ${resultText(result)}`);
  }
  return result;
}

export async function runOpenClawLaunchReadinessLeaseTurns(
  options: OpenClawLaunchSessionOptions,
): Promise<void> {
  const probeArgs = options.cliEntrypoint
    ? [options.cliEntrypoint, options.sandboxName, "connect", "--probe-only"]
    : [options.sandboxName, "connect", "--probe-only"];
  const probe = await options.host.command(options.cliCommand, probeArgs, {
    artifactName: `${options.artifactName}-probe`,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 360_000,
  });
  if (probe.exitCode !== 0) {
    throw new Error(`launch readiness producer failed: ${resultText(probe)}`);
  }

  await options.beforeLaunchTurns?.();

  for (const ordinal of ["first", "second"] as const) {
    await runOpenClawLaunchSession({
      ...options,
      artifactName: `${options.artifactName}-${ordinal}`,
    });
  }
}
