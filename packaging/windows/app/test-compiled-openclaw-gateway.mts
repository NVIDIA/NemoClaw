// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Bounded gateway/browser controls with a local provider; no GPU/MXC qualification.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
  gatewayBrowserConsoleFailure,
  gatewayBrowserMajorVersion,
  gatewayBrowserRoute,
  installGatewayBrowserRouteTrace,
  readGatewayBrowserRouteTrace,
  summarizeGatewayBrowserRouteTrace,
  summarizeGatewayHello,
} from "./gateway-control-browser-diagnostics.mts";
import {
  gatewayDecisionAsset,
  gatewayDecisionLogpoints,
  observeGatewayDecisions,
  type DecisionPage,
} from "./gateway-control-route-decisions.mts";
import {
  gatewayControlModelProviders,
  isGatewayControlDiscoveryRequest,
} from "./gateway-control-model-fixture.mts";

async function archiveWorkerControl(appRoot: string, environment: NodeJS.ProcessEnv) {
  const outcomes = [];
  for (const operation of ["materialize", "publish", "invalid"]) {
    const worker = new Worker(
      path.join(
        appRoot,
        "node_modules/openclaw/dist/config/sessions/session-accessor.sqlite-archive.worker.js",
      ),
      {
        env: environment,
        execArgv: [],
        workerData: { type: "sqlite-transcript-archive-v2", operation, plans: [] },
      },
    );
    const messages: unknown[] = [];
    let failure: Error | undefined;
    worker.on("message", (message) => messages.push(message));
    worker.on("error", (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    });
    const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      void worker.terminate();
    }, 15_000);
    try {
      const code = await exited;
      assert.equal(expired, false, "The archive worker must finish within its bound.");
      assert.equal(code, operation === "invalid" ? 1 : 0, failure?.message);
      assert.deepEqual(
        messages,
        operation === "publish" ? [{ type: "published", results: [] }] : [],
      );
      if (operation === "invalid")
        assert.match(failure?.message ?? "", /requires a supported operation/);
      else assert.equal(failure, undefined);
      outcomes.push({ operation, exitCode: code });
    } finally {
      clearTimeout(timeout);
      await worker.terminate();
    }
  }
  return { outcomes, userArchivesReadOrWritten: false };
}

