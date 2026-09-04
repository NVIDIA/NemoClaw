// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

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
  sanitizedDiagnostic,
  stopChild,
  waitForFileText,
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

function fail(message) {
  throw new Error(`NemoClaw native terminal launch failed: ${message}`);
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
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
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

async function readWindowsCredential(launcher, provider, required) {
  if (!required) return "";
  const result = await new Promise((resolve, reject) => {
    const child = spawn(launcher, ["--credential-read", provider], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = [];
    let stderr = "";
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 2048) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2048);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, secret: Buffer.concat(chunks) }));
  });
  if (result.code !== 0 || !result.secret.length || result.secret.length > 2048)
    fail("Windows Credential Manager does not contain the selected provider credential");
  return result.secret.toString("utf8");
}

async function readRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) fail("the agent request exceeded the broker limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function startInferenceBroker(configuration, credential, brokerToken) {
  const endpoint = new URL(`${configuration.endpoint.replace(/\/$/u, "")}/`);
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/v1/")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${brokerToken}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unauthorized" } }));
        return;
      }
      const upstreamPath = request.url.slice("/v1/".length);
      const upstreamUrl = new URL(upstreamPath, endpoint);
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await readRequest(request);
      const headers = { accept: request.headers.accept ?? "application/json" };
      if (request.headers["content-type"])
        headers["content-type"] = request.headers["content-type"];
      if (credential) headers.authorization = `Bearer ${credential}`;
      if (configuration.inference === "openrouter") {
        headers["http-referer"] = "https://www.nvidia.com/nemoclaw/";
        headers["x-openrouter-title"] = "NVIDIA NemoClaw";
      }
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(180_000),
      });
      const responseBody = Buffer.from(await upstream.arrayBuffer());
      if (responseBody.length > 32 * 1024 * 1024)
        fail("the provider response exceeded the broker limit");
      const responseHeaders = {
        "cache-control": "no-store",
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      };
      response.writeHead(upstream.status, responseHeaders);
      response.end(responseBody);
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : "inference provider request failed",
          },
        }),
      );
    }
  });
  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, port };
}

