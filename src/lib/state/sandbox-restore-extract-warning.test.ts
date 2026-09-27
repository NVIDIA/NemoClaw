// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellClient from "../adapters/openshell/client.js";
import { restoreRecreatedSandboxState } from "./sandbox.js";

type DefsModule = typeof import("../agent/defs.js");

type SpawnResult = ReturnType<typeof import("node:child_process").spawnSync>;
type SpawnHandler = (command: string, args?: readonly string[]) => SpawnResult | undefined;

const spawnRouter = vi.hoisted(() => ({
  handler: ((_command: string, _args?: readonly string[]) => undefined) as SpawnHandler,
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (command: string, args?: readonly string[], options?: object) =>
      spawnRouter.handler(command, args) ?? actual.spawnSync(command, args, options),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (command: string, args?: readonly string[], options?: object) =>
      spawnRouter.handler(command, args) ?? actual.spawnSync(command, args, options),
  };
});

const fixtures: string[] = [];

function makeFakeAgent(): ReturnType<DefsModule["loadAgent"]> {
  return {
    name: "fake-agent",
    displayName: "Fake Agent",
    description: null,
    binaryPath: null,
    versionCommand: "fake --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    runtime: { kind: "terminal" },
    healthProbe: null,
    forwardPort: 0,
    dashboard: { kind: "headless" },
    dashboardUi: null,
    configPaths: {
      dir: "/sandbox/.fake",
      configFile: "config.toml",
      envFile: null,
      format: "toml",
    },
    inferenceProviderOptions: [],
    stateDirs: [],
    stateFiles: [],
    stateDirectories: [],
    backupStateDirs: ["memories", "sessions"],
    backupStateDirPrefixes: [],
    nonBackupStateDirs: [],
    nonBackupStateDirPrefixes: [],
    userManagedFiles: [],
    messagingPlatforms: [],
    agentDir: "/tmp/fake-agent",
    manifestPath: "/tmp/fake-agent/manifest.yaml",
  } as unknown as ReturnType<DefsModule["loadAgent"]>;
}

function writeBackup(): string {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-warning-"));
  fixtures.push(backupPath);
  for (const dirName of ["memories", "sessions"]) {
    fs.mkdirSync(path.join(backupPath, dirName), { recursive: true });
    fs.writeFileSync(path.join(backupPath, dirName, "state.txt"), "backed-up state\n");
  }
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify({
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-09-27T00:00:00.000Z",
      agentType: "fake-agent",
      agentVersion: null,
      expectedVersion: null,
      stateDirs: ["memories", "sessions"],
      backedUpDirs: ["memories", "sessions"],
      stateFiles: [],
      dir: "/sandbox/.fake",
      backupPath,
      blueprintDigest: null,
    }),
  );
  return backupPath;
}

function spawnResult(status: number, stderr = "", stdout = ""): SpawnResult {
  return {
    status,
    signal: null,
    output: [],
    pid: 0,
    stdout,
    stderr,
  } as SpawnResult;
}

describe("restoreSandboxState tar-warning handling (#12358)", () => {
  let recordedSshCommands: string[];
  let extractResult: SpawnResult;
  let usabilityResult: SpawnResult;
  let localTarResult: SpawnResult;

  beforeEach(async () => {
    recordedSshCommands = [];
    extractResult = spawnResult(0);
    usabilityResult = spawnResult(0);
    localTarResult = spawnResult(0);
    const defs = await import("../agent/defs.js");
    vi.spyOn(defs, "loadAgent").mockImplementation(() => makeFakeAgent());
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", process.execPath);
    vi.spyOn(openshellClient, "captureSandboxSshConfigCommand").mockReturnValue({
      status: 0,
      output: "Host openshell-alpha\n  HostName 127.0.0.1\n",
    });
    spawnRouter.handler = (command: string, args?: readonly string[]) => {
      const argList = Array.isArray(args) ? [...args] : [];
      if (command === "tar") return localTarResult;
      if (command === "ssh") {
        const remoteCommand = argList[argList.length - 1] ?? "";
        recordedSshCommands.push(remoteCommand);
        if (remoteCommand.includes("tar --no-same-owner -xf")) return extractResult;
        if (remoteCommand.includes("[ -d ")) return usabilityResult;
        return spawnResult(0);
      }
      return undefined;
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const fixture of fixtures.splice(0)) {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("marks dirs restored when tar exits 1 but every dir is usable", async () => {
    extractResult = spawnResult(
      1,
      "tar: sessions: Cannot utime: Operation not permitted\ntar: Exiting with failure status due to previous errors\n",
    );
    usabilityResult = spawnResult(0);

    const result = await restoreRecreatedSandboxState("alpha", writeBackup(), {
      targetAgentType: "fake-agent",
    });

    expect(result.success).toBe(true);
    expect(result.restoredDirs).toEqual(["memories", "sessions"]);
    expect(result.failedDirs).toEqual([]);
  });

  it("marks dirs failed when tar exits non-zero and usability fails", async () => {
    extractResult = spawnResult(1, "tar: memories: Cannot open: Permission denied\n");
    usabilityResult = spawnResult(1);

    const result = await restoreRecreatedSandboxState("alpha", writeBackup(), {
      targetAgentType: "fake-agent",
    });

    expect(result.success).toBe(false);
    expect(result.restoredDirs).toEqual([]);
    expect(result.failedDirs).toEqual(["memories", "sessions"]);
  });

  it("keeps clean-extract behavior when tar exits 0", async () => {
    extractResult = spawnResult(0);
    usabilityResult = spawnResult(0);

    const result = await restoreRecreatedSandboxState("alpha", writeBackup(), {
      targetAgentType: "fake-agent",
    });

    expect(result.success).toBe(true);
    expect(result.restoredDirs).toEqual(["memories", "sessions"]);
    expect(result.failedDirs).toEqual([]);
  });

  it("fails closed without touching the sandbox when local archive creation fails", async () => {
    localTarResult = spawnResult(2, "tar: /tmp/missing: Cannot stat: No such file or directory\n");

    const result = await restoreRecreatedSandboxState("alpha", writeBackup(), {
      targetAgentType: "fake-agent",
    });

    expect(result.success).toBe(false);
    expect(result.failedDirs).toEqual(["memories", "sessions"]);
    expect(recordedSshCommands).toEqual([]);
  });
});
