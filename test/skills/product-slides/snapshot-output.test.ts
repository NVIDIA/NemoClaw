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

import { waitForSnapshotWorker } from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts";
import { canonicalJson } from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/validate-slide-model.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const COLLECTOR = path.join(
  REPO_ROOT,
  ".agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts",
);

function injectedFailure(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
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

function canonicalPathInExistingParent(filePath: string): string {
  return path.join(fs.realpathSync.native(path.dirname(filePath)), path.basename(filePath));
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

type CollectorFixtureMode =
  | "normal"
  | "ambiguous-link"
  | "cleanup-failure"
  | "competing-output"
  | "termination-failure"
  | "parent-replacement"
  | "staging-write-failure"
  | "staging-replacement";

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
  mode: CollectorFixtureMode = "normal",
): { driverPath: string; workerMarkerPath: string; workerSelfMarkerPath: string } {
  const workerMarkerPath = path.join(directory, "snapshot-worker-started");
  const workerSelfMarkerPath = path.join(directory, "snapshot-worker-self-started");
  const driverPath = path.join(directory, "snapshot-collector-driver.mts");
  const collectorUrl = pathToFileURL(COLLECTOR).href;
  fs.writeFileSync(
    driverPath,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
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
      '  } : mode === "staging-write-failure" ? {',
      "    write: () => {",
      '      throw Object.assign(new Error("injected staging write failure"), { code: "ENOSPC" });',
      "    },",
      '  } : mode === "ambiguous-link" ? {',
      "    link: (temporaryPath, outputPath) => {",
      "      fs.linkSync(temporaryPath, outputPath);",
      '      throw Object.assign(new Error("injected ambiguous link result"), { code: "EIO" });',
      "    },",
      "  } : undefined,",
      '  terminateWorkerTree: mode === "termination-failure" ? () => new Promise(() => undefined) : undefined,',
      '  treeTerminationTimeoutMilliseconds: mode === "termination-failure" ? 50 : undefined,',
      '  workerCloseTimeoutMilliseconds: mode === "termination-failure" ? 50 : undefined,',
      '  beforePublish: mode === "competing-output" ? (_temporaryPath, outputPath) => {',
      '    fs.writeFileSync(outputPath, "competing snapshot bytes\\n", { mode: 0o600 });',
      '  } : mode === "parent-replacement" ? (_temporaryPath, outputPath) => {',
      "    const outputParentPath = path.dirname(outputPath);",
      "    fs.renameSync(outputParentPath, process.env.SNAPSHOT_MOVED_PARENT);",
      "    fs.mkdirSync(outputParentPath, { mode: 0o700 });",
      '    fs.writeFileSync(path.join(outputParentPath, "replacement-sentinel"), "replacement parent\\n", { mode: 0o600 });',
      '  } : mode === "staging-replacement" ? (temporaryPath) => {',
      "    const stagingDirectoryPath = path.dirname(temporaryPath);",
      "    fs.renameSync(stagingDirectoryPath, process.env.SNAPSHOT_MOVED_STAGE);",
      "    fs.mkdirSync(stagingDirectoryPath, { mode: 0o700 });",
      '    fs.writeFileSync(temporaryPath, "replacement stage\\n", { mode: 0o600 });',
      "  } : undefined,",
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
  mode?: CollectorFixtureMode;
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
  mode: CollectorFixtureMode = "normal",
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
            `GitHub snapshot written: ${JSON.stringify(canonicalPathInExistingParent(outputPath))}`,
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
            `GitHub snapshot written: ${JSON.stringify(canonicalPathInExistingParent(publishedOutputPath))}`,
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
    "preserves the completed worker stage when the output parent identity changes before publication",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputParentPath = path.join(directory, "trusted-output-parent");
        const movedParentPath = path.join(directory, "moved-output-parent");
        const outputPath = path.join(outputParentPath, "snapshot.json");
        const binDirectory = installFixtureGh(directory);
        fs.mkdirSync(outputParentPath, { mode: 0o700 });
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: path.join(directory, "parent-replacement-fixture-gh-marker"),
          outputPath,
          mode: "parent-replacement",
          arguments: ["--release-count", "1"],
          environment: {
            FAKE_NODE: process.execPath,
            FAKE_GH_DRIVER: path.join(directory, "fixture-gh.mts"),
            SNAPSHOT_MOVED_PARENT: movedParentPath,
          },
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child, 30_000);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toContain("Protected output parent identity changed");
          expect(invocation.stderr()).toContain("Preserved invocation-created staging directory");
          expect(fs.existsSync(outputPath)).toBe(false);
          expect(fs.existsSync(path.join(movedParentPath, "snapshot.json"))).toBe(false);
          expect(fs.readFileSync(path.join(outputParentPath, "replacement-sentinel"), "utf8")).toBe(
            "replacement parent\n",
          );
          const stagingDirectories = fs
            .readdirSync(movedParentPath)
            .filter((name) => name.includes(".nemoclaw-stage-"));
          expect(stagingDirectories).toHaveLength(1);
          const witnessPath = path.join(movedParentPath, stagingDirectories[0], "snapshot.json");
          const snapshot = JSON.parse(fs.readFileSync(witnessPath, "utf8")) as Record<
            string,
            unknown
          >;
          expect(fs.readFileSync(witnessPath, "utf8")).toBe(canonicalJson(snapshot));
          expect(fs.statSync(witnessPath).mode & 0o777).toBe(0o600);
        } finally {
          await stopCollectorFixture(invocation);
        }
      });
    },
    40_000,
  );

  it.skipIf(process.platform === "win32")(
    "preserves the original and replacement staging directories when identity changes before publication",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputParentPath = path.join(directory, "trusted-output-parent");
        const movedStagePath = path.join(directory, "moved-original-stage");
        const outputPath = path.join(outputParentPath, "snapshot.json");
        const binDirectory = installFixtureGh(directory);
        fs.mkdirSync(outputParentPath, { mode: 0o700 });
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: path.join(directory, "stage-replacement-fixture-gh-marker"),
          outputPath,
          mode: "staging-replacement",
          arguments: ["--release-count", "1"],
          environment: {
            FAKE_NODE: process.execPath,
            FAKE_GH_DRIVER: path.join(directory, "fixture-gh.mts"),
            SNAPSHOT_MOVED_STAGE: movedStagePath,
          },
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child, 30_000);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toContain(
            "Snapshot staging-directory boundary is not trusted",
          );
          expect(fs.existsSync(outputPath)).toBe(false);
          const replacementStageNames = fs
            .readdirSync(outputParentPath)
            .filter((name) => name.includes(".nemoclaw-stage-"));
          expect(replacementStageNames).toHaveLength(1);
          expect(
            fs.readFileSync(
              path.join(outputParentPath, replacementStageNames[0], "snapshot.json"),
              "utf8",
            ),
          ).toBe("replacement stage\n");
          const witnessPath = path.join(movedStagePath, "snapshot.json");
          const snapshot = JSON.parse(fs.readFileSync(witnessPath, "utf8")) as Record<
            string,
            unknown
          >;
          expect(fs.readFileSync(witnessPath, "utf8")).toBe(canonicalJson(snapshot));
          expect(fs.statSync(witnessPath).mode & 0o777).toBe(0o600);
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
            `Snapshot output already exists and will not be overwritten: ${JSON.stringify(canonicalPathInExistingParent(outputPath))}`,
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

  it.skipIf(process.platform === "win32")(
    "rejects a non-0700 output parent before collection without changing its mode",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputParentPath = path.join(directory, "shared-output-parent");
        const outputPath = path.join(outputParentPath, "snapshot.json");
        const ghMarkerPath = path.join(directory, "unexpected-mode-gh-invocation");
        const binDirectory = installFailFastGh(directory, ghMarkerPath);
        fs.mkdirSync(outputParentPath, { mode: 0o700 });
        fs.chmodSync(outputParentPath, 0o750);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: ghMarkerPath,
          outputPath,
          directEntrypoint: true,
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toMatch(
            /Protected output parent must be owned by effective UID .* with mode 0700/u,
          );
          expect(fs.statSync(outputParentPath).mode & 0o777).toBe(0o750);
          expect(fs.existsSync(outputPath)).toBe(false);
          expect(fs.existsSync(ghMarkerPath)).toBe(false);
          expect(fs.readdirSync(outputParentPath)).toEqual([]);
        } finally {
          await stopCollectorFixture(invocation, { expectWorker: false });
          fs.chmodSync(outputParentPath, 0o700);
        }
      });
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic-link output-parent chain without changing its referent",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const realParentPath = path.join(directory, "real-output-parent");
        const aliasParentPath = path.join(directory, "alias-output-parent");
        const outputPath = path.join(aliasParentPath, "snapshot.json");
        const sentinelPath = path.join(realParentPath, "referent-sentinel");
        const ghMarkerPath = path.join(directory, "unexpected-symlink-gh-invocation");
        const binDirectory = installFailFastGh(directory, ghMarkerPath);
        fs.mkdirSync(realParentPath, { mode: 0o700 });
        fs.writeFileSync(sentinelPath, "referent bytes\n", { mode: 0o600 });
        fs.symlinkSync(realParentPath, aliasParentPath);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: ghMarkerPath,
          outputPath,
          directEntrypoint: true,
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toContain(
            "Protected output parent contains an untrusted symbolic-link path",
          );
          expect(fs.lstatSync(aliasParentPath).isSymbolicLink()).toBe(true);
          expect(fs.readFileSync(sentinelPath, "utf8")).toBe("referent bytes\n");
          expect(fs.existsSync(path.join(realParentPath, "snapshot.json"))).toBe(false);
          expect(fs.existsSync(ghMarkerPath)).toBe(false);
          expect(fs.readdirSync(realParentPath)).toEqual(["referent-sentinel"]);
        } finally {
          await stopCollectorFixture(invocation, { expectWorker: false });
        }
      });
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "does not create a missing output parent through a symbolic-link referent",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const realParentPath = path.join(directory, "real-output-parent");
        const aliasParentPath = path.join(directory, "alias-output-parent");
        const outputPath = path.join(aliasParentPath, "missing-parent", "snapshot.json");
        const ghMarkerPath = path.join(directory, "unexpected-missing-parent-gh-invocation");
        const binDirectory = installFailFastGh(directory, ghMarkerPath);
        fs.mkdirSync(realParentPath, { mode: 0o700 });
        fs.symlinkSync(realParentPath, aliasParentPath);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: ghMarkerPath,
          outputPath,
          directEntrypoint: true,
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toContain("Could not resolve protected output directory");
          expect(fs.existsSync(path.join(realParentPath, "missing-parent"))).toBe(false);
          expect(fs.existsSync(ghMarkerPath)).toBe(false);
          expect(fs.readdirSync(realParentPath)).toEqual([]);
        } finally {
          await stopCollectorFixture(invocation, { expectWorker: false });
        }
      });
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "rejects an output ancestor that permits an untrusted pathname swap",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const mutableAncestorPath = path.join(directory, "mutable-ancestor");
        const outputParentPath = path.join(mutableAncestorPath, "run");
        const outputPath = path.join(outputParentPath, "snapshot.json");
        const ghMarkerPath = path.join(directory, "unexpected-ancestor-gh-invocation");
        const binDirectory = installFailFastGh(directory, ghMarkerPath);
        fs.mkdirSync(outputParentPath, { recursive: true, mode: 0o700 });
        fs.chmodSync(mutableAncestorPath, 0o777);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: ghMarkerPath,
          outputPath,
          directEntrypoint: true,
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toContain(
            "Protected output ancestor permits an untrusted pathname swap",
          );
          expect(fs.statSync(mutableAncestorPath).mode & 0o777).toBe(0o777);
          expect(fs.statSync(outputParentPath).mode & 0o777).toBe(0o700);
          expect(fs.existsSync(outputPath)).toBe(false);
          expect(fs.existsSync(ghMarkerPath)).toBe(false);
          expect(fs.readdirSync(outputParentPath)).toEqual([]);
        } finally {
          await stopCollectorFixture(invocation, { expectWorker: false });
          fs.chmodSync(mutableAncestorPath, 0o700);
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

  it.skipIf(process.platform === "win32")(
    "removes the worker stage when snapshot writing fails",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputPath = path.join(directory, "staging-write-failure.json");
        const binDirectory = installFixtureGh(directory);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: path.join(directory, "staging-write-fixture-gh-marker"),
          outputPath,
          mode: "staging-write-failure",
          arguments: ["--release-count", "1"],
          environment: {
            FAKE_NODE: process.execPath,
            FAKE_GH_DRIVER: path.join(directory, "fixture-gh.mts"),
          },
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child, 30_000);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toContain("injected staging write failure");
          expect(fs.existsSync(outputPath)).toBe(false);
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
    "preserves competing output and removes the worker stage",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputPath = path.join(directory, "competing-output.json");
        const binDirectory = installFixtureGh(directory);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: path.join(directory, "competing-output-fixture-gh-marker"),
          outputPath,
          mode: "competing-output",
          arguments: ["--release-count", "1"],
          environment: {
            FAKE_NODE: process.execPath,
            FAKE_GH_DRIVER: path.join(directory, "fixture-gh.mts"),
          },
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child, 30_000);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toContain(
            "Snapshot output already exists and was not changed",
          );
          expect(fs.readFileSync(outputPath, "utf8")).toBe("competing snapshot bytes\n");
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
    "preserves the worker target and witness after ambiguous link completion",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputPath = path.join(directory, "ambiguous-output.json");
        const binDirectory = installFixtureGh(directory);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: path.join(directory, "ambiguous-output-fixture-gh-marker"),
          outputPath,
          mode: "ambiguous-link",
          arguments: ["--release-count", "1"],
          environment: {
            FAKE_NODE: process.execPath,
            FAKE_GH_DRIVER: path.join(directory, "fixture-gh.mts"),
          },
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child, 30_000);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toContain("Target ownership is ambiguous");
          const stagingDirectories = fs
            .readdirSync(directory)
            .filter((name) => name.includes(".nemoclaw-stage-"));
          expect(stagingDirectories).toHaveLength(1);
          const witnessPath = path.join(directory, stagingDirectories[0], "snapshot.json");
          expect(fs.readFileSync(outputPath)).toEqual(fs.readFileSync(witnessPath));
          expect(fs.statSync(outputPath).ino).toBe(fs.statSync(witnessPath).ino);
        } finally {
          await stopCollectorFixture(invocation);
        }
      });
    },
    40_000,
  );

  it.skipIf(process.platform === "win32")(
    "preserves the published worker target when witness cleanup fails",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const outputPath = path.join(directory, "cleanup-failure.json");
        const binDirectory = installFixtureGh(directory);
        const invocation = startCollectorInvocation({
          directory,
          binDirectory,
          markerPath: path.join(directory, "cleanup-failure-fixture-gh-marker"),
          outputPath,
          mode: "cleanup-failure",
          arguments: ["--release-count", "1"],
          environment: {
            FAKE_NODE: process.execPath,
            FAKE_GH_DRIVER: path.join(directory, "fixture-gh.mts"),
          },
        });

        try {
          const [code, terminatingSignal] = await waitForClose(invocation.child, 30_000);
          expect(code).toBe(1);
          expect(terminatingSignal).toBeNull();
          expect(invocation.stderr()).toContain("GitHub snapshot was published");
          expect(invocation.stderr()).toContain("temporary cleanup failed");
          const stagingDirectories = fs
            .readdirSync(directory)
            .filter((name) => name.includes(".nemoclaw-stage-"));
          expect(stagingDirectories).toHaveLength(1);
          const witnessPath = path.join(directory, stagingDirectories[0], "snapshot.json");
          expect(fs.readFileSync(outputPath)).toEqual(fs.readFileSync(witnessPath));
          expect(fs.statSync(outputPath).ino).toBe(fs.statSync(witnessPath).ino);
        } finally {
          await stopCollectorFixture(invocation);
        }
      });
    },
    40_000,
  );

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
              `${signal} interrupted GitHub snapshot collection for ${JSON.stringify(canonicalPathInExistingParent(invocation.outputPath))}`,
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
            `Unresolved invocation-created temporary path ${JSON.stringify(canonicalPathInExistingParent(witnessPath))}: EACCES during unlink. Preserved invocation-created staging directory ${JSON.stringify(canonicalPathInExistingParent(stagingDirectory))} because its temporary path remains unresolved`,
          );
          expect(invocation.stderr()).not.toContain(canonicalPathInExistingParent(witnessPath));
          expect(invocation.stderr()).not.toContain(
            canonicalPathInExistingParent(stagingDirectory),
          );
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
            `Invocation-created temporary path is absent ${JSON.stringify(canonicalPathInExistingParent(witnessPath))}. Preserved invocation-created staging directory ${JSON.stringify(canonicalPathInExistingParent(stagingDirectory))}`,
          );
          expect(invocation.stderr()).not.toContain(
            canonicalPathInExistingParent(stagingDirectory),
          );
        } finally {
          await stopCollectorFixture(invocation);
        }
      });
    }, 30_000);
  });
});
