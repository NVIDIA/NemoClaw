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
import { openNativeWebSession } from "./native-web-session.mts";

import { readNativeServiceEnvironment } from "./native-options.mts";
import { startNativeInferenceBroker } from "./native-inference-broker.mts";
import { acquireNativeStateSession } from "./native-state.mts";

import { resolveNativeConfiguredInference } from "./native-configured-inference.mts";

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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const agent = required("NEMOCLAW_AGENT_ID");
const home = required("NEMOCLAW_AGENT_HOME");
const model = required("NEMOCLAW_AGENT_MODEL");
const brokerToken = required("NEMOCLAW_AGENT_BROKER_TOKEN");
const exitReceipt = required("NEMOCLAW_AGENT_EXIT_RECEIPT");
const proxyPort = required("NEMOCLAW_AGENT_PROXY_PORT");
const node = required("NEMOCLAW_AGENT_NODE");
const runtime = required("NEMOCLAW_AGENT_RUNTIME");
const python = process.env.NEMOCLAW_AGENT_PYTHON;
const sitePackages = process.env.NEMOCLAW_AGENT_SITE_PACKAGES;
const dashboard = process.env.NEMOCLAW_AGENT_INTERFACE === "dashboard";
const baseUrl = "http://127.0.0.1:" + proxyPort + "/v1";
const bootstrapResponse = await fetch("http://127.0.0.1:" + proxyPort + "/native/bootstrap", {
  method: "POST", headers: { authorization: "Bearer " + brokerToken }, signal: AbortSignal.timeout(15000),
});
if (!bootstrapResponse.ok) throw new Error("NemoClaw could not supply the selected optional services.");
const nativeServices = await bootstrapResponse.json();
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
    HERMES_DESKTOP_READY_FILE: join(home, "dashboard-ready-" + process.env.NEMOCLAW_AGENT_SESSION_ID + ".json"),
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
let messaging;
let messagingExit;
let messagingFailure = false;
let child;
let exitCode = 1;
const selectedChannels = Object.keys(nativeServices.options.messaging || {});
try {
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
  child = spawn(executable, args, { cwd: home, env: childEnvironment, stdio: dashboard ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: dashboard });
  if (dashboard) { child.stdout.resume(); child.stderr.resume(); }
  const childExit = observe(child);
  if (messagingExit) {
    messagingExit.then(() => {
      if (child && child.exitCode === null && child.signalCode === null) {
        messagingFailure = true;
        console.error("The messaging gateway stopped. Close this session and reopen the agent to reconnect.");
      }
    });
  }
  if (dashboard) {
    let port;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      let record;
      try { record = JSON.parse(readFileSync(extraEnvironment.HERMES_DESKTOP_READY_FILE, "utf8")); } catch {}
      if (Number.isInteger(record?.port) && record.port > 0 && record.port <= 65535) { port = record.port; break; }
      await pause(100);
    }
    if (!port) throw new Error("The real Hermes dashboard did not become ready.");
    const { startNativeUiTunnel } = await import("./native-ui-tunnel.mts");
    await Promise.race([
      startNativeUiTunnel({ relayRoot: required("NEMOCLAW_UI_RELAY_ROOT"), relayToken: required("NEMOCLAW_UI_RELAY_TOKEN"), uiPort: port }),
      childExit.then(() => { throw new Error("The Hermes dashboard stopped unexpectedly."); }),
    ]);
    // The host subsequently deletes the exact MXC sandbox, which owns every
    // dashboard ConPTY child. No process-name kill or browser handle is used.
    child.kill();
    await childExit;
    exitCode = 0;
  } else exitCode = await childExit;
} catch (error) {
  console.error(error instanceof Error ? error.message : "The selected agent could not start.");
} finally {
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

`;
}

export async function runNativeConsoleAgent(
  options: {
    interface?: "console" | "dashboard";
    webSession?: Awaited<ReturnType<typeof openNativeWebSession>>;
  } = {},
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
  const { config: storedConfig, stateRoot } = readConfiguration(agentId);
  options.webSession?.assertRunning();
  options.webSession?.progress("inference");
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
    { signal: options.webSession?.signal },
  );
  options.webSession?.assertRunning();
  options.webSession?.progress("runtime");
  const brokerToken = randomBytes(32).toString("base64url");
  const stateSession = await acquireNativeStateSession(launcher, agentId);
  const agentRuntimeRoot = stateSession.stateRoot;
  let broker;
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
    broker = await startNativeInferenceBroker(config, credential, brokerToken, services);

    const systemDrive = process.env.SystemDrive;
    if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
    const systemRoot = requiredDirectory(process.env.SystemRoot ?? "", "Windows system root");
    const runId = randomBytes(5).toString("hex");
    const relayToken = randomBytes(32).toString("base64url");
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
    fs.copyFileSync(installedNode, node);
    const runtime = path.join(runtimeRoot, adapter.runtimeDirectory);
    fs.cpSync(installedRuntime, runtime, { recursive: true });
    const pythonRoot = path.join(runtimeRoot, "python");
    if (installedPython !== null) {
      fs.cpSync(installedPython, pythonRoot, { recursive: true });
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
    const exitReceipt = path.join(statusRoot, statusSlot, "sandbox-0000000000.bin");
    const consoleProbePath = path.join(statusRoot, statusSlot, "sandbox-0000000001.bin");
    const readStatus = async (relative: string, limit: number) => {
      const bytes = await statusFiles.read(relative);
      if (bytes !== null && bytes.length > limit)
        fail("the native session status exceeded its limit");
      return bytes?.toString("utf8") ?? null;
    };
    fs.writeFileSync(workload, interactiveWorkloadSource(), "utf8");
    if (dashboard)
      fs.copyFileSync(
        requiredFile(
          path.join(installRoot, "qualification", "native-ui-tunnel.mts"),
          "native UI tunnel",
        ),
        path.join(runtimeRoot, "native-ui-tunnel.mts"),
      );
    webSession?.assertRunning();
    webSession?.progress("sandbox");
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
      { env: gatewayEnvironment, stdio: dashboard ? "ignore" : "inherit", windowsHide: dashboard },
    );
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
      );
      await run(
        openshell,
        ["gateway", "select", gatewayName],
        cliEnvironment,
        "Selecting the native gateway",
      );
      const environment = {
        HOME: agentRuntimeRoot,
        LOCALAPPDATA: agentRuntimeRoot,
        NEMOCLAW_AGENT_HOME: agentRuntimeRoot,
        NEMOCLAW_AGENT_ID: agentId,
        ...(dashboard
          ? {
              NEMOCLAW_AGENT_INTERFACE: "dashboard",
              NEMOCLAW_AGENT_SESSION_ID: runId,
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
            command: [node, workload],
            cwd: agentRuntimeRoot,
            host_loopback: true,
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
      await run(openshell, createArgs, cliEnvironment, "Creating the native console workload");
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
          await Promise.race([
            relay.ready,
            relay.failure,
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
          if (webSession) webSession.ready(url);
          else
            webSession = await openNativeWebSession(installRoot, "hermes", url, {
              qualification: dashboardQualification,
            });
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
            agentExit.then(() => {
              throw new Error("The Hermes dashboard stopped unexpectedly.");
            }),
          ]);
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
      } else exitCode = await agentExit;
      if (exitCode !== 0) fail(`${adapter.displayName} exited with status ${exitCode}`);
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
    } finally {
      if (!passed) {
        try {
          await run(
            openshell,
            ["sandbox", "delete", sandboxName],
            cliEnvironment,
            "Failure cleanup native sandbox",
            30_000,
          );
        } catch {}
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
  } finally {
    const cleanupFailures: string[] = [];
    const attempt = async (label: string, operation: () => Promise<unknown> | unknown) => {
      try {
        await operation();
      } catch {
        cleanupFailures.push(label);
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
    await attempt("inference broker shutdown", async () => {
      if (!broker) return;
      const closed = new Promise<void>((resolve) => broker.server.close(() => resolve()));
      broker.server.closeAllConnections();
      await closed;
    });
    let rootsRemoved = true;
    for (const directory of [runRoot, runtimeRoot, dashboardRelayRoot, statusRoot]) {
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
    await attempt("native session window shutdown", async () => {
      if (webSession)
        await webSession.complete(sessionPassed && cleanupFailures.length === 0 && released);
    });
    if (cleanupFailures.length)
      fail(`native session cleanup failed: ${cleanupFailures.join(", ")}`);
  }
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
