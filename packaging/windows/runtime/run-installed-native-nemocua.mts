// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
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
  sanitizedDiagnostic,
  stopChild,
  waitForFileText,
  waitForPort,
} from "./run-installed-native-turn.mts";

const EXPECTED_TOKENS = [
  "NATIVE_NEMOCUA_TURN_1_OK",
  "NATIVE_NEMOCUA_TURN_2_OK",
  "NATIVE_NEMOCUA_TURN_3_OK",
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fail(message) {
  throw new Error(`NemoClaw native Windows NemoCUA failed: ${message}`);
}

function readNativeConfiguration() {
  const localAppData = requiredDirectory(
    process.env.LOCALAPPDATA ?? "",
    "Windows local application-data directory",
  );
  const stateRoot = path.join(localAppData, "NVIDIA", "NemoClaw", "agents", "nemocua");
  const configPath = requiredFile(
    path.join(stateRoot, "native-windows.json"),
    "NemoCUA graphical configuration",
  );
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (
    config?.schemaVersion !== 1 ||
    config?.classification !== "nemoclaw-native-windows-agent-configuration" ||
    config?.agent !== "nemocua" ||
    !["nvidia", "openrouter", "compatible", "local"].includes(config?.inference) ||
    typeof config?.endpoint !== "string" ||
    typeof config?.model !== "string" ||
    typeof config?.credentialStored !== "boolean"
  )
    fail("NemoCUA graphical configuration is incomplete");
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
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 2048) chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, secret: Buffer.concat(chunks) }));
  });
  if (result.code !== 0 || !result.secret.length || result.secret.length > 2048)
    fail("Windows Credential Manager does not contain the selected provider credential");
  return result.secret.toString("utf8");
}

