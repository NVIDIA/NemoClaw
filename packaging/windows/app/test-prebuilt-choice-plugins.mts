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
import { choiceInspectChildDiagnostics } from "./choice-inspect-diagnostics.mts";
import {
  nativeOpenClawOptions,
  normalizeNativeOptions,
  type NativeOptions,
} from "../runtime/native-options.mts";
function javascriptStringLiteral(value: string) {
  return JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
const argument = (name: string) => {
  const i = process.argv.indexOf(name);
  assert(i >= 0 && process.argv[i + 1]);
  return process.argv[i + 1];
};
const app = path.resolve(argument("--app-root")),
  output = path.resolve(argument("--output")),
  choice = argument("--choice");
assert(["brave", "slack", "tavily"].includes(choice));
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
const selected = nativeOpenClawOptions(normalizeNativeOptions("openclaw", options));
const config = {
  ...selected,
  plugins: { ...selected.plugins, load: { paths: [path.join(app, "plugins", choice)] } },
  update: { checkOnStart: false, auto: { enabled: false } },
  // Plugin convergence does not exercise inference or the mutable public catalog.
  // Keep the installed product's native catalog-refresh default unchanged.
  models: { catalogRefresh: { enabled: false } },
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
  // Gateway startup tracing does not cover `plugins inspect`. Keep the pinned
  // runtime's plugin phase timings in the existing bounded stderr evidence.
  OPENCLAW_PLUGIN_LIFECYCLE_TRACE: "1",
  NODE_DISABLE_COMPILE_CACHE: "1",
});
const systemRoot = Object.entries(env).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1];
env.PATH = [
  path.dirname(process.execPath),
  ...(systemRoot ? [path.join(systemRoot, "System32"), systemRoot] : ["/usr/bin", "/bin"]),
].join(path.delimiter);
const attempts = path.join(output, "package-manager-attempt");
const trap = `const cp=require("node:child_process"),fs=require("node:fs");for(const name of ["spawn","spawnSync","execFile","execFileSync"]){const original=cp[name];cp[name]=function(...args){if(/(?:npm|npx|pnpm|yarn|pip)(?:\\b|[-.])/i.test(JSON.stringify(args.slice(0,2)))){fs.appendFileSync(${javascriptStringLiteral(attempts)},name+"\\n");throw Error("Unexpected package-manager invocation");}return original.apply(this,args);};}require("node:module").syncBuiltinESMExports();`;
function start(label: string, source: string) {
  const file = path.join(output, label + ".cjs");
  fs.writeFileSync(
    file,
    trap + (label === "inspect" ? choiceInspectChildDiagnostics : "") + source,
    { flag: "wx" },
  );
  const child = spawn(process.execPath, [file], {
    cwd: app,
    env:
      label === "inspect"
        ? {
            ...env,
            // The Windows failure enters the CLI but does not finish it. Upstream
            // start/end spans locate the pending bootstrap operation in this
            // synthetic, credential-free fixture without changing its deadline.
            OPENCLAW_DIAGNOSTICS: "1",
            OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: path.join(output, "inspect.timeline.log"),
          }
        : env,
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
function command(label: string, args: string[]) {
  return start(
    label,
    `const entry=${JSON.stringify(code)};process.argv=[process.execPath,entry,...${JSON.stringify(args)}];require(entry).runCli(process.argv).catch(error=>{console.error(error);process.exitCode=1;});`,
  );
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
  remoteModelCatalogTested: false,
  windowsQualified: false,
};
try {
  fs.writeFileSync(path.join(state, "openclaw.json"), JSON.stringify(config));
  const registered = path.join(output, "registered.json");
  const inspect = start(
    "inspect",
    // Fixed stage names and elapsed times distinguish a blocked CLI from a child
    // that finished its work but did not exit. Do not print configuration values.
    `const started=performance.now(),mark=stage=>console.error("[nemoclaw-choice-inspect] "+stage+" elapsedMs="+Math.round(performance.now()-started));mark("load-start");const entry=${JSON.stringify(code)},api=require(entry);mark("load-finished");process.argv=[process.execPath,entry,"plugins","inspect",${JSON.stringify(choice)},"--runtime","--json"];api.registerPrebuiltPlugins(${JSON.stringify(config)}).then(result=>{fs.writeFileSync(${JSON.stringify(registered)},JSON.stringify(result));mark("registration-finished");mark("cli-start");return api.runCli(process.argv);}).then(()=>mark("cli-finished")).catch(error=>{mark("failed");console.error(error);process.exitCode=1;});`,
  );
  assert.equal(await finish(inspect, 30000), 0, inspect.stderr());
  assert.deepEqual(JSON.parse(fs.readFileSync(registered, "utf8")).registered, [choice]);
  let report = JSON.parse(inspect.stdout());
  assert.equal(report.plugin?.id, choice);
  assert.equal(report.plugin?.status, "loaded");
  assert.equal(report.plugin?.imported, true);
  assert.equal(report.install?.source, "path");
  assert.equal(report.install?.installPath, path.join(app, "plugins", choice));
  assert.equal(report.install?.sourcePath, report.install.installPath);
  assert.equal(report.install?.version, "2026.9.2");
  assert.equal(report.install.acceptedSurface, undefined);
  assert.equal(report.diagnostics.length, 1);
  assert.match(report.diagnostics[0].message, /requires capability consent/);
  // Explicit fixture approval, not installer behavior. The browser control owns
  // the user-facing Cancel/Accept path; this control covers each packaged choice.
  const disabled = command("disable", ["plugins", "disable", choice]);
  assert.equal(await finish(disabled, 30000), 0, disabled.stderr());
  const denied = command("enable-without-consent", ["plugins", "enable", choice]);
  assert.equal(await finish(denied, 30000), 1, denied.stderr());
  assert.match(denied.stderr(), /requires capability consent/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state, "openclaw.json"), "utf8")).plugins.entries[choice]
      .enabled,
    false,
  );
  const accepted = command("enable-with-consent", [
    "plugins",
    "enable",
    choice,
    "--accept-capabilities",
  ]);
  assert.equal(await finish(accepted, 30000), 0, accepted.stderr());
  const verified = command("inspect-after-consent", [
    "plugins",
    "inspect",
    choice,
    "--runtime",
    "--json",
  ]);
  assert.equal(await finish(verified, 30000), 0, verified.stderr());
  report = JSON.parse(verified.stdout());
  assert.equal(report.plugin?.status, "loaded");
  assert.equal(report.plugin?.imported, true);
  assert.equal(report.install.source, "path");
  assert(report.install.acceptedSurface);
  assert.match(report.install.acceptedSurfaceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.diagnostics, []);
  const acceptedSurfaceHash = report.install.acceptedSurfaceHash;
  const acceptedSurfaceIntegrity = report.install.acceptedSurfaceIntegrity;
  assert.equal(acceptedSurfaceIntegrity, report.install.integrity);
  assert.match(acceptedSurfaceIntegrity, /^sha256-[A-Za-z0-9+/]{43}=$/);
  const registeredAgain = start(
    "register-after-consent",
    `const entry=${JSON.stringify(code)};require(entry).registerPrebuiltPlugins(${JSON.stringify(config)}).catch(error=>{console.error(error);process.exitCode=1;});`,
  );
  assert.equal(await finish(registeredAgain, 30000), 0, registeredAgain.stderr());
  const persisted = command("inspect-after-registration", [
    "plugins",
    "inspect",
    choice,
    "--runtime",
    "--json",
  ]);
  assert.equal(await finish(persisted, 30000), 0, persisted.stderr());
  const afterRegistration = JSON.parse(persisted.stdout());
  assert.equal(afterRegistration.install.acceptedSurfaceHash, acceptedSurfaceHash);
  assert.equal(afterRegistration.install.acceptedSurfaceIntegrity, acceptedSurfaceIntegrity);
  assert.deepEqual(afterRegistration.diagnostics, []);
  result.capabilityConsent = {
    missingConsentDenied: true,
    explicitlyAccepted: true,
    acceptancePersisted: true,
  };
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
      controlUi: {
        root: path.join(app, "node_modules/openclaw/dist/control-ui"),
        allowedOrigins: [origin],
      },
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
