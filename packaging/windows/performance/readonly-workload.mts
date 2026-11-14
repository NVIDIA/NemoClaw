// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { identity, measuredCommand, publishFixtureRecord } from "./measurement.mts";

async function main() {
  const [installRoot, shareRoot, nonce, cacheManifest] = process.argv.slice(2);
  if (
    process.platform !== "win32" ||
    process.arch !== "arm64" ||
    !installRoot ||
    !shareRoot ||
    !/^[a-f0-9]{24}$/u.test(nonce ?? "")
  )
    throw new Error("The installed read-only workload identity is invalid.");
  const expectedNode = path.join(installRoot, "bin", "node.exe");
  if (
    fs.realpathSync(process.execPath).toLowerCase() !== fs.realpathSync(expectedNode).toLowerCase()
  )
    throw new Error("The workload is not running the installed Node executable.");
  const entry = path.join(installRoot, "openclaw", "node_modules", "openclaw", "openclaw.mjs");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(path.dirname(entry), "package.json"), "utf8"),
  ) as { version: string };
  const home = path.join(shareRoot, "home");
  fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".openclaw", "openclaw.json"),
    JSON.stringify({ gateway: { mode: "local" } }) + "\n",
    { flag: "wx" },
  );
  publishFixtureRecord(path.join(shareRoot, "active.json"), {
    schemaVersion: 1,
    nonce,
    processId: process.pid,
    nodeTimeOriginEpochMs: performance.timeOrigin,
    firstScriptObservedEpochMs: Date.now(),
    node: identity(process.execPath),
    entry: identity(entry),
  });
  const gate = path.join(shareRoot, "continue");
  const deadline = performance.now() + 30_000;
  while (!fs.existsSync(gate) && performance.now() < deadline) await delay(50);
  if (!fs.existsSync(gate) || fs.readFileSync(gate, "utf8") !== nonce + "\n")
    throw new Error("The active ACL observation was not acknowledged.");
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_NO_RESPAWN: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  const version = await measuredCommand({
    executable: process.execPath,
    args: [entry, "--version"],
    environment,
    cwd: home,
    timeoutMs: 60_000,
  });
  const config = await measuredCommand({
    executable: process.execPath,
    args: [entry, "config", "get", "gateway.mode"],
    environment,
    cwd: home,
    timeoutMs: 60_000,
  });
  const okay = (value: typeof version) =>
    value.exitCode === 0 &&
    value.closed &&
    !value.timedOut &&
    !value.outputExceeded &&
    value.spawnError === null;
  let passed =
    okay(version) &&
    version.stdout.includes(pkg.version) &&
    okay(config) &&
    config.stdout.trim() === "local";
  let cacheExperiment = null;
  let cacheError: string | null = null;
  if (cacheManifest && passed) {
    try {
      if (!/^[a-f0-9]{64}$/u.test(cacheManifest))
        throw new Error("The cache experiment manifest identity is invalid.");
      const { runCompileCacheExperiment } = await import("./compile-cache-experiment.mts");
      cacheExperiment = await runCompileCacheExperiment({
        node: process.execPath,
        entry,
        home,
        environment,
        evidenceRoot: shareRoot,
        runtimeManifestSha256: cacheManifest,
      });
    } catch (error) {
      passed = false;
      cacheError = error instanceof Error ? error.message : String(error);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  publishFixtureRecord(path.join(shareRoot, "result.json"), {
    cacheExperiment,
    cacheError,
    schemaVersion: 1,
    nonce,
    passed,
    processId: process.pid,
    node: identity(process.execPath),
    openclawEntry: identity(entry),
    openclawVersion: pkg.version,
    version,
    config,
    runtimeTreeCopies: 0,
    runtimeBytesCopied: 0,
    probeScope: "installed Node and OpenClaw version/config commands, not a full agent turn",
  });
  if (!passed) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
