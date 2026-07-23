// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export interface HermesForwardWatcherState {
  pid: number | null;
  pidFile: string;
  port: string;
  sandbox: string;
  watcherScript: string;
}

export type HermesForwardWatcherCommandLine =
  | { kind: "argv"; value: readonly string[] }
  | { kind: "ps"; value: string };

function hasExpectedExecutableName(executable: string, expected: "node" | "openshell"): boolean {
  const basename = path.basename(executable);
  return expected === "node" ? basename === "node" || basename === "nodejs" : basename === expected;
}

function matchesExactArgv(argv: readonly string[], watcher: HermesForwardWatcherState): boolean {
  return (
    argv.length === 5 &&
    path.isAbsolute(argv[0] ?? "") &&
    hasExpectedExecutableName(argv[0] ?? "", "node") &&
    argv[1] === watcher.watcherScript &&
    path.isAbsolute(argv[2] ?? "") &&
    hasExpectedExecutableName(argv[2] ?? "", "openshell") &&
    argv[3] === watcher.port &&
    argv[4] === watcher.sandbox
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesExactPsCommandLine(
  commandLine: string,
  watcher: HermesForwardWatcherState,
): boolean {
  const nodeExecutable = String.raw`\/(?:\S*\/)?node(?:js)?`;
  const openshellExecutable = String.raw`\/(?:\S*\/)?openshell`;
  const expected = new RegExp(
    `^${nodeExecutable}[ \\t]+${escapeRegExp(watcher.watcherScript)}[ \\t]+${openshellExecutable}[ \\t]+${escapeRegExp(watcher.port)}[ \\t]+${escapeRegExp(watcher.sandbox)}$`,
  );
  return expected.test(commandLine.trim());
}

export function isManagedHermesForwardWatcherProcess(input: {
  commandLine: HermesForwardWatcherCommandLine | null;
  expectedUser: string;
  observedUser: string;
  watcher: HermesForwardWatcherState;
}): boolean {
  const { commandLine, expectedUser, observedUser, watcher } = input;
  if (!commandLine || observedUser !== expectedUser) return false;
  return commandLine.kind === "argv"
    ? matchesExactArgv(commandLine.value, watcher)
    : matchesExactPsCommandLine(commandLine.value, watcher);
}
