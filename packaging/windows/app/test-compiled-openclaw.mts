// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}
const inputApp = argument("--app-root");
const output = argument("--output");
const portable = process.argv.includes("--portable-proof");
if (
  !portable &&
  (process.platform !== "win32" || process.arch !== "arm64" || process.versions.node !== "22.23.2")
)
  throw new Error("Compiled app controls require the canonical Windows ARM64 Node.");
assert.equal(fs.existsSync(output), false, "Control output must be fresh.");
fs.mkdirSync(output, { recursive: true });
const app = path.join(output, "isolated-code-unit");
fs.mkdirSync(app);
for (const name of ["openclaw-app.cjs", "openclaw-dynamic-import.cjs"])
  fs.copyFileSync(path.join(inputApp, name), path.join(app, name), fs.constants.COPYFILE_EXCL);
assert.equal(fs.existsSync(path.join(app, "node_modules")), false);
const state = path.join(output, "state");
fs.mkdirSync(state);
const entry = path.join(app, "openclaw-app.cjs");
const env: NodeJS.ProcessEnv = {};
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
  if (key) env[key] = process.env[key];
}
Object.assign(env, {
  HOME: state,
  USERPROFILE: state,
  LOCALAPPDATA: state,
  APPDATA: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_HOME: state,
  OPENCLAW_COMPILED_ASSET_ROOT: app,
  NODE_DISABLE_COMPILE_CACHE: "1",
  OPENCLAW_NO_RESPAWN: "1",
});
const results: { control: string; passed: boolean; stdout: string }[] = [];
const direct = spawnSync(process.execPath, [entry, "--version"], {
  cwd: app,
  env,
  encoding: "utf8",
  timeout: 30000,
  maxBuffer: 1024 * 1024,
});
fs.writeFileSync(
  path.join(output, "direct-version.log"),
  (direct.stdout ?? "") + (direct.stderr ?? ""),
);
assert.equal(direct.status, 0, direct.stderr);
assert.match(direct.stdout, /OpenClaw 2026\.7\.1/);
results.push({
  control: "direct-version-without-node-modules",
  passed: true,
  stdout: direct.stdout.trim(),
});
const worker = new Worker(
  `const {workerData}=require("node:worker_threads");
process.argv=[process.execPath,workerData,"--version"];
const api=require(workerData);
if(typeof api.runCli!=="function"||typeof api.runOpenClaw!=="function")throw Error("Missing compiled API");
api.runOpenClaw(process.argv).catch(error=>{console.error(error);process.exitCode=1;});`,
  { eval: true, workerData: entry, env, stdout: true, stderr: true, execArgv: [] },
);
let stdout = "";
let stderr = "";
worker.stdout.on("data", (bytes: Buffer) => {
  stdout = (stdout + bytes.toString("utf8")).slice(-65536);
});
worker.stderr.on("data", (bytes: Buffer) => {
  stderr = (stderr + bytes.toString("utf8")).slice(-65536);
});
const timeout = setTimeout(() => void worker.terminate(), 30000);
let exitCode: number;
try {
  exitCode = await new Promise<number>((resolve, reject) => {
    worker.once("exit", resolve);
    worker.once("error", reject);
  });
} finally {
  clearTimeout(timeout);
}
fs.writeFileSync(path.join(output, "worker-version.log"), stdout + stderr);
assert.equal(exitCode, 0, stderr);
assert.match(stdout, /OpenClaw 2026\.7\.1/);
results.push({
  control: "owned-worker-import-and-explicit-api-without-node-modules",
  passed: true,
  stdout: stdout.trim(),
});
fs.writeFileSync(
  path.join(state, "openclaw.json"),
  JSON.stringify({
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: "owned-compiler-control-token" },
    },
  }),
);
const config = spawnSync(process.execPath, [entry, "config", "validate", "--json"], {
  cwd: app,
  env,
  encoding: "utf8",
  timeout: 45000,
  maxBuffer: 1024 * 1024,
});
fs.writeFileSync(
  path.join(output, "config-validate.log"),
  (config.stdout ?? "") + (config.stderr ?? ""),
);
assert.equal(config.status, 0, config.stderr);
assert.equal((JSON.parse(config.stdout) as { valid?: boolean }).valid, true);
results.push({
  control: "actual-config-validation-without-node-modules",
  passed: true,
  stdout: config.stdout.trim(),
});
fs.writeFileSync(
  path.join(output, "compiled-controls.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      classification: "actual-compiled-code-controls",
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      portableProof: portable,
      neighboringDependencyTreeAbsent: true,
      sourceTreeIsolationVerified: false,
      originalBuildTreeAccess:
        "Not asserted by this script; a separate OS-denied control records that boundary.",
      controls: results,
      runtimeClosureProven: false,
      agentResponseQualified: false,
    },
    null,
    2,
  ) + "\n",
);
console.log("PASS: compiled CLI, owned Worker API, and configuration validation.");
