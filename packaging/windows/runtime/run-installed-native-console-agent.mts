// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath as nativeEntryFile } from "node:url";
declare const NEMOCLAW_BUNDLED_RUNTIME: boolean | undefined;
import { nativeWorkerAssets } from "./native-assets.mts";
import { NativeGatewaySession } from "./native-gateway-session.mts";
import {
  openNativeConsoleAttachment,
  reconcileNativeConsoleExit,
} from "./native-console-attachment.mts";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  withNativeRuntimeSession,
  bindNativeRuntimeGuard,
  nativeHermesToolEnvironment,
  nativeHermesCompatibility,
  nativeRuntimeWorkerCommand,
  type NativeRuntimeSession,
} from "./native-runtime.mts";
import { hermesDashboardPythonSource } from "./native-hermes-dashboard.mts";
import { hermesInferencePipePythonSource } from "./native-hermes-inference-pipe.mts";
import { hermesPipeLoopPythonSource } from "./native-hermes-pipe-loop.mts";
import { openNativeUiFileOwner } from "./native-ui-file-owner.mts";
import { startFileTcpRelay } from "./native-ui-relay.mts";
import { openNativeWebSession } from "./native-web-session.mts";
import {
  confirmNativeUiRegistryEmpty,
  requestNativeUiSandboxDeletion,
  waitForNativeMxcCompletion,
} from "./native-ui-lifecycle.mts";
import {
  createNativeSessionDiagnostics,
  NativeSessionFailure,
} from "./native-session-diagnostics.mts";

import { nativeHermesConfiguration, readNativeServiceEnvironment } from "./native-options.mts";
import { startNativeInferenceBroker } from "./native-inference-broker.mts";
import { startNativeBrokerRelay } from "./native-broker-relay.mts";
import { startNativeEdgeBrowser, type NativeEdgeBrowserOwner } from "./native-edge-browser.mts";
import { acquireNativeStateSession } from "./native-state.mts";

import { resolveNativeConfiguredInference } from "./native-configured-inference.mts";
import { readNativeAgentConfiguration } from "./native-setup-configuration.mts";
import type { NativeInferenceProgress } from "./native-inference-manifest.mts";

import { NATIVE_NODE_UI_POLICY, writeNativeGatewayConfig } from "./native-security.mts";

import {
  allowlistedWindowsEnvironment,
  argumentValue,
  freePort,
  quoteYamlPath,
  removeDirectory,
  requiredDirectory,
  requiredFile,
  run,
  waitForPort,
} from "./run-installed-native-turn.mts";

const AGENT_ADAPTERS = {
  hermes: { displayName: "Hermes Agent", runtimeDirectory: "hermes", sandboxPrefix: "nc-h" },
};

function fail(message) {
  throw new Error(`NemoClaw native terminal launch failed: ${message}`);
}

export async function waitForConsoleAgentExit(
  openshell,
  environment,
  sandboxName,
  gateway,
  readExitReceipt,
  agentId,
  stateSession,
  signal: AbortSignal | undefined,
  ownProcess: (child: ChildProcess) => void,
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
        undefined,
        ownProcess,
        signal,
      );
      if (
        (completion === "ExecFailed" || completion === "MainProcessFailed") &&
        receipt.exitCode === 0
      )
        fail("MXC failed after the agent reported its exit status");
      return receipt.exitCode;
    }
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      fail("the native gateway stopped before the agent published its exit status");
    if (Date.now() >= nextStatusCheck) {
      let status;
      try {
        const result = await run(
          openshell,
          ["sandbox", "get", sandboxName, "-o", "json"],
          environment,
          "Reading the native agent status",
          10_000,
          undefined,
          ownProcess,
          { signal, quiet: true },
        );
        status = JSON.parse(result.stdout);
      } catch {
        fail("the native agent's running state could not be confirmed");
      }
      if (status?.name !== sandboxName || typeof status?.phase !== "string")
        fail("the native agent status did not match its sandbox");
      if (["Completed", "Error", "Stopped", "Stopping", "Deleting"].includes(status.phase))
        fail("the contained agent stopped before it published an exit receipt");
      nextStatusCheck = Date.now() + 5000;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("the interactive agent exceeded its session deadline");
}

export function nativeHermesMessagingArguments(channels: string[]): string[] {
  const modules: Record<string, string[]> = {
    telegram: ["telegram.ext", "telegram.request"],
    discord: ["discord.ext.commands"],
    slack: [
      "slack_bolt.async_app",
      "slack_bolt.adapter.socket_mode.async_handler",
      "slack_sdk.web.async_client",
    ],
  };
  if (!channels.length || channels.some((channel) => !Object.hasOwn(modules, channel)))
    throw new Error("The selected Hermes messaging service is unsupported.");
  return [
    "-c",
    [
      "import importlib, runpy, sys",
      "try:",
      `    for name in ${JSON.stringify([...new Set(channels.flatMap((channel) => modules[channel]))])}:`,
      "        importlib.import_module(name)",
      "except (ImportError, OSError):",
      "    sys.exit(78)",
      "runpy.run_module('gateway.run', run_name='__main__', alter_sys=True)",
    ].join("\n"),
  ];
}

