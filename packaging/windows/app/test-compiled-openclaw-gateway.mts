// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Bounded CI composition control. This is not browser/model/MXC qualification.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";

async function auditWorkerControl(appRoot: string, stateDir: string) {
  fs.mkdirSync(stateDir);
  const worker = new Worker(path.join(appRoot, "dist/audit/audit-event-writer.worker.js"), {
    workerData: { stateDir },
    execArgv: [],
  });
  const exit = new Promise<number>((resolve) => worker.once("exit", resolve));
  const message = () => once(worker, "message", { signal: AbortSignal.timeout(15_000) });
  try {
    assert.deepEqual((await message())[0], { type: "ready" });
    const recorded = message();
    worker.postMessage({
      type: "record",
      input: {
        sourceSequence: 1,
        occurredAt: Date.now(),
        kind: "tool",
        action: "invoke",
        status: "succeeded",
        actorType: "agent",
        actorId: "owned-control",
        agentId: "main",
        runId: "owned-audit-worker-control",
        toolCallId: "call-1",
        toolName: "owned-local-control",
      },
    });
    assert.deepEqual((await recorded)[0], { type: "recorded" });
    const stopped = message();
    worker.postMessage({ type: "stop" });
    assert.deepEqual((await stopped)[0], { type: "stopped" });
    assert.equal(
      await Promise.race([
        exit,
        delay(15_000, undefined, { ref: false }).then(() => {
          throw new Error("Audit worker did not exit after Stop.");
        }),
      ]),
      0,
    );
    const database = new DatabaseSync(path.join(stateDir, "state/openclaw.sqlite"), {
      readOnly: true,
    });
    let row;
    try {
      row = database
        .prepare(
          "select source_sequence,kind,action,status,agent_id,run_id,tool_name from audit_events",
        )
        .get();
    } finally {
      database.close();
    }
    assert.deepEqual(
      { ...row },
      {
        source_sequence: 1,
        kind: "tool",
        action: "invoke",
        status: "succeeded",
        agent_id: "main",
        run_id: "owned-audit-worker-control",
        tool_name: "owned-local-control",
      },
    );
    return {
      ready: true,
      recorded: true,
      stopped: true,
      exitCode: 0,
      persistedMetadataMatched: true,
    };
  } finally {
    await worker.terminate();
  }
}
type BrowserPage = {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  locator(selector: string): {
    first(): {
      waitFor(options: { state: "visible"; timeout: number }): Promise<void>;
      isEnabled(): Promise<boolean>;
    };
  };
  screenshot(options: { path: string }): Promise<unknown>;
};
async function browserControl(
  appRoot: string,
  origin: string,
  directory: string,
  executablePath: string,
) {
  const playwright = createRequire(path.join(appRoot, "openclaw-app.cjs"))("playwright-core") as {
    chromium: {
      launch(options: { headless: boolean; executablePath: string; timeout: number }): Promise<{
        newPage(options: { viewport: { width: number; height: number } }): Promise<BrowserPage>;
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
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(origin + "/chat#token=owned-compiled-gateway-control-token", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    const composer = page.locator(".agent-chat__composer-combobox > textarea").first();
    await composer.waitFor({ state: "visible", timeout: 90_000 });
    const deadline = performance.now() + 30_000;
    while (!(await composer.isEnabled()) && performance.now() < deadline) await delay(100);
    assert.equal(
      await composer.isEnabled(),
      true,
      "The actual published dashboard composer must become enabled.",
    );
    await page.screenshot({ path: path.join(directory, "compiled-dashboard.png") });
    return { visibleComposer: true, enabledComposer: true, modelRequestSent: false };
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
      await browser.close();
    } catch (error) {
      if (!failed)
        throw error; /* Preserve the primary browser failure; this path never reports browser success. */
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
const browserExecutable = process.argv.includes("--browser-executable")
  ? argument("--browser-executable")
  : undefined;
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
      controlUi: { root: path.join(app, "dist/control-ui"), allowedOrigins: [origin] },
    },
    agents: { list: [{ id: "main", default: true }], defaults: { skipBootstrap: true } },
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
require(entry).runCli(process.argv).catch(error=>{console.error(error);process.exitCode=1;});\n`,
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
  const page = await fetch(`${origin}/chat`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<openclaw-app/);
  assert.match(html, /type="module"/);
  const ui = receipt.files.filter((file) => file.role === "control-ui");
  assert.ok(ui.length > 100, "The canonical published frontend resources must be inventoried.");
  let resourceBytes = 0;
  for (const file of ui) {
    const relative = file.path.slice("dist/control-ui/".length);
    const response = await fetch(
      `${origin}/${relative.split("/").map(encodeURIComponent).join("/")}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(response.status, 200, `Published UI resource must be served: ${relative}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (relative === "index.html") {
      const original = fs.readFileSync(path.join(app, file.path));
      assert.equal(hash(original), file.sha256);
      // Pinned serveResolvedIndexHtml adds this fixed setting at the root mount.
      const expected = original
        .toString("utf8")
        .replace(/<html\b/i, '<html data-openclaw-terminal-enabled="false"');
      assert.equal(
        content.toString("utf8"),
        expected,
        "Only the canonical fixed index transformation is permitted.",
      );
    } else {
      assert.equal(content.length, file.bytes, `UI resource length: ${relative}`);
      assert.equal(hash(content), file.sha256, `UI resource content: ${relative}`);
    }
    resourceBytes += content.length;
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
    "device-pair",
    "file-transfer",
    "memory-core",
    "ollama",
    "phone-control",
    "talk-voice",
  ])
    assert.ok(plugins.includes(required), `Canonical active plugin required: ${required}`);
  if (withBrave)
    assert.ok(plugins.includes("brave"), "Configured Brave must register successfully.");
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
  result.auditWorker = await auditWorkerControl(app, path.join(output, "audit-worker-state"));
  if (browserExecutable) {
    result.browser = await browserControl(app, origin, output, browserExecutable);
    result.browserObserved = true;
  }
  result.gatewayObserved = true;
} catch (error) {
  failed = true;
  primary = error;
} finally {
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
