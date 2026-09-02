// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = 300_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fail(message) {
  throw new Error(`Native Windows MXC turn qualification failed: ${message}`);
}

function requiredFile(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile()) fail(`${label} is missing`);
  return resolved;
}

function requiredDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) fail(`${label} is missing`);
  return resolved;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function allowlistedWindowsEnvironment(extra = {}) {
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

async function freePort() {
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

async function waitForPort(port, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail("OpenShell gateway exited before readiness");
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
  fail("OpenShell gateway did not become ready");
}

async function run(file, args, environment, label, timeout = TIMEOUT_MS) {
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

function quoteYamlPath(value) {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

function probeSource() {
  return String.raw`import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const node = required("NEMOCLAW_MXC_NODE");
const entry = required("NEMOCLAW_MXC_OPENCLAW_ENTRY");
const home = required("NEMOCLAW_MXC_HOME");
const token = required("NEMOCLAW_MXC_TOKEN");
const resultPath = required("NEMOCLAW_MXC_RESULT");
const mockPort = Number(required("NEMOCLAW_MXC_MOCK_PORT"));
const gatewayPort = Number(required("NEMOCLAW_MXC_OPENCLAW_PORT"));
const env = {
  ...process.env,
  HOME: home,
  OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:" + gatewayPort,
  OPENCLAW_GATEWAY_TOKEN: token,
  USERPROFILE: home,
};
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const run = async (args, timeout = 210000) => {
  try {
    const output = await execFileAsync(node, args, { env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    return { exitCode: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
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
  gateway: { mode: "local", port: gatewayPort, controlUi: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: false, allowedOrigins: ["http://127.0.0.1:" + gatewayPort] }, trustedProxies: ["127.0.0.1", "::1"], auth: { token: "" }, reload: { mode: "hot" } },
}), "utf8");
const version = await run([entry, "--version"], 30000);
const gateway = spawn(node, [entry, "gateway", "run", "--dev", "--allow-unconfigured", "--auth", "token", "--bind", "loopback", "--port", String(gatewayPort)], { env, stdio: "ignore", windowsHide: true });
let healthy = false;
for (let attempt = 0; attempt < 120 && gateway.exitCode === null; attempt += 1) {
  const health = await run([entry, "gateway", "health", "--json", "--timeout", "5000"], 15000);
  if (health.exitCode === 0) { healthy = true; break; }
  await sleep(1000);
}
let chat = { exitCode: 1, stdout: "", stderr: "" };
if (healthy) {
  chat = await run([entry, "agent", "--agent", "main", "--message", "Reply exactly: CHAT_OK", "--thinking", "off", "--timeout", "180", "--json"]);
}
let exactReply = false;
try {
  const document = JSON.parse(chat.stdout.trim());
  const payloads = document?.result?.payloads ?? document?.payloads;
  exactReply = document?.status !== "error" && Array.isArray(payloads) && payloads.length === 1 && payloads[0]?.text === "CHAT_OK";
} catch {}
const result = { version: version.stdout.trim(), versionExitCode: version.exitCode, healthy, chatExitCode: chat.exitCode, exactReply, reply: exactReply ? "CHAT_OK" : null };
writeFileSync(resultPath, JSON.stringify(result), "utf8");
if (gateway.exitCode === null) gateway.kill();
await Promise.race([new Promise((resolve) => gateway.once("exit", resolve)), sleep(5000)]);
await new Promise((resolve) => mock.close(resolve));
process.exit(version.exitCode === 0 && healthy && exactReply ? 0 : 1);
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
  const node = requiredFile(path.join(binRoot, "node.exe"), "Node.js runtime");
  const openshell = requiredFile(path.join(binRoot, "openshell.exe"), "OpenShell CLI");
  const gatewayExecutable = requiredFile(
    path.join(binRoot, "openshell-gateway.exe"),
    "OpenShell gateway",
  );
  const openClawRoot = requiredDirectory(path.join(installRoot, "openclaw"), "OpenClaw runtime");
  const openClawEntry = requiredFile(
    path.join(openClawRoot, "node_modules", "openclaw", "openclaw.mjs"),
    "OpenClaw entrypoint",
  );
  const gatewayConfig = requiredFile(
    path.join(installRoot, "config", "mxc-gateway.toml"),
    "MXC gateway configuration",
  );
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");

  const systemDrive = process.env.SystemDrive;
  if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
  const runId = randomBytes(5).toString("hex");
  const runRoot = path.join(`${systemDrive}\\`, `NemoClawNativeTurn-${runId}`);
  const shareRoot = path.join(`${systemDrive}\\`, `NemoClawNativeShare-${runId}`);
  if (fs.existsSync(runRoot) || fs.existsSync(shareRoot)) fail("qualification roots already exist");
  fs.mkdirSync(runRoot);
  fs.mkdirSync(shareRoot);
  const artifactArgument = argumentValue("--artifact-directory");
  const artifactRoot = path.resolve(
    artifactArgument ??
      path.join(process.env.LOCALAPPDATA ?? runRoot, "NVIDIA", "NemoClaw", "evidence"),
  );
  fs.mkdirSync(artifactRoot, { recursive: true });
  const receiptPath = path.join(artifactRoot, `native-windows-turn-${runId}.json`);
  const gatewayPort = await freePort();
  const mockPort = await freePort();
  const openClawPort = await freePort();
  const sandboxName = `nemoclaw-turn-${runId}`;
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
      `    - ${quoteYamlPath(node)}`,
      `    - ${quoteYamlPath(openClawRoot)}`,
      "  read_write:",
      `    - ${quoteYamlPath(shareRoot)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const gatewayLog = fs.openSync(path.join(runRoot, "openshell-gateway.log"), "w");
  const gatewayError = fs.openSync(path.join(runRoot, "openshell-gateway.err.log"), "w");
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
    { env: gatewayEnvironment, stdio: ["ignore", gatewayLog, gatewayError], windowsHide: true },
  );
  let passed = false;
  let result = null;
  let cliEnvironment = gatewayEnvironment;
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
      NEMOCLAW_MXC_NODE: node,
      NEMOCLAW_MXC_OPENCLAW_ENTRY: openClawEntry,
      NEMOCLAW_MXC_HOME: home,
      NEMOCLAW_MXC_TOKEN: randomBytes(32).toString("base64url"),
      NEMOCLAW_MXC_RESULT: resultPath,
      NEMOCLAW_MXC_MOCK_PORT: String(mockPort),
      NEMOCLAW_MXC_OPENCLAW_PORT: String(openClawPort),
      TEMP: temp,
      TMP: temp,
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
    await run(openshell, createArgs, cliEnvironment, "Creating native MXC OpenClaw sandbox");
    console.log("NEMOCLAW> Waiting for the installed OpenClaw agent turn");
    const deadline = Date.now() + TIMEOUT_MS;
    while (!fs.existsSync(resultPath) && Date.now() < deadline && gateway.exitCode === null)
      await sleep(500);
    if (!fs.existsSync(resultPath)) fail("installed OpenClaw turn did not publish a result");
    result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    passed =
      result.version === "2026.7.1" &&
      result.versionExitCode === 0 &&
      result.healthy === true &&
      result.chatExitCode === 0 &&
      result.exactReply === true &&
      result.reply === "CHAT_OK";
    if (!passed) fail("installed OpenClaw turn result was not exact");
    console.log("AGENT> CHAT_OK");
    await run(
      openshell,
      ["sandbox", "delete", sandboxName],
      cliEnvironment,
      "Deleting native MXC sandbox",
    );
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ schemaVersion: 1, classification: "installed-nemoclaw-native-windows-turn", architecture: "arm64", backend: "process_container", openClawVersion: result.version, exactReply: result.reply, sandboxDeleted: true, verdict: "pass" }, null, 2)}\n`,
      "utf8",
    );
    console.log(`NEMOCLAW> PASS receipt=${receiptPath}`);
  } finally {
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
    if (gateway.exitCode === null) gateway.kill();
    await Promise.race([new Promise((resolve) => gateway.once("exit", resolve)), sleep(5000)]);
    fs.closeSync(gatewayLog);
    fs.closeSync(gatewayError);
    try {
      fs.rmSync(runRoot, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(shareRoot, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Native Windows turn qualification failed.",
  );
  process.exitCode = 1;
});
