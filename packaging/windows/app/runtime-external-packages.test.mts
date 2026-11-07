// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { build, transform } from "esbuild";
import {
  compileAsyncProcessEntry,
  compiledModuleLocationPlugin,
  publishDynamicImportBridges,
  publishPluginFacades,
  runtimeExternalPlugin,
  runtimeInputRoot,
} from "./openclaw-app-resources.mts";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sidecar-graph-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, "inputs");
  const source = path.join(inputs, "node_modules/openclaw");
  const app = path.join(root, "app");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(app);
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { flag: "wx" });
  };
  return { root, inputs, source, app, write };
}

test("compiled imports retain nested versions and import/require export conditions", async (t) => {
  const { inputs, source, app, write } = fixture(t);
  write(
    "inputs/node_modules/openclaw/package.json",
    JSON.stringify({ name: "openclaw", type: "module" }),
  );
  write(
    "inputs/node_modules/openclaw/entry.mjs",
    'import {version} from "versioned"; import consumer from "consumer"; export const selected = [version, consumer];',
  );
  write(
    "inputs/node_modules/consumer/package.json",
    JSON.stringify({ name: "consumer", main: "index.cjs" }),
  );
  write("inputs/node_modules/consumer/index.cjs", 'module.exports = require("versioned").version;');
  for (const [folder, version] of [
    ["inputs/node_modules/versioned", "2"],
    ["inputs/node_modules/openclaw/node_modules/versioned", "1"],
  ]) {
    write(
      folder + "/package.json",
      JSON.stringify({
        name: "versioned",
        exports: { import: "./import.mjs", require: "./require.cjs" },
      }),
    );
    write(folder + "/import.mjs", `export const version = "${version}.import";`);
    write(folder + "/require.cjs", `exports.version = "${version}.require";`);
  }
  const output = path.join(app, "openclaw-app.cjs");
  const result = await build({
    entryPoints: [path.join(source, "entry.mjs")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    metafile: true,
    logLevel: "silent",
    plugins: [runtimeExternalPlugin(source, ["versioned"])],
  });
  fs.cpSync(path.join(inputs, "node_modules"), path.join(app, "node_modules"), { recursive: true });
  assert.deepEqual(createRequire(import.meta.url)(output).selected, ["1.import", "2.require"]);
  const imports = Object.values(result.metafile!.outputs).flatMap((item) => item.imports);
  assert(
    imports.some(
      (item) =>
        item.external && item.path === "./node_modules/openclaw/node_modules/versioned/import.mjs",
    ),
  );
  assert(
    imports.some((item) => item.external && item.path === "./node_modules/versioned/require.cjs"),
  );
  assert.equal(runtimeInputRoot(source), inputs);
});

test("sidecar resolution rejects packages outside verified build inputs", async (t) => {
  const { source, app, write } = fixture(t);
  write("inputs/node_modules/openclaw/entry.cjs", 'module.exports = require("outside");');
  write(
    "node_modules/outside/package.json",
    JSON.stringify({ name: "outside", main: "index.cjs" }),
  );
  write("node_modules/outside/index.cjs", "module.exports = 'not an admitted input';");
  await assert.rejects(
    build({
      entryPoints: [path.join(source, "entry.cjs")],
      outfile: path.join(app, "bundle.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      plugins: [runtimeExternalPlugin(source, ["outside"])],
    }),
    /escaped the verified input root/,
  );
});

test("missing required sidecars fail while the approved absent tracing peer stays lazy", async (t) => {
  const { source, app, write } = fixture(t);
  write(
    "inputs/node_modules/openclaw/missing.cjs",
    'module.exports = require("required-sidecar");',
  );
  await assert.rejects(
    build({
      entryPoints: [path.join(source, "missing.cjs")],
      outfile: path.join(app, "missing.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      plugins: [runtimeExternalPlugin(source, ["required-sidecar"])],
    }),
    /Could not resolve/,
  );
  write(
    "inputs/node_modules/openclaw/tracing.cjs",
    'exports.load = () => import("@opentelemetry/api");',
  );
  const result = await build({
    entryPoints: [path.join(source, "tracing.cjs")],
    outfile: path.join(app, "tracing.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    metafile: true,
    logLevel: "silent",
    plugins: [runtimeExternalPlugin(source, ["@opentelemetry/api"])],
  });
  assert(
    Object.values(result.metafile!.outputs)
      .flatMap((item) => item.imports)
      .some((item) => item.path === "@opentelemetry/api" && item.external),
  );
  assert.equal(
    typeof createRequire(import.meta.url)(path.join(app, "tracing.cjs")).load,
    "function",
  );
});

test("runtime source must use the canonical wrapper package location", () => {
  assert.throws(
    () => runtimeInputRoot(path.join(os.tmpdir(), "openclaw")),
    /canonical OpenClaw wrapper layout/,
  );
});

test("dynamic SDK imports use the canonical wrapper and retain ESM export conditions", async (t) => {
  const { app, write } = fixture(t);
  write(
    "app/package.json",
    JSON.stringify({
      name: "openclaw",
      exports: { "./plugin-sdk/extension-shared": "./missing.js" },
    }),
  );
  write(
    "app/node_modules/openclaw/package.json",
    JSON.stringify({
      name: "openclaw",
      exports: {
        "./plugin-sdk/extension-shared": { import: "./import.mjs", require: "./require.cjs" },
      },
    }),
  );
  write("app/node_modules/openclaw/import.mjs", 'export const owner="canonical-import";');
  write("app/node_modules/openclaw/require.cjs", 'exports.owner="wrong-require-condition";');
  write("app/other.mjs", 'export const owner="root-relative";');
  publishDynamicImportBridges(app);
  const load = createRequire(import.meta.url)(path.join(app, "openclaw-dynamic-import.cjs"));
  assert.equal((await load("openclaw/plugin-sdk/extension-shared")).owner, "canonical-import");
  assert.equal((await load("./other.mjs")).owner, "root-relative");
  await assert.rejects(load("openclaw/plugin-sdk/not-exported"), /not defined by "exports"/);
});

test("process facades initialize the compiled owner and load only the selected entry", (t) => {
  const { app, write } = fixture(t);
  const entry = "node_modules/openclaw/dist/infra/owned.worker.js";
  write("app/package.json", '{"type":"module"}');
  write(
    "app/openclaw-app.cjs",
    `
    exports.registerPrebuiltPlugins = async config => {
      if (Object.keys(config).length) throw Error("Unexpected plugin configuration");
      await Promise.resolve();
      globalThis[Symbol.for("nemoclaw.compiled-openclaw.plugins.v1")] = {
        load(key) {
          if (key !== ${JSON.stringify(entry)}) throw Error("Wrong entry");
          process.stdout.write(JSON.stringify({key, args:process.argv.slice(2)}));
          return {answer:42};
        }
      };
    };`,
  );
  publishPluginFacades(app, [
    { path: entry, exports: ["answer"], sourceSha256: "fixture", processEntry: true },
  ]);
  const roots = [app, app + path.sep + "."];
  if (process.platform === "win32") roots.push(app.toUpperCase());
  for (const root of roots) {
    const result = spawnSync(
      process.execPath,
      [path.join(app, entry), "owned-child", "path with spaces"],
      {
        env: { ...process.env, OPENCLAW_COMPILED_ASSET_ROOT: root },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      key: entry,
      args: ["owned-child", "path with spaces"],
    });
  }
});

test("process facades locate their sealed owner in an empty Worker environment", async (t) => {
  const { app, write } = fixture(t);
  const entry = "node_modules/openclaw/dist/state/owned.worker.js";
  write("app/package.json", '{"type":"module"}');
  write(
    "app/openclaw-app.cjs",
    `
    exports.registerPrebuiltPlugins = async () => {
      if(process.env.OPENCLAW_COMPILED_ASSET_ROOT !== __dirname)
        throw Error("The sealed OpenClaw asset root is required.");
      globalThis[Symbol.for("nemoclaw.compiled-openclaw.plugins.v1")] = {load(key){
        if(key !== ${JSON.stringify(entry)}) throw Error("Wrong entry");
        require("node:worker_threads").parentPort.postMessage({
          assetRoot:process.env.OPENCLAW_COMPILED_ASSET_ROOT,
          environmentKeys:Object.keys(process.env)
        });
        return {};
      }};
    };`,
  );
  publishPluginFacades(app, [
    { path: entry, exports: [], sourceSha256: "fixture", processEntry: true },
  ]);
  const worker = new Worker(path.join(app, entry), {
    env: {},
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  const messages: unknown[] = [];
  worker.on("message", (message) => messages.push(message));
  let failure: Error | undefined;
  worker.on("error", (error) => {
    failure = error;
  });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void worker.terminate();
  }, 10_000);
  try {
    assert.equal(await exited, 0, failure?.message);
    assert.equal(expired, false);
    assert.equal(failure, undefined);
    assert.deepEqual(messages, [
      { assetRoot: app, environmentKeys: ["OPENCLAW_COMPILED_ASSET_ROOT"] },
    ]);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});

test("process facades reject a conflicting asset root before loading the owner", (t) => {
  const { app, write } = fixture(t);
  write("app/package.json", '{"type":"module"}');
  write("app/openclaw-app.cjs", 'throw Error("Owner must not load for a conflicting root");');
  publishPluginFacades(app, [
    { path: "worker.js", exports: [], sourceSha256: "fixture", processEntry: true },
  ]);
  for (const root of ["relative-root", path.join(app, "other"), ""]) {
    const result = spawnSync(process.execPath, [path.join(app, "worker.js")], {
      env: { ...process.env, OPENCLAW_COMPILED_ASSET_ROOT: root },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /asset root does not match its compiled owner/);
    assert.doesNotMatch(result.stderr, /Owner must not load/);
    assert.equal(result.stdout, "");
  }
});

test("ordinary plugin facades do not initialize an absent owner", (t) => {
  const { app, write } = fixture(t);
  write("app/package.json", '{"type":"module"}');
  write("app/openclaw-app.cjs", 'throw Error("Owner must not be loaded automatically");');
  publishPluginFacades(app, [{ path: "plugin.js", exports: [], sourceSha256: "fixture" }]);
  const result = spawnSync(process.execPath, [path.join(app, "plugin.js")], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /compiled OpenClaw owner is unavailable/);
  assert.doesNotMatch(result.stderr, /Owner must not be loaded automatically/);
});

test("process facade initialization failure does not reach the worker", (t) => {
  const { app, write } = fixture(t);
  write("app/package.json", '{"type":"module"}');
  write(
    "app/openclaw-app.cjs",
    `
    globalThis[Symbol.for("nemoclaw.compiled-openclaw.plugins.v1")] = {load(){process.stdout.write("must-not-run");}};
    exports.registerPrebuiltPlugins = async () => {throw Error("owned-initialization-failure");};`,
  );
  publishPluginFacades(app, [
    { path: "worker.js", exports: [], sourceSha256: "fixture", processEntry: true },
  ]);
  const result = spawnSync(process.execPath, [path.join(app, "worker.js")], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /owned-initialization-failure/);
  assert.equal(result.stdout, "");
});

test("process facades await asynchronous completion and propagate its rejection", (t) => {
  const { app, write } = fixture(t);
  write("app/package.json", '{"type":"module"}');
  write(
    "app/openclaw-app.cjs",
    `
    exports.registerPrebuiltPlugins = async () => {
      globalThis[Symbol.for("nemoclaw.compiled-openclaw.plugins.v1")] = {load(){return {
        __nemoWorkerCompletion:new Promise((resolve,reject)=>setTimeout(()=>{
          if(process.argv[2] === "fail") reject(Error("owned-worker-completion-failure"));
          else {process.stdout.write("completed\\n");resolve();}
        },20))
      };}};
    };`,
  );
  publishPluginFacades(app, [
    { path: "worker.js", exports: [], sourceSha256: "fixture", processEntry: true },
  ]);
  write("app/driver.mjs", 'await import("./worker.js");process.stdout.write("imported\\n");');
  for (const mode of ["pass", "fail"]) {
    const result = spawnSync(process.execPath, [path.join(app, "driver.mjs"), mode], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(result.status, mode === "pass" ? 0 : 1, result.stderr);
    if (mode === "pass") assert.equal(result.stdout, "completed\nimported\n");
    else {
      assert.match(result.stderr, /owned-worker-completion-failure/);
      assert.equal(result.stdout, "");
    }
  }
});

test("archive worker adaptation refuses source drift and leaves other modules unchanged", () => {
  assert.equal(compileAsyncProcessEntry("dist/unrelated.js", "unchanged"), "unchanged");
  assert.throws(
    () =>
      compileAsyncProcessEntry(
        "dist/config/sessions/session-accessor.sqlite-archive.worker.js",
        "changed",
      ),
    /reviewed asynchronous archive worker changed/,
  );
});

test("setup worker compilation preserves partial results, completion, and reported failures", async () => {
  // Pinned upstream entry; only detection is replaced with a credential-free fixture.
  const original = [
    'import { t as detectSetupInference } from "../setup-inference-detect-QZ_aVC2Y.js";',
    'import { parentPort, workerData } from "node:worker_threads";',
    "//#region src/system-agent/setup-inference-detection.worker.ts",
    'if (!parentPort) throw new Error("setup inference detection worker requires a parent port");',
    "const port = parentPort;",
    "try {",
    '\tconst agentId = workerData && typeof workerData === "object" && typeof workerData.agentId === "string" ? workerData.agentId : void 0;',
    "\tconst detection = await detectSetupInference({ onPartial: (partial) => port.postMessage({",
    '\t\ttype: "partial",',
    "\t\tdetection: partial",
    "\t}) }, agentId);",
    "\tport.postMessage({",
    '\t\ttype: "result",',
    "\t\tdetection",
    "\t});",
    "} catch (error) {",
    "\tport.postMessage({",
    "\t\tok: false,",
    "\t\terror: error instanceof Error ? error.message : String(error)",
    "\t});",
    "} finally {",
    "\tport.close();",
    "}",
    "//#endregion",
    "export {};",
    "",
  ].join("\n");
  const relative = "dist/system-agent/setup-inference-detection.worker.js";
  const adapted = compileAsyncProcessEntry(relative, original);
  assert.throws(
    () => compileAsyncProcessEntry(relative, original + "\n"),
    /reviewed asynchronous setup worker changed/,
  );
  const compiled = await build({
    stdin: { contents: adapted, loader: "js" },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "isolated-detection",
        setup(builder) {
          builder.onResolve({ filter: /setup-inference-detect-QZ_aVC2Y/ }, () => ({
            path: "detection",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `
        export async function t({onPartial}, agentId) {
          onPartial({agentId, complete:false});
          await new Promise(resolve=>setTimeout(resolve,10));
          if(agentId==="fail") throw Error("owned-detection-failure");
          return {agentId, complete:true};
        }`,
            loader: "js",
          }));
        },
      },
    ],
  });
  for (const agentId of ["main", "fail"]) {
    const messages: unknown[] = [];
    let failure: Error | undefined;
    const worker = new Worker(
      compiled.outputFiles[0].text +
        '\nmodule.exports.__nemoWorkerCompletion.then(()=>console.log("completed"));',
      { eval: true, workerData: { agentId }, execArgv: [], stdout: true, stderr: true },
    );
    let stdout = "";
    worker.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    worker.on("message", (message) => messages.push(message));
    worker.on("error", (error) => {
      failure = error;
    });
    const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      void worker.terminate();
    }, 10_000);
    try {
      assert.equal(await exited, 0, failure?.message);
      assert.equal(expired, false);
      assert.equal(failure, undefined);
      assert.equal(stdout.trim(), "completed");
      assert.deepEqual(messages, [
        { type: "partial", detection: { agentId, complete: false } },
        agentId === "fail"
          ? { ok: false, error: "owned-detection-failure" }
          : { type: "result", detection: { agentId, complete: true } },
      ]);
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  }
});

test("bundled dependencies retain module URLs for native createRequire", async (t) => {
  const { source, app, write } = fixture(t);
  write("inputs/node_modules/openclaw/package.json", '{"name":"openclaw"}');
  write("inputs/node_modules/openclaw/entry.mjs", 'export {location, name} from "dependency";');
  write("inputs/node_modules/dependency/package.json", '{"name":"dependency","main":"index.mjs"}');
  write(
    "inputs/node_modules/dependency/index.mjs",
    `
    import {createRequire} from "node:module";
    export const location=import.meta.url;
    export const name=createRequire(import.meta.url)("node:path").basename(__filename);`,
  );
  const output = path.join(app, "bundle.cjs");
  await build({
    entryPoints: [path.join(source, "entry.mjs")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [compiledModuleLocationPlugin(source, { transform })],
    banner: {
      js: `
      function __nemoModuleFilenameFor(relative){return require("node:path").join(${JSON.stringify(app)},relative);}
      function __nemoModuleDirnameFor(relative){return require("node:path").dirname(__nemoModuleFilenameFor(relative));}
      function __nemoModuleUrlFor(relative){return require("node:url").pathToFileURL(__nemoModuleFilenameFor(relative)).href;}`,
    },
  });
  const result = createRequire(import.meta.url)(output);
  assert.equal(result.name, "index.mjs");
  assert.equal(
    new URL(result.location).pathname.endsWith("/app/node_modules/dependency/index.mjs"),
    true,
  );
});

test("module location adaptation refuses source outside verified inputs", async (t) => {
  const { source, app, write } = fixture(t);
  write("inputs/node_modules/openclaw/package.json", '{"name":"openclaw"}');
  write("inputs/node_modules/openclaw/entry.mjs", 'import "outside";');
  write("node_modules/outside/package.json", '{"name":"outside","main":"index.mjs"}');
  write("node_modules/outside/index.mjs", "export const location=import.meta.url;");
  await assert.rejects(
    build({
      entryPoints: [path.join(source, "entry.mjs")],
      outfile: path.join(app, "bundle.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      plugins: [compiledModuleLocationPlugin(source, { transform })],
    }),
    /escaped the verified input root/,
  );
});
