// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Real compiled registry/gateway control. External channel/search activity is deliberately disabled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { nativeOpenClawOptions, type NativeOptions } from "../runtime/native-options.mts";
const argument = (name: string) => {
  const i = process.argv.indexOf(name);
  assert(i >= 0 && process.argv[i + 1]);
  return process.argv[i + 1];
};
const app = path.resolve(argument("--app-root")),
  output = path.resolve(argument("--output")),
  choice = argument("--choice");
assert(["brave", "discord", "slack", "tavily"].includes(choice));
if (!process.argv.includes("--portable-proof")) {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.2");
}
assert(!fs.existsSync(output));
fs.mkdirSync(output, { recursive: true });
const state = path.join(output, "state");
fs.mkdirSync(state);
const code = path.join(app, "openclaw-app.cjs"),
  codeHash = createHash("sha256").update(fs.readFileSync(code)).digest("hex");
assert.equal(
  codeHash,
  JSON.parse(fs.readFileSync(path.join(app, "openclaw-resource-closure.json"), "utf8")).compiler
    .mainSha256,
);
const options: NativeOptions =
  choice === "brave" || choice === "tavily"
    ? { search: { provider: choice, credentialStored: true } }
    : {
        messaging: {
          [choice]: {
            credentialStored: true,
            allowedUsers: [],
            ...(choice === "slack" ? { appCredentialStored: true } : {}),
          },
        },
      };
const selected = nativeOpenClawOptions(options);
const config = {
  ...selected,
  plugins: { ...selected.plugins, load: { paths: [path.join(app, "plugins", choice)] } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: { list: [{ id: "main", default: true }], defaults: { skipBootstrap: true } },
};
const env: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env))
  if (
    [
      "systemroot",
      "windir",
      "systemdrive",
      "comspec",
      "path",
      "pathext",
      "temp",
      "tmp",
      "programfiles",
      "programfiles(x86)",
      "os",
      "processor_architecture",
      "lang",
      "lc_all",
      "tmpdir",
    ].includes(key.toLowerCase())
  )
    env[key] = value;
Object.assign(env, {
  HOME: state,
  USERPROFILE: state,
  LOCALAPPDATA: state,
  APPDATA: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_HOME: state,
  OPENCLAW_COMPILED_ASSET_ROOT: app,
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_NO_AUTO_UPDATE: "1",
  OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
  NODE_DISABLE_COMPILE_CACHE: "1",
});
const systemRoot = Object.entries(env).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1];
env.PATH = [
  path.dirname(process.execPath),
  ...(systemRoot ? [path.join(systemRoot, "System32"), systemRoot] : ["/usr/bin", "/bin"]),
].join(path.delimiter);
const attempts = path.join(output, "package-manager-attempt");
const trap = `const cp=require("node:child_process"),fs=require("node:fs");for(const name of ["spawn","spawnSync","execFile","execFileSync"]){const original=cp[name];cp[name]=function(...args){if(/(?:npm|npx|pnpm|yarn|pip)(?:\\b|[-.])/i.test(JSON.stringify(args.slice(0,2)))){fs.appendFileSync(${JSON.stringify(attempts)},name+"\\n");throw Error("Unexpected package-manager invocation");}return original.apply(this,args);};}require("node:module").syncBuiltinESMExports();`;
function start(label: string, source: string) {
  const file = path.join(output, label + ".cjs");
  fs.writeFileSync(file, trap + source, { flag: "wx" });
  const child = spawn(process.execPath, [file], {
    cwd: app,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "",
    stderr = "";
  child.once("error", (error) => {
    stderr += error.message;
  });
  child.stdout!.on("data", (data) => {
    stdout += data;
    if (stdout.length > 2 * 1024 * 1024) child.kill();
  });
  child.stderr!.on("data", (data) => {
    stderr += data;
    if (stderr.length > 2 * 1024 * 1024) child.kill();
  });
  let closed = false;
  const completion = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    }),
  );
  return {
    child,
    completion,
    isClosed: () => closed,
    stdout: () => stdout,
    stderr: () => stderr,
    save: () => {
      fs.writeFileSync(path.join(output, label + ".stdout.log"), stdout);
      fs.writeFileSync(path.join(output, label + ".stderr.log"), stderr);
    },
  };
}
async function finish(child: ReturnType<typeof start>, milliseconds: number) {
  const timer = setTimeout(() => child.child.kill(), milliseconds);
  try {
    return await child.completion;
  } finally {
    clearTimeout(timer);
    child.save();
  }
}
async function observeRecurringHealth(_origin: string) {
  const samples: { ts: number; observedAtMs: number; ok: boolean }[] = [];
  for (const index of [0, 1]) {
    if (index) await delay(65000); // Cross the unchanged 60s background health interval.
    const probe = start(
      "health-" + index,
      `const entry=${JSON.stringify(code)};process.argv=[process.execPath,entry,"health","--json","--timeout","15000"];require(entry).runCli(process.argv).catch(error=>{console.error(error);process.exitCode=1;});`,
    );
    assert.equal(await finish(probe, 30000), 0, "The actual gateway health RPC failed.");
    const response = JSON.parse(probe.stdout());
    assert.equal(response.ok, true);
    assert(Number.isFinite(response.ts));
    samples.push({ ts: response.ts, observedAtMs: Date.now(), ok: true });
  }
  assert(samples[1].ts > samples[0].ts, "The configured health snapshot did not refresh.");
  return {
    samples,
    naturalIntervalWaitMs: 65000,
    healthRpcRequestsSent: 2,
    observation:
      "successful repeated canonical health RPC plus no background refresh errors across the unchanged timer interval; not a passive timer-only measurement",
  };
}

