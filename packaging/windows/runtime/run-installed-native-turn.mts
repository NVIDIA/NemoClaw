// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 300_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fail(message) {
  throw new Error(`Native Windows MXC turn qualification failed: ${message}`);
}

export function requiredFile(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile()) fail(`${label} is missing`);
  return resolved;
}

export function requiredDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) fail(`${label} is missing`);
  return resolved;
}

export function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

export function allowlistedWindowsEnvironment(extra = {}) {
  const allowedNames = new Set(
    [
      "ComSpec",
      "LOCALAPPDATA",
      "NUMBER_OF_PROCESSORS",
      "OS",
      "Path",
      "PATHEXT",
      "PROCESSOR_ARCHITECTURE",
      "PROCESSOR_ARCHITEW6432",
      "SystemDrive",
      "SystemRoot",
      "TEMP",
      "TMP",
      "windir",
    ].map((name) => name.toLowerCase()),
  );
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedNames.has(name.toLowerCase())) environment[name] = value;
  }
  return { ...environment, ...extra };
}

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a loopback port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

export async function waitForPort(port, child, label = "OpenShell gateway") {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`${label} exited before readiness`);
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await sleep(500);
  }
  fail(`${label} did not become ready`);
}

export async function run(file, args, environment, label, timeout = TIMEOUT_MS) {
  console.log(`NEMOCLAW> ${label}`);
  const child = spawn(file, args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out`));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 1024 * 1024) child.kill();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = { exitCode: code ?? 1, stdout, stderr };
      if (result.exitCode !== 0) {
        const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join(" | ").slice(0, 1000);
        reject(new Error(`${label} exited ${result.exitCode}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(result);
    });
  });
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  child.kill();
  return await Promise.race([exited, sleep(5000).then(() => false)]);
}

export async function removeDirectory(directory) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {}
    if (!fs.existsSync(directory)) return true;
    await sleep(1000);
  }
  return false;
}

export async function waitForFileText(file, expected, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(expected)) return true;
    await sleep(250);
  }
  return false;
}

export function jsonContainsExactValue(value, target) {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => jsonContainsExactValue(item, target));
  if (value !== null && typeof value === "object")
    return Object.values(value).some((item) => jsonContainsExactValue(item, target));
  return false;
}

