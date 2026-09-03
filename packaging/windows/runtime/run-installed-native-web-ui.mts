// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
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
  stopChild,
  waitForPort,
} from "./run-installed-native-turn.mts";

const TURN_PROOFS = [
  ["Reply exactly with NATIVE_WINDOWS_TURN_1_OK", "NATIVE_WINDOWS_TURN_1_OK"],
  ["Reply exactly with NATIVE_WINDOWS_TURN_2_OK", "NATIVE_WINDOWS_TURN_2_OK"],
  ["Reply exactly with NATIVE_WINDOWS_TURN_3_OK", "NATIVE_WINDOWS_TURN_3_OK"],
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fail(message) {
  throw new Error(`Native Windows OpenClaw UI qualification failed: ${message}`);
}

function gatewaySource() {
  return String.raw`import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const launcher = required("NEMOCLAW_MXC_OPENCLAW_ENTRY");
const home = required("NEMOCLAW_MXC_HOME");
const mockPort = Number(required("NEMOCLAW_MXC_MOCK_PORT"));
const uiPort = Number(required("NEMOCLAW_MXC_UI_PORT"));
const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const contentText = (value) => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : part?.text ?? "").join(" ");
};
const responseFor = (body) => {
  const text = body.messages.map((message) => contentText(message?.content)).join("\n");
  const turn = text.match(/NATIVE_WINDOWS_TURN_([123])_OK/u)?.[1];
  return turn ? "NATIVE_WINDOWS_TURN_" + turn + "_OK" : "NEMOCLAW_NATIVE_PREVIEW_OK";
};
const mock = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "native-preview", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const body = JSON.parse(await readBody(request));
  if (body?.model !== "native-preview" || !Array.isArray(body?.messages)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected request" } }));
    return;
  }
  const content = responseFor(body);
  const id = "chatcmpl-nemoclaw-native-ui";
  const created = Math.floor(Date.now() / 1000);
  if (body.stream === true) {
    response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" });
    for (const value of [
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { content }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) response.write("data: " + JSON.stringify(value) + "\n\n");
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "native-preview",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  }));
});
await new Promise((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(mockPort, "127.0.0.1", resolve);
});
const configDirectory = join(home, ".openclaw");
mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, "openclaw.json"), JSON.stringify({
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "none" },
    controlUi: { allowedOrigins: ["http://127.0.0.1:" + uiPort, "http://localhost:" + uiPort] },
  },
  models: { mode: "merge", providers: { nemoclawNativePreview: {
    baseUrl: "http://127.0.0.1:" + mockPort + "/v1",
    apiKey: "unused",
    api: "openai-completions",
    timeoutSeconds: 180,
    models: [{ id: "native-preview", name: "NemoClaw Native Preview", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
  } } },
  agents: { defaults: { model: { primary: "nemoclawNativePreview/native-preview" }, timeoutSeconds: 180, skipBootstrap: true, thinkingDefault: "off" }, list: [{ id: "main", default: true }] },
}), "utf8");
Object.assign(process.env, {
  HOME: home,
  NODE_DISABLE_COMPILE_CACHE: "1",
  OPENCLAW_HOME: home,
  OPENCLAW_NO_RESPAWN: "1",
  USERPROFILE: home,
});
process.argv = [process.execPath, launcher, "gateway", "run", "--allow-unconfigured", "--port", String(uiPort), "--bind", "loopback", "--auth", "none"];
await import(pathToFileURL(launcher).href);
`;
}

function resolveEdge() {
  const candidates = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ]
    .filter(Boolean)
    .map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
  for (const candidate of candidates) {
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  fail("Microsoft Edge is required for the visible Control UI proof");
}

async function driveBrowser(openClawRoot, url, evidenceRoot, qualification) {
  const playwrightRoot = requiredDirectory(
    path.join(openClawRoot, "node_modules", "openclaw", "node_modules", "playwright-core"),
    "installed Playwright browser driver",
  );
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightRoot);
  const browser = await chromium.launch({
    executablePath: resolveEdge(),
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--start-maximized"],
  });
  let browserVersion = "unknown";
  try {
    browserVersion = browser.version();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    await page.goto(`${url}/chat`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.evaluate(() => {
      document.title = "NemoClaw Native Windows · OpenClaw Control UI";
    });
    const composer = page.locator(".agent-chat__composer-combobox > textarea").first();
    await composer.waitFor({ state: "visible", timeout: 90_000 });
    await page.waitForFunction(
      () => {
        const input = document.querySelector(".agent-chat__composer-combobox > textarea");
        return input instanceof HTMLTextAreaElement && !input.disabled;
      },
      undefined,
      { timeout: 90_000 },
    );
    await page.evaluate(() => {
      document.title = "NemoClaw Native Windows · OpenClaw Control UI";
    });
    await page.screenshot({
      path: path.join(evidenceRoot, "web-ui-ready.png"),
    });
    if (!qualification) {
      console.log(`WEB UI> READY ${url}/chat`);
      await new Promise((resolve) => browser.once("disconnected", resolve));
      return { browserVersion, turns: [] };
    }
    const turns = [];
    for (let index = 0; index < TURN_PROOFS.length; index += 1) {
      const [prompt, expected] = TURN_PROOFS[index];
      console.log(`WEB UI> TURN ${index + 1} typing in the real OpenClaw Control UI`);
      await composer.fill("");
      await composer.pressSequentially(prompt, { delay: 20 });
      await sleep(750);
      await composer.press("Enter");
      await page.getByText(expected, { exact: true }).last().waitFor({
        state: "visible",
        timeout: 120_000,
      });
      await page.screenshot({
        path: path.join(evidenceRoot, `web-ui-turn-${index + 1}.png`),
        fullPage: false,
      });
      console.log(`WEB UI> TURN ${index + 1} PASS ${expected}`);
      turns.push({ prompt, expected, visible: true });
      await sleep(2000);
    }
    await sleep(3000);
    return { browserVersion, turns };
  } finally {
    if (browser.isConnected()) await browser.close();
  }
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64")
    fail("native Windows ARM64 is required");
  const qualification = process.argv.includes("--qualification");
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
  const installedOpenClawEntry = requiredFile(
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
  const runId = randomBytes(5).toString("hex");
  const runRoot = path.join(`${systemDrive}\\`, `NemoClawNativeUi-${runId}`);
  const shareRoot = path.join(`${systemDrive}\\`, `NemoClawNativeUiShare-${runId}`);
  const runtimeRoot = path.join(`${systemDrive}\\`, `NemoClawNativeUiRuntime-${runId}`);
  for (const directory of [runRoot, shareRoot, runtimeRoot]) {
    if (fs.existsSync(directory)) fail("qualification root already exists");
    fs.mkdirSync(directory);
  }
  const evidenceRoot = path.resolve(
    argumentValue("--artifact-directory") ??
      path.join(process.env.LOCALAPPDATA ?? runRoot, "NVIDIA", "NemoClaw", "evidence"),
  );
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const node = path.join(runtimeRoot, "node.exe");
  const openClawRoot = path.join(runtimeRoot, "openclaw");
  console.log("WEB UI> Staging the exact installed OpenClaw runtime for MXC");
  fs.copyFileSync(installedNode, node);
  fs.cpSync(installedOpenClawRoot, openClawRoot, { recursive: true });
  const openClawEntry = requiredFile(
    path.join(openClawRoot, "node_modules", "openclaw", "openclaw.mjs"),
    "staged OpenClaw entrypoint",
  );
  if (!fs.readFileSync(openClawEntry).equals(fs.readFileSync(installedOpenClawEntry)))
    fail("staged OpenClaw entrypoint does not match the installed payload");
  const gatewayScript = path.join(shareRoot, "openclaw-native-ui.mjs");
  fs.writeFileSync(gatewayScript, gatewaySource(), "utf8");
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
      `    - ${quoteYamlPath(shareRoot)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const configRoot = path.join(runRoot, "config");
  const stateRoot = path.join(runRoot, "state");
  const home = path.join(shareRoot, "home");
  const temp = path.join(shareRoot, "temp");
  for (const directory of [configRoot, stateRoot, home, temp])
    fs.mkdirSync(directory, { recursive: true });
  const openShellPort = await freePort();
  const uiPort = await freePort();
  const mockPort = await freePort();
  const sandboxName = `nc-ui-${runId}`;
  const gatewayName = `nemoclaw-ui-${runId}`;
  const gatewayLogPath = path.join(runRoot, "openshell-gateway.log");
  const gatewayErrorPath = path.join(runRoot, "openshell-gateway.err.log");
  const gatewayLog = fs.openSync(gatewayLogPath, "w");
  const gatewayError = fs.openSync(gatewayErrorPath, "w");
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
      String(openShellPort),
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
  let cliEnvironment = gatewayEnvironment;
  let create = null;
  let passed = false;
  let logsClosed = false;
  try {
    console.log("WEB UI> Starting the installed OpenShell MXC gateway");
    await waitForPort(openShellPort, gateway);
    cliEnvironment = allowlistedWindowsEnvironment({
      ...gatewayEnvironment,
      OPENSHELL_GATEWAY: undefined,
    });
    await run(
      openshell,
      ["gateway", "add", `http://127.0.0.1:${openShellPort}`, "--local", "--name", gatewayName],
      cliEnvironment,
      "Registering the native UI gateway",
    );
    await run(
      openshell,
      ["gateway", "select", gatewayName],
      cliEnvironment,
      "Selecting the native UI gateway",
    );
    const sandboxEnvironment = {
      LOCALAPPDATA: home,
      NEMOCLAW_MXC_HOME: home,
      NEMOCLAW_MXC_MOCK_PORT: String(mockPort),
      NEMOCLAW_MXC_OPENCLAW_ENTRY: openClawEntry,
      NEMOCLAW_MXC_UI_PORT: String(uiPort),
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
      JSON.stringify({
        mxc: { command: [node, gatewayScript], cwd: shareRoot },
      }),
      "--no-tty",
    ];
    for (const [name, value] of Object.entries(sandboxEnvironment))
      createArgs.push("--env", `${name}=${value}`);
    console.log("WEB UI> Creating the native MXC OpenClaw Control UI sandbox");
    create = spawn(openshell, createArgs, {
      env: cliEnvironment,
      stdio: "ignore",
      windowsHide: true,
    });
    console.log("WEB UI> Waiting for the real OpenClaw Control UI");
    await waitForPort(uiPort, create, "OpenClaw Control UI");
    const uiUrl = `http://127.0.0.1:${uiPort}`;
    console.log(`WEB UI> Launching Microsoft Edge at ${uiUrl}/chat`);
    const browserProof = await driveBrowser(openClawRoot, uiUrl, evidenceRoot, qualification);
    await run(
      openshell,
      ["sandbox", "delete", sandboxName],
      cliEnvironment,
      "Deleting the native Control UI sandbox",
    );
    if (create !== null && !(await stopChild(create)))
      fail("OpenShell sandbox request watcher did not stop");
    const sandboxList = await run(
      openshell,
      ["sandbox", "list", "-o", "json"],
      cliEnvironment,
      "Verifying Control UI sandbox registry cleanup",
    );
    if (jsonContainsExactValue(JSON.parse(sandboxList.stdout.trim()), sandboxName))
      fail("Control UI sandbox remained registered after deletion");
    if (!(await stopChild(gateway))) fail("OpenShell MXC gateway did not stop");
    fs.closeSync(gatewayLog);
    fs.closeSync(gatewayError);
    logsClosed = true;
    for (const directory of [runRoot, shareRoot, runtimeRoot]) {
      if (!(await removeDirectory(directory)))
        fail(`runtime root remained after cleanup: ${path.basename(directory)}`);
    }
    const receipt = {
      schemaVersion: 1,
      classification: "installed-nemoclaw-native-windows-openclaw-control-ui",
      architecture: "arm64",
      backend: "process_container",
      browser: "Microsoft Edge",
      browserVersion: browserProof.browserVersion,
      deterministicLocalModel: qualification,
      turnCount: browserProof.turns.length,
      turns: browserProof.turns,
      sandboxDeleted: true,
      sandboxRegistryAbsent: true,
      gatewayStopped: true,
      qualificationRootsRemoved: true,
      verdict: "pass",
    };
    fs.writeFileSync(
      path.join(evidenceRoot, `native-windows-web-ui-${runId}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    passed = true;
    console.log(
      qualification
        ? "WEB UI> PASS three real OpenClaw Control UI agent turns"
        : "WEB UI> NemoClaw preview session closed cleanly",
    );
  } finally {
    if (create !== null) await stopChild(create);
    if (!passed) {
      try {
        await run(
          openshell,
          ["sandbox", "delete", sandboxName],
          cliEnvironment,
          "Failure cleanup Control UI sandbox delete",
          30_000,
        );
      } catch {}
    }
    await stopChild(gateway);
    if (!logsClosed) {
      fs.closeSync(gatewayLog);
      fs.closeSync(gatewayError);
    }
    for (const directory of [runRoot, shareRoot, runtimeRoot]) await removeDirectory(directory);
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Native Windows OpenClaw UI qualification failed.",
  );
  process.exitCode = 1;
});
