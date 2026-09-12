// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [root, evidence, role, sourceSha, requireDesktop] = process.argv.slice(2);
process.chdir(root);
assert.equal(
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  sourceSha,
);
const runner = require(path.join(root, "dist/lib/runner.js"));
const local = require(path.join(root, "dist/lib/inference/local.js"));
const { detectWindowsHostOllama } = require(
  path.join(root, "dist/lib/onboard/windows-host-ollama.js"),
);
const host = detectWindowsHostOllama();
assert.equal(host.installed, true);
assert.equal(host.loopbackOnly, true);
assert.equal(local.detectLocalTcpListener(11434), false);
const windowsPath = path.join(root, "dist/lib/inference/ollama/windows.js");
const realRun = runner.run;
const realCapture = runner.runCapture;
const realError = console.error;
let captured;
let suppressedMutations = 0;
let outcome;
runner.run = (command, options) => {
  if (captured) {
    suppressedMutations++;
    return { status: 0, stdout: "", stderr: "" };
  }
  const result = realRun(command, { ...options, timeout: 15000 });
  captured = {
    status: result.status,
    error: result.error?.message,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
  return result;
};
// Permit the production read, then stop at the first attempted mutation. No Windows state is written.
runner.runCapture = () => {
  suppressedMutations++;
  return "";
};
console.error = () => {};
try {
  delete require.cache[require.resolve(windowsPath)];
  outcome = require(windowsPath).setupWindowsOllamaLoopbackBinding();
} finally {
  runner.run = realRun;
  runner.runCapture = realCapture;
  console.error = realError;
  delete require.cache[require.resolve(windowsPath)];
}
assert.equal(captured?.status, 0, captured?.stderr);
assert.equal(captured?.error, undefined);
const snapshot = JSON.parse(captured.stdout);
assert.equal(snapshot.daemonPath, host.installedPath);
const report = {
  sourceSha,
  role,
  installed: true,
  loopbackOnly: true,
  watcherPath: snapshot.watcherPath,
  daemonPath: snapshot.daemonPath,
  outcome,
  suppressedMutations,
  mutationBoundaryStubbed: true,
};
fs.writeFileSync(path.join(evidence, "snapshot.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (role === "base") {
  assert.deepEqual(snapshot.watcherPath, {});
  assert.equal(outcome.reason, "snapshot");
  assert.equal(suppressedMutations, 0);
} else {
  assert.equal(snapshot.watcherPath, null);
  assert.equal(outcome.reason, "binding");
  assert.ok(suppressedMutations > 0);
}

if (requireDesktop === "true") {
  const tags = spawnSync(
    "curl",
    [
      "--noproxy",
      "*",
      "-fsS",
      "--connect-timeout",
      "5",
      "--max-time",
      "15",
      "http://host.docker.internal:11434/api/tags",
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  fs.writeFileSync(
    path.join(evidence, "wsl-direct-api.json"),
    JSON.stringify({ status: tags.status, stdout: tags.stdout, stderr: tags.stderr }, null, 2),
  );
  const { detectInferenceProviderHostState } = require(
    path.join(root, "dist/lib/onboard/provider-host-state.js"),
  );
  const state = detectInferenceProviderHostState({
    gpu: null,
    experimental: false,
    probeVllm: false,
  });
  fs.writeFileSync(path.join(evidence, "desktop-discovery.json"), JSON.stringify(state, null, 2));
  assert.equal(state.isWindowsHostOllama, true);
  assert.equal(state.ollamaRunning, true);
  assert.equal(state.ollamaHost, "host.docker.internal");
  const program = `process.chdir(${JSON.stringify(root)}); const fs=require('node:fs'); const {setupNim}=require(${JSON.stringify(path.join(root, "dist/lib/onboard.js"))}); const {loadAgent}=require(${JSON.stringify(path.join(root, "dist/lib/agent/defs.js"))}); Promise.resolve(setupNim(null,null,loadAgent('hermes'))).then(result=>{fs.writeFileSync(${JSON.stringify(path.join(evidence, "provider-result.json"))},JSON.stringify(result,null,2));}).catch(error=>{console.error(error.stack);process.exitCode=1;});`;
  const programPath = path.join(evidence, "provider-stage.cjs");
  fs.writeFileSync(programPath, program);
  const selection = spawnSync(process.execPath, [programPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 300000,
    env: {
      ...process.env,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_PROVIDER: "install-windows-ollama",
      NEMOCLAW_MODEL: "qwen3.5:0.8b",
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    },
  });
  fs.writeFileSync(
    path.join(evidence, "provider-selection.log"),
    String(selection.stdout ?? "") + String(selection.stderr ?? ""),
  );
  assert.equal(selection.status, 0, selection.stderr);
  const selected = JSON.parse(fs.readFileSync(path.join(evidence, "provider-result.json"), "utf8"));
  assert.equal(selected.provider, "ollama-local");
  assert.equal(selected.model, "qwen3.5:0.8b");
}
