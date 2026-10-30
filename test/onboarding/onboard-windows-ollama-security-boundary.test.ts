// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { ownChildProcess } from "../helpers/child-process-lifecycle";
import { minimalSpawnEnv, testRepoRoot } from "../helpers/onboard-child-process-harness";
import { execTimeout, testTimeout } from "../helpers/timeouts";
import { runNativeDockerWindowsProviderBoundary } from "../support/onboard-selection-test-helpers.js";

const PROVIDER_SELECTION_TEST_TIMEOUT_MS = testTimeout(60_000);
const WINDOWS_EFFECT_MARKERS = /WINDOWS_INSTALL_CALLED|WINDOWS_SETUP_CALLED|WINDOWS_SWITCH_CALLED/;
const WINDOWS_ACTION_MARKERS = new RegExp(
  `MODEL_SELECTION_REACHED|${WINDOWS_EFFECT_MARKERS.source}`,
);

// Both production signal owners run together. Only Windows process and state I/O are fake.
// This proves cleanup ordering. Native WSL installer ownership needs separate host evidence.
const WINDOWS_CANCELLATION_CHILD = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createInterface } = require("node:readline");
const childProcess = require("node:child_process");
const realSpawn = childProcess.spawn;
const source = (name) => path.join(process.cwd(), "src/lib", name);
const session = require(source("state/onboard-session.ts"));
const { registerIncompleteOnboardExitHandlerForSession } = require(source("onboard/onboard-exit-handler.ts"));
const runner = require(source("runner.ts"));
require(source("platform.ts")).isWsl = () => true;
const ledger = process.env.NEMOCLAW_TEST_WINDOWS_CANCEL_LEDGER;
const groupSignal = process.env.NEMOCLAW_TEST_WINDOWS_GROUP_SIGNAL === "1";
const checkpointFile = path.join(path.dirname(ledger), "proxy-checkpoint");
fs.writeFileSync(checkpointFile, "", { mode: 0o600, flag: "wx" });
const state = { userHost: null, cancelConfirmed: false, rollbackCount: 0, lockReleaseCount: 0, unexpectedWindowsCalls: 0, restoreTimedOut: false, restoreChildSignal: null, proxyPid: null, proxySignal: null };
const events = [];
const record = (event) => {
  events.push(event);
  fs.writeFileSync(ledger, JSON.stringify({ ...state, lockFile: session.LOCK_FILE, lockExists: fs.existsSync(session.LOCK_FILE), events }), { mode: 0o600 });
};
const notify = (event) => process.send({ event });
assert.equal(session.acquireOnboardLock("Windows installer cancellation test").acquired, true);
const pendingSession = { lastStepStarted: "inference", status: "failed" };
registerIncompleteOnboardExitHandlerForSession(
  {
    loadSession: () => pendingSession,
    finalizeIncompleteOnboardStep: () => { record("finalize-step"); return pendingSession; },
    releaseOnboardLock: () => {
      session.releaseOnboardLock();
      state.lockReleaseCount += 1;
      record("release-lock");
    },
  },
  () => false,
);
const unexpectedWindowsCall = () => {
  state.unexpectedWindowsCalls += 1;
  record("unexpected-windows-call");
  throw new Error("Unexpected Windows command after installer interruption");
};
const runActions = [
  () => { record("snapshot"); return { status: 0, stdout: JSON.stringify({ userHost: null, watcherPath: null, daemonPath: null }), stderr: "" }; },
  (options) => {
    record("restore-start");
    const result = process.env.NEMOCLAW_TEST_WINDOWS_SLOW_RESTORE === "1"
      ? childProcess.spawnSync(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 15_000)"], { timeout: options.timeout, killSignal: options.killSignal, stdio: "ignore" })
      : { status: 0, stdout: "", stderr: "" };
    state.restoreTimedOut = result.error?.code === "ETIMEDOUT";
    state.restoreChildSignal = result.signal ?? null;
    state.userHost = result.status === 0 ? null : state.userHost;
    state.rollbackCount += Number(result.status === 0);
    record(result.status === 0 ? "restore" : "restore-failed");
    return result;
  },
];
const captureActions = [() => { state.userHost = "127.0.0.1:11434"; record("persist"); return state.userHost; }];
runner.run = (_command, options) => (runActions.shift() ?? unexpectedWindowsCall)(options);
runner.runCapture = () => (captureActions.shift() ?? unexpectedWindowsCall)();
runner.windowsInteropWorkingDirectory = () => "/";
let installer = Object.assign(new EventEmitter(), {
  stdout: new EventEmitter(), stderr: new EventEmitter(),
  kill: () => { record("wrapper-stop"); return true; },
});
const taskkill = new EventEmitter();
const proxyProgram = [
  "const fs = require('node:fs');",
  "const acknowledge = () => fs.readFileSync(process.argv[1], 'utf8') === 'checkpoint' ? (fs.unwatchFile(process.argv[1]), process.stdout.write('__WINDOWS_PROXY_CHECKPOINT__\\n')) : undefined;",
  "fs.watchFile(process.argv[1], { interval: 5 }, acknowledge);",
  "process.stdout.write('__NEMOCLAW_WINDOWS_INSTALLER_PID__:' + process.pid + '\\n');",
  "setTimeout(() => { fs.unwatchFile(process.argv[1]); process.exit(71); }, 15000);",
].join("\n");
const spawns = {
  "powershell.exe": (_args, options) => {
    record("installer-start");
    installer = groupSignal ? realSpawn(process.execPath, ["-e", proxyProgram, checkpointFile], options) : installer;
    groupSignal ? createInterface({ input: installer.stdout }).on("line", (line) => {
      line.startsWith("__NEMOCLAW_WINDOWS_INSTALLER_PID__:") ? notify("ready") : undefined;
      line === "__WINDOWS_PROXY_CHECKPOINT__" ? notify("checkpoint") : undefined;
    }) : queueMicrotask(() => {
      installer.stdout.emit("data", Buffer.from("__NEMOCLAW_WINDOWS_INSTALLER_PID__:4321\n"));
      notify("ready");
    });
    groupSignal ? installer.once("close", (_code, signal) => { state.proxyPid = installer.pid; state.proxySignal = signal; record("proxy-closed"); notify("proxy-closed"); }) : undefined;
    return installer;
  },
  "taskkill.exe": (args) => {
    assert.deepEqual(args, ["/PID", String(installer.pid ?? 4321), "/T", "/F"]);
    record("cancel-start");
    notify("cancel-start");
    return taskkill;
  },
};
childProcess.spawn = (command, args, options) => (spawns[command] ?? unexpectedWindowsCall)(args, options);
const confirmCancellation = () => {
  state.cancelConfirmed = true;
  record("cancel-confirmed");
  taskkill.emit("close", 0);
};
const drainProxy = () => installer.exitCode === null && installer.signalCode === null
  ? (installer.once("close", confirmCancellation), installer.kill("SIGKILL"))
  : taskkill.emit("close", 128);