async function auditRecorderControl(
  appRoot: string,
  stateDir: string,
  environment: NodeJS.ProcessEnv,
) {
  fs.mkdirSync(stateDir);
  const source = `
  (async () => {
    const api = require(${JSON.stringify(path.join(appRoot, "openclaw-app.cjs"))});
    await api.registerPrebuiltPlugins({});
    const registry = globalThis[Symbol.for("nemoclaw.compiled-openclaw.plugins.v1")];
    const { t: createRecorder } = registry.load("node_modules/openclaw/dist/audit-recorder-BCaTSxYZ.js");
    const recorder = createRecorder({ stateDir: process.env.OPENCLAW_STATE_DIR, messageMode: "off" });
    process.once("message", async message => {
      try {
        if (message !== "record-and-stop") throw Error("Unexpected audit control message");
        recorder.recordTool({ type: "tool.execution.completed", seq: 1, ts: Date.now(),
          agentId: "main", runId: "owned-audit-recorder-control", toolCallId: "call-1",
          toolName: "owned-local-control" });
        await recorder.stop();
        process.send({ type: "stopped" }, () => process.disconnect());
      } catch (error) {
        console.error(error); process.exitCode = 1; process.disconnect();
      }
    });
    process.send({ type: "ready" });
  })().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });`;
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", source], {
    env: { ...environment, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_COMPILED_ASSET_ROOT: appRoot },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let closed = false;
  let diagnostic = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192);
  });
  child.once("error", (error) => {
    diagnostic = error.message;
  });
  const exit = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    }),
  );
  const message = () =>
    Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(15_000) }),
      exit.then((code) => {
        throw new Error(`Audit recorder exited ${code} before acknowledgement: ${diagnostic}`);
      }),
    ]);
  let failed = false;
  let primary: unknown;
  try {
    assert.deepEqual((await message())[0], { type: "ready" });
    const stopped = message();
    child.send("record-and-stop");
    assert.deepEqual((await stopped)[0], { type: "stopped" });
    assert.equal(
      await Promise.race([
        exit,
        delay(15_000, undefined, { ref: false }).then(() => {
          throw new Error("Audit recorder process did not exit after Stop.");
        }),
      ]),
      0,
      diagnostic,
    );
    const database = new DatabaseSync(path.join(stateDir, "state/openclaw.sqlite"), {
      readOnly: true,
    });
    let row;
    try {
      row = database
        .prepare(
          "select source_sequence,kind,action,status,agent_id,run_id,tool_name,tool_call_id from audit_events",
        )
        .all();
    } finally {
      database.close();
    }
    assert.deepEqual(
      row.map((item) => ({ ...item })),
      [
        {
          source_sequence: 1,
          kind: "tool_action",
          action: "tool.action.finished",
          status: "succeeded",
          agent_id: "main",
          run_id: "owned-audit-recorder-control",
          tool_name: "owned-local-control",
          tool_call_id: "sha256:" + createHash("sha256").update("call-1").digest("hex"),
        },
      ],
    );
    return {
      ready: true,
      recorded: true,
      stopped: true,
      exitCode: 0,
      persistedMetadataMatched: true,
      implementation: "process-owned-upstream-recorder",
    };
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    if (!closed) {
      try {
        child.kill();
        await Promise.race([
          exit,
          delay(5000, undefined, { ref: false }).then(() => {
            throw new Error("Audit recorder process remained after failure cleanup.");
          }),
        ]);
      } catch (cleanup) {
        if (failed)
          throw new AggregateError([primary, cleanup], "Audit recorder and cleanup failed.");
        throw cleanup;
      }
    }
  }
}
type BrowserLocator = {
  count(): Promise<number>;
  first(): BrowserLocator;
  filter(options: { hasText: string }): BrowserLocator;
  getByRole(role: "button", options: { name: string; exact: boolean }): BrowserLocator;
  waitFor(options: { state: "visible" | "hidden"; timeout: number }): Promise<void>;
  isEnabled(): Promise<boolean>;
  click(options?: { timeout: number }): Promise<void>;
  textContent(): Promise<string | null>;
};
type BrowserPage = DecisionPage & {
  addInitScript(script: () => void): Promise<void>;
  evaluate<T>(script: () => T): Promise<T>;
  url(): string;
  on(event: "pageerror", listener: () => void): void;
  on(event: "console", listener: (message: { type(): string; text(): string }) => void): void;
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  on(
    event: "websocket",
    listener: (socket: {
      on(
        event: "framesent" | "framereceived",
        listener: (frame: { payload: string | Buffer }) => void,
      ): void;
    }) => void,
  ): void;
  locator(selector: string): BrowserLocator;
  screenshot(options: { path: string }): Promise<unknown>;
};
async function inspectBraveConsent(appRoot: string, environment: NodeJS.ProcessEnv) {
  const entry = path.join(appRoot, "openclaw-app.cjs");
  const source = `const entry=${JSON.stringify(entry)};process.argv=[process.execPath,entry,"plugins","inspect","brave","--runtime","--json"];require(entry).runCli(process.argv).catch(error=>{console.error(error);process.exitCode=1;});`;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", source], {
    cwd: appRoot,
    env: environment,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout) as {
    install: {
      source: string;
      acceptedSurface?: { contracts: string[] };
      acceptedSurfaceHash?: string;
    };
    diagnostics: { message: string }[];
  };
}
async function browserControl(
  appRoot: string,
  origin: string,
  directory: string,
  executablePath: string,
  firstRun: boolean,
  pluginConsent: boolean,
  environment: NodeJS.ProcessEnv,
) {
  const playwright = createRequire(path.join(appRoot, "openclaw-app.cjs"))("playwright-core") as {
    chromium: {
      launch(options: { headless: boolean; executablePath: string; timeout: number }): Promise<{
        newPage(options: { viewport: { width: number; height: number } }): Promise<BrowserPage>;
        version(): string;
        close(): Promise<void>;
      }>;
    };
  };
  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath,
    timeout: 30_000,
  });
  let failed = false;
  let page: BrowserPage | undefined;
  let decisionObserver: Awaited<ReturnType<typeof observeGatewayDecisions>> | undefined;
  const diagnostics = {
    schemaVersion: 1,
    browserMajorVersion: null as number | null,
    firstRun,
    sockets: 0,
    pageErrors: 0,
    consoleFailures: {
      "application-start": 0,
      "initial-location": 0,
      "route-navigation": 0,
      "gateway-snapshot": 0,
      other: 0,
    },
    helloResponses: 0,
    lastHello: null as ReturnType<typeof summarizeGatewayHello>,
    detectionRequests: 0,
    detectionResponses: 0,
    verificationRequests: 0,
    verificationResponses: 0,
    navigation: null as ReturnType<typeof summarizeGatewayBrowserRouteTrace> | null,
    decisions: null as Awaited<
      ReturnType<Awaited<ReturnType<typeof observeGatewayDecisions>>["finish"]>
    > | null,
  };
  const captureNavigation = async () => {
    try {
      return page
        ? summarizeGatewayBrowserRouteTrace(await page.evaluate(readGatewayBrowserRouteTrace))
        : null;
    } catch {
      return null;
    }
  };
  try {
    diagnostics.browserMajorVersion = gatewayBrowserMajorVersion(browser.version());
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(installGatewayBrowserRouteTrace);
    if (firstRun) {
      decisionObserver = await observeGatewayDecisions(
        page,
        gatewayDecisionLogpoints(
          fs.readFileSync(
            path.join(
              appRoot,
              "node_modules/openclaw/dist/control-ui/assets",
              gatewayDecisionAsset,
            ),
            "utf8",
          ),
        ),
      );
    }
    page.on("pageerror", () => diagnostics.pageErrors++);
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const category = gatewayBrowserConsoleFailure(message.text());
      diagnostics.consoleFailures[category] = Math.min(
        64,
        diagnostics.consoleFailures[category] + 1,
      );
    });
    let detectionId: string | undefined;
    let detection:
      | { ok?: boolean; payload?: { setupComplete?: boolean }; error?: unknown }
      | undefined;
    let verificationId: string | undefined;
    let verification: { ok?: boolean; payload?: { ok?: boolean; modelRef?: string } } | undefined;
    page.on("websocket", (socket) => {
      diagnostics.sockets++;
      socket.on("framesent", (frame) => {
        const message = JSON.parse(String(frame.payload));
        if (message.type === "req" && message.method === "openclaw.setup.detect") {
          diagnostics.detectionRequests++;
          detectionId = message.id;
        }
        if (message.type === "req" && message.method === "openclaw.setup.verify") {
          diagnostics.verificationRequests++;
          verificationId = message.id;
        }
      });
      socket.on("framereceived", (frame) => {
        const message = JSON.parse(String(frame.payload));
        const hello = summarizeGatewayHello(message);
        if (hello) {
          diagnostics.helloResponses++;
          diagnostics.lastHello = hello;
        }
        if (message.type === "res" && detectionId && message.id === detectionId) {
          diagnostics.detectionResponses++;
          detection = message;
        }
        if (message.type === "res" && verificationId && message.id === verificationId) {
          diagnostics.verificationResponses++;
          verification = message;
        }
      });
    });
    const route = firstRun ? "/chat" : "/settings/model-setup?firstRun=1";
    await page.goto(origin + route + "#token=owned-compiled-gateway-control-token", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    if (firstRun) {
      // The real dashboard must receive a successful worker-backed detection.
      // No model is configured in this fixture, so conversation readiness stays false.
      const deadline = performance.now() + 45_000;
      while (!detection && performance.now() < deadline) await delay(100);
      assert.equal(detection?.ok, true, "The dashboard model-detection RPC must succeed.");
      assert.equal(detection?.payload?.setupComplete, false);
      await page
        .locator(".model-setup__intro")
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await page
        .locator(".model-setup__manual")
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await page.locator(".model-setup__failure").count(), 0);
      assert.equal(
        await page.locator(".agent-chat__composer-combobox > textarea:enabled").count(),
        0,
      );
      await page.screenshot({ path: path.join(directory, "compiled-model-setup.png") });
      diagnostics.navigation = await captureNavigation();
      if (pluginConsent) {
        // All mutations belong to this disposable, credential-free Brave fixture.
        // Cancellation must leave it disabled before a separate explicit acceptance.
        const before = await inspectBraveConsent(appRoot, environment);
        assert.equal(before.install.source, "path");
        assert.equal(before.install.acceptedSurface, undefined);
        assert.equal(before.diagnostics.length, 1);
        assert.match(before.diagnostics[0].message, /requires capability consent/);
        await page.goto(origin + "/settings/plugins", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        const row = page.locator('article[data-plugin-id="brave"]');
        await row.waitFor({ state: "visible", timeout: 30_000 });
        await row.getByRole("button", { name: "Disable", exact: true }).click();
        const enable = row.getByRole("button", { name: "Enable", exact: true });
        await enable.waitFor({ state: "visible", timeout: 30_000 });
        await enable.click();
        const consent = page.locator('.plugins-consent[data-plugin-consent="enable"]');
        // The dialog opens before its capability inspection finishes.
        await consent
          .filter({ hasText: "webSearchProviders: brave" })
          .waitFor({ state: "visible", timeout: 30_000 });
        assert.match((await consent.textContent()) ?? "", /webSearchProviders: brave/);
        await page.screenshot({ path: path.join(directory, "compiled-plugin-consent.png") });
        await consent.getByRole("button", { name: "Cancel", exact: true }).click();
        await consent.waitFor({ state: "hidden", timeout: 10_000 });
        await enable.waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(
          (await inspectBraveConsent(appRoot, environment)).install.acceptedSurface,
          undefined,
        );
        await enable.click();
        await consent.waitFor({ state: "visible", timeout: 30_000 });
        await consent.getByRole("button", { name: "Enable Brave", exact: true }).click();
        await consent.waitFor({ state: "hidden", timeout: 30_000 });
        await row
          .getByRole("button", { name: "Disable", exact: true })
          .waitFor({ state: "visible", timeout: 30_000 });
        const after = await inspectBraveConsent(appRoot, environment);
        assert.equal(after.install.source, "path");
        assert(after.install.acceptedSurface?.contracts.includes("webSearchProviders: brave"));
        assert.match(after.install.acceptedSurfaceHash ?? "", /^[a-f0-9]{64}$/);
        assert.deepEqual(after.diagnostics, []);
      }
      return {
        modelDetectionSucceeded: true,
        setupComplete: false,
        enabledComposer: false,
        modelRequestSent: false,
        ...(pluginConsent
          ? {
              pluginConsent: {
                plugin: "brave",
                cancelledThenExplicitlyAccepted: true,
                acceptancePersisted: true,
                diagnostics: [],
                liveSearchTested: false,
              },
            }
          : {}),
      };
    }
    const composer = page.locator(".agent-chat__composer-combobox > textarea").first();
    await composer.waitFor({ state: "visible", timeout: 90_000 });
    assert.equal(detection?.ok, true, "Configured model detection must succeed.");
    assert.equal(detection?.payload?.setupComplete, true);
    assert.equal(verification?.ok, true, "The actual dashboard verification RPC must succeed.");
    assert.equal(
      verification?.payload?.ok,
      true,
      "The compiled runtime must verify the local provider.",
    );
    assert.equal(verification?.payload?.modelRef, "nemoclawnative/fixture");
    const deadline = performance.now() + 30_000;
    while (!(await composer.isEnabled()) && performance.now() < deadline) await delay(100);
    assert.equal(
      await composer.isEnabled(),
      true,
      "The actual published dashboard composer must become enabled.",
    );
    await page.screenshot({ path: path.join(directory, "compiled-dashboard.png") });
    return {
      visibleComposer: true,
      enabledComposer: true,
      modelRequestSent: true,
      localProvider: true,
      externalModelRequest: false,
      modelVerificationSucceeded: true,
    };
  } catch (error) {
    failed = true;
    try {
      await page?.screenshot({ path: path.join(directory, "compiled-dashboard-failed.png") });
    } catch {
      /* Keep the primary startup error if the browser cannot capture a frame. */
    }
    throw error;
  } finally {
    try {
      diagnostics.navigation ??= await captureNavigation();
      diagnostics.decisions = (await decisionObserver?.finish()) ?? null;
      try {
        fs.writeFileSync(
          path.join(directory, "browser-control.json"),
          JSON.stringify({
            ...diagnostics,
            finalRoute: gatewayBrowserRoute(page?.url() ?? ""),
            failed,
          }),
          { flag: "wx" },
        );
      } catch (error) {
        if (!failed) throw error;
      }
    } finally {
      try {
        await browser.close();
      } catch (error) {
        if (!failed)
          throw error; /* Preserve the primary browser failure; this path never reports browser success. */
      }
    }
  }
}
function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}
const app = argument("--app-root");
const output = argument("--output");
const portable = process.argv.includes("--portable-proof");
const withBrave = process.argv.includes("--with-brave");
const browserSetupControl = process.argv.includes("--browser-setup-control");
const browserPluginConsentControl = process.argv.includes("--browser-plugin-consent-control");
const browserExecutable = process.argv.includes("--browser-executable")
  ? argument("--browser-executable")
  : undefined;
