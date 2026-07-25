// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { DockerProbe } from "../fixtures/docker-probe.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import {
  type AbortSignalSource,
  ShellProbe,
  trustedShellCommand,
} from "../fixtures/shell-probe.ts";

async function createShellProbe(signal: AbortSignalSource): Promise<ShellProbe> {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-signal-"));
  const artifacts = new ArtifactSink(artifactRoot);
  await artifacts.ensureRoot();
  const progress = startTestProgress(
    "cleanup signal support",
    ["exercise cleanup signal", "verify cleanup signal"],
    {
      clearTimer: () => undefined,
      logLine: () => undefined,
      setTimer: () => ({}),
    },
  );
  onTestFinished(() => {
    progress.stop();
    fs.rmSync(artifactRoot, { force: true, recursive: true });
  });
  return new ShellProbe({
    artifacts,
    progress,
    redact: (text) => text,
    signal,
  });
}

it("cleanup commands receive a fresh signal after the test signal is aborted", async () => {
  const testController = new AbortController();
  const cleanup = new CleanupRegistry((text) => text, undefined, {
    testSignal: testController.signal,
  });
  const observedSignals: AbortSignal[] = [];
  const probe = await createShellProbe(() => {
    const signal = cleanup.currentSignal();
    observedSignals.push(signal);
    return signal;
  });
  let cleanupSignalWasLive = false;
  let cleanupExitCode: number | null | undefined;
  cleanup.add("run cleanup command", async () => {
    const signal = cleanup.currentSignal();
    cleanupSignalWasLive = signal !== testController.signal && !signal.aborted;
    const result = await probe.run(
      trustedShellCommand({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        reason: "verify cleanup commands outlive the test signal",
      }),
      { artifactName: "fresh-cleanup-signal", timeoutMs: 5_000 },
    );
    cleanupExitCode = result.exitCode;
  });

  testController.abort();
  expect(cleanup.currentSignal()).toBe(testController.signal);
  expect(cleanup.currentSignal().aborted).toBe(true);

  const result = await cleanup.runAll();

  expect(result).toEqual({ passed: ["run cleanup command"], failures: [] });
  expect(cleanupSignalWasLive).toBe(true);
  expect(cleanupExitCode).toBe(0);
  expect(observedSignals).toHaveLength(1);
  expect(observedSignals[0]).not.toBe(testController.signal);
  expect(cleanup.currentSignal()).toBe(testController.signal);
  expect(cleanup.currentSignal().aborted).toBe(true);
});

it("normal commands retain cancellation from the original test signal", async () => {
  const testController = new AbortController();
  const cleanup = new CleanupRegistry((text) => text, undefined, {
    testSignal: testController.signal,
  });
  const probe = await createShellProbe(() => cleanup.currentSignal());

  const run = probe.run(
    trustedShellCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      reason: "verify normal commands retain test cancellation",
    }),
    {
      artifactName: "normal-command-test-signal",
      killGraceMs: 25,
      timeoutMs: 5_000,
    },
  );
  setTimeout(() => testController.abort(), 50).unref();
  const result = await run;

  expect(result.signal).toMatch(/^SIG(TERM|KILL)$/);
  expect(result.timedOut).toBe(false);
  expect(cleanup.currentSignal()).toBe(testController.signal);
});

it("shell and Docker probes latch their signal source once per command", async () => {
  const originalController = new AbortController();
  const preAbortedController = new AbortController();
  preAbortedController.abort();
  let activeSignal = originalController.signal;
  const shellSignals: AbortSignal[] = [];
  const shellProbe = await createShellProbe(() => {
    shellSignals.push(activeSignal);
    return activeSignal;
  });

  const shellRun = shellProbe.run(
    trustedShellCommand({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 50)"],
      reason: "verify each shell command latches its starting signal",
    }),
    { artifactName: "latched-shell-signal", timeoutMs: 5_000 },
  );
  activeSignal = preAbortedController.signal;
  const shellResult = await shellRun;

  expect(shellResult.exitCode).toBe(0);
  expect(shellSignals).toEqual([originalController.signal]);

  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-signal-"));
  const artifacts = new ArtifactSink(artifactRoot);
  await artifacts.ensureRoot();
  onTestFinished(() => fs.rmSync(artifactRoot, { force: true, recursive: true }));
  activeSignal = originalController.signal;
  const dockerSignals: AbortSignal[] = [];
  const dockerProbe = new DockerProbe(
    artifacts,
    (text) => text,
    () => ({
      error: undefined,
      output: [null, "", ""],
      pid: 1,
      signal: null,
      status: 0,
      stderr: "",
      stdout: "",
    }),
    undefined,
    () => {
      dockerSignals.push(activeSignal);
      return activeSignal;
    },
  );

  const firstDockerRun = dockerProbe.run(["version"], { artifactName: "first-signal" });
  activeSignal = preAbortedController.signal;
  await firstDockerRun;
  await dockerProbe.run(["info"], { artifactName: "second-signal" });

  expect(dockerSignals).toEqual([originalController.signal, preAbortedController.signal]);
});

it("the shared cleanup deadline aborts commands without skipping later callbacks", async () => {
  const testController = new AbortController();
  const cleanup = new CleanupRegistry((text) => text, undefined, {
    testSignal: testController.signal,
    timeoutMs: 75,
  });
  const probe = await createShellProbe(() => cleanup.currentSignal());
  const callbacks: string[] = [];
  let commandSignal: NodeJS.Signals | null | undefined;
  let commandTimedOut: boolean | undefined;
  cleanup.add("release later resource", () => {
    callbacks.push("later resource");
  });
  cleanup.add("stop hanging command", async () => {
    callbacks.push("command started");
    const result = await probe.run(
      trustedShellCommand({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        reason: "verify the cleanup command deadline",
      }),
      {
        artifactName: "cleanup-deadline",
        killGraceMs: 25,
        timeoutMs: 5_000,
      },
    );
    commandSignal = result.signal;
    commandTimedOut = result.timedOut;
    callbacks.push("command finished");
  });

  const startedAt = Date.now();
  const result = await cleanup.runAll();

  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(commandSignal).toMatch(/^SIG(TERM|KILL)$/);
  expect(commandTimedOut).toBe(false);
  expect(callbacks).toEqual(["command started", "command finished", "later resource"]);
  expect(result).toEqual({
    passed: ["stop hanging command", "release later resource"],
    failures: [],
  });
  expect(cleanup.currentSignal()).toBe(testController.signal);
});

it("rejects concurrent cleanup without clearing the active registry", async () => {
  const cleanup = new CleanupRegistry();
  const callbacks: string[] = [];
  let releaseFirstCleanup: (() => void) | undefined;
  const firstCleanupBlocked = new Promise<void>((resolve) => {
    releaseFirstCleanup = resolve;
  });
  cleanup.add("release earlier resource", () => {
    callbacks.push("earlier resource");
  });
  cleanup.add("release blocking resource", async () => {
    callbacks.push("blocking resource");
    await firstCleanupBlocked;
  });

  const firstRun = cleanup.runAll();
  await expect(cleanup.runAll()).rejects.toThrow("cleanup is already running");
  releaseFirstCleanup?.();

  expect(await firstRun).toEqual({
    passed: ["release blocking resource", "release earlier resource"],
    failures: [],
  });
  expect(callbacks).toEqual(["blocking resource", "earlier resource"]);
});