const commands = {
  checkpoint: () => groupSignal ? fs.writeFileSync(checkpointFile, "checkpoint") : setImmediate(() => setImmediate(() => notify("checkpoint"))),
  drain: () => {
    groupSignal ? drainProxy() : (confirmCancellation(), installer.emit("close", null));
  },
};
process.on("message", (message) => (commands[message.action] ?? unexpectedWindowsCall)());
const { installOllamaOnWindowsHost } = require(source("inference/ollama/windows.ts"));
void installOllamaOnWindowsHost().then(
  () => { record("unexpected-install-success"); process.exitCode = 1; },
  () => record("install-rejected"),
);
`;

type WindowsCancellationLedger = {
  userHost: string | null;
  cancelConfirmed: boolean;
  rollbackCount: number;
  lockReleaseCount: number;
  unexpectedWindowsCalls: number;
  restoreTimedOut: boolean;
  restoreChildSignal: NodeJS.Signals | null;
  proxyPid: number | null;
  proxySignal: NodeJS.Signals | null;
  lockFile: string;
  lockExists: boolean;
  events: string[];
};

function startWindowsCancellationFixture(
  options: { slowRestore?: boolean; groupSignal?: boolean } = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-windows-cancel-"));
  const ledger = path.join(home, "events.json");
  const child = spawn(
    process.execPath,
    [
      "--require",
      path.join(testRepoRoot, "test/helpers/onboard-script-mocks.cjs"),
      "-e",
      WINDOWS_CANCELLATION_CHILD,
    ],
    {
      cwd: testRepoRoot,
      env: minimalSpawnEnv(home, {
        NEMOCLAW_TEST_WINDOWS_CANCEL_LEDGER: ledger,
        NEMOCLAW_TEST_WINDOWS_SLOW_RESTORE: options.slowRestore ? "1" : "0",
        NEMOCLAW_TEST_WINDOWS_GROUP_SIGNAL: options.groupSignal ? "1" : "0",
      }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      timeout: execTimeout(30_000),
      killSignal: "SIGKILL",
      detached: options.groupSignal === true,
    },
  );
  const owner = ownChildProcess(child);
  onTestFinished(async () => {
    child.send({ action: "drain" }, () => {});
    await owner.terminate();
    fs.rmSync(home, { recursive: true, force: true });
  });
  let stderr = "";
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  child.on("error", (error) => {
    stderr = String(error);
  });
  const messages = new Set<string>();
  const waiters = new Map<string, () => void>();
  child.on("message", (message: { event: string }) => {
    messages.add(message.event);
    waiters.get(message.event)?.();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    diagnostics: () => stderr,
    readLedger: () => JSON.parse(fs.readFileSync(ledger, "utf8")) as WindowsCancellationLedger,
    send: (action: "checkpoint" | "drain") => child.send({ action }, () => {}),
    next: (event: string) =>
      Promise.race([
        (messages.has(event)
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiters.set(event, resolve);
            })
        ).then(() => event),
        exited.then(({ code, signal }) => `closed:${signal ?? code}`),
      ]),
  };
}

describe(
  "Windows-host Ollama security boundary",
  { timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS },
  () => {
    it.each([
      { provider: "start-windows-ollama", installed: true },
      { provider: "install-windows-ollama", installed: false },
    ] as const)("rejects $provider on native Docker WSL before launching Ollama", (scenario) => {
      const boundary = runNativeDockerWindowsProviderBoundary({
        ...scenario,
        reachable: false,
        timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
      });

      assert.equal(boundary.status, 1, `${scenario.provider} unexpectedly passed`);
      assert.match(boundary.stderr, /\[non-interactive\] Aborting:/);
      assert.match(boundary.stderr, new RegExp(scenario.provider + " requires Docker Desktop"));
      assert.match(boundary.stderr, /Choose WSL-local Ollama/);
      assert.doesNotMatch(boundary.stderr, WINDOWS_ACTION_MARKERS);
    });

    it.each([
      { provider: "start-windows-ollama", rejectedKey: "start-windows-ollama" },
      { provider: "install-windows-ollama", rejectedKey: "start-windows-ollama" },
    ] as const)(
      "rejects reachable Windows-host Ollama on native Docker WSL [$provider]",
      (scenario) => {
        const boundary = runNativeDockerWindowsProviderBoundary({
          provider: scenario.provider,
          installed: true,
          reachable: true,
          timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
        });

        assert.equal(boundary.status, 1, `${scenario.provider} unexpectedly passed`);
        assert.match(boundary.stderr, /\[non-interactive\] Aborting:/);
        assert.match(
          boundary.stderr,
          new RegExp(scenario.rejectedKey + " requires Docker Desktop"),
        );
        assert.match(boundary.stderr, /Choose WSL-local Ollama/);
        assert.doesNotMatch(boundary.stderr, WINDOWS_ACTION_MARKERS);
      },
    );

    it("routes generic Ollama to WSL-local setup when the Windows route is unprotected", () => {
      const boundary = runNativeDockerWindowsProviderBoundary({
        provider: "ollama",
        installed: true,
        reachable: true,
        timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
      });

      assert.equal(boundary.status, 1);
      assert.match(boundary.stderr, /OLLAMA_READINESS_PROBED/);
      assert.match(boundary.stderr, /MODEL_SELECTION_REACHED/);
      assert.doesNotMatch(boundary.stderr, /requires Docker Desktop/);
      assert.doesNotMatch(boundary.stderr, WINDOWS_EFFECT_MARKERS);
    });

    it.skipIf(process.platform === "win32")(
      "keeps the Windows installer alive for owned cancellation after process-group SIGINT",
      async () => {
        const fixture = startWindowsCancellationFixture({ groupSignal: true });
        expect(await fixture.next("ready"), fixture.diagnostics()).toBe("ready");
        assert.ok(fixture.child.pid);
        expect(process.kill(-fixture.child.pid, "SIGINT")).toBe(true);
        expect(await fixture.next("cancel-start"), fixture.diagnostics()).toBe("cancel-start");
        fixture.send("checkpoint");
        const checkpoint = await Promise.race([
          fixture.next("checkpoint"),
          fixture.next("proxy-closed"),
        ]);
        expect(checkpoint, JSON.stringify(fixture.readLedger())).toBe("checkpoint");
        const pending = fixture.readLedger();
        expect(pending.cancelConfirmed).toBe(false);
        expect(pending.lockReleaseCount).toBe(0);
        expect(fs.existsSync(pending.lockFile)).toBe(true);

        fixture.send("drain");
        expect(await fixture.exited).toEqual({ code: null, signal: "SIGINT" });
        const completed = fixture.readLedger();
        expect(completed.proxySignal).toBe("SIGKILL");
        expect(completed.cancelConfirmed).toBe(true);
        expect(completed.userHost).toBeNull();
        expect(completed.rollbackCount).toBe(1);
        expect(completed.lockReleaseCount).toBe(1);
        expect(completed.unexpectedWindowsCalls).toBe(0);
        expect(fs.existsSync(completed.lockFile)).toBe(false);
        expect(fixture.diagnostics()).not.toContain(
          "Could not confirm that the Windows Ollama installer stopped",
        );
      },
    );

    it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
      "drains Windows installer cancellation before onboarding releases its lock [%s]",
      async (signal) => {
        const fixture = startWindowsCancellationFixture();
        expect(await fixture.next("ready"), fixture.diagnostics()).toBe("ready");
        expect(fixture.child.kill(signal)).toBe(true);
        expect(await fixture.next("cancel-start"), fixture.diagnostics()).toBe("cancel-start");
        fixture.send("checkpoint");
        expect(await fixture.next("checkpoint"), fixture.diagnostics()).toBe("checkpoint");

        const pending = fixture.readLedger();
        expect(pending.cancelConfirmed).toBe(false);
        expect(pending.rollbackCount).toBe(0);
        expect(pending.lockReleaseCount).toBe(0);
        expect(fs.existsSync(pending.lockFile)).toBe(true);

        fixture.send("drain");
        expect(await fixture.exited).toEqual({ code: null, signal });
        const completed = fixture.readLedger();
        expect(completed.cancelConfirmed).toBe(true);
        expect(completed.userHost).toBeNull();
        expect(completed.rollbackCount).toBe(1);
        expect(completed.lockReleaseCount).toBe(1);
        expect(completed.unexpectedWindowsCalls).toBe(0);
        expect(fs.existsSync(completed.lockFile)).toBe(false);
        expect(completed.events.indexOf("cancel-confirmed")).toBeLessThan(
          completed.events.indexOf("restore"),
        );
        expect(completed.events.indexOf("restore")).toBeLessThan(
          completed.events.indexOf("release-lock"),
        );
        expect(fixture.diagnostics()).not.toContain(
          "Could not confirm that the Windows Ollama installer stopped",
        );
      },
    );

    it.skipIf(process.platform === "win32")(
      "bounds Windows state rollback before onboarding releases its lock",
      async () => {
        const fixture = startWindowsCancellationFixture({ slowRestore: true });
        expect(await fixture.next("ready"), fixture.diagnostics()).toBe("ready");
        expect(fixture.child.kill("SIGTERM")).toBe(true);
        expect(await fixture.next("cancel-start"), fixture.diagnostics()).toBe("cancel-start");
        fixture.send("checkpoint");
        expect(await fixture.next("checkpoint"), fixture.diagnostics()).toBe("checkpoint");
        const pending = fixture.readLedger();
        expect(pending.lockReleaseCount).toBe(0);
        expect(fs.existsSync(pending.lockFile)).toBe(true);

        fixture.send("drain");
        expect(await fixture.exited).toEqual({ code: null, signal: "SIGTERM" });
        const failed = fixture.readLedger();
        expect(failed.cancelConfirmed).toBe(true);
        expect(failed.userHost).toBe("127.0.0.1:11434");
        expect(failed.restoreTimedOut).toBe(true);
        expect(failed.restoreChildSignal).toBe("SIGKILL");
        expect(failed.rollbackCount).toBe(0);
        expect(failed.lockReleaseCount).toBe(1);
        expect(failed.unexpectedWindowsCalls).toBe(0);
        expect(fs.existsSync(failed.lockFile)).toBe(false);
        expect(failed.events.indexOf("restore-failed")).toBeLessThan(
          failed.events.indexOf("release-lock"),
        );
        expect(fixture.diagnostics()).toContain(
          "Failed to restore the previous Windows Ollama state",
        );
        expect(fixture.diagnostics()).not.toContain(
          "Could not confirm that the Windows Ollama installer stopped",
        );
      },
    );

    it.skipIf(process.platform === "win32")(
      "bounds unconfirmed Windows installer cancellation without restoring mutable state",
      async () => {
        const fixture = startWindowsCancellationFixture();
        expect(await fixture.next("ready"), fixture.diagnostics()).toBe("ready");
        expect(fixture.child.kill("SIGTERM")).toBe(true);
        expect(await fixture.next("cancel-start"), fixture.diagnostics()).toBe("cancel-start");
        fixture.send("checkpoint");
        expect(await fixture.next("checkpoint"), fixture.diagnostics()).toBe("checkpoint");
        const pending = fixture.readLedger();
        expect(pending.lockReleaseCount).toBe(0);
        expect(fs.existsSync(pending.lockFile)).toBe(true);

        expect(await fixture.exited).toEqual({ code: null, signal: "SIGTERM" });
        const failed = fixture.readLedger();
        expect(failed.cancelConfirmed).toBe(false);
        expect(failed.userHost).toBe("127.0.0.1:11434");
        expect(failed.rollbackCount).toBe(0);
        expect(failed.lockReleaseCount).toBe(1);
        expect(failed.unexpectedWindowsCalls).toBe(0);
        expect(fs.existsSync(failed.lockFile)).toBe(false);
        expect(fixture.diagnostics()).toContain(
          "Could not confirm that the Windows Ollama installer stopped",
        );
        expect(fixture.diagnostics()).toContain(
          "did not restore the previous Windows Ollama state",
        );
      },
    );
  },
);
