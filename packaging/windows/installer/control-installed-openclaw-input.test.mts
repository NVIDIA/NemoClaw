// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { signalObserverStop } from "./observer-stop.mts";

async function heldSentinelControl(reader: string, contents: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-observer-input-"));
  const sentinel = path.join(root, `observer-stop-${"a".repeat(64)}.sentinel`);
  const script = path.join(root, "observer.ps1");
  fs.writeFileSync(
    script,
    `$ErrorActionPreference='Stop'
$stopSentinelPath = '${sentinel.replaceAll("'", "''")}'
${reader}
if (Test-OwnedStopSentinel) { throw 'Stop arrived before discovery.' }
[Console]::Out.WriteLine('before-sentinel'); [Console]::Out.Flush()
[Console]::Out.WriteLine('discovery-entered'); [Console]::Out.Flush()
while (-not (Test-OwnedStopSentinel)) {
  Start-Sleep -Milliseconds 10
}
[Console]::Out.WriteLine('stop-observed'); [Console]::Out.Flush()
`,
  );
  const powershell =
    process.platform === "win32"
      ? path.join(
          process.env.SystemRoot ?? process.env.SYSTEMROOT!,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : "pwsh";
  const child = spawn(powershell, ["-NoProfile", "-File", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "",
    discoveryBeforeSignal = false,
    signalFailure: unknown;
  let signalSent = false;
  let rejectDeadline: ((error: Error) => void) | undefined;
  const deadlineExpired = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (milliseconds: number) => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      child.kill();
      const sentinelState = fs.statSync(sentinel, { throwIfNoEntry: false });
      rejectDeadline!(
        new Error(
          `Sentinel control timed out (signal=${signalSent}, bytes=${sentinelState?.size ?? "absent"}).\n${stdout}${stderr}`,
        ),
      );
    }, milliseconds);
  };
  armDeadline(60_000);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.includes("discovery-entered") && !signalSent) {
      discoveryBeforeSignal = !fs.existsSync(sentinel);
      try {
        if (contents === "") signalObserverStop(sentinel);
        else fs.writeFileSync(sentinel, contents, { flag: "wx" });
        signalSent = true;
        // Measure Stop after publication, not while the parent is publishing it.
        armDeadline(15_000);
      } catch (error) {
        signalFailure = error;
        child.kill();
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const code = await Promise.race([closed, deadlineExpired]);
    if (signalFailure) throw signalFailure;
    return { code, stdout, stderr, discoveryBeforeSignal };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
      child.unref();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the exact observer sentinel preserves discovery before Stop", async () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "control-installed-openclaw.ps1"),
    "utf8",
  );
  const reader = source.match(/^function Test-OwnedStopSentinel \{[\s\S]*?^\}$/mu)?.[0];
  assert(reader);
  assert.doesNotMatch(source, /OpenStandardInput|ReadLine/u);
  const result = await heldSentinelControl(reader, "");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.discoveryBeforeSignal, true);
  assert.match(result.stdout, /stop-observed/u);
});

test("the exact observer sentinel rejects nonempty files", async () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "control-installed-openclaw.ps1"),
    "utf8",
  );
  const reader = source.match(/^function Test-OwnedStopSentinel \{[\s\S]*?^\}$/mu)?.[0];
  assert(reader);
  const result = await heldSentinelControl(reader, "stop\n");
  assert.notEqual(result.code, 0);
  assert.equal(result.discoveryBeforeSignal, true);
  assert.match(result.stderr, /empty regular file/u);
});

test("installed observers receive private runner-owned controls", () => {
  for (const name of ["qualify-installed-openclaw.mts", "qualify-installed-hermes.mts"]) {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), name),
      "utf8",
    );
    assert.match(source, /RUNNER_TEMP: runnerTemp/u);
    assert.match(source, /NEMOCLAW_OBSERVER_CONTROLLER_PID: String\(process\.pid\)/u);
    assert.match(source, /NEMOCLAW_OBSERVER_STOP_SENTINEL: observerStopSentinel/u);
    assert.match(source, /stdio: \["ignore", "pipe", "pipe"\]/u);
  }
});

test("Stop exclusively creates an empty file and refuses existing paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observer-stop-"));
  const sentinel = path.join(root, "stop.sentinel");
  try {
    signalObserverStop(sentinel);
    assert.equal(fs.statSync(sentinel).size, 0);
    assert.throws(() => signalObserverStop(sentinel), { code: "EEXIST" });
    fs.writeFileSync(sentinel, "retain");
    assert.throws(() => signalObserverStop(sentinel), { code: "EEXIST" });
    assert.equal(fs.readFileSync(sentinel, "utf8"), "retain");
    assert.throws(() => signalObserverStop(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