if (browserSetupControl && !browserExecutable)
  throw new Error("The browser setup control requires a browser executable.");
if (browserPluginConsentControl && (!browserSetupControl || !withBrave))
  throw new Error(
    "The plugin consent control requires the browser setup control and Brave fixture.",
  );
if (
  !portable &&
  (process.platform !== "win32" || process.arch !== "arm64" || process.versions.node !== "22.23.2")
)
  throw new Error("The gateway control requires canonical Windows ARM64 Node 22.23.2.");
if (fs.existsSync(output)) throw new Error("Gateway evidence requires a fresh output directory.");
fs.mkdirSync(output, { recursive: true });
const state = path.join(output, "state");
fs.mkdirSync(state);
const receipt = JSON.parse(
  fs.readFileSync(path.join(app, "openclaw-resource-closure.json"), "utf8"),
) as {
  compiler: { mainSha256: string };
  files: { path: string; bytes: number; sha256: string; role: string }[];
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
assert.equal(
  hash(fs.readFileSync(path.join(app, "openclaw-app.cjs"))),
  receipt.compiler.mainSha256,
);
const allocator = net.createServer();
await new Promise<void>((resolve, reject) => {
  allocator.once("error", reject);
  allocator.listen(0, "127.0.0.1", resolve);
});
const port = (allocator.address() as net.AddressInfo).port;
await new Promise<void>((resolve, reject) =>
  allocator.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
// A configured model must pass OpenClaw's real first-run verification before chat.
// Only the model endpoint is a fixture; the browser, gateway and verification are real.
const configuredModelControl = Boolean(browserExecutable && !browserSetupControl);
const modelEndpointControl = Boolean(browserExecutable);
const modelAllocator = net.createServer();
let modelPort = 0;
if (modelEndpointControl) {
  await new Promise<void>((resolve, reject) => {
    modelAllocator.once("error", reject);
    modelAllocator.listen(0, "127.0.0.1", resolve);
  });
  modelPort = (modelAllocator.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    modelAllocator.close((error) => (error ? reject(error) : resolve())),
  );
}
let modelRequests = 0;
let discoveryRequests = 0;
let modelError: unknown;
const modelServer = http.createServer(async (request, response) => {
  try {
    if (isGatewayControlDiscoveryRequest(request.method, request.url)) {
      discoveryRequests++;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    assert(configuredModelControl);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer owned-local-model-control");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      assert(bytes <= 1024 * 1024);
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "fixture");
    assert.equal(body.stream, true);
    assert(
      JSON.stringify(body.messages).includes("Reply with the single word OK. Do not use tools."),
    );
    assert(++modelRequests <= 3, "The bounded verification must not loop.");
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    for (const [delta, finish_reason] of [
      [{ role: "assistant", content: "OK" }, null],
      [{}, "stop"],
    ]) {
      response.write(
        "data: " +
          JSON.stringify({
            id: "owned-model-verification",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    modelError ??= error;
    response.writeHead(500);
    response.end("Controlled model rejected request");
  }
});
modelServer.requestTimeout = 15_000;
const inherited: NodeJS.ProcessEnv = {};
for (const name of [
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
]) {
  const key = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
  if (key) inherited[key] = process.env[key];
}
const env: NodeJS.ProcessEnv = {
  ...inherited,
  HOME: state,
  USERPROFILE: state,
  LOCALAPPDATA: state,
  APPDATA: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_HOME: state,
  OPENCLAW_COMPILED_ASSET_ROOT: app,
  OPENCLAW_NO_RESPAWN: "1",
  NODE_DISABLE_COMPILE_CACHE: "1",
  OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
};
const systemRoot = Object.entries(inherited).find(
  ([name]) => name.toUpperCase() === "SYSTEMROOT",
)?.[1];
if (process.platform === "win32" && !systemRoot)
  throw new Error("Windows controls require the owned SystemRoot.");
env.PATH = [
  path.dirname(process.execPath),
  ...(systemRoot ? [path.join(systemRoot, "System32"), systemRoot] : ["/usr/bin", "/bin"]),
].join(path.delimiter);
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
fs.writeFileSync(
  path.join(state, "openclaw.json"),
  JSON.stringify({
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token: "owned-compiled-gateway-control-token" },
      terminal: { enabled: false },
      controlUi: {
        root: path.join(app, "node_modules/openclaw/dist/control-ui"),
        allowedOrigins: [origin],
      },
    },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: {
      list: [{ id: "main", default: true }],
      defaults: {
        skipBootstrap: true,
        workspace: path.join(output, "workspace"),
        ...(configuredModelControl
          ? { model: { primary: "nemoclawnative/fixture" }, thinkingDefault: "off" }
          : {}),
      },
    },
    ...(modelEndpointControl
      ? {
          models: {
            mode: "merge",
            providers: gatewayControlModelProviders(modelPort, configuredModelControl),
          },
        }
      : {}),
    ...(withBrave
      ? {
          plugins: {
            load: { paths: [path.join(app, "plugins/brave")] },
            entries: { brave: { enabled: true } },
          },
        }
      : {}),
    logging: { file: path.join(output, "gateway.jsonl") },
  }),
  { flag: "wx" },
);
const started = performance.now();
// Owned CI supervisor calls the public compiled API. IPC delivers the same in-process
// shutdown signal on Windows, where ChildProcess.kill cannot run JS signal cleanup.
const driver = path.join(output, "gateway-driver.cjs");
fs.writeFileSync(
  driver,
  `const entry=process.argv[2];process.argv=[process.execPath,entry,...process.argv.slice(3)];
process.on("message",message=>{if(message==="owned-gateway-stop")process.emit("SIGTERM");});
const api=require(entry);Promise.resolve(${withBrave ? 'api.registerPrebuiltPlugins(JSON.parse(require("node:fs").readFileSync(require("node:path").join(process.env.OPENCLAW_STATE_DIR,"openclaw.json"),"utf8")))' : "undefined"}).then(()=>api.runCli(process.argv)).catch(error=>{console.error(error);process.exitCode=1;});\n`,
  { flag: "wx" },
);
const child = spawn(
  process.execPath,
  [
    driver,
    path.join(app, "openclaw-app.cjs"),
    "gateway",
    "run",
    "--allow-unconfigured",
    "--bind",
    "loopback",
    "--port",
    String(port),
  ],
  { cwd: app, env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
);
let stdout = "",
  stderr = "",
  closed = false,
  spawnError: Error | undefined;
const exit = new Promise<number | null>((resolve) => {
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", (code) => {
    closed = true;
    resolve(code);
  });
});
assert.ok(child.stdout && child.stderr, "Owned gateway output pipes must be present.");
child.stdout.on("data", (bytes: Buffer) => {
  stdout = (stdout + bytes.toString("utf8")).slice(-2 * 1024 * 1024);
});
child.stderr.on("data", (bytes: Buffer) => {
  stderr = (stderr + bytes.toString("utf8")).slice(-2 * 1024 * 1024);
});
const result: Record<string, unknown> = {
  schemaVersion: 1,
  classification: "compiled-openclaw-gateway-resource-control",
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.versions.node,
  portableProof: portable,
  codeSha256: receipt.compiler.mainSha256,
  modelRequestSent: false,
  browserObserved: false,
  windowsQualified: false,
};
let primary: unknown;
let failed = false;
try {
  if (modelEndpointControl)
    await new Promise<void>((resolve, reject) => {
      modelServer.once("error", reject);
      modelServer.listen(modelPort, "127.0.0.1", resolve);
    });
  let healthy = false;
  while (!closed && performance.now() - started < 45_000) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) {
        assert.equal(((await response.json()) as { ok: boolean }).ok, true);
        healthy = true;
        break;
      }
    } catch {
      /* The real listener is not present during bounded startup. */
    }
    await delay(100);
  }
  if (spawnError) throw spawnError;
  assert.equal(healthy, true, "The compiled gateway must become healthy within the control bound.");
  result.healthMs = performance.now() - started;
  const page = await fetch(`${origin}/chat`, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<openclaw-app/);
  assert.match(html, /type="module"/);
  const ui = receipt.files.filter((file) => file.role === "control-ui");
  assert.ok(ui.length > 100, "The canonical published frontend resources must be inventoried.");
  let resourceBytes = 0;
  for (const file of ui) {
    assert(file.path.startsWith("node_modules/openclaw/dist/control-ui/"));
    const relative = file.path.slice("node_modules/openclaw/dist/control-ui/".length);
    const response = await fetch(
      `${origin}/${relative.split("/").map(encodeURIComponent).join("/")}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(response.status, 200, `Published UI resource must be served: ${relative}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (relative === "index.html") {
      const original = fs.readFileSync(path.join(app, file.path));
      assert.equal(hash(original), file.sha256);
      // 9.2 anchors asset links and replaces document settings. This fixture uses
      // an explicit root (not a bundled root), no base path/environment, and no terminal.
      let expected = original
        .toString("utf8")
        .replaceAll('src="./assets/', 'src="/assets/')
        .replaceAll('href="./assets/', 'href="/assets/');
      for (const asset of [
        "apple-touch-icon.png",
        "favicon-32.png",
        "favicon.ico",
        "favicon.svg",
        "manifest.webmanifest",
        "sw.js",
      ])
        expected = expected.replaceAll(`href="./${asset}"`, `href="/${asset}"`);
      expected = expected.replace(/<html\b[^>]*>/i, (tag) =>
        tag
          .replace(/\sdata-openclaw-control-ui-build-id="[^"]*"/g, "")
          .replace(
            /<html\b/i,
            '<html data-openclaw-control-ui-base-path="" data-openclaw-terminal-enabled="false"',
          ),
      );
      assert.equal(
        content.toString("utf8"),
        expected,
        "Only the canonical fixed index transformation is permitted.",
      );
    } else {
      assert.equal(content.length, file.bytes, `UI resource length: ${relative}`);
      assert.equal(hash(content), file.sha256, `UI resource content: ${relative}`);
    }
    resourceBytes += file.bytes;
  }
  result.uiResources = {
    files: ui.length,
    bytes: resourceBytes,
    staticFileHashesMatched: true,
    indexCanonicalTransformationMatched: true,
  };
  await delay(5_000);
  assert.equal(closed, false, "The gateway must remain alive through post-startup sidecars.");
  const pluginLine = stdout
    .split("\n")
    .find((line) => line.includes("http server listening (") && line.includes(" plugins:"));
  assert.ok(pluginLine, "Actual plugin registration must be reported.");
  const match = /\((\d+) plugins: ([^;]+);/.exec(pluginLine);
  assert.ok(match);
  const plugins = match[2].split(", ");
  for (const required of [
    "browser",
    "canvas",
    "cua-computer",
    "device-pair",
    "file-transfer",
    "geolocation",
    "linux-node",
    "memory-core",
    "ollama",
    "talk-voice",
  ])
    assert.ok(plugins.includes(required), `Canonical active plugin required: ${required}`);
  if (withBrave) {
    // 9.2 defers Brave until use. test-prebuilt-choice-plugins.mts owns actual
    // runtime registration, persisted installation and fresh-process convergence.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(app, "plugins/brave/openclaw.plugin.json"), "utf8"),
    );
    assert.equal(manifest.activation.onStartup, false);
    assert.equal(
      plugins.includes("brave"),
      false,
      "Brave must retain upstream deferred activation.",
    );
  }
  result.brave = {
    requested: withBrave,
    observed: plugins.includes("brave"),
    liveSearchTested: false,
  };
  result.plugins = plugins;
  assert.doesNotMatch(
    stdout + stderr,
    /failed to load plugin|failed to start audit|Cannot find (?:module|package)|Control UI assets are missing|building.*Control UI/i,
  );
  const trace = fs
    .readFileSync(path.join(output, "gateway.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { message?: string })
    .map((line) => line.message ?? "")
    .find((line) => line.startsWith("startup trace: plugins.gateway-load "));
  assert.ok(trace, "The actual canonical plugin loader counters must be retained.");
  assert.match(trace, /loaderNativeMissesCount=0\.0(?: |$)/);
  assert.match(trace, /loaderSourceTransformForcedCount=0\.0(?: |$)/);
  assert.match(trace, /loaderSourceTransformFallbacksCount=0\.0(?: |$)/);
  result.pluginLoaderTrace = trace;
  result.auditRecorder = await auditRecorderControl(
    app,
    path.join(output, "audit-recorder-state"),
    env,
  );
  result.archiveWorker = await archiveWorkerControl(app, env);
  if (browserExecutable) {
    result.browser = await browserControl(
      app,
      origin,
      output,
      browserExecutable,
      browserSetupControl,
      browserPluginConsentControl,
      env,
    );
    result.browserObserved = true;
    if (modelError) throw modelError;
    if (configuredModelControl) {
      assert(modelRequests > 0, "Browser readiness requires an actual local model request.");
      result.modelRequestSent = true;
    }
  }
  result.gatewayObserved = true;
} catch (error) {
  failed = true;
  primary = error;
} finally {
  modelServer.closeAllConnections();
  if (modelServer.listening)
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  result.localModelVerificationRequests = modelRequests;
  result.localModelDiscoveryRequests = discoveryRequests;
  result.modelRequestSent = modelRequests > 0;
  result.externalModelRequest = false;
  if (modelError)
    result.localModelError = modelError instanceof Error ? modelError.message : String(modelError);
  if (!closed && child.connected)
    child.send("owned-gateway-stop", (error) => {
      if (error && !closed) child.kill();
    });
  let forced = false;
  const force = setTimeout(() => {
    if (!closed) {
      forced = true;
      child.kill("SIGKILL");
    }
  }, 10_000);
  result.exitCode = await exit;
  clearTimeout(force);
  result.cleanup = { ownedProcessExited: closed, forced };
  result.elapsedMs = performance.now() - started;
  result.passed = !failed && result.exitCode === 0 && !forced;
  if (failed)
    result.primaryError =
      primary instanceof Error ? primary.message : "Gateway control threw a non-Error value.";
  fs.writeFileSync(path.join(output, "stdout.log"), stdout, { flag: "wx" });
  fs.writeFileSync(path.join(output, "stderr.log"), stderr, { flag: "wx" });
  fs.writeFileSync(
    path.join(output, "gateway-control.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
}
if (failed) throw primary;
assert.equal(result.passed, true, "Gateway control and owned graceful exit must both pass.");
console.log(JSON.stringify(result));
