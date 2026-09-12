// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [root, evidence, role, sourceSha] = process.argv.slice(2);
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
