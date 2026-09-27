// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { loadAgent } from "../agent/defs.js";

export type SpawnResult = ReturnType<typeof import("node:child_process").spawnSync>;
export type SpawnHandler = (command: string, args?: readonly string[]) => SpawnResult | undefined;
type AgentInstance = ReturnType<typeof loadAgent>;

export function spawnResult(status: number, stderr = "", stdout = ""): SpawnResult {
  return {
    status,
    signal: null,
    output: [],
    pid: 0,
    stdout,
    stderr,
  } as SpawnResult;
}

function makeFakeAgent(): AgentInstance {
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
  } as unknown as AgentInstance;
}

export interface RestoreWarningBehavior {
  extract: SpawnResult;
  usability: SpawnResult;
  localTar: SpawnResult;
}

export interface RestoreWarningHarness {
  agent: AgentInstance;
  behavior: RestoreWarningBehavior;
  recordedSshCommands: string[];
  writeBackup(): string;
  spawnHandler(command: string, args?: readonly string[]): SpawnResult | undefined;
  dispose(): void;
}

export function createRestoreWarningHarness(): RestoreWarningHarness {
  const fixtures: string[] = [];
  const recordedSshCommands: string[] = [];
  const behavior: RestoreWarningBehavior = {
    extract: spawnResult(0),
    usability: spawnResult(0),
    localTar: spawnResult(0),
  };
  return {
    agent: makeFakeAgent(),
    behavior,
    recordedSshCommands,
    writeBackup() {
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
    },
    spawnHandler(command: string, args?: readonly string[]) {
      const argList = Array.isArray(args) ? [...args] : [];
      if (command === "tar") return behavior.localTar;
      if (command === "ssh") {
        const remoteCommand = argList[argList.length - 1] ?? "";
        recordedSshCommands.push(remoteCommand);
        if (remoteCommand.includes("tar --no-same-owner -xf")) return behavior.extract;
        if (remoteCommand.includes("[ -d ")) return behavior.usability;
        return spawnResult(0);
      }
      return undefined;
    },
    dispose() {
      for (const fixture of fixtures.splice(0)) {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  };
}
