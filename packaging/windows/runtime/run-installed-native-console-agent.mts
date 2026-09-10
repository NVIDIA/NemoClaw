// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hermesDashboardPythonSource } from "./native-hermes-dashboard.mts";
import { openNativeUiFileOwner } from "./native-ui-file-owner.mts";
import { startFileTcpRelay } from "./native-ui-relay.mts";
import { copyNativeRuntime, openNativeWebSession } from "./native-web-session.mts";
import { waitForNativeMxcCompletion } from "./native-ui-lifecycle.mts";
import {
  createNativeSessionDiagnostics,
  NativeSessionFailure,
} from "./native-session-diagnostics.mts";

import { readNativeServiceEnvironment } from "./native-options.mts";
import { startNativeInferenceBroker } from "./native-inference-broker.mts";
import { startNativeBrokerRelay } from "./native-broker-relay.mts";
import { acquireNativeStateSession } from "./native-state.mts";

import { resolveNativeConfiguredInference } from "./native-configured-inference.mts";
import type { NativeInferenceProgress } from "./native-inference-manifest.mts";

import { readOpenedRegularFile, writeNativeGatewayConfig } from "./native-security.mts";

import {
  allowlistedWindowsEnvironment,
  argumentValue,
  freePort,
  jsonContainsExactValue,
  quoteYamlPath,
  removeDirectory,
  requiredDirectory,
  requiredFile,
  run,
  stopChild,
  waitForPort,
} from "./run-installed-native-turn.mts";

const AGENT_ADAPTERS = {
  pi: { displayName: "Pi", runtimeDirectory: "pi", sandboxPrefix: "nc-pi" },
  hermes: { displayName: "Hermes Agent", runtimeDirectory: "hermes", sandboxPrefix: "nc-h" },
  "langchain-deepagents-code": {
    displayName: "Deep Agents Code",
    runtimeDirectory: "deepagents",
    sandboxPrefix: "nc-d",
  },
};
const execFileAsync = promisify(execFile);

function fail(message) {
  throw new Error(`NemoClaw native terminal launch failed: ${message}`);
}

async function waitForConsoleAgentExit(
  openshell,
  environment,
  sandboxName,
  gateway,
  readExitReceipt,
  agentId,
  stateSession,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + 24 * 60 * 60_000;
  let nextStatusCheck = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) return 0;
    stateSession.assertHeld();
    const text = await readExitReceipt();
    if (text?.endsWith("\n")) {
      const receipt = JSON.parse(text);
      if (
        receipt.schemaVersion !== 1 ||
        receipt.agent !== agentId ||
        !Number.isInteger(receipt.exitCode)
      )
        fail("the native agent exit receipt is invalid");
      const completion = await waitForNativeMxcCompletion(
        openshell,
        environment,
        sandboxName,
        gateway,
        stateSession,
      );
      if (completion === "ExecFailed" && receipt.exitCode === 0)
        fail("MXC failed after the agent reported its exit status");
      return receipt.exitCode;
    }
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      fail("the native gateway stopped before the agent published its exit status");
    if (Date.now() >= nextStatusCheck) {
      let status;
      try {
        const result = await execFileAsync(
          openshell,
          ["sandbox", "get", sandboxName, "-o", "json"],
          {
            env: environment,
            encoding: "utf8",
            windowsHide: true,
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
          },
        );
        status = JSON.parse(result.stdout);
      } catch {
        fail("the native agent's running state could not be confirmed");
      }
      if (status?.name !== sandboxName || typeof status?.phase !== "string")
        fail("the native agent status did not match its sandbox");
      if (["Error", "Stopped", "Stopping", "Deleting"].includes(status.phase))
        fail("the contained agent stopped before it published an exit receipt");
      nextStatusCheck = Date.now() + 5000;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("the interactive agent exceeded its session deadline");
}

function readConfiguration(agentId) {
  const localAppData = requiredDirectory(
    process.env.LOCALAPPDATA ?? "",
    "Windows local application-data directory",
  );
  const stateRoot = path.join(localAppData, "NVIDIA", "NemoClaw", "agents", agentId);
  const configPath = requiredFile(
    path.join(stateRoot, "native-windows.json"),
    `${AGENT_ADAPTERS[agentId].displayName} configuration`,
  );
  const configText = readOpenedRegularFile(configPath, { encoding: "utf8", maxBytes: 1024 * 1024 });
  if (configText === null) fail("the graphical onboarding configuration disappeared");
  const config = JSON.parse(configText);
  if (
    config?.schemaVersion !== 1 ||
    config?.classification !== "nemoclaw-native-windows-agent-configuration" ||
    config?.agent !== agentId ||
    !["nvidia", "openrouter", "compatible", "local"].includes(config?.inference) ||
    typeof config?.endpoint !== "string" ||
    typeof config?.model !== "string" ||
    typeof config?.credentialStored !== "boolean"
  )
    fail("the graphical onboarding configuration is incomplete");
  return { config, stateRoot };
}