export function interactiveWorkloadSource() {
  return String.raw`import { spawn } from "node:child_process";
import { requestNativeBrokerBootstrap } from "./native-local-pipe.mts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const nativeHermesConfiguration = ${nativeHermesConfiguration.toString()};
const nativeHermesMessagingArguments = ${nativeHermesMessagingArguments.toString()};

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
const hermesSource = process.env.NEMOCLAW_HERMES_SOURCE_ROOT;
const dashboard = process.env.NEMOCLAW_AGENT_INTERFACE === "dashboard";
const inferencePipePort = Number(required("NEMOCLAW_HERMES_INFERENCE_PIPE_PORT"));
let brokerTunnel;
let browserTunnel;
let bootstrapWritten = false;
const connectivity = {
  schemaVersion: 1, agent, interface: dashboard ? "dashboard" : "console",
  sessionId, transport: "guarded-file-native-pipe",
  brokerHost: "127.0.0.1", brokerPort: hostBrokerPort,
  containedPipePort: null,
  contained: { pipeConnected: false, unauthenticatedStatus: null, authenticatedStatus: null, bootstrapConsumedByWorkload: false },
  verdict: "fail", failureStage: "bridge", errorCode: null,
};
const stopWatcher = watchNativeStopRequest(stopRequest, sessionId);
try {
const { startNativeBrokerTunnel } = await import("./native-broker-tunnel.mts");
brokerTunnel = await startNativeBrokerTunnel({
  relayRoot: required("NEMOCLAW_BROKER_RELAY_ROOT"), relayToken: required("NEMOCLAW_BROKER_RELAY_TOKEN"),
  sandboxPipePort: inferencePipePort,
  signal: stopWatcher.signal,
});
if (agent === "hermes") {
  browserTunnel = await startNativeBrokerTunnel({
    relayRoot: required("NEMOCLAW_BROWSER_RELAY_ROOT"),
    relayToken: required("NEMOCLAW_BROWSER_RELAY_TOKEN"),
    sandboxPipePort: Number(required("NEMOCLAW_HERMES_BROWSER_PIPE_PORT")),
    signal: stopWatcher.signal,
  });
  const cdpPath = required("NEMOCLAW_BROWSER_CDP_PATH");
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/u.test(cdpPath))
    throw new Error("The native Microsoft Edge CDP path is invalid.");
  process.env.BROWSER_CDP_URL = "ws://127.0.0.1:" + browserTunnel.port + cdpPath;
  process.env.BU_CDP_WS = process.env.BROWSER_CDP_URL;
}
const proxyPort = String(brokerTunnel.port);
connectivity.containedPipePort = brokerTunnel.port;
const baseUrl = "http://127.0.0.1:" + proxyPort + "/v1";
connectivity.failureStage = "unauthenticated-http";
const denied = await requestNativeBrokerBootstrap(brokerTunnel.port, null, stopWatcher.signal);
connectivity.contained.pipeConnected = true;
connectivity.contained.unauthenticatedStatus = denied.status;
if (denied.status !== 403) throw new Error("The local broker did not reject an unauthenticated bootstrap probe.");
connectivity.failureStage = "authenticated-bootstrap";
const bootstrapResponse = await requestNativeBrokerBootstrap(brokerTunnel.port, brokerToken, stopWatcher.signal);
connectivity.contained.authenticatedStatus = bootstrapResponse.status;
if (bootstrapResponse.status !== 200) throw new Error("NemoClaw could not supply the selected optional services.");
connectivity.failureStage = "bootstrap-json";
const nativeServices = bootstrapResponse.body;
connectivity.contained.bootstrapConsumedByWorkload = true;
connectivity.verdict = "pass";
connectivity.failureStage = null;
writeFileSync(bootstrapReceipt, JSON.stringify(connectivity) + "\n", "utf8");
bootstrapWritten = true;
Object.assign(process.env, nativeServices.environment);
for (const [channel, settings] of Object.entries(nativeServices.options.messaging || {})) {
  process.env[channel.toUpperCase() + "_ALLOWED_USERS"] = settings.allowedUsers.join(",");
}

mkdirSync(home, { recursive: true });
let executable;
let args;
let extraEnvironment = {};

if (agent === "hermes") {
  if (!python || !hermesSource) throw new Error("Hermes Python runtime is incomplete");
  const hermesHome = join(home, ".hermes");
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(join(hermesHome, "config.yaml"), nativeHermesConfiguration(model, baseUrl, brokerToken, nativeServices.options), "utf8");
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
    "from hermes_cli import __version__ as _hermes_version",
    "if _hermes_version != '0.21.1': raise RuntimeError('The official Hermes runtime version does not match its installation')",
    ...${JSON.stringify(hermesPipeLoopPythonSource())},
    ...${JSON.stringify(hermesInferencePipePythonSource())},
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
  extraEnvironment = { HERMES_HOME: hermesHome, HERMES_TUI_DIR: process.env.NEMOCLAW_HERMES_TUI_DIR, HERMES_NODE: required("HERMES_NODE"), HERMES_PYTHON: python, PYTHONPATH: required("NEMOCLAW_WORKER_ROOT"), HERMES_SKIP_NODE_BOOTSTRAP: "1", HERMES_DISABLE_LAZY_INSTALLS: "1", ...(dashboard ? {
    // Hermes's optional atomic file publication conflicts with the held state
    // directory guard. Its normal stdout contract reports the live bound port.
    HERMES_DESKTOP_READY_FILE: "",
    HERMES_DASHBOARD_SESSION_TOKEN: process.env.NEMOCLAW_UI_SESSION_TOKEN,
  } : {}) };
} else {
  throw new Error("unsupported native terminal agent " + agent);
}

const childEnvironment = {
  ...process.env, ...extraEnvironment, HOME: home, LOCALAPPDATA: home,
  NODE_DISABLE_COMPILE_CACHE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", USERPROFILE: home,
};
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const observe = (process) => new Promise((resolve) => {
  let failed = false;
  process.on("error", () => { failed = true; });
  process.once("close", (code) => resolve(failed ? 1 : code ?? 1));
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
async function waitForOwnedNativeAgent(childStopped, timeoutMilliseconds) {
  let timer;
  try {
    return await Promise.race([
      childStopped.then((exitCode) => ({ closed: true, exitCode })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ closed: false, exitCode: null }), timeoutMilliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function stopOwnedNativeAgent(child, childStopped, timeoutMilliseconds = 10000) {
  if (!child) return true;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch { /* Closure must still be confirmed after a failed kill. */ }
  }
  const stopped = await waitForOwnedNativeAgent(childStopped, timeoutMilliseconds);
  if (!stopped.closed) {
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
  return stopped.closed;
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
    messaging = spawn(python, nativeHermesMessagingArguments(selectedChannels), {
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
    if (!connected) {
      if (messaging.exitCode === 78)
        throw new Error("This Hermes installation could not load the selected messaging components. Repair Hermes in NemoClaw Setup before reconnecting.");
      throw new Error("A selected messaging service could not connect. Check its bot key, app permissions, and network in NemoClaw Setup.");
    }
    console.log("Messaging connected: " + selectedChannels.join(", ") + ".");
  }
  stopWatcher.signal.throwIfAborted();
  child = spawn(executable, args, { cwd: home, env: childEnvironment, stdio: dashboard ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: dashboard });
  childStopped = observe(child);
  const childExit = Promise.race([
    childStopped,
    brokerTunnel.failure,
    ...(browserTunnel ? [browserTunnel.failure] : []),
    stopWatcher.requested,
  ]);
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
    if (port !== Number(required("NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT")))
      throw new Error("The Hermes dashboard announced an undeclared pipe.");
    if (processId !== child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error("The Hermes dashboard process stopped during readiness.");
    const { startNativeUiTunnel } = await import("./native-ui-tunnel.mts");
    await Promise.race([
      startNativeUiTunnel({ relayRoot: required("NEMOCLAW_UI_RELAY_ROOT"), relayToken: required("NEMOCLAW_UI_RELAY_TOKEN"), uiPort: port, pipe: true, signal: stopWatcher.signal }),
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
  if (messaging) {
    if (messaging.exitCode === null && messaging.signalCode === null) {
      try {
        const stop = spawn(python, ["-c", "import sys; from gateway.status import get_running_pid, write_planned_stop_marker; pid=int(sys.argv[1]); sys.exit(0 if get_running_pid()==pid and write_planned_stop_marker(pid) else 1)", String(messaging.pid)], {
          cwd: home, env: childEnvironment, stdio: "ignore", windowsHide: true,
        });
        const stopClosed = observe(stop);
        const marker = await waitForOwnedNativeAgent(stopClosed, 10000);
        if (!marker.closed || marker.exitCode !== 0) messagingFailure = true;
        if (!marker.closed && !(await stopOwnedNativeAgent(stop, stopClosed))) {
          console.error("The owned messaging stop helper did not close within its cleanup deadline.");
        }
      } catch {
        messagingFailure = true;
      }
    }
    const gateway = await waitForOwnedNativeAgent(messagingExit, 30000);
    if (!gateway.closed || gateway.exitCode !== 0) messagingFailure = true;
    if (!gateway.closed && !(await stopOwnedNativeAgent(messaging, messagingExit))) {
      console.error("The owned messaging gateway did not close within its cleanup deadline.");
    }
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
  await browserTunnel?.close();
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
  runtimeLease: NativeRuntimeSession,
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
  const binRoot = requiredDirectory(path.join(installRoot, "bin"), "NemoClaw bin directory");
  const launcher = requiredFile(path.join(binRoot, "NemoClaw.exe"), "NemoClaw launcher");
  const installedNode = requiredFile(runtimeLease.node, "sealed Node.js runtime");
  const openshell = requiredFile(path.join(binRoot, "openshell.exe"), "OpenShell CLI");
  const gatewayExecutable = requiredFile(
    path.join(binRoot, "openshell-gateway.exe"),
    "OpenShell gateway",
  );
  const installedRuntime = requiredDirectory(
    runtimeLease.agentRoot,
    `${adapter.displayName} sealed runtime`,
  );
  const _installedPython =
    runtimeLease.python === null
      ? null
      : requiredDirectory(path.dirname(runtimeLease.python), "sealed Python directory");
  const hermesTools =
    agentId === "hermes"
      ? nativeHermesToolEnvironment(
          runtimeLease,
          requiredDirectory(process.env.SystemRoot ?? "", "Windows system root"),
        )
      : null;
  const hermesCompatibility = agentId === "hermes" ? nativeHermesCompatibility(runtimeLease) : null;
  if (hermesTools) {
    for (const [tool, executable] of Object.entries({
      Python: hermesTools.python,
      Bash: hermesTools.bash,
      Node: hermesTools.node,
      ripgrep: hermesTools.ripgrep,
      compatibilityLauncher: hermesCompatibility!.launcher,
      compatibilityArm64Dll: hermesCompatibility!.arm64Dll,
      compatibilityX64Dll: hermesCompatibility!.x64Dll,
      compatibilityExecutor: hermesCompatibility!.executor,
    }))
      requiredFile(executable, `sealed Hermes ${tool}`);
  }
  requiredFile(path.join(installRoot, "config", "mxc-gateway.toml"), "MXC gateway configuration");
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");
  const stateSession = bindNativeRuntimeGuard(
    await acquireNativeStateSession(launcher, agentId),
    runtimeLease,
  );
  const agentRuntimeRoot = stateSession.stateRoot;
  let broker;
  let brokerRelay: Awaited<ReturnType<typeof startNativeBrokerRelay>> | undefined;
  let browserRelay: Awaited<ReturnType<typeof startNativeBrokerRelay>> | undefined;
  let edge: Awaited<ReturnType<typeof startNativeEdgeBrowser>> | undefined;
  let edgeOwner: NativeEdgeBrowserOwner | undefined;
  let brokerRelayRoot: string | undefined;
  let browserRelayRoot: string | undefined;
  let runRoot;
  let runtimeRoot;
  let relay;
  let webSession = options.webSession;
  let sessionPassed = false;
  let consoleSessionEnded = false;
  let dashboardRelayRoot;
  let statusRoot;
  let statusFiles;
  let dashboardGatewayStopped = false;
  let gatewaySession: NativeGatewaySession | undefined;
  let consoleAttachment: ReturnType<typeof openNativeConsoleAttachment> | undefined;
  try {
    stateSession.assertHeld();
    const { config: storedConfig } = readNativeAgentConfiguration(agentId);
    webSession?.assertRunning();
    webSession?.progress("inference");
    diagnostics.stage("inference");
    const { configuration: config, credential } = await resolveNativeConfiguredInference(
      installRoot,
      launcher,
      storedConfig,
      {
        signal: webSession?.signal,
        ...(webSession
          ? {
              onProgress: (event: NativeInferenceProgress) =>
                webSession?.progress(
                  "inference",
                  typeof event.completedBytes === "number" && typeof event.totalBytes === "number"
                    ? { completed: event.completedBytes, total: event.totalBytes, unit: "bytes" }
                    : undefined,
                ),
            }
          : {}),
      },
    );
    stateSession.assertHeld();
    webSession?.assertRunning();
    webSession?.progress("runtime");
    diagnostics.secret(credential);
    diagnostics.stage("runtime");
    const brokerToken = randomBytes(32).toString("base64url");
    diagnostics.secret(brokerToken);
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
    // Identifiers in the sandbox's LOCAL pipe namespace, not bound TCP ports.
    const inferencePipePort = randomInt(20000, 60000);
    const browserPipePort = inferencePipePort + 1;
    const dashboardPipePort = inferencePipePort + 2;
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
    let browserRelayToken: string | undefined;
    if (agentId === "hermes") {
      diagnostics.stage("browser");
      edge = await startNativeEdgeBrowser({
        profileRoot: path.join(runRoot, "edge-profile"),
        environment: process.env,
        signal: webSession?.signal,
        onOwner: (owner) => {
          edgeOwner = owner;
        },
      });
      diagnostics.capture(
        "edge.identity",
        JSON.stringify({
          ...edge.identity,
          process: edge.process,
          profile: "session-owned",
          endpoint: { host: "127.0.0.1", port: edge.endpoint.port },
          authenticatedRelay: true,
          agent: agentId,
          sessionId: runId,
        }) + "\n",
      );
      browserRelayToken = randomBytes(32).toString("base64url");
      diagnostics.secret(browserRelayToken);
      browserRelayRoot = path.join(agentRuntimeRoot, `browser-relay-${runId}`);
      browserRelay = await startNativeBrokerRelay({
        relayRoot: browserRelayRoot,
        relayToken: browserRelayToken,
        brokerPort: edge.endpoint.port,
        launcher,
        signal: webSession?.signal,
      });
      void browserRelay.failure.catch(() => {});
      void edge.failure.catch(() => {});
      for (const evidenceRoot of [consoleEvidenceRoot, dashboardEvidenceRoot]) {
        if (!evidenceRoot) continue;
        fs.writeFileSync(
          path.join(evidenceRoot, "edge-browser.json"),
          JSON.stringify({
            schemaVersion: 1,
            classification: "native-hermes-edge-browser",
            agent: agentId,
            sessionId: runId,
            identity: edge.identity,
            process: edge.process,
            endpoint: { host: "127.0.0.1", port: edge.endpoint.port, path: edge.endpoint.path },
            profileRoot: path.join(runRoot, "edge-profile"),
            relayRoot: browserRelayRoot,
            authenticatedRelay: true,
            generalHostProxy: false,
            inheritedKillOnCloseJob: edge.inheritedKillOnCloseJob,
          }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
      }
      diagnostics.stage("runtime");
    }
    gatewaySession = new NativeGatewaySession(installRoot, runRoot);
    const gatewayConfig = await writeNativeGatewayConfig(
      installRoot,
      runRoot,
      agentId === "hermes" ? runtimeLease : undefined,
      { network: { kind: "supervised" }, hostConsole: false },
      gatewaySession,
    );
    runtimeLease.assertHeld();
    const node = installedNode;
    const runtime = installedRuntime;
    diagnostics.stage("runtime");
    const worker = nativeWorkerAssets(runtimeLease.runtimeRoot, "interactive");
    const workload = requiredFile(worker.entry, "prebuilt interactive agent worker");
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
    webSession?.assertRunning();
    webSession?.progress("gateway");
    const policyPath = path.join(runRoot, "policy.yaml");
    fs.writeFileSync(
      policyPath,
      [
        "version: 1",
        "",
        ...NATIVE_NODE_UI_POLICY,
        "filesystem_policy:",
        "  include_workdir: false",
        "  read_only:",
        `    - ${quoteYamlPath(runtimeRoot)}`,
        ...runtimeLease.readOnlyRoots.map((root) => `    - ${quoteYamlPath(root)}`),
        "  read_write:",
        `    - ${quoteYamlPath(agentRuntimeRoot)}`,
        `    - ${quoteYamlPath(statusRoot)}`,
        `    - ${quoteYamlPath(brokerRelayRoot)}`,
        ...(browserRelayRoot ? [`    - ${quoteYamlPath(browserRelayRoot)}`] : []),
        ...(dashboard ? [`    - ${quoteYamlPath(relayRoot)}`] : []),
        "",
      ].join("\n"),
      "utf8",
    );
    const temp = path.join(agentRuntimeRoot, "temp");
    fs.mkdirSync(temp, { recursive: true });
    const gatewayPort = await freePort();
    const sandboxName = `${adapter.sandboxPrefix}-${runId}`;
    const gatewayName = `nemoclaw-${agentId}-${runId}`;
    stateSession.assertHeld();
    await gatewaySession.prepare();
    const gatewayEnvironment = allowlistedWindowsEnvironment({
      ...(agentId === "hermes"
        ? { NEMOCLAW_MSYS_TOKEN_INSPECTION: "hermes-query", NEMOCLAW_HERMES_PRIVATE_DESKTOP: "1" }
        : {}),
      OPENSHELL_DRIVERS: "mxc",
      OPENSHELL_GATEWAY_CONFIG: gatewayConfig,
      ...gatewaySession.environment,
    });
    diagnostics.stage("gateway");
    const gateway = gatewaySession.spawnGateway(
      gatewayExecutable,
      [
        "--port",
        String(gatewayPort),
        "--enable-mtls-auth",
        "true",
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
    let cliEnvironment = allowlistedWindowsEnvironment({
      ...gatewayEnvironment,
      ...(agentId === "hermes"
        ? { NEMOCLAW_MSYS_TOKEN_INSPECTION: undefined, NEMOCLAW_HERMES_PRIVATE_DESKTOP: undefined }
        : {}),
    });
    let passed = false;
    try {
      console.log("Starting the native OpenShell MXC boundary…");
      await waitForPort(gatewayPort, gateway);
      cliEnvironment = allowlistedWindowsEnvironment({
        ...gatewayEnvironment,
        OPENSHELL_GATEWAY: undefined,
        ...(agentId === "hermes"
          ? {
              NEMOCLAW_MSYS_TOKEN_INSPECTION: undefined,
              NEMOCLAW_HERMES_PRIVATE_DESKTOP: undefined,
            }
          : {}),
      });
      await run(
        openshell,
        ["gateway", "add", `https://127.0.0.1:${gatewayPort}`, "--local", "--name", gatewayName],
        cliEnvironment,
        "Registering the native gateway",
        undefined,
        diagnostics,
        gatewaySession.ownCommandProcess,
      );
      await run(
        openshell,
        ["gateway", "select", gatewayName],
        cliEnvironment,
        "Selecting the native gateway",
        undefined,
        diagnostics,
        gatewaySession.ownCommandProcess,
      );
      const environment = {
        ...worker.environment,
        HOME: agentRuntimeRoot,
        LOCALAPPDATA: agentRuntimeRoot,
        NEMOCLAW_AGENT_HOME: agentRuntimeRoot,
        ...(agentId === "hermes"
          ? { NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD: "hermes-query", NEMOCLAW_MSYS_DIAGNOSTICS: "0" }
          : {}),
        NEMOCLAW_AGENT_ID: agentId,
        NEMOCLAW_AGENT_SESSION_ID: runId,
        NEMOCLAW_HERMES_INFERENCE_PIPE_PORT: String(inferencePipePort),
        NEMOCLAW_AGENT_BOOTSTRAP_RECEIPT: bootstrapPath,
        NEMOCLAW_AGENT_STOP_REQUEST: path.join(statusRoot, "shutdown"),
        NEMOCLAW_BROKER_RELAY_ROOT: brokerRelayRoot,
        NEMOCLAW_BROKER_RELAY_TOKEN: brokerRelayToken,
        ...(edge && browserRelayRoot && browserRelayToken
          ? {
              NEMOCLAW_BROWSER_RELAY_ROOT: browserRelayRoot,
              NEMOCLAW_BROWSER_RELAY_TOKEN: browserRelayToken,
              NEMOCLAW_BROWSER_CDP_PATH: edge.endpoint.path,
              NEMOCLAW_HERMES_BROWSER_PIPE_PORT: String(browserPipePort),
            }
          : {}),
        ...(dashboard
          ? {
              NEMOCLAW_AGENT_INTERFACE: "dashboard",
              NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT: String(dashboardPipePort),
              NEMOCLAW_UI_RELAY_ROOT: relayRoot,
              NEMOCLAW_UI_RELAY_TOKEN: relayToken,
              NEMOCLAW_UI_SESSION_TOKEN: randomBytes(32).toString("base64url"),
            }
          : {}),
        NEMOCLAW_AGENT_BROKER_TOKEN: brokerToken,
        NEMOCLAW_AGENT_EXIT_RECEIPT: exitReceipt,
        ...(consoleQualification && agentId === "hermes"
          ? { NEMOCLAW_AGENT_CONSOLE_PROBE: consoleProbePath }
          : {}),
        NEMOCLAW_AGENT_MODEL: config.model,
        NEMOCLAW_AGENT_NODE: node,
        NEMOCLAW_AGENT_PROXY_PORT: String(broker.port),
        NEMOCLAW_AGENT_PYTHON: runtimeLease.python ?? "",
        NEMOCLAW_AGENT_RUNTIME: runtime,
        NEMOCLAW_HERMES_SOURCE_ROOT: agentId === "hermes" ? path.join(runtime, "hermes-agent") : "",
        NEMOCLAW_HERMES_TUI_DIR:
          agentId === "hermes" ? path.join(runtime, "hermes-agent", "ui-tui") : "",
        NODE_DISABLE_COMPILE_CACHE: "1",
        NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS ?? "1",
        OS: "Windows_NT",
        ...(hermesTools
          ? hermesTools.environment
          : {
              PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
            }),
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
      const workloadCommand = nativeRuntimeWorkerCommand(runtimeLease, workload);
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
            command: workloadCommand,
            cwd: agentRuntimeRoot,
            loopback_pipe_ports: [
              inferencePipePort,
              browserPipePort,
              ...(dashboard ? [dashboardPipePort] : []),
            ],
          },
        }),
        "--detach",
        dashboard ? "--no-tty" : "--tty",
      ];
      for (const [name, value] of Object.entries(environment))
        createArgs.push("--env", `${name}=${value}`);
      createArgs.push("--", ...workloadCommand);
      console.log(`Opening the authentic ${adapter.displayName} terminal inside native MXC…\n`);
      if (consoleEvidenceRoot !== null) {
        fs.writeFileSync(
          path.join(consoleEvidenceRoot, "interactive-session-start.json"),
          JSON.stringify({
            schemaVersion: 1,
            agent: agentId,
            nodeProcessId: process.pid,
            gatewayProcessId: gatewaySession.gatewayProcessId,
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
              result.transport !== "guarded-file-native-pipe" ||
              result.brokerHost !== "127.0.0.1" ||
              result.brokerPort !== broker.port ||
              (result.containedPipePort !== null &&
                result.containedPipePort !== inferencePipePort) ||
              !["pass", "fail"].includes(result.verdict) ||
              !result.contained ||
              typeof result.contained.pipeConnected !== "boolean" ||
              ![
                "bridge",
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
              result.contained.pipeConnected &&
              validPort(result.containedPipePort) &&
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
              transport: "guarded-file-native-pipe",
              brokerHost: "127.0.0.1",
              brokerPort: broker.port,
              containedPipePort: result.containedPipePort,
              hostListener: { httpStatus: hostProbe.status },
              contained: {
                pipeConnected: result.contained.pipeConnected,
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
          gatewaySession.ownCommandProcess,
        );
      } catch (error) {
        const bootstrap = await publishBootstrap(false);
        if (bootstrap?.verdict === "pass") diagnostics.stage(dashboard ? "dashboard" : "agent");
        throw error;
      }
      diagnostics.stage("bootstrap");
      webSession?.progress("bootstrap");
      if (!dashboard) {
        stateSession.assertHeld();
        consoleAttachment = openNativeConsoleAttachment(openshell, sandboxName, cliEnvironment);
      }
      const bootstrapMonitoring = new AbortController();
      const bootstrapResult = publishBootstrap(true, bootstrapMonitoring.signal);
      try {
        await Promise.race([
          bootstrapResult,
          brokerRelay.failure,
          ...(browserRelay ? [browserRelay.failure] : []),
          ...(edge ? [edge.failure] : []),
          ...(consoleAttachment
            ? [
                consoleAttachment.exited.then(() => {
                  throw new Error("The native terminal closed before bootstrap finished.");
                }),
              ]
            : []),
        ]);
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
        gatewaySession.ownCommandProcess,
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
            ...(browserRelay ? [browserRelay.failure] : []),
            ...(edge ? [edge.failure] : []),
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
                sessionId: runId,
                url,
                nodeProcessId: process.pid,
                gatewayProcessId: gatewaySession.gatewayProcessId,
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
            ...(browserRelay ? [browserRelay.failure] : []),
            ...(edge ? [edge.failure] : []),
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
        try {
          if (!consoleAttachment) fail("the native terminal attachment is missing");
          exitCode = await Promise.race([
            reconcileNativeConsoleExit(consoleAttachment.exited, agentExit),
            brokerRelay.failure,
            ...(browserRelay ? [browserRelay.failure] : []),
            ...(edge ? [edge.failure] : []),
          ]);
        } finally {
          monitoring.abort();
          await agentExit.catch(() => {});
        }
      }
      if (exitCode !== 0) fail(`${adapter.displayName} exited with status ${exitCode}`);
      diagnostics.stage("cleanup");
      await run(
        openshell,
        ["sandbox", "delete", sandboxName],
        cliEnvironment,
        "Deleting the native agent sandbox",
        undefined,
        undefined,
        gatewaySession.ownCommandProcess,
      );
      await confirmNativeUiRegistryEmpty(
        openshell,
        cliEnvironment,
        {
          sandboxName,
          gateway,
          stateSession,
        },
        gatewaySession.ownCommandProcess,
      );
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
        await cleanup("browser relay stop signal", async () => {
          if (browserRelay) await browserRelay.close();
        });
        await cleanup("native sandbox deletion", () =>
          requestNativeUiSandboxDeletion(
            openshell,
            cliEnvironment,
            {
              sandboxName,
              gateway,
              stateSession,
            },
            gatewaySession.ownCommandProcess,
          ),
        );
        await cleanup("native sandbox registry", () =>
          confirmNativeUiRegistryEmpty(
            openshell,
            cliEnvironment,
            {
              sandboxName,
              gateway,
              stateSession,
            },
            gatewaySession.ownCommandProcess,
          ),
        );
      }
      const gatewayStopped = await gatewaySession.stopGateway();
      dashboardGatewayStopped = gatewayStopped;
      if (!gatewayStopped) {
        sessionPassed = false;
        fail("the native gateway could not be stopped");
      }
      await consoleAttachment?.dispose();
      await gatewaySession.dispose();
      if (relay) await relay.close();
      if (relay) await relay.dispose();
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
        consoleSessionEnded = true;
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
    await attempt("browser transport shutdown", async () => {
      if (browserRelay) await browserRelay.dispose();
    });
    await attempt("Microsoft Edge shutdown", async () => {
      if (edgeOwner) await edgeOwner.close();
    });
    await attempt("inference broker shutdown", async () => {
      if (!broker) return;
      const closed = new Promise<void>((resolve) => broker.server.close(() => resolve()));
      broker.server.closeAllConnections();
      await closed;
    });
    let rootsRemoved = true;
    await attempt("private gateway cleanup", async () => {
      if (consoleAttachment) {
        if (!(await gatewaySession?.stopGateway()))
          throw new Error("The private gateway did not stop before terminal cleanup.");
        await consoleAttachment.dispose();
      }
      await gatewaySession?.dispose();
    });
    const runtimeOwnersStopped = cleanupFailures.length === 0;
    for (const directory of [
      runRoot,
      runtimeRoot,
      dashboardRelayRoot,
      statusRoot,
      brokerRelayRoot,
      browserRelayRoot,
    ]) {
      await attempt("temporary runtime removal", async () => {
        if (directory && !runtimeOwnersStopped) {
          rootsRemoved = false;
          throw new Error(
            "Temporary native runtime files were retained because owner cleanup is unconfirmed.",
          );
        }
        if (directory && !(await removeDirectory(directory))) {
          rootsRemoved = false;
          throw new Error("Temporary native runtime files could not be removed.");
        }
      });
    }
    await attempt("interactive session cleanup receipt", () => {
      if (!consoleSessionEnded || !consoleEvidenceRoot) return;
      fs.writeFileSync(
        path.join(consoleEvidenceRoot, "interactive-session-end.json"),
        JSON.stringify({
          schemaVersion: 1,
          agent: agentId,
          sandboxDeleted: sessionPassed,
          gatewayStopped: dashboardGatewayStopped,
          ephemeralRootsRemoved:
            runtimeOwnersStopped &&
            rootsRemoved &&
            (!gatewaySession || !fs.existsSync(gatewaySession.root)) &&
            [
              runRoot,
              runtimeRoot,
              dashboardRelayRoot,
              statusRoot,
              brokerRelayRoot,
              browserRelayRoot,
            ].every((root) => !root || !fs.existsSync(root)),
          persistentStateRetained: fs.existsSync(agentRuntimeRoot),
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    });
    let released = false;
    await attempt("private state release", async () => {
      await stateSession.release();
      released = true;
    });
    await attempt("qualification cleanup receipt", () => {
      for (const [directory, file, classification] of [
        [dashboardEvidenceRoot, "dashboard-end.json", "native-hermes-dashboard-qualification"],
        [consoleEvidenceRoot, "console-cleanup.json", "native-agent-console-qualification"],
      ]) {
        if (!directory) continue;
        fs.writeFileSync(
          path.join(directory, file!),
          JSON.stringify({
            schemaVersion: 1,
            classification,
            agent: agentId,
            runtimeIdentity: {
              runtimeId: runtimeLease.runtimeId,
              manifestSha256: runtimeLease.manifestSha256,
              sourceRevision: runtimeLease.sourceRevision,
            },
            runtimeCounterSource: "held-runtime-session",
            runtimeBytesCopied: runtimeLease.runtimeBytesCopied,
            runtimeFilesHashedAtLaunch: runtimeLease.runtimeFilesHashedAtLaunch,
            sandboxDeleted: sessionPassed,
            gatewayStopped: dashboardGatewayStopped,
            ephemeralRootsRemoved:
              rootsRemoved &&
              (!gatewaySession || !fs.existsSync(gatewaySession.root)) &&
              [runRoot, runtimeRoot, dashboardRelayRoot, statusRoot].every(
                (root) => !root || !fs.existsSync(root),
              ),
            stateRetained: fs.existsSync(agentRuntimeRoot),
            retainedPrivateGatewayRoot:
              gatewaySession && fs.existsSync(gatewaySession.root) ? gatewaySession.root : null,
            leaseReleased: released,
            cleanupSucceeded: cleanupFailures.length === 0,
          }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
      }
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
    await withNativeRuntimeSession(
      path.join(installRoot, "bin", "NemoClaw.exe"),
      installRoot,
      agent as NativeRuntimeSession["purpose"],
      (runtimeLease) => {
        const opened = options.webSession;
        const guarded = opened
          ? {
              ...opened,
              signal: AbortSignal.any([opened.signal, runtimeLease.signal]),
              assertRunning() {
                opened.assertRunning();
                runtimeLease.assertHeld();
              },
            }
          : undefined;
        return runNativeConsoleAgentInternal(
          { ...options, webSession: guarded },
          diagnostics,
          runtimeLease,
        );
      },
      () => diagnostics.cleanupFailed("immutable runtime lease"),
    );
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

export async function runNativeConsoleEntry() {
  await runNativeConsoleAgent().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "NemoClaw native terminal launch failed.",
    );
    console.error("Press Enter to close.");
    process.stdin.resume();
    process.stdin.once("data", () => process.stdin.pause());
    process.exitCode = 1;
  });
}

if (
  typeof NEMOCLAW_BUNDLED_RUNTIME === "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === nativeEntryFile(import.meta.url)
) {
  void runNativeConsoleEntry();
}