function interactiveWorkloadSource() {
  return String.raw`import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
const baseUrl = "http://127.0.0.1:" + proxyPort + "/v1";
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
    "memory:",
    "  memory_enabled: true",
    "  user_profile_enabled: true",
    "updates:",
    "  pre_update_backup: false",
    "  refresh_cua_driver: false",
    "",
  ].join("\n"), "utf8");
  const runner = join(home, "run-hermes.py");
  writeFileSync(runner, [
    "import os",
    "import sys",
    "sys.path.insert(0, os.environ['NEMOCLAW_AGENT_SITE_PACKAGES'])",
    "from hermes_cli.main import main",
    "main()",
    "",
  ].join("\n"), "utf8");
  executable = python;
  args = [runner, "--provider", "custom", "--model", model];
  extraEnvironment = { HERMES_HOME: hermesHome };
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
  ].join("\n"), "utf8");
  const runner = join(home, "run-deep-agents.py");
  writeFileSync(runner, [
    "import os",
    "import sys",
    "sys.path.insert(0, os.environ['NEMOCLAW_AGENT_SITE_PACKAGES'])",
    "from deepagents_code import cli_main",
    "cli_main()",
    "",
  ].join("\n"), "utf8");
  executable = python;
  args = [runner, "--sandbox", "none"];
  extraEnvironment = { DEEPAGENTS_CODE_OPENAI_API_KEY: brokerToken };
} else {
  throw new Error("unsupported native terminal agent " + agent);
}

const child = spawn(executable, args, {
  cwd: home,
  env: {
    ...process.env,
    ...extraEnvironment,
    HOME: home,
    LOCALAPPDATA: home,
    NODE_DISABLE_COMPILE_CACHE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    USERPROFILE: home,
  },
  stdio: "inherit",
  windowsHide: false,
});
child.once("error", (error) => { throw error; });
const exitCode = await new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1)));
writeFileSync(exitReceipt, JSON.stringify({ schemaVersion: 1, agent, exitCode }) + "\n", "utf8");
process.exitCode = exitCode;
`;
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64")
    fail("native Windows ARM64 is required");
  if (!process.argv.includes("--configured")) fail("graphical onboarding is required");
  const agentId = argumentValue("--agent") ?? "";
  if (!Object.hasOwn(AGENT_ADAPTERS, agentId)) fail(`unsupported terminal agent: ${agentId}`);
  const adapter = AGENT_ADAPTERS[agentId];
  process.title = `NemoClaw · ${adapter.displayName} · Native ARM64`;
  console.log(`NVIDIA NemoClaw · ${adapter.displayName}`);
  console.log("Native Windows ARM64 · OpenShell + Microsoft MXC · no WSL · no Docker\n");

  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  const { config, stateRoot } = readConfiguration(agentId);
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
  const gatewayConfig = requiredFile(
    path.join(installRoot, "config", "mxc-gateway.toml"),
    "MXC gateway configuration",
  );
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");
  const credential = await readWindowsCredential(
    launcher,
    config.inference,
    config.credentialStored,
  );
  const brokerToken = randomBytes(32).toString("base64url");
  const broker = await startInferenceBroker(config, credential, brokerToken);

  const systemDrive = process.env.SystemDrive;
  if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
  const systemRoot = requiredDirectory(process.env.SystemRoot ?? "", "Windows system root");
  const runId = randomBytes(5).toString("hex");
  const runRoot = path.join(`${systemDrive}\\`, `NemoClaw-${agentId}-${runId}`);
  const runtimeRoot = path.join(`${systemDrive}\\`, `NemoClawRuntime-${agentId}-${runId}`);
  fs.mkdirSync(runRoot);
  fs.mkdirSync(runtimeRoot);
  const node = path.join(runtimeRoot, "node.exe");
  fs.copyFileSync(installedNode, node);
  const runtime = path.join(runtimeRoot, adapter.runtimeDirectory);
  fs.cpSync(installedRuntime, runtime, { recursive: true });
  const pythonRoot = path.join(runtimeRoot, "python");
  if (installedPython !== null) fs.cpSync(installedPython, pythonRoot, { recursive: true });
  const workload = path.join(stateRoot, "run-native-agent.mjs");
  const exitReceipt = path.join(stateRoot, `native-session-${runId}.json`);
  fs.writeFileSync(workload, interactiveWorkloadSource(), "utf8");
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
      `    - ${quoteYamlPath(stateRoot)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const configRoot = path.join(runRoot, "config");
  const gatewayState = path.join(runRoot, "state");
  const temp = path.join(stateRoot, "temp");
  for (const directory of [configRoot, gatewayState, temp])
    fs.mkdirSync(directory, { recursive: true });
  const gatewayPort = await freePort();
  const sandboxName = `${adapter.sandboxPrefix}-${runId}`;
  const gatewayName = `nemoclaw-${agentId}-${runId}`;
  const gatewayLogPath = path.join(runRoot, "openshell-gateway.log");
  const gatewayErrorPath = path.join(runRoot, "openshell-gateway.err.log");
  const gatewayLog = fs.openSync(gatewayLogPath, "w");
  const gatewayError = fs.openSync(gatewayErrorPath, "w");
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
      "info",
    ],
    { env: gatewayEnvironment, stdio: ["ignore", gatewayLog, gatewayError], windowsHide: true },
  );
  let cliEnvironment = gatewayEnvironment;
  let create = null;
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
      HOME: stateRoot,
      LOCALAPPDATA: stateRoot,
      NEMOCLAW_AGENT_HOME: stateRoot,
      NEMOCLAW_AGENT_ID: agentId,
      NEMOCLAW_AGENT_BROKER_TOKEN: brokerToken,
      NEMOCLAW_AGENT_EXIT_RECEIPT: exitReceipt,
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
      USERPROFILE: stateRoot,
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
      JSON.stringify({ mxc: { command: [node, workload], cwd: stateRoot, host_loopback: true } }),
      "--tty",
    ];
    for (const [name, value] of Object.entries(environment))
      createArgs.push("--env", `${name}=${value}`);
    console.log(`Opening the authentic ${adapter.displayName} terminal inside native MXC…\n`);
    create = spawn(openshell, createArgs, {
      env: cliEnvironment,
      stdio: "inherit",
      windowsHide: false,
    });
    const createFailure = new Promise((_, reject) => {
      create.once("error", reject);
      create.once("close", (code) => {
        if (!fs.existsSync(exitReceipt))
          reject(new Error(`OpenShell request exited ${code ?? 1} before the agent finished`));
      });
    });
    await Promise.race([
      waitForFileText(exitReceipt, '"exitCode":', 24 * 60 * 60_000),
      createFailure,
    ]);
    const exitCode = JSON.parse(fs.readFileSync(exitReceipt, "utf8")).exitCode;
    if (!(await stopChild(create))) fail("the OpenShell sandbox request watcher did not stop");
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
    console.log(`\n${adapter.displayName} closed. NemoClaw removed the temporary sandbox.`);
  } finally {
    if (create !== null) await stopChild(create);
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
    await stopChild(gateway);
    await new Promise((resolve) => broker.server.close(() => resolve()));
    fs.closeSync(gatewayLog);
    fs.closeSync(gatewayError);
    if (!passed) {
      const diagnostic = sanitizedDiagnostic(
        [gatewayLogPath, gatewayErrorPath]
          .filter((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile())
          .map((file) => fs.readFileSync(file, "utf8"))
          .join("\n"),
        [
          [installRoot, "<install-root>"],
          [runtimeRoot, "<runtime-root>"],
          [runRoot, "<run-root>"],
          [stateRoot, "<agent-state>"],
        ],
      );
      if (diagnostic)
        fs.writeFileSync(path.join(stateRoot, `failure-${runId}.log`), diagnostic, "utf8");
    }
    for (const directory of [runRoot, runtimeRoot]) await removeDirectory(directory);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "NemoClaw native terminal launch failed.");
  console.error("Press Enter to close.");
  process.stdin.resume();
  process.stdin.once("data", () => process.stdin.pause());
  process.exitCode = 1;
});