export function interactiveWorkloadSource() {
  return String.raw`import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
function watchNativeStopRequest(file, sessionId, intervalMilliseconds = 100) {
  if (!/^[a-f0-9]{10}$/.test(sessionId)) throw new Error("The native session stop identity is invalid.");
  const expected = Buffer.from(sessionId + "\n", "utf8");
  const controller = new AbortController();
  let rejectRequested;
  const requested = new Promise((_resolve, reject) => { rejectRequested = reject; });
  requested.catch(() => {});
  let closed = false;
  let timer;
  let active = Promise.resolve();
  const abort = (message) => {
    if (closed || controller.signal.aborted) return;
    const error = Object.assign(new Error(message), { code: "ABORT_ERR" });
    controller.abort(error);
    rejectRequested(error);
  };
  const poll = async () => {
    let handle;
    try {
      handle = await openFile(file, "r");
      const stat = await handle.stat();
      if (stat.isFile() && stat.size === expected.length) {
        const bytes = Buffer.alloc(expected.length + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead === expected.length && bytes.subarray(0, bytesRead).equals(expected))
          abort("The host requested this native session to stop.");
      }
    } catch (error) {
      if (!["ENOENT", "EACCES", "EBUSY"].includes(error?.code))
        abort("The native session stop request could not be read.");
    } finally {
      if (handle) {
        try { await handle.close(); }
        catch { abort("The native session stop request handle could not be closed."); }
      }
    }
    if (!closed && !controller.signal.aborted) timer = setTimeout(start, intervalMilliseconds);
  };
  const start = () => { active = poll(); };
  start();
  return {
    signal: controller.signal,
    requested,
    async close() {
      // Also cancel an active UI tunnel when child or broker failure reaches
      // cleanup before the host has written its shutdown marker.
      abort("The native session is closing.");
      closed = true;
      clearTimeout(timer);
      await active;
    },
  };
}
const agent = required("NEMOCLAW_AGENT_ID");
const home = required("NEMOCLAW_AGENT_HOME");
const model = required("NEMOCLAW_AGENT_MODEL");
const brokerToken = required("NEMOCLAW_AGENT_BROKER_TOKEN");
const exitReceipt = required("NEMOCLAW_AGENT_EXIT_RECEIPT");
const hostBrokerPort = Number(required("NEMOCLAW_AGENT_PROXY_PORT"));
const bootstrapReceipt = required("NEMOCLAW_AGENT_BOOTSTRAP_RECEIPT");
const stopRequest = required("NEMOCLAW_AGENT_STOP_REQUEST");
const sessionId = required("NEMOCLAW_AGENT_SESSION_ID");
const node = required("NEMOCLAW_AGENT_NODE");
const runtime = required("NEMOCLAW_AGENT_RUNTIME");
const python = process.env.NEMOCLAW_AGENT_PYTHON;
const sitePackages = process.env.NEMOCLAW_AGENT_SITE_PACKAGES;
const dashboard = process.env.NEMOCLAW_AGENT_INTERFACE === "dashboard";
let brokerTunnel;
let bootstrapWritten = false;
const connectivity = {
  schemaVersion: 1, agent, interface: dashboard ? "dashboard" : "console",
  sessionId, transport: "guarded-file-tcp",
  brokerHost: "127.0.0.1", brokerPort: hostBrokerPort,
  containedHost: "127.0.0.1", containedPort: null,
  contained: { tcpConnected: false, unauthenticatedStatus: null, authenticatedStatus: null, bootstrapConsumedByWorkload: false },
  verdict: "fail", failureStage: "bridge", errorCode: null,
};
const stopWatcher = watchNativeStopRequest(stopRequest, sessionId);
try {
const { startNativeBrokerTunnel } = await import("./native-broker-tunnel.mts");
brokerTunnel = await startNativeBrokerTunnel({
  relayRoot: required("NEMOCLAW_BROKER_RELAY_ROOT"), relayToken: required("NEMOCLAW_BROKER_RELAY_TOKEN"),
  signal: stopWatcher.signal,
});
const proxyPort = String(brokerTunnel.port);
connectivity.containedPort = brokerTunnel.port;
const baseUrl = "http://127.0.0.1:" + proxyPort + "/v1";
connectivity.failureStage = "tcp";
await new Promise((resolve, reject) => {
  const socket = createConnection({ host: "127.0.0.1", port: brokerTunnel.port, signal: stopWatcher.signal });
  socket.setTimeout(5000);
  socket.once("connect", () => { socket.destroy(); resolve(); });
  socket.once("error", (error) => { socket.destroy(); reject(error); });
  socket.once("timeout", () => { socket.destroy(); reject(Object.assign(new Error("Local broker TCP probe timed out."), { code: "ETIMEDOUT" })); });
});
connectivity.contained.tcpConnected = true;
connectivity.failureStage = "unauthenticated-http";
const denied = await fetch("http://127.0.0.1:" + proxyPort + "/native/bootstrap", {
  method: "POST", signal: AbortSignal.any([AbortSignal.timeout(15000), stopWatcher.signal]),
});
connectivity.contained.unauthenticatedStatus = denied.status;
await denied.body?.cancel();
if (denied.status !== 403) throw new Error("The local broker did not reject an unauthenticated bootstrap probe.");
connectivity.failureStage = "authenticated-bootstrap";
const bootstrapResponse = await fetch("http://127.0.0.1:" + proxyPort + "/native/bootstrap", {
  method: "POST", headers: { authorization: "Bearer " + brokerToken }, signal: AbortSignal.any([AbortSignal.timeout(15000), stopWatcher.signal]),
});
connectivity.contained.authenticatedStatus = bootstrapResponse.status;
if (!bootstrapResponse.ok) throw new Error("NemoClaw could not supply the selected optional services.");
connectivity.failureStage = "bootstrap-json";
const nativeServices = await bootstrapResponse.json();
connectivity.contained.bootstrapConsumedByWorkload = true;
connectivity.verdict = "pass";
connectivity.failureStage = null;
writeFileSync(bootstrapReceipt, JSON.stringify(connectivity) + "\n", "utf8");
bootstrapWritten = true;
Object.assign(process.env, nativeServices.environment);
for (const [channel, settings] of Object.entries(nativeServices.options.messaging || {})) {
  process.env[channel.toUpperCase() + "_ALLOWED_USERS"] = settings.allowedUsers.join(",");
}

// Python 3.13 gives tempfile.mkdtemp() a protected owner-only Windows DACL.
// MXC child processes need the approved writable-root capability to inherit.
const deepAgentsTempfileShim = [
  "import tempfile",
  "def _nemoclaw_mkdtemp(suffix=None, prefix=None, dir=None):",
  "    suffix = '' if suffix is None else suffix",
  "    prefix = tempfile.template if prefix is None else prefix",
  "    parent = tempfile.gettempdir() if dir is None else dir",
  "    for _ in range(tempfile.TMP_MAX):",
  "        candidate = os.path.join(parent, prefix + os.urandom(16).hex() + suffix)",
  "        sys.audit('tempfile.mkdtemp', candidate)",
  "        try:",
  "            os.mkdir(candidate, 0o777)",
  "        except FileExistsError:",
  "            continue",
  "        return os.path.abspath(candidate)",
  "    raise FileExistsError('No usable temporary directory name found')",
  "tempfile.mkdtemp = _nemoclaw_mkdtemp",
];
mkdirSync(home, { recursive: true });
let executable;
let args;
let extraEnvironment = {};

if (agent === "pi") {
  const configDirectory = join(home, ".pi", "agent");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "models.json"), JSON.stringify({
    defaultModel: model,
    providers: { openshell: {
      api: "openai-completions",
      apiKey: brokerToken,
      baseUrl,
      models: [{ id: model, name: model, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
    } },
  }, null, 2) + "\n", "utf8");
  writeFileSync(join(configDirectory, "settings.json"), JSON.stringify({
    defaultProvider: "openshell",
    defaultModel: model,
    enableInstallTelemetry: false,
    enableAnalytics: false,
  }, null, 2) + "\n", "utf8");
  executable = node;
  args = [join(runtime, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), "--no-approve", "--provider", "openshell", "--model", model];
  extraEnvironment = { PI_CODING_AGENT_DIR: configDirectory };
} else if (agent === "hermes") {
  if (!python || !sitePackages) throw new Error("Hermes Python runtime is incomplete");
  const hermesHome = join(home, ".hermes");
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(join(hermesHome, "config.yaml"), [
    "model:",
    "  default: " + JSON.stringify(model),
    "  provider: custom",
    "  base_url: " + JSON.stringify(baseUrl),
    "  api_key: " + JSON.stringify(brokerToken),
    "  context_length: 131072",
    ...(nativeServices.options.search ? ["web:", "  backend: tavily", "  search_backend: tavily", "  extract_backend: tavily"] : []),
    "platforms:",
    ...Object.entries(nativeServices.options.messaging || {}).flatMap(([channel]) => ["  " + channel + ":", "    enabled: true"]),
    "memory:",
    "  memory_enabled: true",
    "  user_profile_enabled: true",
    "updates:",
    "  pre_update_backup: false",
    "  refresh_cua_driver: false",
    "",
  ].join("\n"), "utf8");
  const runner = join(home, "run-hermes.py");
  const consoleProbe = process.env.NEMOCLAW_AGENT_CONSOLE_PROBE;
  writeFileSync(runner, [
    "import os",
    "import sys",
    ...(consoleProbe ? [
      "import ctypes, json",
      "from ctypes import wintypes",
      "class _Coord(ctypes.Structure):",
      "    _fields_ = [('X', wintypes.SHORT), ('Y', wintypes.SHORT)]",
      "class _Rect(ctypes.Structure):",
      "    _fields_ = [('Left', wintypes.SHORT), ('Top', wintypes.SHORT), ('Right', wintypes.SHORT), ('Bottom', wintypes.SHORT)]",
      "class _BufferInfo(ctypes.Structure):",
      "    _fields_ = [('size', _Coord), ('cursor', _Coord), ('attributes', wintypes.WORD), ('window', _Rect), ('maximum', _Coord)]",
      "_kernel = ctypes.WinDLL('kernel32', use_last_error=True)",
      "_kernel.GetStdHandle.argtypes = [wintypes.DWORD]",
      "_kernel.GetStdHandle.restype = wintypes.HANDLE",
      "_kernel.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]",
      "_kernel.GetConsoleScreenBufferInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(_BufferInfo)]",
      "def _console_snapshot():",
      "    modes = {}",
      "    for name, kind in [('stdin', -10), ('stdout', -11), ('stderr', -12)]:",
      "        mode = wintypes.DWORD()",
      "        if not _kernel.GetConsoleMode(_kernel.GetStdHandle(kind & 0xffffffff), ctypes.byref(mode)):",
      "            raise RuntimeError('Contained Windows console handle is unavailable: ' + name)",
      "        modes[name] = mode.value",
      "    info = _BufferInfo()",
      "    if not _kernel.GetConsoleScreenBufferInfo(_kernel.GetStdHandle((-11) & 0xffffffff), ctypes.byref(info)):",
      "        raise RuntimeError('Contained Windows console screen buffer is unavailable')",
      "    return {'modes': modes, 'columns': info.window.Right - info.window.Left + 1, 'rows': info.window.Bottom - info.window.Top + 1}",
      "_console_evidence = {'schemaVersion': 1, 'processId': os.getpid(), 'before': _console_snapshot()}",
      "def _save_console_evidence():",
      "    with open(os.environ['NEMOCLAW_AGENT_CONSOLE_PROBE'], 'w', encoding='utf-8') as output:",
      "        json.dump(_console_evidence, output)",
      "_save_console_evidence()",
    ] : []),
    "sys.path.insert(0, os.environ['NEMOCLAW_AGENT_SITE_PACKAGES'])",
    ...(dashboard ? ${JSON.stringify(hermesDashboardPythonSource())} : ["from hermes_cli.main import main"]),
    ...(consoleProbe ? [
      "try:",
      "    main()",
      "finally:",
      "    _console_evidence['after'] = _console_snapshot()",
      "    _save_console_evidence()",
    ] : dashboard ? [] : ["main()"]),
    "",
  ].join("\n"), "utf8");
  executable = python;
  args = dashboard ? [runner] : [runner, "--provider", "custom", "--model", model];
  extraEnvironment = { HERMES_HOME: hermesHome, ...(dashboard ? {
    // Hermes's optional atomic file publication conflicts with the held state
    // directory guard. Its normal stdout contract reports the live bound port.
    HERMES_DESKTOP_READY_FILE: "",
    HERMES_DASHBOARD_SESSION_TOKEN: process.env.NEMOCLAW_UI_SESSION_TOKEN,
    HERMES_NODE: node, HERMES_PYTHON: python, HERMES_SKIP_NODE_BOOTSTRAP: "1",
  } : {}) };
} else if (agent === "langchain-deepagents-code") {
  if (!python || !sitePackages) throw new Error("Deep Agents Code Python runtime is incomplete");
  const configDirectory = join(home, ".deepagents");
  mkdirSync(join(configDirectory, ".state"), { recursive: true });
  mkdirSync(join(configDirectory, "skills"), { recursive: true });
  writeFileSync(join(configDirectory, "config.toml"), [
    "# Generated by NemoClaw. This file contains no provider secrets.",
    "[models]",
    "default = " + JSON.stringify("openai:" + model),
    "",
    "[models.providers.openai]",
    "models = [" + JSON.stringify(model) + "]",
    "api_key_env = \"DEEPAGENTS_CODE_OPENAI_API_KEY\"",
    "base_url = " + JSON.stringify(baseUrl),
    "enabled = true",
    "",
    "[models.providers.openai.params]",
    "use_responses_api = false",
    "",
    "[update]",
    "check = false",
    "auto_update = false",
    "",
    "[warnings]",
    "suppress = [\"ripgrep\", \"tavily\"]",
    "",
  ].join("\n"), "utf8");
  const runner = join(home, "run-deep-agents.py");
  writeFileSync(runner, [
    "import os",
    "import sys",
    ...deepAgentsTempfileShim,
    "sys.path.insert(0, os.environ['NEMOCLAW_AGENT_SITE_PACKAGES'])",
    "from deepagents_code import cli_main",
    "cli_main()",
    "",
  ].join("\n"), "utf8");
  executable = python;
  args = [runner, "--sandbox", "none"];
  extraEnvironment = {
    DEEPAGENTS_CODE_OPENAI_API_KEY: brokerToken,
    DEEPAGENTS_CODE_RIPGREP_INSTALLER: "system",
  };
} else {
  throw new Error("unsupported native terminal agent " + agent);
}

const childEnvironment = {
  ...process.env, ...extraEnvironment, HOME: home, LOCALAPPDATA: home,
  NODE_DISABLE_COMPILE_CACHE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", USERPROFILE: home,
};
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const observe = (process) => new Promise((resolve) => {
  process.once("error", () => resolve(1));
  process.once("close", (code) => resolve(code ?? 1));
});
function waitForHermesDashboardReady(child, childExit, timeoutMilliseconds = 180000) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let dropping = false;
    let settled = false;
    let timer;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stdout?.off("end", onEnd);
      child.stdout?.off("error", onError);
      child.off("error", onError);
      if (error) reject(error); else resolve({ port, processId: child.pid });
    };
    const onError = (error) => finish(error);
    const onEnd = () => finish(new Error("The Hermes dashboard closed stdout before announcing readiness."));
    const onData = (bytes) => {
      for (const part of decoder.write(bytes).split(/(\n)/)) {
        if (settled) return;
        if (part !== "\n") {
          if (dropping) continue;
          pending += part;
          if (pending.length > 4096) {
            if (pending.startsWith("HERMES_DASHBOARD_READY")) {
              finish(new Error("The Hermes dashboard readiness announcement exceeded its limit."));
              return;
            }
            pending = "";
            dropping = true;
          }
          continue;
        }
        const line = pending.replace(/\r$/, "");
        pending = "";
        if (dropping) { dropping = false; continue; }
        if (!line.startsWith("HERMES_DASHBOARD_READY")) continue;
        const match = /^HERMES_DASHBOARD_READY port=([1-9][0-9]{0,4})$/.exec(line);
        const port = match ? Number(match[1]) : 0;
        if (!port || port > 65535) {
          finish(new Error("The Hermes dashboard announced an invalid port."));
        } else if (child.exitCode !== null || child.signalCode !== null) {
          finish(new Error("The Hermes dashboard exited before its readiness announcement was accepted."));
        } else finish(null, port);
      }
    };
    child.stdout?.on("data", onData);
    child.stdout?.once("end", onEnd);
    child.stdout?.once("error", onError);
    child.once("error", onError);
    childExit.then(
      () => finish(new Error("The Hermes dashboard exited before becoming ready.")),
      onError,
    );
    if (!Number.isInteger(child.pid) || child.pid <= 0 || !child.stdout) {
      finish(new Error("The Hermes dashboard process could not start with owned stdout."));
      return;
    }
    timer = setTimeout(() => finish(new Error("The real Hermes dashboard did not become ready.")), timeoutMilliseconds);
  });
}
async function stopOwnedNativeAgent(child, childStopped, timeoutMilliseconds = 10000) {
  if (!child) return true;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let timer;
  try {
    const stopped = await Promise.race([
      childStopped.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMilliseconds); }),
    ]);
    if (!stopped) {
      // A descendant can retain the pipes after the direct child exits. Close
      // only this child's owned streams so Node can exit with failure and MXC
      // can finish its job teardown; never destroy inherited console handles.
      child.stdout?.unpipe(process.stdout);
      child.stderr?.unpipe(process.stderr);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    return stopped;
  } finally { clearTimeout(timer); }
}
let messaging;
let messagingExit;
let messagingFailure = false;
let child;
let childStopped;
let exitCode = 1;
const selectedChannels = Object.keys(nativeServices.options.messaging || {});
try {
  stopWatcher.signal.throwIfAborted();
  if (agent === "hermes" && selectedChannels.length) {
    console.log("Connecting your selected messaging services…");
    messaging = spawn(python, ["-m", "gateway.run"], {
      cwd: home, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    messagingExit = observe(messaging);
    // Upstream gateway logs may contain SDK diagnostics. Keep them out of the
    // terminal/configuration and report selected-channel readiness below.
    messaging.stdout.resume(); messaging.stderr.resume();
    const deadline = Date.now() + 120000;
    let connected = false;
    while (Date.now() < deadline && messaging.exitCode === null && messaging.signalCode === null) {
      stopWatcher.signal.throwIfAborted();
      let status;
      try { status = JSON.parse(readFileSync(join(extraEnvironment.HERMES_HOME, "gateway_state.json"), "utf8")); } catch {}
      if (status?.pid === messaging.pid && status?.gateway_state === "running" &&
          selectedChannels.every((channel) => status.platforms?.[channel]?.state === "connected")) { connected = true; break; }
      if (status?.pid === messaging.pid && (status.gateway_state === "startup_failed" ||
          selectedChannels.some((channel) => status.platforms?.[channel]?.state === "fatal"))) break;
      await pause(250);
    }
    if (!connected) throw new Error("A selected messaging service could not connect. Check its bot key, app permissions, and network in NemoClaw Setup.");
    console.log("Messaging connected: " + selectedChannels.join(", ") + ".");
  }
  stopWatcher.signal.throwIfAborted();
  child = spawn(executable, args, { cwd: home, env: childEnvironment, stdio: dashboard ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: dashboard });
  childStopped = observe(child);
  const childExit = Promise.race([childStopped, brokerTunnel.failure, stopWatcher.requested]);
  const dashboardReady = dashboard ? waitForHermesDashboardReady(child, childExit) : null;
  if (dashboard) { child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false }); }
  if (messagingExit) {
    messagingExit.then(() => {
      if (child && child.exitCode === null && child.signalCode === null) {
        messagingFailure = true;
        console.error("The messaging gateway stopped. Close this session and reopen the agent to reconnect.");
      }
    });
  }
  if (dashboard) {
    const { port, processId } = await dashboardReady;
    if (processId !== child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error("The Hermes dashboard process stopped during readiness.");
    const { startNativeUiTunnel } = await import("./native-ui-tunnel.mts");
    await Promise.race([
      startNativeUiTunnel({ relayRoot: required("NEMOCLAW_UI_RELAY_ROOT"), relayToken: required("NEMOCLAW_UI_RELAY_TOKEN"), uiPort: port, signal: stopWatcher.signal }),
      childExit.then(() => { throw new Error("The Hermes dashboard stopped unexpectedly."); }),
    ]);
    // The host subsequently deletes the exact MXC sandbox, which owns every
    // dashboard ConPTY child. The shared finally block first bounds shutdown
    // of the exact Python child; no process-name kill or browser handle is used.
    exitCode = 0;
  } else exitCode = await childExit;
} catch (error) {
  console.error(error instanceof Error ? error.message : "The selected agent could not start.");
} finally {
  if (!(await stopOwnedNativeAgent(child, childStopped))) {
    exitCode = 1;
    console.error("The owned native agent process did not stop within its cleanup deadline.");
  }
  if (messaging && messaging.exitCode === null && messaging.signalCode === null) {
    const stop = spawn(python, ["-c", "import sys; from gateway.status import get_running_pid, write_planned_stop_marker; pid=int(sys.argv[1]); sys.exit(0 if get_running_pid()==pid and write_planned_stop_marker(pid) else 1)", String(messaging.pid)], {
      cwd: home, env: childEnvironment, stdio: "ignore", windowsHide: true,
    });
    const stopTimer = setTimeout(() => stop.kill(), 10000);
    const stopCode = await observe(stop);
    clearTimeout(stopTimer);
    const drainTimer = setTimeout(() => { messagingFailure = true; messaging.kill(); }, 30000);
    const gatewayCode = await messagingExit;
    clearTimeout(drainTimer);
    if (stopCode !== 0 || gatewayCode !== 0) messagingFailure = true;
  }
}
if (messagingFailure) exitCode = 1;
writeFileSync(exitReceipt, JSON.stringify({ schemaVersion: 1, agent, exitCode }) + "\n", "utf8");
process.exitCode = exitCode;
} catch (error) {
  if (!bootstrapWritten) {
    const code = error?.cause?.code ?? error?.code ?? (error?.name === "TimeoutError" ? "ETIMEDOUT" : "BOOTSTRAP_FAILED");
    connectivity.errorCode = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EACCES", "EPERM", "ENETUNREACH", "EHOSTUNREACH", "ABORT_ERR"].includes(code) ? code : "BOOTSTRAP_FAILED";
    writeFileSync(bootstrapReceipt, JSON.stringify(connectivity) + "\n", "utf8");
  }
  throw error;
} finally {
  await stopWatcher.close();
  await brokerTunnel?.close();
}

`;
}

