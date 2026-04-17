// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as childProcess from "child_process";
import * as path from "path";
import { resolveOpenshell } from "./resolve-openshell";
import { readConfigFile, writeConfigFile } from "./config-io";

export interface CommandResult {
  ok: boolean;
  output: string;
}

const DEFAULT_CONFIG_PATH = path.join(
  process.env.HOME || "/tmp",
  ".nemoclaw",
  "nemoclaw-config.json",
);

function getOpenshellBin(): string {
  const bin = resolveOpenshell();
  if (!bin) throw new Error("openshell CLI not found — install OpenShell first");
  return bin;
}

function runOpenshell(args: string[], openshellBin?: string): CommandResult {
  const bin = openshellBin || getOpenshellBin();
  const result = childProcess.spawnSync(bin, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    output: ((result.stdout || "") + (result.stderr || "")).trim(),
  };
}

export function stopSandbox(name: string, openshellBin?: string): CommandResult {
  return runOpenshell(["sandbox", "delete", name], openshellBin);
}

export function startSandbox(): CommandResult {
  const nemoclawBin = path.resolve(__dirname, "..", "..", "bin", "nemoclaw.js");
  const result = childProcess.spawnSync(process.execPath, [nemoclawBin, "start"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    output: ((result.stdout || "") + (result.stderr || "")).trim(),
  };
}

export function restartSandbox(name: string, openshellBin?: string): CommandResult {
  const stopResult = stopSandbox(name, openshellBin);
  if (!stopResult.ok) return stopResult;
  return startSandbox();
}

export function runSandboxCommand(
  name: string,
  command: string,
  openshellBin?: string,
): CommandResult {
  return runOpenshell(["sandbox", "exec", name, "--", command], openshellBin);
}

export function readConfig(configPath?: string): Record<string, unknown> {
  return readConfigFile<Record<string, unknown>>(configPath || DEFAULT_CONFIG_PATH, {});
}

export function writeConfig(updates: Record<string, unknown>, configPath?: string): void {
  const filePath = configPath || DEFAULT_CONFIG_PATH;
  const current = readConfigFile<Record<string, unknown>>(filePath, {});
  writeConfigFile(filePath, { ...current, ...updates });
}