let primary: unknown;
let gateway: ReturnType<typeof start> | undefined;
const result: Record<string, unknown> = {
  schemaVersion: 1,
  classification: "compiled-prebuilt-choice-convergence",
  choice,
  codeSha256: codeHash,
  channelConnectionsStarted: false,
  liveSearchTested: false,
  modelTested: false,
  windowsQualified: false,
};
try {
  fs.writeFileSync(path.join(state, "openclaw.json"), JSON.stringify(config));
  const registered = path.join(output, "registered.json");
  const inspect = start(
    "inspect",
    `const entry=${JSON.stringify(code)},api=require(entry);process.argv=[process.execPath,entry,"plugins","inspect",${JSON.stringify(choice)},"--runtime","--json"];api.registerPrebuiltPlugins(${JSON.stringify(config)}).then(result=>{fs.writeFileSync(${JSON.stringify(registered)},JSON.stringify(result));return api.runCli(process.argv);}).catch(error=>{console.error(error);process.exitCode=1;});`,
  );
  assert.equal(await finish(inspect, 30000), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(registered, "utf8")).registered, [choice]);
  const report = JSON.parse(inspect.stdout());
  assert.equal(report.plugin?.id, choice);
  assert.equal(report.plugin?.status, "loaded");
  assert.equal(report.plugin?.imported, true);
  assert.equal(report.install?.source, "path");
  assert.equal(report.install?.installPath, path.join(app, "plugins", choice));
  assert.equal(report.install?.sourcePath, report.install.installPath);
  assert.equal(report.install?.version, "2026.7.1");
  assert.deepEqual(report.diagnostics, []);
  result.runtimeInspection = {
    status: report.plugin.status,
    capabilities: report.capabilities,
    install: report.install,
  };
  const allocator = net.createServer();
  await new Promise<void>((r) => allocator.listen(0, "127.0.0.1", r));
  const port = (allocator.address() as net.AddressInfo).port;
  await new Promise<void>((r) => allocator.close(() => r()));
  const origin = "http://127.0.0.1:" + port;
  const gatewayConfig = {
    ...config,
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "none" },
      controlUi: { root: path.join(app, "dist/control-ui"), allowedOrigins: [origin] },
    },
    logging: { file: path.join(output, "gateway.jsonl") },
  };
  fs.writeFileSync(path.join(state, "openclaw.json"), JSON.stringify(gatewayConfig));
  // A new process must converge from the actual persisted metadata, without
  // running the registration API again or inheriting a prior CLI checkpoint.
  gateway = start(
    "gateway",
    `const entry=${JSON.stringify(code)};process.argv=[process.execPath,entry,"gateway","run","--allow-unconfigured","--port",${JSON.stringify(String(port))},"--bind","loopback","--auth","none"];process.on("message",message=>{if(message==="stop")process.emit("SIGINT");});require(entry).runCli(process.argv).catch(error=>{console.error(error);process.exitCode=1;});`,
  );
  const started = performance.now();
  let healthy = false;
  while (!gateway.isClosed() && performance.now() - started < 45000) {
    try {
      const response = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert(healthy, "The configured compiled gateway did not become healthy.");
  result.recurringHealth = await observeRecurringHealth(origin);
  assert.equal(gateway.isClosed(), false);
  const trace = fs
    .readFileSync(path.join(output, "gateway.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).message)
    .find(
      (line: unknown) =>
        typeof line === "string" && line.startsWith("startup trace: plugins.gateway-load "),
    );
  assert.equal(typeof trace, "string");
  for (const metric of [
    "loaderNativeMissesCount",
    "loaderSourceTransformForcedCount",
    "loaderSourceTransformFallbacksCount",
  ])
    assert.match(trace, new RegExp(metric + "=0\\.0(?: |$)"));
  result.loaderTrace = trace;
  assert.doesNotMatch(
    gateway.stdout() + gateway.stderr(),
    /Cannot find (?:module|package)|failed to load plugin|(?:initial |background )?refresh failed|building.*Control UI|runtime plugin downloads are disabled/i,
  );
  assert(!fs.existsSync(attempts));
  result.packageManagerInvocations = 0;
} catch (error) {
  primary = error;
} finally {
  if (gateway) {
    if (!gateway.isClosed()) gateway.child.send("stop");
    const code = await finish(gateway, 30000);
    if (code !== 0) primary ??= new Error("The configured gateway did not close successfully.");
    result.gatewayExitCode = code;
  }
  result.verdict = primary ? "fail" : "pass";
  result.error = primary instanceof Error ? primary.message : null;
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
}
if (primary) throw primary;
console.log(
  "PASS prebuilt " +
    choice +
    " registration, fresh convergence and real recurring health; no package manager or channel/search request.",
);