async function runNativeConsoleAgentInternal(
  options: {
    interface?: "console" | "dashboard";
    webSession?: Awaited<ReturnType<typeof openNativeWebSession>>;
  },
  diagnostics: ReturnType<typeof createNativeSessionDiagnostics>,
) {
  if (process.platform !== "win32" || process.arch !== "arm64")
    fail("native Windows ARM64 is required");
  if (!process.argv.includes("--configured")) fail("graphical onboarding is required");
  const agentId = argumentValue("--agent") ?? "";
  const dashboard = options.interface === "dashboard";
  if (dashboard && agentId !== "hermes") fail("the native dashboard requires Hermes");
  if (!Object.hasOwn(AGENT_ADAPTERS, agentId)) fail(`unsupported terminal agent: ${agentId}`);
  const consoleQualification = process.argv.includes("--console-qualification");
  const dashboardQualification = process.argv.includes("--dashboard-qualification");
  if (dashboardQualification && !dashboard)
    fail("dashboard qualification requires the real Hermes dashboard");
  const dashboardEvidenceRoot = dashboardQualification
    ? requiredDirectory(argumentValue("--artifact-directory") ?? "", "dashboard evidence directory")
    : null;
  if (dashboard && consoleQualification)
    fail("console qualification cannot substitute for dashboard evidence");
  if (consoleQualification && agentId !== "hermes")
    fail("interactive console qualification requires Hermes");
  const consoleEvidenceRoot = consoleQualification
    ? requiredDirectory(
        argumentValue("--artifact-directory") ?? "",
        "interactive console evidence directory",
      )
    : null;
  const adapter = AGENT_ADAPTERS[agentId];
  process.title = `NemoClaw · ${adapter.displayName} · Native ARM64`;
  console.log(`NVIDIA NemoClaw · ${adapter.displayName}`);
  console.log("Native Windows ARM64 · OpenShell + Microsoft MXC · no WSL · no Docker\n");

  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  const { config: storedConfig } = readConfiguration(agentId);
  options.webSession?.assertRunning();
  options.webSession?.progress("inference");
  diagnostics.stage("inference");
  const binRoot = requiredDirectory(path.join(installRoot, "bin"), "NemoClaw bin directory");
  const launcher = requiredFile(path.join(binRoot, "NemoClaw.exe"), "NemoClaw launcher");
  const installedNode = requiredFile(path.join(binRoot, "node.exe"), "Node.js runtime");
  const openshell = requiredFile(path.join(binRoot, "openshell.exe"), "OpenShell CLI");
  const gatewayExecutable = requiredFile(
    path.join(binRoot, "openshell-gateway.exe"),
    "OpenShell gateway",
  );
  const installedRuntime = requiredDirectory(
    path.join(installRoot, adapter.runtimeDirectory),
    `${adapter.displayName} runtime`,
  );
  const installedPython =
    agentId === "pi" ? null : requiredDirectory(path.join(installRoot, "python"), "Python runtime");
  requiredFile(path.join(installRoot, "config", "mxc-gateway.toml"), "MXC gateway configuration");
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");
  const { configuration: config, credential } = await resolveNativeConfiguredInference(
    installRoot,
    launcher,
    storedConfig,
    {
      signal: options.webSession?.signal,
      ...(options.webSession
        ? {
            onProgress: (event: NativeInferenceProgress) =>
              options.webSession?.progress(
                "inference",
                typeof event.completedBytes === "number" && typeof event.totalBytes === "number"
                  ? { completed: event.completedBytes, total: event.totalBytes, unit: "bytes" }
                  : undefined,
              ),
          }
        : {}),
    },
  );
  options.webSession?.assertRunning();
  options.webSession?.progress("runtime");
  diagnostics.secret(credential);
  diagnostics.stage("runtime");
  const brokerToken = randomBytes(32).toString("base64url");
  diagnostics.secret(brokerToken);
  const stateSession = await acquireNativeStateSession(launcher, agentId);
  const agentRuntimeRoot = stateSession.stateRoot;
  let broker;
  let brokerRelay: Awaited<ReturnType<typeof startNativeBrokerRelay>> | undefined;
  let brokerRelayRoot: string | undefined;
  let runRoot;
  let runtimeRoot;
  let relay;
  let webSession = options.webSession;
  let sessionPassed = false;
  let dashboardRelayRoot;
  let statusRoot;
  let statusFiles;
  let dashboardGatewayStopped = false;
  try {
    const services = await readNativeServiceEnvironment(launcher, agentId, config.options);
    diagnostics.secret(...Object.values(services.environment));
    webSession?.capabilities(services.options.search ? "available" : "unconfigured");
    diagnostics.stage("broker");
    broker = await startNativeInferenceBroker(config, credential, brokerToken, services);
    const hostProbe = await fetch(`http://127.0.0.1:${broker.port}/native/bootstrap`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    await hostProbe.body?.cancel();
    if (hostProbe.status !== 403)
      fail("the local broker did not reject its unauthenticated host probe");
    diagnostics.stage("runtime");

    const systemDrive = process.env.SystemDrive;
    if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
    const systemRoot = requiredDirectory(process.env.SystemRoot ?? "", "Windows system root");
    const runId = randomBytes(5).toString("hex");
    const relayToken = randomBytes(32).toString("base64url");
    diagnostics.secret(relayToken);
    const brokerRelayToken = randomBytes(32).toString("base64url");
    diagnostics.secret(brokerRelayToken);
    brokerRelayRoot = path.join(agentRuntimeRoot, `broker-relay-${runId}`);
    diagnostics.stage("broker");
    brokerRelay = await startNativeBrokerRelay({
      relayRoot: brokerRelayRoot,
      relayToken: brokerRelayToken,
      brokerPort: broker.port,
      launcher,
      signal: webSession?.signal,
    });
    void brokerRelay.failure.catch(() => {});
    diagnostics.stage("runtime");
    const relayRoot = path.join(agentRuntimeRoot, `ui-relay-${runId}`);
    if (dashboard) {
      dashboardRelayRoot = relayRoot;
      relay = await startFileTcpRelay(relayRoot, relayToken, launcher);
    }
    runRoot = path.join(`${systemDrive}\\`, `NemoClaw-${agentId}-${runId}`);
    runtimeRoot = path.join(`${systemDrive}\\`, `NemoClawRuntime-${agentId}-${runId}`);
    fs.mkdirSync(runRoot);
    fs.mkdirSync(runtimeRoot);
    const gatewayConfig = writeNativeGatewayConfig(installRoot, runRoot);
    const node = path.join(runtimeRoot, "node.exe");
    const runtime = path.join(runtimeRoot, adapter.runtimeDirectory);
    const pythonRoot = path.join(runtimeRoot, "python");
    if (dashboard) {
      await copyNativeRuntime(
        [
          { source: installedNode, destination: node },
          { source: installedRuntime, destination: runtime },
          ...(installedPython === null
            ? []
            : [{ source: installedPython, destination: pythonRoot }]),
        ],
        {
          signal: webSession?.signal,
          onTargetStart: (index) =>
            diagnostics.stage(
              index === 0
                ? "runtime-copy-node"
                : index === 1
                  ? "runtime-copy-agent"
                  : "runtime-copy-python",
            ),
          onProgress: (counts) => webSession?.progress("runtime", counts),
        },
      );
    } else {
      diagnostics.stage("runtime-copy-node");
      fs.copyFileSync(installedNode, node);
      diagnostics.stage("runtime-copy-agent");
      fs.cpSync(installedRuntime, runtime, { recursive: true });
      if (installedPython !== null) {
        diagnostics.stage("runtime-copy-python");
        fs.cpSync(installedPython, pythonRoot, { recursive: true });
      }
    }
    diagnostics.stage("runtime");
    if (installedPython !== null) {
      fs.writeFileSync(
        path.join(pythonRoot, "python313._pth"),
        [
          "python313.zip",
          ".",
          path.relative(pythonRoot, path.join(runtime, "site-packages")),
          "import site",
          "",
        ].join("\r\n"),
        "ascii",
      );
    }
    const workload = path.join(runtimeRoot, "run-native-agent.mjs");
    statusRoot = path.join(agentRuntimeRoot, `session-status-${runId}`);
    statusFiles = await openNativeUiFileOwner(launcher, statusRoot);
    const statusSlot = `stream-${randomBytes(8).toString("hex")}`;
    await statusFiles.mkdir(statusSlot);
    const exitRelative = `${statusSlot}/sandbox-0000000000.bin`;
    const probeRelative = `${statusSlot}/sandbox-0000000001.bin`;
    const bootstrapRelative = `${statusSlot}/sandbox-0000000002.bin`;
    const exitReceipt = path.join(statusRoot, statusSlot, "sandbox-0000000000.bin");
    const consoleProbePath = path.join(statusRoot, statusSlot, "sandbox-0000000001.bin");
    const bootstrapPath = path.join(statusRoot, statusSlot, "sandbox-0000000002.bin");
    const readStatus = async (relative: string, limit: number) => {
      const bytes = await statusFiles.read(relative);
      if (bytes !== null && bytes.length > limit)
        fail("the native session status exceeded its limit");
      return bytes?.toString("utf8") ?? null;
    };
    fs.writeFileSync(workload, interactiveWorkloadSource(), "utf8");
    for (const file of ["native-broker-tunnel.mts", "native-broker-relay-protocol.mts"])
      fs.copyFileSync(
        requiredFile(path.join(installRoot, "qualification", file), "native broker transport"),
        path.join(runtimeRoot, file),
      );
    if (dashboard)
      fs.copyFileSync(
        requiredFile(
          path.join(installRoot, "qualification", "native-ui-tunnel.mts"),
          "native UI tunnel",
        ),
        path.join(runtimeRoot, "native-ui-tunnel.mts"),
      );
    webSession?.assertRunning();
    webSession?.progress("gateway");
    const policyPath = path.join(runRoot, "policy.yaml");
    fs.writeFileSync(
      policyPath,
      [
        "version: 1",
        "",
        "filesystem_policy:",
        "  include_workdir: false",
        "  read_only:",
        `    - ${quoteYamlPath(runtimeRoot)}`,
        "  read_write:",
        `    - ${quoteYamlPath(agentRuntimeRoot)}`,
        `    - ${quoteYamlPath(statusRoot)}`,
        `    - ${quoteYamlPath(brokerRelayRoot)}`,
        ...(dashboard ? [`    - ${quoteYamlPath(relayRoot)}`] : []),
        "",
      ].join("\n"),
      "utf8",
    );
    const configRoot = path.join(runRoot, "config");
    const gatewayState = path.join(runRoot, "state");
    const temp = path.join(agentRuntimeRoot, "temp");
    for (const directory of [configRoot, gatewayState, temp])
      fs.mkdirSync(directory, { recursive: true });
    const gatewayPort = await freePort();
    const sandboxName = `${adapter.sandboxPrefix}-${runId}`;
    const gatewayName = `nemoclaw-${agentId}-${runId}`;
    const gatewayEnvironment = allowlistedWindowsEnvironment({
      OPENSHELL_DRIVERS: "mxc",
      OPENSHELL_GATEWAY_CONFIG: gatewayConfig,
      XDG_CONFIG_HOME: configRoot,
      XDG_STATE_HOME: gatewayState,
    });
    diagnostics.stage("gateway");
    const gateway = spawn(
      gatewayExecutable,
      [
        "--port",
        String(gatewayPort),
        "--disable-tls",
        "--db-url",
        "sqlite::memory:",
        "--log-level",
        "warn",
      ],
      {
        env: gatewayEnvironment,
        stdio: dashboard ? ["ignore", "pipe", "pipe"] : "inherit",
        windowsHide: dashboard,
      },
    );
    gateway.stdout?.on("data", (chunk) => diagnostics.capture("gateway.stdout", chunk));
    gateway.stderr?.on("data", (chunk) => diagnostics.capture("gateway.stderr", chunk));
    let cliEnvironment = gatewayEnvironment;
    let passed = false;
    try {
      console.log("Starting the native OpenShell MXC boundary…");
      await waitForPort(gatewayPort, gateway);
      cliEnvironment = allowlistedWindowsEnvironment({
        ...gatewayEnvironment,
        OPENSHELL_GATEWAY: undefined,
      });
      await run(
        openshell,
        ["gateway", "add", `http://127.0.0.1:${gatewayPort}`, "--local", "--name", gatewayName],
        cliEnvironment,
        "Registering the native gateway",
        undefined,
        diagnostics,
      );
      await run(
        openshell,
        ["gateway", "select", gatewayName],
        cliEnvironment,
        "Selecting the native gateway",
        undefined,
        diagnostics,
      );
      const environment = {
        HOME: agentRuntimeRoot,
        LOCALAPPDATA: agentRuntimeRoot,
        NEMOCLAW_AGENT_HOME: agentRuntimeRoot,
        NEMOCLAW_AGENT_ID: agentId,
        NEMOCLAW_AGENT_SESSION_ID: runId,
        NEMOCLAW_AGENT_BOOTSTRAP_RECEIPT: bootstrapPath,
        NEMOCLAW_AGENT_STOP_REQUEST: path.join(statusRoot, "shutdown"),
        NEMOCLAW_BROKER_RELAY_ROOT: brokerRelayRoot,
        NEMOCLAW_BROKER_RELAY_TOKEN: brokerRelayToken,
        ...(dashboard
          ? {
              NEMOCLAW_AGENT_INTERFACE: "dashboard",
              NEMOCLAW_UI_RELAY_ROOT: relayRoot,
              NEMOCLAW_UI_RELAY_TOKEN: relayToken,
              NEMOCLAW_UI_SESSION_TOKEN: randomBytes(32).toString("base64url"),
            }
          : {}),
        NEMOCLAW_AGENT_BROKER_TOKEN: brokerToken,
        NEMOCLAW_AGENT_EXIT_RECEIPT: exitReceipt,
        ...(consoleQualification ? { NEMOCLAW_AGENT_CONSOLE_PROBE: consoleProbePath } : {}),
        NEMOCLAW_AGENT_MODEL: config.model,
        NEMOCLAW_AGENT_NODE: node,
        NEMOCLAW_AGENT_PROXY_PORT: String(broker.port),
        NEMOCLAW_AGENT_PYTHON: installedPython === null ? "" : path.join(pythonRoot, "python.exe"),
        NEMOCLAW_AGENT_RUNTIME: runtime,
        NEMOCLAW_AGENT_SITE_PACKAGES:
          installedPython === null ? "" : path.join(runtime, "site-packages"),
        NODE_DISABLE_COMPILE_CACHE: "1",
        NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS ?? "1",
        OS: "Windows_NT",
        PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        PROCESSOR_ARCHITECTURE: "ARM64",
        SYSTEMDRIVE: systemDrive,
        SYSTEMROOT: systemRoot,
        TEMP: temp,
        TMP: temp,
        USERPROFILE: agentRuntimeRoot,
        WINDIR: systemRoot,
      };
      diagnostics.secret(
        ...Object.entries(environment)
          .filter(([name]) => /token|key|secret/iu.test(name))
          .map(([, value]) => String(value)),
      );
      const createArgs = [
        "sandbox",
        "create",
        "--name",
        sandboxName,
        "--policy",
        policyPath,
        "--driver-config-json",
        JSON.stringify({
          mxc: {
            windows_ui: true,
            command: [node, workload],
            cwd: agentRuntimeRoot,
            host_loopback: false,
            host_console: !dashboard,
            personal_network: true,
          },
        }),
        "--detach",
        "--no-tty",
      ];
      for (const [name, value] of Object.entries(environment))
        createArgs.push("--env", `${name}=${value}`);
      console.log(`Opening the authentic ${adapter.displayName} terminal inside native MXC…\n`);
      if (consoleEvidenceRoot !== null) {
        fs.writeFileSync(
          path.join(consoleEvidenceRoot, "interactive-session-start.json"),
          JSON.stringify({
            schemaVersion: 1,
            agent: agentId,
            nodeProcessId: process.pid,
            gatewayProcessId: gateway.pid,
            runRoot,
            runtimeRoot,
            agentRuntimeRoot,
            exitReceipt,
            consoleProbePath,
          }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
      }
      const publishBootstrap = async (wait: boolean, signal?: AbortSignal) => {
        const deadline = Date.now() + (wait ? 60_000 : 1000);
        do {
          signal?.throwIfAborted();
          const text = await readStatus(bootstrapRelative, 16 * 1024);
          signal?.throwIfAborted();
          if (text?.endsWith("\n")) {
            diagnostics.stage("bootstrap");
            const result = JSON.parse(text);
            const validPort = (value: unknown) =>
              Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
            if (
              result.schemaVersion !== 1 ||
              result.agent !== agentId ||
              result.sessionId !== runId ||
              result.interface !== (dashboard ? "dashboard" : "console") ||
              result.transport !== "guarded-file-tcp" ||
              result.brokerHost !== "127.0.0.1" ||
              result.brokerPort !== broker.port ||
              result.containedHost !== "127.0.0.1" ||
              (result.containedPort !== null && !validPort(result.containedPort)) ||
              !["pass", "fail"].includes(result.verdict) ||
              !result.contained ||
              typeof result.contained.tcpConnected !== "boolean" ||
              ![
                "bridge",
                "tcp",
                "unauthenticated-http",
                "authenticated-bootstrap",
                "bootstrap-json",
                null,
              ].includes(result.failureStage) ||
              ![
                "ETIMEDOUT",
                "ECONNREFUSED",
                "ECONNRESET",
                "EACCES",
                "EPERM",
                "ENETUNREACH",
                "EHOSTUNREACH",
                "ABORT_ERR",
                "BOOTSTRAP_FAILED",
                null,
              ].includes(result.errorCode)
            )
              fail("the contained bootstrap result was invalid");
            const pass =
              result.verdict === "pass" &&
              result.contained.tcpConnected &&
              validPort(result.containedPort) &&
              result.contained.unauthenticatedStatus === 403 &&
              result.contained.authenticatedStatus === 200 &&
              result.contained.bootstrapConsumedByWorkload === true &&
              result.failureStage === null &&
              result.errorCode === null;
            if (result.verdict === "pass" && !pass)
              fail("the contained bootstrap did not prove its connection and authentication");
            const receipt = {
              schemaVersion: 1,
              classification: "native-contained-bootstrap-connectivity",
              agent: agentId,
              interface: dashboard ? "dashboard" : "console",
              nodeProcessId: process.pid,
              sandboxName,
              transport: "guarded-file-tcp",
              brokerHost: "127.0.0.1",
              brokerPort: broker.port,
              containedHost: "127.0.0.1",
              containedPort: result.containedPort,
              hostListener: { httpStatus: hostProbe.status },
              contained: {
                tcpConnected: result.contained.tcpConnected,
                unauthenticatedStatus: Number.isInteger(result.contained.unauthenticatedStatus)
                  ? result.contained.unauthenticatedStatus
                  : null,
                authenticatedStatus: Number.isInteger(result.contained.authenticatedStatus)
                  ? result.contained.authenticatedStatus
                  : null,
                bootstrapConsumedByWorkload: result.contained.bootstrapConsumedByWorkload === true,
              },
              verdict: result.verdict,
              failureStage: result.failureStage,
              errorCode: result.errorCode,
            };
            for (const directory of [consoleEvidenceRoot, dashboardEvidenceRoot]) {
              if (!directory) continue;
              const destination = path.join(directory, "bootstrap-connectivity.json");
              const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
              try {
                fs.writeFileSync(temporary, JSON.stringify(receipt) + "\n", {
                  flag: "wx",
                  mode: 0o600,
                });
                fs.renameSync(temporary, destination);
              } finally {
                fs.rmSync(temporary, { force: true });
              }
            }
            if (!pass)
              throw new Error(
                `The sandbox could not connect to its local broker at ${result.failureStage} (${result.errorCode ?? "BOOTSTRAP_FAILED"}).`,
              );
            return receipt;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        if (wait) fail("the contained broker bootstrap did not publish its connectivity result");
        return null;
      };
      diagnostics.stage("sandbox");
      webSession?.progress("sandbox");
      try {
        await run(
          openshell,
          createArgs,
          cliEnvironment,
          "Creating the native console workload",
          undefined,
          diagnostics,
        );
      } catch (error) {
        const bootstrap = await publishBootstrap(false);
        if (bootstrap?.verdict === "pass") diagnostics.stage(dashboard ? "dashboard" : "agent");
        throw error;
      }
      diagnostics.stage("bootstrap");
      webSession?.progress("bootstrap");
      const bootstrapMonitoring = new AbortController();
      const bootstrapResult = publishBootstrap(true, bootstrapMonitoring.signal);
      try {
        await Promise.race([bootstrapResult, brokerRelay.failure]);
      } finally {
        bootstrapMonitoring.abort();
        await bootstrapResult.catch(() => {});
      }
      const monitoring = new AbortController();
      const agentExit = waitForConsoleAgentExit(
        openshell,
        cliEnvironment,
        sandboxName,
        gateway,
        () => readStatus(exitRelative, 4096),
        agentId,
        stateSession,
        monitoring.signal,
      );
      void agentExit.catch(() => {});
      let exitCode;
      if (dashboard) {
        try {
          webSession?.progress("dashboard");
          diagnostics.stage("dashboard");
          await Promise.race([
            relay.ready,
            relay.failure,
            brokerRelay.failure,
            agentExit.then(() => {
              throw new Error("Hermes stopped before its dashboard became ready.");
            }),
            ...(webSession
              ? [
                  webSession.stopped.then(() => {
                    throw new Error("The native dashboard startup was stopped.");
                  }),
                ]
              : []),
          ]);
          const url = `http://127.0.0.1:${relay.browserPort}/`;
          webSession?.progress("browser");
          diagnostics.stage("browser");
          if (webSession) webSession.ready(url);
          else
            webSession = await openNativeWebSession(installRoot, "hermes", url, {
              qualification: dashboardQualification,
            });
          options.webSession = webSession;
          webSession.capabilities(services.options.search ? "available" : "unconfigured");
          diagnostics.stage("agent");
          if (dashboardEvidenceRoot)
            fs.writeFileSync(
              path.join(dashboardEvidenceRoot, "dashboard-ready.json"),
              JSON.stringify({
                schemaVersion: 1,
                classification: "native-hermes-dashboard-qualification",
                agent: agentId,
                url,
                nodeProcessId: process.pid,
                gatewayProcessId: gateway.pid,
                runRoot,
                runtimeRoot,
                agentRuntimeRoot,
              }) + "\n",
              { flag: "wx", mode: 0o600 },
            );
          await Promise.race([
            webSession.stopped,
            relay.failure,
            brokerRelay.failure,
            agentExit.then(() => {
              throw new Error("The Hermes dashboard stopped unexpectedly.");
            }),
          ]);
          webSession.progress("cleanup");
          await relay.close();
          // Let the contained owner stop its real messaging gateway and publish
          // its exit receipt before MXC removes the complete descendant tree.
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            exitCode = await Promise.race([
              agentExit,
              new Promise<never>((_, reject) => {
                drainTimer = setTimeout(
                  () =>
                    reject(new Error("The Hermes dashboard did not finish its bounded shutdown.")),
                  45_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(drainTimer);
          }
        } finally {
          monitoring.abort();
          await agentExit.catch(() => {});
        }
      } else {
        diagnostics.stage("agent");
        exitCode = await Promise.race([agentExit, brokerRelay.failure]);
      }
      if (exitCode !== 0) fail(`${adapter.displayName} exited with status ${exitCode}`);
      diagnostics.stage("cleanup");
      await run(
        openshell,
        ["sandbox", "delete", sandboxName],
        cliEnvironment,
        "Deleting the native agent sandbox",
      );
      const sandboxList = await run(
        openshell,
        ["sandbox", "list", "-o", "json"],
        cliEnvironment,
        "Verifying native sandbox cleanup",
      );
      if (jsonContainsExactValue(JSON.parse(sandboxList.stdout.trim()), sandboxName))
        fail("the native agent sandbox remained registered");
      passed = true;
      sessionPassed = true;
      console.log(`\n${adapter.displayName} closed. NemoClaw removed the temporary sandbox.`);
    } catch (error) {
      diagnostics.fail(error);
      throw error;
    } finally {
      webSession?.progress("cleanup");
      diagnostics.stage("cleanup");
      if (!passed) {
        const cleanup = async (label: string, operation: () => Promise<unknown>) => {
          try {
            await operation();
          } catch (error) {
            diagnostics.cleanupFailed(label);
            diagnostics.capture(
              "cleanup.stderr",
              `${label}: ${error instanceof Error ? (error.stack ?? error.message) : "The cleanup operation failed."}\n`,
            );
          }
        };
        await cleanup("contained agent stop request", () =>
          statusFiles.write("shutdown", `${runId}\n`),
        );
        await cleanup("dashboard stop signal", async () => {
          if (relay) await relay.close();
        });
        await cleanup("broker stop signal", async () => {
          if (brokerRelay) await brokerRelay.close();
        });
        await cleanup("MXC execution cleanup", () =>
          waitForNativeMxcCompletion(openshell, cliEnvironment, sandboxName, gateway, stateSession),
        );
        await cleanup("native sandbox deletion", () =>
          run(
            openshell,
            ["sandbox", "delete", sandboxName],
            cliEnvironment,
            "Failure cleanup native sandbox",
            30_000,
            diagnostics,
          ),
        );
      }
      const gatewayStopped = await stopChild(gateway);
      dashboardGatewayStopped = gatewayStopped;
      if (!gatewayStopped) {
        sessionPassed = false;
        fail("the native gateway could not be stopped");
      }
      if (relay) await relay.close();
      if (relay) await relay.dispose();
      for (const directory of [runRoot, runtimeRoot]) await removeDirectory(directory);
      if (consoleEvidenceRoot !== null) {
        const probe = await readStatus(probeRelative, 16384);
        const exit = await readStatus(exitRelative, 4096);
        if (probe !== null)
          fs.writeFileSync(path.join(consoleEvidenceRoot, "contained-console.json"), probe, {
            flag: "wx",
            mode: 0o600,
          });
        if (exit !== null)
          fs.writeFileSync(path.join(consoleEvidenceRoot, "agent-exit.json"), exit, {
            flag: "wx",
            mode: 0o600,
          });
        fs.writeFileSync(
          path.join(consoleEvidenceRoot, "interactive-session-end.json"),
          JSON.stringify({
            schemaVersion: 1,
            agent: agentId,
            sandboxDeleted: passed,
            gatewayStopped,
            ephemeralRootsRemoved: !fs.existsSync(runRoot) && !fs.existsSync(runtimeRoot),
            persistentStateRetained: fs.existsSync(agentRuntimeRoot),
          }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
      }
    }
  } catch (error) {
    diagnostics.fail(error);
    throw error;
  } finally {
    webSession?.progress("cleanup");
    diagnostics.stage("cleanup");
    const cleanupFailures: string[] = [];
    const attempt = async (label: string, operation: () => Promise<unknown> | unknown) => {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push(label);
        diagnostics.capture(
          "cleanup.stderr",
          `${label}: ${error instanceof Error ? (error.stack ?? error.message) : "The cleanup operation failed."}\n`,
        );
      }
    };
    // A failed file-boundary owner must not keep the credential-bearing broker,
    // temporary runtime, state lease or native window alive.
    await attempt("UI relay shutdown", async () => {
      if (relay) await relay.close();
    });
    await attempt("UI file owner shutdown", async () => {
      if (relay) await relay.dispose();
    });
    await attempt("session status owner shutdown", async () => {
      if (statusFiles) await statusFiles.close();
    });
    await attempt("broker transport shutdown", async () => {
      if (brokerRelay) await brokerRelay.dispose();
    });
    await attempt("inference broker shutdown", async () => {
      if (!broker) return;
      const closed = new Promise<void>((resolve) => broker.server.close(() => resolve()));
      broker.server.closeAllConnections();
      await closed;
    });
    let rootsRemoved = true;
    for (const directory of [
      runRoot,
      runtimeRoot,
      dashboardRelayRoot,
      statusRoot,
      brokerRelayRoot,
    ]) {
      await attempt("temporary runtime removal", async () => {
        if (directory && !(await removeDirectory(directory))) {
          rootsRemoved = false;
          throw new Error("Temporary native runtime files could not be removed.");
        }
      });
    }
    let released = false;
    await attempt("private state release", async () => {
      await stateSession.release();
      released = true;
    });
    await attempt("dashboard cleanup receipt", () => {
      if (dashboardEvidenceRoot)
        fs.writeFileSync(
          path.join(dashboardEvidenceRoot, "dashboard-end.json"),
          JSON.stringify({
            schemaVersion: 1,
            classification: "native-hermes-dashboard-qualification",
            agent: agentId,
            sandboxDeleted: sessionPassed,
            gatewayStopped: dashboardGatewayStopped,
            ephemeralRootsRemoved:
              rootsRemoved &&
              [runRoot, runtimeRoot, dashboardRelayRoot, statusRoot].every(
                (root) => !root || !fs.existsSync(root),
              ),
            stateRetained: fs.existsSync(agentRuntimeRoot),
            leaseReleased: released,
            cleanupSucceeded: cleanupFailures.length === 0,
          }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
    });
    diagnostics.cleanupFailed(...cleanupFailures);
    if (cleanupFailures.length)
      fail(`native session cleanup failed: ${cleanupFailures.join(", ")}`);
  }
}

export async function runNativeConsoleAgent(
  options: {
    interface?: "console" | "dashboard";
    webSession?: Awaited<ReturnType<typeof openNativeWebSession>>;
  } = {},
) {
  const agent = argumentValue("--agent") ?? "";
  if (!Object.hasOwn(AGENT_ADAPTERS, agent)) fail("a supported agent is required");
  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  const localAppData = requiredDirectory(
    process.env.LOCALAPPDATA ?? "",
    "Windows local application-data directory",
  );
  const diagnostics = createNativeSessionDiagnostics(
    path.join(installRoot, "bin", "NemoClaw.exe"),
    path.join(localAppData, "NVIDIA", "NemoClaw", "agents", agent),
    agent,
  );
  let presentation;
  try {
    await runNativeConsoleAgentInternal(options, diagnostics);
  } catch (error) {
    diagnostics.fail(error);
    options.webSession?.progress("cleanup");
    presentation = await diagnostics.persist(diagnostics.primaryError());
    if (
      process.argv.includes("--console-qualification") ||
      process.argv.includes("--dashboard-qualification")
    ) {
      try {
        const evidence = requiredDirectory(
          argumentValue("--artifact-directory") ?? "",
          "native qualification evidence directory",
        );
        const destination = path.join(evidence, "session-failure.json");
        const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          const record =
            JSON.stringify({
              schemaVersion: 1,
              classification: "native-session-failure-evidence",
              agent,
              interface: options.interface === "dashboard" ? "dashboard" : "console",
              nodeProcessId: process.pid,
              backendCleanupFinished: true,
              stage: presentation.stage,
              diagnosticPath: presentation.diagnosticPath,
              diagnostics: JSON.parse(diagnostics.failureEvidence()),
            }) + "\n";
          if (Buffer.byteLength(record) > 1024 * 1024)
            fail("native failure evidence exceeds its limit");
          fs.writeFileSync(temporary, record, { flag: "wx", mode: 0o600 });
          fs.renameSync(temporary, destination);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      } catch {
        console.error("NemoClaw could not retain the qualification failure snapshot.");
      }
    }
  }
  try {
    if (options.webSession) diagnostics.stage("control-close");
    await options.webSession?.complete(!diagnostics.hasFailure(), presentation);
  } catch (error) {
    diagnostics.fail(error);
    presentation ??= await diagnostics.persist(diagnostics.primaryError());
  }
  if (diagnostics.hasFailure())
    throw new NativeSessionFailure(presentation!, diagnostics.primaryError());
  const completed = await diagnostics.persistSuccess();
  if (!completed.diagnosticPath) console.error(completed.message);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runNativeConsoleAgent().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "NemoClaw native terminal launch failed.",
    );
    console.error("Press Enter to close.");
    process.stdin.resume();
    process.stdin.once("data", () => process.stdin.pause());
    process.exitCode = 1;
  });
