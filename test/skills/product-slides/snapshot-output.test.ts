// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  waitForSnapshotWorker,
  writeGitHubSnapshotOutput,
  type SnapshotOutputOperations,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts";
import {
  canonicalJson,
  canonicalSha256,
  withoutTopLevelKey,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/validate-slide-model.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const COLLECTOR = path.join(
  REPO_ROOT,
  ".agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts",
);

function snapshotFixture(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    asOf: "2026-08-26T12:00:00.000Z",
    collection: { complete: true },
    repository: { nameWithOwner: "NVIDIA/NemoClaw" },
  };
  snapshot.snapshotSha256 = canonicalSha256(withoutTopLevelKey(snapshot, "snapshotSha256"));
  return snapshot;
}

function injectedFailure(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function captureError(run: () => void): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the operation to fail");
}

async function withTemporaryDirectory(
  run: (directory: string) => void | Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-output-"));
  try {
    await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function waitForClose(
  child: ChildProcess,
  timeoutMilliseconds = 8_000,
): Promise<[number | null, NodeJS.Signals | null]> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve([child.exitCode, child.signalCode])
    : new Promise((resolve, reject) => {
        const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
          clearTimeout(timer);
          resolve([code, signal]);
        };
        const timer = setTimeout(() => {
          child.off("close", onClose);
          reject(new Error(`collector did not stop within ${timeoutMilliseconds} milliseconds`));
        }, timeoutMilliseconds);
        timer.unref();
        child.once("close", onClose);
      });
}

function isolatedGitHubEnvironment(
  directory: string,
  values: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const home = path.join(directory, "home");
  const ghConfig = path.join(directory, "gh-config");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ghConfig, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(directory, "xdg-config"),
    GH_CONFIG_DIR: ghConfig,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    ...values,
  };
}