async function forwardConfiguredModel(body, configuration, credential) {
  const endpoint = new URL(`${configuration.endpoint.replace(/\/$/u, "")}/`);
  const upstreamUrl = new URL("chat/completions", endpoint);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const upstreamBody = {
    ...body,
    model: configuration.model,
    messages: [
      {
        role: "system",
        content:
          'You control a bounded browser verification task. Return only one JSON object with kind "focus", "type", or "click" and the selector from the observation. Do not use Markdown.',
      },
      ...messages,
    ],
    stream: false,
  };
  const headers = { "content-type": "application/json" };
  if (credential) headers.authorization = `Bearer ${credential}`;
  if (configuration.inference === "openrouter") {
    headers["http-referer"] = "https://www.nvidia.com/nemoclaw/";
    headers["x-openrouter-title"] = "NVIDIA NemoClaw";
  }
  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  const responseBody = Buffer.from(await upstream.arrayBuffer());
  if (responseBody.length > 4 * 1024 * 1024) fail("the provider response exceeded the limit");
  return {
    status: upstream.status,
    contentType: upstream.headers.get("content-type") ?? "application/json",
    body: responseBody,
  };
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
  fail("Microsoft Edge is required for the visible NemoCUA proof");
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) fail("bridge request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function taskPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NemoClaw Native Windows · NemoCUA</title>
  <style>
    :root { font-family: "Segoe UI", system-ui, sans-serif; color: #171717; background: #f2f3f0; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 18% 10%, #f7faef, #eef0eb 50%, #e7e9e4); }
    main { width: min(880px, calc(100vw - 64px)); padding: 42px; background: white; border: 1px solid #dfe1dc; border-radius: 16px; box-shadow: 0 24px 70px rgba(0,0,0,.11); }
    .brand { display: flex; align-items: center; gap: 12px; color: #4f7d00; font-size: 13px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
    .mark { width: 14px; height: 14px; border-radius: 3px; background: #76b900; }
    h1 { margin: 20px 0 8px; font-size: 36px; letter-spacing: -.035em; }
    p { color: #646662; line-height: 1.55; }
    .task { margin-top: 28px; padding: 24px; border: 1px solid #e1e3de; border-radius: 12px; background: #fbfbfa; }
    label { display: block; margin-bottom: 9px; font-size: 13px; font-weight: 650; }
    input { width: 100%; height: 48px; padding: 0 14px; border: 1px solid #b8bbb5; border-radius: 7px; font: inherit; outline: none; }
    input:focus { border-color: #76b900; box-shadow: 0 0 0 3px rgba(118,185,0,.16); }
    button { margin-top: 16px; padding: 12px 20px; color: white; background: #76b900; border: 1px solid #4f7d00; border-radius: 6px; font: inherit; font-weight: 650; cursor: pointer; }
    #result { margin-top: 22px; padding: 16px; border-left: 4px solid #76b900; background: #f0f7e5; color: #355600; font-weight: 650; }
    .status { margin-top: 24px; display: flex; gap: 16px; color: #777; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark"></span>NVIDIA NemoClaw · Experimental</div>
    <h1>NemoCUA native browser task</h1>
    <p>The agent is running inside Microsoft MXC. This visible Edge window is controlled through a loopback-only browser bridge—no WSL, Docker, or prerecorded interaction.</p>
    <section class="task">
      <label for="task-input">Verification phrase</label>
      <input id="task-input" autocomplete="off" placeholder="Waiting for the contained agent…">
      <button id="complete-task" type="button">Complete task</button>
      <div id="result" hidden>Native Windows browser task complete.</div>
    </section>
    <div class="status"><span>ARM64 host</span><span>OpenShell + MXC</span><span>Actual browser pixels captured</span></div>
  </main>
  <script src="/task.js"></script>
</body>
</html>`;
}

function taskScript() {
  return `document.querySelector("#complete-task").addEventListener("click", () => {
  const input = document.querySelector("#task-input");
  if (input.value === "NEMOCUA_NATIVE_WINDOWS") {
    document.querySelector("#result").hidden = false;
    document.body.dataset.completed = "true";
  }
});`;
}

async function startBrowserBridge(
  openClawRoot,
  evidenceRoot,
  qualification,
  configuration,
  credential,
  bridgeToken,
) {
  const playwrightRoot = requiredDirectory(
    path.join(openClawRoot, "node_modules", "openclaw", "node_modules", "playwright-core"),
    "installed Playwright browser driver",
  );
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightRoot);
  const browser = await chromium.launch({
    executablePath: resolveEdge(),
    headless: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--window-position=20,10",
      "--window-size=1440,810",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 730 } });
  const page = await context.newPage();
  let observationIndex = 0;
  let port = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/task")) {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'",
          "content-type": "text/html; charset=utf-8",
        });
        response.end(taskPage());
        return;
      }
      if (request.method === "GET" && url.pathname === "/task.js") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end(taskScript());
        return;
      }
      if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "unauthorized" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/observe") {
        const screenshot = await page.screenshot({ fullPage: false });
        observationIndex += 1;
        fs.writeFileSync(
          path.join(
            evidenceRoot,
            `nemocua-observation-${String(observationIndex).padStart(2, "0")}.png`,
          ),
          screenshot,
        );
        const state = await page.evaluate(() => {
          const input = document.querySelector("#task-input");
          const result = document.querySelector("#result");
          return {
            inputFocused: input === document.activeElement,
            inputValue: input instanceof HTMLInputElement ? input.value : null,
            completed: document.body.dataset.completed === "true" && result?.hidden === false,
          };
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            url: page.url(),
            title: await page.title(),
            bodyText: (await page.locator("body").innerText()).slice(0, 16 * 1024),
            screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
            state,
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = JSON.parse(await readRequestBody(request));
        if (!qualification) {
          const upstream = await forwardConfiguredModel(body, configuration, credential);
          response.writeHead(upstream.status, { "content-type": upstream.contentType });
          response.end(upstream.body);
          return;
        }
        const content = body?.messages?.at(-1)?.content;
        const prompt = typeof content === "string" ? content : JSON.stringify(content ?? "");
        const action = prompt.includes("focus its input")
          ? { kind: "focus", selector: "#task-input" }
          : prompt.includes("Type NEMOCUA_NATIVE_WINDOWS")
            ? { kind: "type", selector: "#task-input", text: "NEMOCUA_NATIVE_WINDOWS" }
            : prompt.includes("Submit the task")
              ? { kind: "click", selector: "#complete-task" }
              : null;
        if (body?.model !== "nemocua-native-preview" || action === null)
          fail("deterministic model received an unexpected request");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "chatcmpl-nemoclaw-native-cua",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "nemocua-native-preview",
            choices: [
              { index: 0, message: { role: "assistant", content: JSON.stringify(action) } },
            ],
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/act") {
        const action = JSON.parse(await readRequestBody(request));
        const allowed =
          (action?.kind === "focus" && action.selector === "#task-input") ||
          (action?.kind === "type" &&
            action.selector === "#task-input" &&
            action.text === "NEMOCUA_NATIVE_WINDOWS") ||
          (action?.kind === "click" && action.selector === "#complete-task");
        if (!allowed)
          fail("contained NemoCUA requested an action outside the qualification allowlist");
        const locator = page.locator(action.selector);
        if (action.kind === "focus") await locator.focus();
        else if (action.kind === "type") await locator.fill(action.text);
        else await locator.click();
        await sleep(1600);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ applied: true, kind: action.kind }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ message: error instanceof Error ? error.message : "bridge failure" }),
      );
    }
  });
  port = await freePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await page.goto(`http://127.0.0.1:${port}/task`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.locator("#task-input").waitFor({ state: "visible", timeout: 30_000 });
  await sleep(3000);
  return { browser, page, server, port, browserVersion: browser.version() };
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64")
    fail("native Windows ARM64 is required");
  const qualification = process.argv.includes("--qualification");
  const configured = process.argv.includes("--configured");
  if (qualification === configured)
    fail("select exactly one of qualification or configured execution");
  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  const binRoot = requiredDirectory(path.join(installRoot, "bin"), "NemoClaw bin directory");
  const launcher = requiredFile(path.join(binRoot, "NemoClaw.exe"), "NemoClaw launcher");
  const openshell = requiredFile(path.join(binRoot, "openshell.exe"), "OpenShell CLI");
  const gatewayExecutable = requiredFile(
    path.join(binRoot, "openshell-gateway.exe"),
    "OpenShell gateway",
  );
  const installedPythonRoot = requiredDirectory(path.join(installRoot, "python"), "Python runtime");
  const installedNemoCuaRoot = requiredDirectory(
    path.join(installRoot, "nemocua"),
    "NemoCUA runtime",
  );
  const installedOpenClawRoot = requiredDirectory(
    path.join(installRoot, "openclaw"),
    "OpenClaw browser-driver runtime",
  );
  const gatewayConfig = requiredFile(
    path.join(installRoot, "config", "mxc-gateway.toml"),
    "MXC gateway configuration",
  );
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");
  const configuredIdentity = configured ? readNativeConfiguration() : null;
  const credential = configuredIdentity
    ? await readWindowsCredential(
        launcher,
        configuredIdentity.config.inference,
        configuredIdentity.config.credentialStored,
      )
    : "";

  const systemDrive = process.env.SystemDrive;
  if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
  const systemRoot = requiredDirectory(process.env.SystemRoot ?? "", "Windows system root");
  const runId = randomBytes(5).toString("hex");
  const runRoot = path.join(`${systemDrive}\\`, `NemoClawNativeCua-${runId}`);
  const shareRoot = path.join(`${systemDrive}\\`, `NemoClawNativeCuaShare-${runId}`);
  const runtimeRoot = path.join(`${systemDrive}\\`, `NemoClawNativeCuaRuntime-${runId}`);
  for (const directory of [runRoot, shareRoot, runtimeRoot]) {
    if (fs.existsSync(directory)) fail("runtime root already exists");
    fs.mkdirSync(directory);
  }
  const evidenceRoot = path.resolve(
    argumentValue("--artifact-directory") ??
      path.join(configuredIdentity?.stateRoot ?? process.env.LOCALAPPDATA ?? runRoot, "evidence"),
  );
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const pythonRoot = path.join(runtimeRoot, "python");
  const nemocuaRoot = path.join(runtimeRoot, "nemocua");
  fs.cpSync(installedPythonRoot, pythonRoot, { recursive: true });
  fs.cpSync(installedNemoCuaRoot, nemocuaRoot, { recursive: true });
  const python = requiredFile(path.join(pythonRoot, "python.exe"), "staged Python runtime");
  const harness = requiredFile(
    path.join(nemocuaRoot, "run_with_harness.py"),
    "staged NemoCUA harness",
  );
  const resultPath = path.join(shareRoot, "nemocua-result.json");
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
  const temp = path.join(shareRoot, "temp");
  for (const directory of [configRoot, stateRoot, temp])
    fs.mkdirSync(directory, { recursive: true });
  const bridgeToken = randomBytes(32).toString("base64url");
  const bridge = await startBrowserBridge(
    installedOpenClawRoot,
    evidenceRoot,
    qualification,
    configuredIdentity?.config ?? null,
    credential,
    bridgeToken,
  );
  const openShellPort = await freePort();
  const sandboxName = `nc-nemocua-${runId}`;
  const gatewayName = `nemoclaw-nemocua-${runId}`;
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
    { env: gatewayEnvironment, stdio: ["ignore", gatewayLog, gatewayError], windowsHide: true },
  );
  let cliEnvironment = gatewayEnvironment;
  let create = null;
  let createOutput = "";
  let createError = "";
  let passed = false;
  let logsClosed = false;
  try {
    console.log("NEMOCUA> Starting the installed OpenShell MXC gateway");
    await waitForPort(openShellPort, gateway);
    cliEnvironment = allowlistedWindowsEnvironment({
      ...gatewayEnvironment,
      OPENSHELL_GATEWAY: undefined,
    });
    await run(
      openshell,
      ["gateway", "add", `http://127.0.0.1:${openShellPort}`, "--local", "--name", gatewayName],
      cliEnvironment,
      "Registering the native NemoCUA gateway",
    );
    await run(
      openshell,
      ["gateway", "select", gatewayName],
      cliEnvironment,
      "Selecting the native NemoCUA gateway",
    );
    const sandboxEnvironment = {
      HOME: shareRoot,
      LOCALAPPDATA: shareRoot,
      NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS ?? "1",
      OS: "Windows_NT",
      PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PROCESSOR_ARCHITECTURE: "ARM64",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
      SYSTEMDRIVE: systemDrive,
      SYSTEMROOT: systemRoot,
      TEMP: temp,
      TMP: temp,
      USERPROFILE: shareRoot,
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
          command: [
            python,
            harness,
            qualification ? "--qualification" : "--configured",
            "--bridge-url",
            `http://127.0.0.1:${bridge.port}`,
            "--bridge-token",
            bridgeToken,
            "--result-path",
            resultPath,
          ],
          cwd: shareRoot,
          host_loopback: true,
        },
      }),
      "--no-tty",
    ];
    for (const [name, value] of Object.entries(sandboxEnvironment))
      createArgs.push("--env", `${name}=${value}`);
    console.log("NEMOCUA> Launching the real experimental browser harness inside native MXC");
    create = spawn(openshell, createArgs, {
      env: cliEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    create.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      createOutput = `${createOutput}${text}`.slice(-128 * 1024);
      process.stdout.write(text);
    });
    create.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      createError = `${createError}${text}`.slice(-128 * 1024);
      process.stderr.write(text);
    });
    await waitForFileText(resultPath, EXPECTED_TOKENS[2], 360_000);
    const agentResult = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const finalState = await bridge.page.evaluate(() => ({
      inputValue: document.querySelector("#task-input")?.value ?? null,
      completed: document.body.dataset.completed === "true",
      resultVisible: document.querySelector("#result")?.hidden === false,
    }));
    if (
      agentResult.verdict !== "pass" ||
      agentResult.nemocuaVersion !== "0.1.0-windows-experimental" ||
      agentResult.turnCount !== 3 ||
      !EXPECTED_TOKENS.every((token, index) => agentResult.turns?.[index]?.token === token) ||
      finalState.inputValue !== "NEMOCUA_NATIVE_WINDOWS" ||
      finalState.completed !== true ||
      finalState.resultVisible !== true
    )
      fail("NemoCUA browser receipt or visible postcondition is incomplete");
    await bridge.page.screenshot({
      path: path.join(evidenceRoot, "nemocua-browser-complete.png"),
      fullPage: false,
    });
    await sleep(3000);
    await run(
      openshell,
      ["sandbox", "delete", sandboxName],
      cliEnvironment,
      "Deleting the native NemoCUA sandbox",
    );
    if (create !== null && !(await stopChild(create)))
      fail("NemoCUA sandbox request watcher did not stop");
    const sandboxList = await run(
      openshell,
      ["sandbox", "list", "-o", "json"],
      cliEnvironment,
      "Verifying native NemoCUA sandbox cleanup",
    );
    if (jsonContainsExactValue(JSON.parse(sandboxList.stdout.trim()), sandboxName))
      fail("NemoCUA sandbox remained registered after deletion");
    if (!(await stopChild(gateway))) fail("OpenShell MXC gateway did not stop");
    fs.closeSync(gatewayLog);
    fs.closeSync(gatewayError);
    logsClosed = true;
    for (const directory of [runRoot, runtimeRoot]) {
      if (!(await removeDirectory(directory)))
        fail(`runtime root remained: ${path.basename(directory)}`);
    }
    const receipt = {
      ...agentResult,
      classification: "installed-nemoclaw-native-windows-nemocua",
      architecture: "arm64",
      backend: "process_container",
      browser: "Microsoft Edge",
      browserVersion: bridge.browserVersion,
      interface: "NemoCUA visible browser task",
      runtimeEntrypointSha256: createHash("sha256")
        .update(fs.readFileSync(path.join(installedNemoCuaRoot, "run_with_harness.py")))
        .digest("hex"),
      pythonSha256: createHash("sha256")
        .update(fs.readFileSync(path.join(installedPythonRoot, "python.exe")))
        .digest("hex"),
      openShellSha256: createHash("sha256").update(fs.readFileSync(openshell)).digest("hex"),
      deterministicLocalModel: qualification,
      inferenceProvider: configuredIdentity?.config.inference ?? "qualification",
      model: configuredIdentity?.config.model ?? "nemocua-native-preview",
      visiblePostcondition: finalState,
      createWatcherStopped: true,
      sandboxDeleted: true,
      sandboxRegistryAbsent: true,
      gatewayStopped: true,
      qualificationRootsRemoved: true,
    };
    fs.writeFileSync(
      path.join(evidenceRoot, `native-windows-nemocua-${runId}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    await removeDirectory(shareRoot);
    passed = true;
    console.log("NEMOCUA> PASS three real model-driven browser actions inside native MXC");
  } finally {
    if (create !== null) await stopChild(create);
    if (!passed) {
      try {
        await run(
          openshell,
          ["sandbox", "delete", sandboxName],
          cliEnvironment,
          "Failure cleanup native NemoCUA sandbox",
          30_000,
        );
      } catch {}
    }
    await stopChild(gateway);
    if (!logsClosed) {
      fs.closeSync(gatewayLog);
      fs.closeSync(gatewayError);
    }
    await new Promise((resolve) => bridge.server.close(() => resolve()));
    if (bridge.browser.isConnected()) await bridge.browser.close();
    if (!passed) {
      const diagnosticParts = [createOutput, createError];
      for (const file of [gatewayLogPath, gatewayErrorPath]) {
        if (fs.statSync(file, { throwIfNoEntry: false })?.isFile())
          diagnosticParts.push(fs.readFileSync(file, "utf8"));
      }
      const diagnostic = sanitizedDiagnostic(diagnosticParts.filter(Boolean).join("\n"), [
        [installRoot, "<install-root>"],
        [runtimeRoot, "<runtime-root>"],
        [shareRoot, "<share-root>"],
        [runRoot, "<run-root>"],
      ]);
      if (diagnostic) {
        fs.writeFileSync(
          path.join(evidenceRoot, `native-windows-nemocua-diagnostic-${runId}.log`),
          diagnostic,
          "utf8",
        );
        console.error(`NEMOCUA> Sanitized failure diagnostic\n${diagnostic}`);
      }
    }
    for (const directory of [runRoot, shareRoot, runtimeRoot]) await removeDirectory(directory);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "NemoClaw native Windows NemoCUA failed.");
  if (process.argv.includes("--configured")) {
    console.error("Press Enter to close.");
    process.stdin.resume();
    process.stdin.once("data", () => process.stdin.pause());
  }
  process.exitCode = 1;
});