export function quoteYamlPath(value) {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

export function sanitizedDiagnostic(text, replacements) {
  let sanitized = text.slice(-64 * 1024);
  for (const [value, replacement] of replacements) {
    if (value) sanitized = sanitized.replaceAll(value, replacement);
  }
  return sanitized
    .replaceAll(/C:\\Users\\[^\\\r\n]+/giu, "<user-profile>")
    .replaceAll(/[A-Za-z0-9_-]{32,}/gu, "<opaque>");
}

function probeSource() {
  return String.raw`import { Worker } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const launcher = required("NEMOCLAW_MXC_OPENCLAW_ENTRY");
const entry = join(dirname(launcher), "dist", "entry.js");
const home = required("NEMOCLAW_MXC_HOME");
const resultPath = required("NEMOCLAW_MXC_RESULT");
const mockPort = Number(required("NEMOCLAW_MXC_MOCK_PORT"));
const env = {
  ...process.env,
  HOME: home,
  NODE_DISABLE_COMPILE_CACHE: "1",
  OPENCLAW_HOME: home,
  OPENCLAW_NO_RESPAWN: "1",
  USERPROFILE: home,
};
const workerSource = [
  'const { workerData } = require("node:worker_threads");',
  'const { pathToFileURL } = require("node:url");',
  'process.argv = [process.execPath, workerData.entry, ...workerData.args];',
  'import(pathToFileURL(workerData.entry).href).catch((error) => {',
  '  console.error(error instanceof Error ? error.stack ?? error.message : String(error));',
  '  process.exit(1);',
  '});',
].join("\n");
const run = async (args, timeout = 210000) => {
  const worker = new Worker(workerSource, { eval: true, env, execArgv: [], resourceLimits: { stackSizeMb: 64 }, stderr: true, stdout: true, workerData: { args, entry } });
  let stdout = "";
  let stderr = "";
  worker.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  worker.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ exitCode: 1, stdout, stderr: stderr + "OpenClaw worker timed out" });
    }, timeout);
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr + (error instanceof Error ? error.message : String(error)) });
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
};
const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const mock = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "mock-chat", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const body = JSON.parse(await readBody(request));
  if (body?.model !== "mock-chat" || !Array.isArray(body?.messages)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected request" } }));
    return;
  }
  const id = "chatcmpl-nemoclaw-native";
  const created = Math.floor(Date.now() / 1000);
  if (body.stream === true) {
    response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" });
    for (const value of [
      { id, object: "chat.completion.chunk", created, model: "mock-chat", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "mock-chat", choices: [{ index: 0, delta: { content: "CHAT_OK" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "mock-chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) response.write("data: " + JSON.stringify(value) + "\n\n");
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "mock-chat",
    choices: [{ index: 0, message: { role: "assistant", content: "CHAT_OK" }, finish_reason: "stop" }],
  }));
});
await new Promise((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(mockPort, "127.0.0.1", resolve);
});
const configDirectory = join(home, ".openclaw");
mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, "openclaw.json"), JSON.stringify({
  models: { mode: "merge", providers: { mock: {
    baseUrl: "http://127.0.0.1:" + mockPort + "/v1",
    apiKey: "unused",
    api: "openai-completions",
    timeoutSeconds: 180,
    models: [{ id: "mock-chat", name: "mock/mock-chat", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
  } } },
  agents: { defaults: { model: { primary: "mock/mock-chat" }, timeoutSeconds: 180, skipBootstrap: true, thinkingDefault: "off" }, list: [{ id: "main", default: true }] },
}), "utf8");
const version = await run(["--version"], 30000);
const normalizedVersion = /\b2026\.7\.1\b/u.test(version.stdout) ? "2026.7.1" : version.stdout.trim();
const chat = await run(["agent", "--local", "--agent", "main", "--message", "Reply exactly: CHAT_OK", "--thinking", "off", "--timeout", "180", "--json"]);
let exactReply = false;
try {
  const document = JSON.parse(chat.stdout.trim());
  const payloads = document?.result?.payloads ?? document?.payloads;
  exactReply = document?.status !== "error" && Array.isArray(payloads) && payloads.length === 1 && payloads[0]?.text === "CHAT_OK";
} catch {}
const result = { executionMode: "embedded-worker", version: normalizedVersion, versionExitCode: version.exitCode, versionError: version.stderr.slice(-2000), chatExitCode: chat.exitCode, chatError: chat.stderr.slice(-2000), exactReply, reply: exactReply ? "CHAT_OK" : null };
writeFileSync(resultPath, JSON.stringify(result), "utf8");
await new Promise((resolve) => mock.close(resolve));
process.exit(version.exitCode === 0 && normalizedVersion === "2026.7.1" && chat.exitCode === 0 && exactReply ? 0 : 1);
`;
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64") {
    fail("native Windows ARM64 is required");
  }
  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  const binRoot = requiredDirectory(path.join(installRoot, "bin"), "NemoClaw bin directory");
  const installedNode = requiredFile(path.join(binRoot, "node.exe"), "Node.js runtime");
  const openshell = requiredFile(path.join(binRoot, "openshell.exe"), "OpenShell CLI");
  const gatewayExecutable = requiredFile(
    path.join(binRoot, "openshell-gateway.exe"),
    "OpenShell gateway",
  );
  const installedOpenClawRoot = requiredDirectory(
    path.join(installRoot, "openclaw"),
    "OpenClaw runtime",
  );
  requiredFile(
    path.join(installedOpenClawRoot, "node_modules", "openclaw", "openclaw.mjs"),
    "OpenClaw entrypoint",
  );
  const gatewayConfig = requiredFile(
    path.join(installRoot, "config", "mxc-gateway.toml"),
    "MXC gateway configuration",
  );
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");

  const systemDrive = process.env.SystemDrive;
  if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
  const systemRoot = requiredDirectory(process.env.SystemRoot ?? "", "Windows system root");
  const comSpec = requiredFile(
    path.join(systemRoot, "System32", "cmd.exe"),
    "Windows command host",
  );
  const runId = randomBytes(5).toString("hex");
  const runRoot = path.join(`${systemDrive}\\`, `NemoClawNativeTurn-${runId}`);
  const shareRoot = path.join(`${systemDrive}\\`, `NemoClawNativeShare-${runId}`);
  const runtimeRoot = path.join(`${systemDrive}\\`, `NemoClawNativeArtifact-${runId}`);
  if (fs.existsSync(runRoot) || fs.existsSync(shareRoot) || fs.existsSync(runtimeRoot))
    fail("qualification roots already exist");
  fs.mkdirSync(runRoot);
  fs.mkdirSync(shareRoot);
  fs.mkdirSync(runtimeRoot);
  console.log("NEMOCLAW> Staging exact installed Node/OpenClaw bytes at the shallow MXC root");
  const node = path.join(runtimeRoot, "node.exe");
  const openClawRoot = path.join(runtimeRoot, "openclaw");
  fs.copyFileSync(installedNode, node);
  fs.cpSync(installedOpenClawRoot, openClawRoot, { recursive: true });
  const openClawEntry = requiredFile(
    path.join(openClawRoot, "node_modules", "openclaw", "openclaw.mjs"),
    "Staged OpenClaw entrypoint",
  );
  const artifactArgument = argumentValue("--artifact-directory");
  const evidenceRoot = path.resolve(
    artifactArgument ??
      path.join(process.env.LOCALAPPDATA ?? runRoot, "NVIDIA", "NemoClaw", "evidence"),
  );
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const receiptPath = path.join(evidenceRoot, `native-windows-turn-${runId}.json`);
  const gatewayPort = await freePort();
  const mockPort = await freePort();
  const sandboxName = `nc-${runId}`;
  const gatewayName = `nemoclaw-gateway-${runId}`;
  const stateRoot = path.join(runRoot, "state");
  const configRoot = path.join(runRoot, "config");
  const home = path.join(shareRoot, "home");
  const temp = path.join(shareRoot, "temp");
  for (const directory of [stateRoot, configRoot, home, temp])
    fs.mkdirSync(directory, { recursive: true });
  const probePath = path.join(shareRoot, "probe.mjs");
  const resultPath = path.join(shareRoot, "result.json");
  const policyPath = path.join(runRoot, "policy.yaml");
  fs.writeFileSync(probePath, probeSource(), "utf8");
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
      `    - ${quoteYamlPath(shareRoot)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const gatewayLog = fs.openSync(path.join(runRoot, "openshell-gateway.log"), "w");
  const gatewayError = fs.openSync(path.join(runRoot, "openshell-gateway.err.log"), "w");
  const gatewayLogPath = path.join(runRoot, "openshell-gateway.log");
  const gatewayErrorPath = path.join(runRoot, "openshell-gateway.err.log");
  const gatewayEnvironment = allowlistedWindowsEnvironment({
    OPENSHELL_DRIVERS: "mxc",
    OPENSHELL_GATEWAY_CONFIG: gatewayConfig,
    XDG_CONFIG_HOME: configRoot,
    XDG_STATE_HOME: stateRoot,
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
      "info",
    ],
    {
      env: gatewayEnvironment,
      stdio: ["ignore", gatewayLog, gatewayError],
      windowsHide: true,
    },
  );
  let passed = false;
  let result = null;
  let cliEnvironment = gatewayEnvironment;
  let create = null;
  let createWatcherDetached = false;
  let logsClosed = false;
  try {
    console.log("NEMOCLAW> Starting installed OpenShell MXC gateway");
    await waitForPort(gatewayPort, gateway);
    cliEnvironment = allowlistedWindowsEnvironment({
      ...gatewayEnvironment,
      OPENSHELL_GATEWAY: undefined,
    });
    await run(
      openshell,
      ["gateway", "add", `http://127.0.0.1:${gatewayPort}`, "--local", "--name", gatewayName],
      cliEnvironment,
      "Registering qualification gateway",
    );
    await run(
      openshell,
      ["gateway", "select", gatewayName],
      cliEnvironment,
      "Selecting qualification gateway",
    );
    const sandboxEnvironment = {
      COMSPEC: comSpec,
      LOCALAPPDATA: home,
      NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS ?? "1",
      NEMOCLAW_MXC_OPENCLAW_ENTRY: openClawEntry,
      NEMOCLAW_MXC_HOME: home,
      NEMOCLAW_MXC_RESULT: resultPath,
      NEMOCLAW_MXC_MOCK_PORT: String(mockPort),
      OS: "Windows_NT",
      PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PROCESSOR_ARCHITECTURE: "ARM64",
      SYSTEMDRIVE: systemDrive,
      SYSTEMROOT: systemRoot,
      TEMP: temp,
      TMP: temp,
      USERPROFILE: home,
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
      JSON.stringify({ mxc: { command: [node, probePath], cwd: shareRoot } }),
      "--no-tty",
    ];
    for (const [name, value] of Object.entries(sandboxEnvironment))
      createArgs.push("--env", `${name}=${value}`);
    console.log("NEMOCLAW> Creating native MXC OpenClaw sandbox");
    let createSpawnError = null;
    let createClosed = false;
    create = spawn(openshell, createArgs, {
      env: cliEnvironment,
      stdio: "ignore",
      windowsHide: true,
    });
    create.once("error", (error) => {
      createSpawnError = error;
    });
    create.once("close", () => {
      createClosed = true;
    });
    console.log("NEMOCLAW> Waiting for the installed OpenClaw agent turn");
    const deadline = Date.now() + TIMEOUT_MS;
    while (
      !fs.existsSync(resultPath) &&
      Date.now() < deadline &&
      gateway.exitCode === null &&
      !createClosed &&
      createSpawnError === null
    )
      await sleep(500);
    if (!fs.existsSync(resultPath)) {
      if (createSpawnError !== null) throw createSpawnError;
      if (createClosed)
        fail(
          `OpenShell sandbox request exited ${create.exitCode ?? create.signalCode ?? "unknown"} before publishing a result`,
        );
      fail("installed OpenClaw turn did not publish a result");
    }
    createWatcherDetached = create.exitCode === null;
    if (!(await stopChild(create))) fail("OpenShell sandbox request watcher did not stop");
    result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const turnPassed =
      result.executionMode === "embedded-worker" &&
      result.version === "2026.7.1" &&
      result.versionExitCode === 0 &&
      result.chatExitCode === 0 &&
      result.exactReply === true &&
      result.reply === "CHAT_OK";
    if (!turnPassed) {
      const failedProbe = sanitizedDiagnostic(JSON.stringify(result), [
        [installRoot, "<install-root>"],
        [runtimeRoot, "<runtime-root>"],
        [shareRoot, "<share-root>"],
        [runRoot, "<run-root>"],
      ]);
      console.error(`NEMOCLAW> Failed sandbox probe result ${failedProbe}`);
      fail("installed OpenClaw turn result was not exact");
    }
    if (!(await waitForFileText(gatewayLogPath, "MXC agent exec completed successfully")))
      fail("OpenShell did not report successful MXC workload termination");
    console.log("AGENT> CHAT_OK");
    await run(
      openshell,
      ["sandbox", "delete", sandboxName],
      cliEnvironment,
      "Deleting native MXC sandbox",
    );
    const sandboxList = await run(
      openshell,
      ["sandbox", "list", "-o", "json"],
      cliEnvironment,
      "Verifying native MXC sandbox registry cleanup",
    );
    let sandboxRegistry;
    try {
      sandboxRegistry = JSON.parse(sandboxList.stdout.trim());
    } catch {
      fail("OpenShell sandbox registry output was not JSON");
    }
    if (jsonContainsExactValue(sandboxRegistry, sandboxName))
      fail("native MXC sandbox remained registered after deletion");
    if (!(await stopChild(gateway))) fail("OpenShell MXC gateway did not stop");
    fs.closeSync(gatewayLog);
    fs.closeSync(gatewayError);
    logsClosed = true;
    for (const directory of [runRoot, shareRoot, runtimeRoot]) {
      if (!(await removeDirectory(directory)))
        fail(`qualification root remained after cleanup: ${path.basename(directory)}`);
    }
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ schemaVersion: 1, classification: "installed-nemoclaw-native-windows-turn", architecture: "arm64", backend: "process_container", openClawExecutionMode: result.executionMode, openShellCreateWatcherDetached: createWatcherDetached, createWatcherStopped: true, workloadStopped: true, gatewayStopped: true, artifactStagedAtDriveRoot: true, openClawVersion: result.version, exactReply: result.reply, sandboxDeleted: true, sandboxRegistryAbsent: true, qualificationRootsRemoved: true, verdict: "pass" }, null, 2)}\n`,
      "utf8",
    );
    passed = true;
    console.log(`NEMOCLAW> PASS receipt=${receiptPath}`);
  } finally {
    if (create !== null) await stopChild(create);
    if (!passed) {
      try {
        await run(
          openshell,
          ["sandbox", "delete", sandboxName],
          cliEnvironment,
          "Failure cleanup sandbox delete",
          30_000,
        );
      } catch {}
    }
    await stopChild(gateway);
    if (!logsClosed) {
      fs.closeSync(gatewayLog);
      fs.closeSync(gatewayError);
    }
    if (!passed) {
      const diagnosticParts = [gatewayLogPath, gatewayErrorPath]
        .filter((file) => fs.existsSync(file))
        .map((file) => fs.readFileSync(file, "utf8"));
      if (diagnosticParts.length > 0) {
        const diagnostic = sanitizedDiagnostic(diagnosticParts.join("\n"), [
          [installRoot, "<install-root>"],
          [runtimeRoot, "<runtime-root>"],
          [shareRoot, "<share-root>"],
          [runRoot, "<run-root>"],
        ]);
        const diagnosticPath = path.join(
          evidenceRoot,
          `native-windows-turn-diagnostic-${runId}.log`,
        );
        fs.writeFileSync(diagnosticPath, diagnostic, "utf8");
        console.error(`NEMOCLAW> Sanitized MXC diagnostic\n${diagnostic}`);
      }
    }
    for (const directory of [runRoot, shareRoot, runtimeRoot]) await removeDirectory(directory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Native Windows turn qualification failed.",
    );
    process.exitCode = 1;
  });
}
