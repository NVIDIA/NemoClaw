// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SHELL_TIMEOUT_MS = 5000;
const CHOWN_LOGGER = 'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }';

export interface LoggedDockerShellOptions {
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

export interface LoggedDockerShellResult {
  readonly calls: string;
  readonly result: SpawnSyncReturns<string>;
}

export function dockerRunCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile block between ${startMarker} and ${endMarker}`);
  }
  const runIndex = dockerfile.indexOf("RUN ", start);
  if (runIndex === -1 || runIndex > end) {
    throw new Error(`Expected RUN instruction after ${startMarker}`);
  }
  const blockLines = dockerfile.slice(runIndex, end).split("\n");
  const finalLineIndex = blockLines.findIndex(
    (line) => !line.trimStart().startsWith("#") && !line.trimEnd().endsWith("\\"),
  );
  if (finalLineIndex === -1) {
    throw new Error(`Expected complete RUN instruction before ${endMarker}`);
  }
  return blockLines
    .slice(0, finalLineIndex + 1)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim()
    .replace(/\\\n\s*/g, " ")
    .replace(/^RUN\s+/, "")
    .replace(/^(?:--[a-z-]+=[^\s]+\s+)+/u, "");
}

function shellEnvironment(
  overrides: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv | undefined {
  if (overrides === undefined) {
    return undefined;
  }
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete childEnv[key];
    } else {
      childEnv[key] = value;
    }
  }
  return childEnv;
}

export function runLoggedDockerShell(
  command: string,
  tmp: string,
  functionDefs: readonly string[] = [],
  options: LoggedDockerShellOptions = {},
): LoggedDockerShellResult {
  const logPath = path.join(tmp, "calls.log");
  fs.rmSync(logPath, { force: true });
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(logPath)}`,
    ...functionDefs,
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run-docker-block.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    env: shellEnvironment(options.env),
    timeout: options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
  });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { calls, result };
}

export function runDockerShell(command: string, sandboxRoot: string): LoggedDockerShellResult {
  return runLoggedDockerShell(command.replaceAll("/sandbox", sandboxRoot), sandboxRoot, [
    CHOWN_LOGGER,
  ]);
}