function installFailFastGh(directory: string, markerPath: string): string {
  const binDirectory = path.join(directory, "fail-fast-bin");
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(
    path.join(binDirectory, "gh"),
    [
      "#!/bin/sh",
      `printf '{"workerPid":%s,"fakeGhPid":%s}\\n' "$PPID" "$$" > ${JSON.stringify(markerPath)}`,
      "exit 97",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return binDirectory;
}

function installFixtureGh(directory: string): string {
  const binDirectory = path.join(directory, "fixture-bin");
  const driverPath = path.join(directory, "fixture-gh.mts");
  const supportUrl = pathToFileURL(
    path.join(REPO_ROOT, "test/skills/product-slides/github-snapshot-test-support.ts"),
  ).href;
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(
    driverPath,
    [
      'import fs from "node:fs";',
      `import { createReadOnlyGitHubExecutor } from ${JSON.stringify(supportUrl)};`,
      'const input = fs.readFileSync(0, "utf8");',
      "const github = createReadOnlyGitHubExecutor();",
      'const output = github.execFileSync("gh", process.argv.slice(2), { input });',
      "process.stdout.write(output);",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(binDirectory, "gh"),
    ["#!/bin/sh", 'exec "$FAKE_NODE" --import tsx "$FAKE_GH_DRIVER" "$@"', ""].join("\n"),
    { mode: 0o700 },
  );
  return binDirectory;
}

type BlockedCollectorMode = "normal" | "cleanup-failure" | "termination-failure";

type CollectorInvocation = {
  child: ChildProcess;
  markerPath: string;
  outputPath: string;
  stderr: () => string;
  stdout: () => string;
  workerMarkerPath: string;
  workerSelfMarkerPath: string;
};

function installCollectorDriver(
  directory: string,
  mode: BlockedCollectorMode = "normal",
): { driverPath: string; workerMarkerPath: string; workerSelfMarkerPath: string } {
  const workerMarkerPath = path.join(directory, "snapshot-worker-started");
  const workerSelfMarkerPath = path.join(directory, "snapshot-worker-self-started");
  const driverPath = path.join(directory, "snapshot-collector-driver.mts");
  const collectorUrl = pathToFileURL(COLLECTOR).href;
  fs.writeFileSync(
    driverPath,
    [
      'import fs from "node:fs";',
      `import { runGitHubSnapshotCollector } from ${JSON.stringify(collectorUrl)};`,
      "const writeAtomicMarker = (markerPath, value) => {",
      "  const markerTemporaryPath = `${markerPath}.${process.pid}.tmp`;",
      "  fs.writeFileSync(markerTemporaryPath, `${value}\\n`);",
      "  fs.renameSync(markerTemporaryPath, markerPath);",
      "};",
      "const processArguments = process.argv.slice(2);",
      'const isSnapshotWorker = processArguments.includes("--snapshot-worker-path");',
      "if (isSnapshotWorker) {",
      "  writeAtomicMarker(process.env.SNAPSHOT_WORKER_SELF_STARTED, process.pid);",
      "}",
      "const suppliedArguments = process.env.SNAPSHOT_SUPPLIED_ARGV;",
      "const collectorArguments = !isSnapshotWorker && suppliedArguments",
      "  ? JSON.parse(suppliedArguments)",
      "  : processArguments;",
      "const mode = process.env.SNAPSHOT_FIXTURE_MODE;",
      "const runtime = {",
      "  onWorkerSpawn: (worker) => {",
      "    writeAtomicMarker(process.env.SNAPSHOT_WORKER_STARTED, worker.pid);",
      "  },",
      '  outputOperations: mode === "cleanup-failure" ? {',
      "    unlink: (temporaryPath) => {",
      '      throw Object.assign(new Error(`unsafe raw path: ${temporaryPath}`), { code: "EACCES", syscall: "unlink", path: temporaryPath });',
      "    },",
      "  } : undefined,",
      '  terminateWorkerTree: mode === "termination-failure" ? () => new Promise(() => undefined) : undefined,',
      '  treeTerminationTimeoutMilliseconds: mode === "termination-failure" ? 50 : undefined,',
      '  workerCloseTimeoutMilliseconds: mode === "termination-failure" ? 50 : undefined,',
      "};",
      "await runGitHubSnapshotCollector(collectorArguments, runtime);",
      "",
    ].join("\n"),
  );
  return { driverPath, workerMarkerPath, workerSelfMarkerPath };
}

function startCollectorInvocation(options: {
  directory: string;
  binDirectory: string;
  markerPath: string;
  outputPath: string;
  mode?: BlockedCollectorMode;
  arguments?: string[];
  suppliedArguments?: string[];
  environment?: NodeJS.ProcessEnv;
  directEntrypoint?: boolean;
}): CollectorInvocation {
  const mode = options.mode ?? "normal";
  const { driverPath, workerMarkerPath, workerSelfMarkerPath } = installCollectorDriver(
    options.directory,
    mode,
  );
  let standardError = "";
  let standardOutput = "";
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      options.directEntrypoint ? COLLECTOR : driverPath,
      "--output",
      options.outputPath,
      ...(options.arguments ?? []),
    ],
    {
      cwd: REPO_ROOT,
      env: isolatedGitHubEnvironment(options.directory, {
        ...options.environment,
        FAKE_GH_STARTED: options.markerPath,
        SNAPSHOT_FIXTURE_MODE: mode,
        SNAPSHOT_OUTPUT_PARENT: options.directory,
        SNAPSHOT_WORKER_STARTED: workerMarkerPath,
        SNAPSHOT_WORKER_SELF_STARTED: workerSelfMarkerPath,
        ...(options.suppliedArguments === undefined
          ? {}
          : { SNAPSHOT_SUPPLIED_ARGV: JSON.stringify(options.suppliedArguments) }),
        PATH: `${options.binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    standardOutput += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    standardError += chunk;
  });
  return {
    child,
    markerPath: options.markerPath,
    outputPath: options.outputPath,
    stderr: () => standardError,
    stdout: () => standardOutput,
    workerMarkerPath,
    workerSelfMarkerPath,
  };
}

function startBlockedCollector(
  directory: string,
  mode: BlockedCollectorMode = "normal",
): CollectorInvocation {
  const binDirectory = path.join(directory, "bin");
  const markerPath = path.join(directory, "fake-gh-started");
  const outputPath = path.join(directory, "snapshot [signal]\n#.json");
  fs.mkdirSync(binDirectory);
  const fakeGhPath = path.join(binDirectory, "gh");
  fs.writeFileSync(
    fakeGhPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'process.on("SIGINT", () => {});',
      'process.on("SIGTERM", () => {});',
      'if (process.env.SNAPSHOT_FIXTURE_MODE === "cleanup-failure") {',
      "  const stage = fs.readdirSync(process.env.SNAPSHOT_OUTPUT_PARENT).find((name) => name.includes('.nemoclaw-stage-'));",
      '  const stageDirectory = require("node:path").join(process.env.SNAPSHOT_OUTPUT_PARENT, stage);',
      '  fs.writeFileSync(require("node:path").join(stageDirectory, "snapshot.json"), "partial snapshot\\n", { mode: 0o600 });',
      "}",
      "const markerPath = process.env.FAKE_GH_STARTED;",
      "const markerTemporaryPath = `${markerPath}.${process.pid}.tmp`;",
      "fs.writeFileSync(markerTemporaryPath, `${JSON.stringify({ workerPid: process.ppid, fakeGhPid: process.pid })}\\n`);",
      "fs.renameSync(markerTemporaryPath, markerPath);",
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return startCollectorInvocation({
    directory,
    binDirectory,
    markerPath,
    outputPath,
    mode,
  });
}

function validatedProcessId(value: unknown, label: string): number {
  const processId = Number(value);
  expect(
    Number.isSafeInteger(processId) && processId > 1,
    `${label} is not a process identifier between 2 and Number.MAX_SAFE_INTEGER`,
  ).toBe(true);
  return processId;
}

function validatedFixtureProcess(
  value: unknown,
  invocation: { child: ChildProcess },
  label: string,
): number {
  const processId = validatedProcessId(value, label);
  expect(
    [process.pid, process.ppid, invocation.child.pid],
    `${label} aliases a protected fixture process`,
  ).not.toContain(processId);
  return processId;
}

function readCrossValidatedWorkerProcessGroup(
  invocation: CollectorInvocation,
  required: boolean,
): number | undefined {
  const supervisorMarkerExists = fs.existsSync(invocation.workerMarkerPath);
  const workerMarkerExists = fs.existsSync(invocation.workerSelfMarkerPath);
  return !supervisorMarkerExists && !workerMarkerExists && !required
    ? undefined
    : requireCrossValidatedWorkerProcessGroup(
        invocation,
        supervisorMarkerExists,
        workerMarkerExists,
      );
}

function requireCrossValidatedWorkerProcessGroup(
  invocation: CollectorInvocation,
  supervisorMarkerExists: boolean,
  workerMarkerExists: boolean,
): number {
  expect(supervisorMarkerExists, "supervisor did not record the detached worker").toBe(true);
  expect(workerMarkerExists, "detached worker did not record its own identity").toBe(true);
  const supervisorWorkerId = validatedFixtureProcess(
    fs.readFileSync(invocation.workerMarkerPath, "utf8").trim(),
    invocation,
    "supervisor-recorded worker process group",
  );
  const selfRecordedWorkerId = validatedFixtureProcess(
    fs.readFileSync(invocation.workerSelfMarkerPath, "utf8").trim(),
    invocation,
    "self-recorded worker process group",
  );
  expect(
    selfRecordedWorkerId,
    "supervisor and worker recorded different detached worker identities",
  ).toBe(supervisorWorkerId);
  return supervisorWorkerId;
}

function readCrossValidatedFakeGhProcess(
  invocation: CollectorInvocation,
  workerProcessGroupId: number,
): number | undefined {
  return fs.existsSync(invocation.markerPath)
    ? requireCrossValidatedFakeGhProcess(invocation, workerProcessGroupId)
    : undefined;
}

function requireCrossValidatedFakeGhProcess(
  invocation: CollectorInvocation,
  workerProcessGroupId: number,
): number {
  const marker = JSON.parse(fs.readFileSync(invocation.markerPath, "utf8")) as Record<
    string,
    unknown
  >;
  const workerProcessId = validatedFixtureProcess(
    marker.workerPid,
    invocation,
    "fake-gh parent worker",
  );
  expect(workerProcessId, "fake-gh and worker markers identify different workers").toBe(
    workerProcessGroupId,
  );
  return validatedFixtureProcess(marker.fakeGhPid, invocation, "fake-gh process");
}

function waitForProcessTargetAbsent(processTarget: number): Promise<void> {
  return vi.waitFor(
    () =>
      expect(() => process.kill(processTarget, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      ),
    { timeout: 2_000, interval: 20 },
  );
}

function collectorIsRunning(invocation: CollectorInvocation): boolean {
  return invocation.child.exitCode === null && invocation.child.signalCode === null;
}

async function giveCollectorCleanupGrace(invocation: CollectorInvocation): Promise<void> {
  const wasRunning = collectorIsRunning(invocation);
  wasRunning ? invocation.child.kill("SIGTERM") : false;
  await (wasRunning
    ? waitForClose(invocation.child, 6_000)
        .then(() => undefined)
        .catch(() => undefined)
    : Promise.resolve());
}

async function stopCollectorFixture(
  invocation: CollectorInvocation,
  options: { expectWorker?: boolean } = {},
): Promise<void> {
  const expectWorker = options.expectWorker ?? true;
  let workerProcessGroupId: number | undefined;
  let fakeGhProcessId: number | undefined;
  let discoveryFailure: unknown;
  const discoverWorkerProcessGroup = (): void => {
    try {
      workerProcessGroupId = readCrossValidatedWorkerProcessGroup(invocation, expectWorker);
      discoveryFailure = undefined;
    } catch (error) {
      workerProcessGroupId = undefined;
      discoveryFailure = error;
    }
  };
  discoverWorkerProcessGroup();
  const needsCollectorCleanupGrace =
    workerProcessGroupId === undefined && collectorIsRunning(invocation);
  await (needsCollectorCleanupGrace ? giveCollectorCleanupGrace(invocation) : Promise.resolve());
  needsCollectorCleanupGrace ? discoverWorkerProcessGroup() : undefined;
  const readFakeGhProcess = (): void => {
    try {
      fakeGhProcessId = readCrossValidatedFakeGhProcess(invocation, workerProcessGroupId as number);
    } catch (error) {
      discoveryFailure ??= error;
    }
  };
  workerProcessGroupId === undefined ? undefined : readFakeGhProcess();

  const collectorWasRunning = collectorIsRunning(invocation);
  collectorWasRunning && workerProcessGroupId !== undefined
    ? invocation.child.kill("SIGSTOP")
    : undefined;
  const stopWorkerProcessGroup = (): void => {
    try {
      process.kill(-(workerProcessGroupId as number), "SIGKILL");
    } catch (error) {
      expect(error).toMatchObject({ code: "ESRCH" });
    }
  };
  workerProcessGroupId === undefined ? undefined : stopWorkerProcessGroup();
  collectorWasRunning ? invocation.child.kill("SIGKILL") : undefined;

  await Promise.all([
    waitForClose(invocation.child, 2_000).then(() => undefined),
    ...(workerProcessGroupId === undefined
      ? []
      : [waitForProcessTargetAbsent(-workerProcessGroupId)]),
    ...(fakeGhProcessId === undefined ? [] : [waitForProcessTargetAbsent(fakeGhProcessId)]),
  ]);
  await (discoveryFailure === undefined ? Promise.resolve() : Promise.reject(discoveryFailure));
}

async function waitForBlockedCollector(
  invocation: CollectorInvocation,
): Promise<{ fakeGhProcessId: number; workerProcessGroupId: number }> {
  await Promise.all([
    vi.waitFor(() => expect(fs.existsSync(invocation.workerMarkerPath)).toBe(true), {
      timeout: 5_000,
      interval: 20,
    }),
    vi.waitFor(() => expect(fs.existsSync(invocation.workerSelfMarkerPath)).toBe(true), {
      timeout: 5_000,
      interval: 20,
    }),
    vi.waitFor(() => expect(fs.existsSync(invocation.markerPath)).toBe(true), {
      timeout: 5_000,
      interval: 20,
    }),
  ]);
  const workerProcessGroupId = readCrossValidatedWorkerProcessGroup(invocation, true);
  expect(workerProcessGroupId).toBeDefined();
  const requiredWorkerProcessGroupId = workerProcessGroupId as number;
  const fakeGhProcessId = readCrossValidatedFakeGhProcess(invocation, requiredWorkerProcessGroupId);
  expect(fakeGhProcessId).toBeDefined();
  const requiredFakeGhProcessId = fakeGhProcessId as number;
  expect(() => process.kill(-requiredWorkerProcessGroupId, 0)).not.toThrow();
  return {
    fakeGhProcessId: requiredFakeGhProcessId,
    workerProcessGroupId: requiredWorkerProcessGroupId,
  };
}

describe("GitHub snapshot output", () => {
  it("publishes private canonical bytes after write, fsync, and close", async () => {
    await withTemporaryDirectory((directory) => {
      const outputPath = path.join(directory, "snapshot.json");
      const snapshot = snapshotFixture();
      const events: string[] = [];
      const operations: Partial<SnapshotOutputOperations> = {
        write: (descriptor, value) => {
          events.push("write");
          fs.writeFileSync(descriptor, value, "utf8");
        },
        fsync: (descriptor) => {
          events.push("fsync");
          fs.fsyncSync(descriptor);
        },
        close: (descriptor) => {
          events.push("close");
          fs.closeSync(descriptor);
        },
        link: (temporaryPath, targetPath) => {
          events.push("link");
          fs.linkSync(temporaryPath, targetPath);
        },
      };

      writeGitHubSnapshotOutput(snapshot, outputPath, { operations });

      expect(events).toEqual(["write", "fsync", "close", "link"]);
      expect(fs.readFileSync(outputPath, "utf8")).toBe(canonicalJson(snapshot));
      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(directory)).toEqual(["snapshot.json"]);
    });
  });

  it.skipIf(process.platform === "win32")(
    "publishes one canonical snapshot through the offline POSIX worker and parent finalization path",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputPath = path.join(directory, "offline-snapshot.json");
        const binDirectory = installFixtureGh(directory);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: path.join(directory, "offline-fixture-gh-marker"),
          outputPath,
          arguments: ["--release-count", "1"],
          environment: {
            FAKE_NODE: process.execPath,
            FAKE_GH_DRIVER: path.join(directory, "fixture-gh.mts"),
          },
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child, 30_000);
          expect(code).toBe(0);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stdout()).toContain(
            `GitHub snapshot written: ${JSON.stringify(outputPath)}`,
          );
          const snapshot = JSON.parse(fs.readFileSync(outputPath, "utf8")) as Record<
            string,
            unknown
          >;
          expect(fs.readFileSync(outputPath, "utf8")).toBe(canonicalJson(snapshot));
          expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
          expect(
            fs.readdirSync(directory).filter((name) => name.includes(".nemoclaw-stage-")),
          ).toEqual([]);
        } finally {
          await stopCollectorFixture(invocation);
        }
      });
    },
    40_000,
  );

  it.skipIf(process.platform === "win32")(
    "forwards supplied programmatic arguments to the offline POSIX worker",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const publishedOutputPath = path.join(directory, "supplied-argv-snapshot.json");
        const wrapperOutputPath = path.join(directory, "wrapper-process-argv-snapshot.json");
        const binDirectory = installFixtureGh(directory);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: path.join(directory, "supplied-argv-fixture-gh-marker"),
          outputPath: wrapperOutputPath,
          arguments: ["--wrapper-only-unknown-option"],
          suppliedArguments: [
            "--output",
            publishedOutputPath,
            "--repo",
            "NVIDIA/NemoClaw",
            "--release-count",
            "1",
          ],
          environment: {
            FAKE_NODE: process.execPath,
            FAKE_GH_DRIVER: path.join(directory, "fixture-gh.mts"),
          },
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child, 30_000);
          expect(code).toBe(0);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stdout()).toContain(
            `GitHub snapshot written: ${JSON.stringify(publishedOutputPath)}`,
          );
          expect(fs.existsSync(publishedOutputPath)).toBe(true);
          expect(fs.existsSync(wrapperOutputPath)).toBe(false);
          const snapshot = JSON.parse(fs.readFileSync(publishedOutputPath, "utf8")) as Record<
            string,
            unknown
          >;
          expect(fs.readFileSync(publishedOutputPath, "utf8")).toBe(canonicalJson(snapshot));
        } finally {
          await stopCollectorFixture(invocation);
        }
      });
    },
    40_000,
  );

  it.skipIf(process.platform === "win32")(
    "rejects a quoted existing destination at the POSIX CLI boundary without changing its bytes",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputPath = path.join(directory, "snapshot [trusted]\n#.json");
        const ghMarkerPath = path.join(directory, "unexpected-gh-invocation");
        const binDirectory = installFailFastGh(directory, ghMarkerPath);
        const sentinel = Buffer.from("trusted snapshot bytes\n");
        fs.writeFileSync(outputPath, sentinel);

        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: ghMarkerPath,
          outputPath,
          directEntrypoint: true,
        });

        try {
          const [code] = await waitForClose(invocation.child);
          expect(code).not.toBe(0);
          expect(invocation.stderr()).toContain(
            `Snapshot output already exists and will not be overwritten: ${JSON.stringify(outputPath)}`,
          );
          expect(fs.readFileSync(outputPath)).toEqual(sentinel);
          expect(fs.existsSync(ghMarkerPath)).toBe(false);
          expect(
            fs.readdirSync(directory).filter((name) => name.includes(".nemoclaw-stage-")),
          ).toEqual([]);
        } finally {
          await stopCollectorFixture(invocation, { expectWorker: false });
        }
      });
    },
    30_000,
  );

  it("waits for worker close after recording an earlier child error", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const workerResult = waitForSnapshotWorker(child);
    let settled = false;
    void workerResult.then(() => {
      settled = true;
    });

    child.emit("error", injectedFailure("injected child error", "EIO"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.emit("close", 1, null);
    await expect(workerResult).resolves.toMatchObject({
      failure: { message: "injected child error" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "removes the staging workspace after an offline POSIX worker failure",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputPath = path.join(directory, "failed-worker-snapshot.json");
        const ghMarkerPath = path.join(directory, "failed-worker-gh-invoked");
        const binDirectory = installFailFastGh(directory, ghMarkerPath);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: ghMarkerPath,
          outputPath,
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(fs.existsSync(ghMarkerPath)).toBe(true);
          expect(fs.existsSync(outputPath)).toBe(false);
          expect(invocation.stderr()).toContain(
            "GitHub snapshot worker stopped before publication",
          );
          expect(
            fs.readdirSync(directory).filter((name) => name.includes(".nemoclaw-stage-")),
          ).toEqual([]);
        } finally {
          await stopCollectorFixture(invocation);
        }
      });
    },
    30_000,
  );

  it("removes the quoted temporary path when staging fails", async () => {
    await withTemporaryDirectory((directory) => {
      const outputPath = path.join(directory, "snapshot [staging]\n#.json");
      const operations: Partial<SnapshotOutputOperations> = {
        write: () => {
          throw injectedFailure("injected staging failure", "ENOSPC");
        },
      };

      const failure = captureError(() =>
        writeGitHubSnapshotOutput(snapshotFixture(), outputPath, {
          operations,
        }),
      );

      expect(failure.message).toContain(`staging failed for ${JSON.stringify(outputPath)}`);
      expect(failure.message).toContain("injected staging failure");
      expect(failure.message).toMatch(/Removed invocation-created temporary path ".*\\n.*"/u);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual([]);
    });
  });

  it("removes the witness when finalization fails with no target", async () => {
    await withTemporaryDirectory((directory) => {
      const outputPath = path.join(directory, "snapshot.json");
      const operations: Partial<SnapshotOutputOperations> = {
        link: () => {
          throw injectedFailure("injected finalization failure", "EIO");
        },
      };

      expect(() =>
        writeGitHubSnapshotOutput(snapshotFixture(), outputPath, {
          operations,
        }),
      ).toThrow(/This invocation did not publish the snapshot.*Removed invocation-created/u);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual([]);
    });
  });

  it("preserves competing bytes when a pre-link race makes real linkSync return EEXIST", async () => {
    await withTemporaryDirectory((directory) => {
      const outputPath = path.join(directory, "snapshot.json");
      const sentinel = Buffer.from("competing trusted snapshot bytes\n");

      expect(() =>
        writeGitHubSnapshotOutput(snapshotFixture(), outputPath, {
          beforeLink: (_temporaryPath, targetPath) => {
            fs.writeFileSync(targetPath, sentinel);
          },
        }),
      ).toThrow(/already exists and was not changed.*Removed invocation-created/u);
      expect(fs.readFileSync(outputPath)).toEqual(sentinel);
      expect(fs.readdirSync(directory)).toEqual(["snapshot.json"]);
    });
  });

  it("preserves the target and witness when link completion is ambiguous", async () => {
    await withTemporaryDirectory((directory) => {
      const outputPath = path.join(directory, "snapshot.json");
      let temporaryPath = "";
      const operations: Partial<SnapshotOutputOperations> = {
        link: (sourcePath, targetPath) => {
          fs.linkSync(sourcePath, targetPath);
          throw injectedFailure("injected ambiguous link result", "EIO");
        },
      };

      const failure = captureError(() =>
        writeGitHubSnapshotOutput(snapshotFixture(), outputPath, {
          operations,
          beforeLink: (sourcePath) => {
            temporaryPath = sourcePath;
          },
        }),
      );

      expect(failure.message).toContain(
        `Preserved possible snapshot target ${JSON.stringify(outputPath)}. Preserved invocation-created temporary path ${JSON.stringify(temporaryPath)}`,
      );
      expect(fs.readFileSync(outputPath)).toEqual(fs.readFileSync(temporaryPath));
      expect(fs.statSync(outputPath).ino).toBe(fs.statSync(temporaryPath).ino);
    });
  });

  it("preserves the published target when post-link witness cleanup fails", async () => {
    await withTemporaryDirectory((directory) => {
      const outputPath = path.join(directory, "snapshot [published]\n#.json");
      let temporaryPath = "";
      const operations: Partial<SnapshotOutputOperations> = {
        unlink: () => {
          throw injectedFailure("injected cleanup failure", "EACCES");
        },
      };

      const failure = captureError(() =>
        writeGitHubSnapshotOutput(snapshotFixture(), outputPath, {
          operations,
          beforeLink: (sourcePath) => {
            temporaryPath = sourcePath;
          },
        }),
      );

      expect(failure.message).toContain(
        `Preserved published snapshot target ${JSON.stringify(outputPath)}. Unresolved invocation-created temporary path ${JSON.stringify(temporaryPath)}`,
      );
      expect(fs.readFileSync(outputPath)).toEqual(fs.readFileSync(temporaryPath));
      expect(fs.statSync(outputPath).ino).toBe(fs.statSync(temporaryPath).ino);
    });
  });

  it("quotes newline-bearing paths without repeating raw filesystem error paths", async () => {
    await withTemporaryDirectory((directory) => {
      const outputPath = path.join(directory, 'snapshot [quoted] "value"\n#.json');
      let temporaryPath = "";
      const failure = captureError(() =>
        writeGitHubSnapshotOutput(snapshotFixture(), outputPath, {
          beforeLink: (sourcePath, targetPath) => {
            temporaryPath = sourcePath;
            throw Object.assign(new Error(`unsafe ${sourcePath} ${targetPath}`), {
              code: "EIO",
              syscall: "link",
              path: sourcePath,
              dest: targetPath,
            });
          },
        }),
      );

      expect(failure.message).toContain(JSON.stringify(outputPath));
      expect(failure.message).toContain(JSON.stringify(temporaryPath));
      expect(failure.message).toContain("EIO during link");
      expect(failure.message).not.toContain(outputPath);
      expect(failure.message).not.toContain(temporaryPath);
      expect(failure.message.split("\n")).toHaveLength(1);
    });
  });

  it("escapes C1 and Unicode line-separator controls into one physical diagnostic line", async () => {
    await withTemporaryDirectory((directory) => {
      const diagnosticControls = "\u0080\u0085\u009f\u2028\u2029";
      const outputPath = path.join(directory, `snapshot-${diagnosticControls}.json`);

      const failure = captureError(() =>
        writeGitHubSnapshotOutput(snapshotFixture(), outputPath, {
          beforeLink: () => {
            throw Object.assign(new Error(`unsafe diagnostic ${diagnosticControls}`), {
              code: "EIO",
              syscall: "link",
            });
          },
        }),
      );

      expect(failure.message).toContain("\\u0080\\u0085\\u009f\\u2028\\u2029");
      expect(failure.message).not.toMatch(/[\u0080-\u009f\u2028\u2029]/u);
      expect(failure.message).not.toMatch(/[\r\n]/u);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual([]);
    });
  });

  describe.skipIf(process.platform === "win32")("POSIX worker process-group cancellation", () => {
    it.each([
      { signal: "SIGINT" as const, exitCode: 130 },
      { signal: "SIGTERM" as const, exitCode: 143 },
    ])(
      "escalates $signal to stop an ignoring fake-gh descendant before removing the stage",
      async ({ signal, exitCode }) => {
        await withTemporaryDirectory(async (directory) => {
          const invocation = startBlockedCollector(directory);
          try {
            const { fakeGhProcessId, workerProcessGroupId } =
              await waitForBlockedCollector(invocation);
            expect(invocation.child.kill(signal)).toBe(true);
            const [code, terminatingSignal] = await waitForClose(invocation.child);

            expect(code).toBe(exitCode);
            expect(terminatingSignal).toBeNull();
            expect(invocation.stderr()).toContain(
              `${signal} interrupted GitHub snapshot collection for ${JSON.stringify(invocation.outputPath)}`,
            );
            expect(invocation.stderr()).toMatch(
              /Invocation-created temporary path is absent ".*\\n.*"/u,
            );
            expect(fs.existsSync(invocation.outputPath)).toBe(false);
            expect(
              fs.readdirSync(directory).filter((name) => name.includes(".nemoclaw-stage-")),
            ).toEqual([]);
            await vi.waitFor(
              () =>
                expect(() => process.kill(fakeGhProcessId, 0)).toThrow(
                  expect.objectContaining({ code: "ESRCH" }),
                ),
              { timeout: 2_000, interval: 20 },
            );
            expect(() => process.kill(-workerProcessGroupId, 0)).toThrow(
              expect.objectContaining({ code: "ESRCH" }),
            );
          } finally {
            await stopCollectorFixture(invocation);
          }
        });
      },
      30_000,
    );

    it("retains and exactly quotes the witness when SIGTERM cleanup is injected to fail", async () => {
      await withTemporaryDirectory(async (directory) => {
        const invocation = startBlockedCollector(directory, "cleanup-failure");
        try {
          const { fakeGhProcessId, workerProcessGroupId } =
            await waitForBlockedCollector(invocation);
          expect(invocation.child.kill("SIGTERM")).toBe(true);
          const [code, terminatingSignal] = await waitForClose(invocation.child);

          expect(code).toBe(143);
          expect(terminatingSignal).toBeNull();
          expect(fs.existsSync(invocation.outputPath)).toBe(false);
          const stagingDirectories = fs
            .readdirSync(directory)
            .filter((name) => name.includes(".nemoclaw-stage-"));
          expect(stagingDirectories).toHaveLength(1);
          const stagingDirectory = path.join(directory, stagingDirectories[0]);
          const witnessPath = path.join(stagingDirectory, "snapshot.json");
          expect(fs.existsSync(witnessPath)).toBe(true);
          expect(fs.statSync(stagingDirectory).mode & 0o777).toBe(0o700);
          expect(invocation.stderr()).toContain(
            `Unresolved invocation-created temporary path ${JSON.stringify(witnessPath)}: EACCES during unlink. Preserved invocation-created staging directory ${JSON.stringify(stagingDirectory)} because its temporary path remains unresolved`,
          );
          expect(invocation.stderr()).not.toContain(witnessPath);
          expect(invocation.stderr()).not.toContain(stagingDirectory);
          await vi.waitFor(
            () =>
              expect(() => process.kill(fakeGhProcessId, 0)).toThrow(
                expect.objectContaining({ code: "ESRCH" }),
              ),
            { timeout: 2_000, interval: 20 },
          );
          expect(() => process.kill(-workerProcessGroupId, 0)).toThrow(
            expect.objectContaining({ code: "ESRCH" }),
          );
        } finally {
          await stopCollectorFixture(invocation);
        }
      });
    }, 30_000);

    it("returns after failed termination without awaiting a never-closing worker", async () => {
      await withTemporaryDirectory(async (directory) => {
        const invocation = startBlockedCollector(directory, "termination-failure");
        try {
          const { workerProcessGroupId } = await waitForBlockedCollector(invocation);
          expect(invocation.child.kill("SIGTERM")).toBe(true);
          const [code, terminatingSignal] = await waitForClose(invocation.child);

          expect(code).toBe(143);
          expect(terminatingSignal).toBeNull();
          expect(fs.existsSync(invocation.outputPath)).toBe(false);
          expect(() => process.kill(-workerProcessGroupId, 0)).not.toThrow();
          const stagingDirectories = fs
            .readdirSync(directory)
            .filter((name) => name.includes(".nemoclaw-stage-"));
          expect(stagingDirectories).toHaveLength(1);
          const stagingDirectory = path.join(directory, stagingDirectories[0]);
          const witnessPath = path.join(stagingDirectory, "snapshot.json");
          expect(invocation.stderr()).toContain("Worker-tree termination was not confirmed");
          expect(invocation.stderr()).toContain(
            `Invocation-created temporary path is absent ${JSON.stringify(witnessPath)}. Preserved invocation-created staging directory ${JSON.stringify(stagingDirectory)}`,
          );
          expect(invocation.stderr()).not.toContain(stagingDirectory);
        } finally {
          await stopCollectorFixture(invocation);
        }
      });
    }, 30_000);
  });
});
