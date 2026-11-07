// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Failure-only diagnostic, never installer acceptance. Exercise the unchanged
// compiled worker with synthetic SQLite data and a separate diagnostic preload.
// The preload adds fixed phase timings to its PowerShell child, not acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteReadonlyWorkerDiagnostics } from "./choice-inspect-diagnostics.mts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  assert(index >= 0 && process.argv[index + 1], `Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}
const app = argument("--app-root");
const owner = argument("--process-owner");
const output = argument("--output");
assert.equal(process.platform, "win32");
assert.equal(process.arch, "arm64");
assert.equal(process.versions.node, "22.23.2");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const entry = path.join(app, "openclaw-app.cjs");
const worker = path.join(
  app,
  "node_modules/openclaw/dist/infra/sqlite-readonly-location.worker.js",
);
const appSha256 = hash(entry),
  workerSha256 = hash(worker),
  ownerSha256 = hash(owner);
assert.equal(
  JSON.parse(fs.readFileSync(path.join(app, "openclaw-resource-closure.json"), "utf8")).compiler
    .mainSha256,
  appSha256,
);
assert.equal(fs.existsSync(output), false, "Diagnostic output must be fresh.");
fs.mkdirSync(output, { recursive: true });
const preload = path.join(output, "readonly-diagnostics.cjs");
fs.writeFileSync(preload, sqliteReadonlyWorkerDiagnostics, { flag: "wx" });
const result = {
  schemaVersion: 1,
  classification: "compiled-sqlite-readonly-diagnostic",
  installedAcceptance: false,
  instrumented: true,
  powerShellPhaseInstrumentation: true,
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  appSha256,
  workerSha256,
  ownerSha256,
  cases: [] as {
    scenario: string;
    timedOut: boolean;
    forcedOwnerStop: boolean;
    ownerExitCode: number | null;
    jobDrained: boolean;
    snapshotRetained: boolean;
    syntheticStateRemoved: boolean;
    elapsedMs: number;
    failed: boolean;
  }[],
};
try {
  for (const journal of ["DELETE", "WAL"] as const) {
    const scenario = journal === "WAL" ? "wal-held" : "delete-closed";
    const root = path.join(output, scenario),
      home = path.join(root, "synthetic-home");
    fs.mkdirSync(home, { recursive: true });
    const stop = path.join(root, "stop"),
      receipt = path.join(root, "stopped.json");
    const nonce = randomBytes(24).toString("hex"),
      started = performance.now();
    const row = {
      scenario,
      timedOut: false,
      forcedOwnerStop: false,
      ownerExitCode: null as number | null,
      jobDrained: false,
      snapshotRetained: false,
      syntheticStateRemoved: false,
      elapsedMs: 0,
      failed: true,
    };
    result.cases.push(row);
    let source: DatabaseSync | undefined;
    let launched = false;
    try {
      const input = path.join(home, "source.sqlite");
      source = new DatabaseSync(input);
      source.exec(`PRAGMA journal_mode=${journal}; CREATE TABLE probe(value TEXT);
        INSERT INTO probe VALUES ('synthetic snapshot retained');`);
      if (journal === "DELETE") {
        source.close();
        source = undefined;
      }
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env))
        if (
          [
            "systemroot",
            "windir",
            "systemdrive",
            "comspec",
            "pathext",
            "programfiles",
            "programfiles(x86)",
            "os",
            "processor_architecture",
          ].includes(key.toLowerCase())
        )
          env[key] = value;
      const systemRoot = Object.entries(env).find(
        ([key]) => key.toLowerCase() === "systemroot",
      )?.[1];
      assert(systemRoot && path.isAbsolute(systemRoot));
      Object.assign(env, {
        PATH: [path.dirname(process.execPath), path.join(systemRoot, "System32"), systemRoot].join(
          path.delimiter,
        ),
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: home,
        APPDATA: home,
        TEMP: home,
        TMP: home,
        OPENCLAW_COMPILED_ASSET_ROOT: app,
        NODE_DISABLE_COMPILE_CACHE: "1",
      });
      // Reuse the tested owner: assignment to a non-breakaway Windows job occurs
      // at process creation. A stop drains Node and its PowerShell descendants.
      const child = spawn(
        owner,
        [
          "--owner",
          process.execPath,
          stop,
          receipt,
          nonce,
          "--require",
          preload,
          worker,
          "--openclaw-sqlite-readonly-child",
          "async",
          input,
        ],
        { cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      launched = true;
      let stdout = "",
        stderr = "",
        spawnFailed = false;
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk.toString()).slice(0, 65536);
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(0, 262144);
      });
      child.once("error", () => {
        spawnFailed = true;
      });
      const stopTimer = setTimeout(() => {
        row.timedOut = true;
        try {
          fs.writeFileSync(stop + ".pending", nonce, { flag: "wx" });
          fs.renameSync(stop + ".pending", stop);
        } catch {
          row.forcedOwnerStop = true;
          child.kill();
        }
      }, 30000);
      const killTimer = setTimeout(() => {
        row.forcedOwnerStop = true;
        child.kill();
      }, 45000);
      try {
        row.ownerExitCode = await new Promise<number | null>((resolve) =>
          child.once("close", resolve),
        );
      } finally {
        clearTimeout(stopTimer);
        clearTimeout(killTimer);
        // Never retain worker stdout, exception text, arguments, or environment.
        const trace = stderr
          .split(/\r?\n/u)
          .filter((line) =>
            /^\[nemoclaw-(?:choice-child|snapshot-backup|private-directory)\] \{/u.test(line),
          )
          .join("\n");
        fs.writeFileSync(path.join(output, scenario + ".trace.log"), trace + "\n", { flag: "wx" });
      }
      const drained = JSON.parse(fs.readFileSync(receipt, "utf8"));
      assert.equal(drained.schemaVersion, 1);
      assert.equal(drained.nonce, nonce);
      assert.equal(drained.activeProcesses, 0);
      assert.equal(drained.stopped, true);
      row.jobDrained = true;
      assert.equal(row.timedOut || row.forcedOwnerStop || spawnFailed, false);
      assert.equal(row.ownerExitCode, 0);
      assert.equal(drained.requested, false);
      assert.equal(drained.gatewayExitCode, 0);
      const snapshot = JSON.parse(stdout);
      assert.equal(snapshot.ok, true);
      assert.equal(typeof snapshot.location, "string");
      const relative = path.relative(home, snapshot.location);
      assert(
        relative &&
          !path.isAbsolute(relative) &&
          relative !== ".." &&
          !relative.startsWith(".." + path.sep),
      );
      const database = new DatabaseSync(snapshot.location, { readOnly: true });
      try {
        assert.equal(
          database.prepare("SELECT value FROM probe").get()?.value,
          "synthetic snapshot retained",
        );
      } finally {
        database.close();
      }
      row.snapshotRetained = true;
      assert.equal(hash(entry), appSha256);
      assert.equal(hash(worker), workerSha256);
      row.failed = false;
    } catch {
      // Stage markers and fixed booleans are sufficient; no raw error export.
      row.failed = true;
    } finally {
      try {
        source?.close();
        if (!launched || row.jobDrained) {
          fs.rmSync(home, { recursive: true, force: true });
          row.syntheticStateRemoved = !fs.existsSync(home);
        }
      } catch {
        row.failed = true;
      }
      row.elapsedMs = Math.round(performance.now() - started);
    }
  }
} finally {
  fs.writeFileSync(
    path.join(output, "readonly-diagnostic.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
}
if (result.cases.some((row) => row.failed || !row.syntheticStateRemoved))
  throw new Error(
    "Readonly worker diagnostic failed; inspect the bounded stage trace and cleanup receipt.",
  );
console.log("Readonly worker diagnostic completed; this is not installed acceptance.");
