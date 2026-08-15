// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type HostCommandOutcome = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  repeat?: boolean;
};

export type HostCommandRoute = HostCommandOutcome &
  (
    | { args: readonly string[]; argsPrefix?: never }
    | { args?: never; argsPrefix: readonly string[] }
  );

export type HostCommandRecord = {
  command: string;
  args: string[];
  environment: Record<string, string | null>;
  route: number | null;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type HostProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: Error | undefined;
  stdout: string;
  stderr: string;
  output: string;
};

export type HostProcessWorkspace = {
  root: string;
  homeDir: string;
  binDir: string;
  path: (...segments: string[]) => string;
  environment: (overrides?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  writeExecutable: (name: string, contents: string) => string;
  writeCommand: (
    name: string,
    routes: readonly HostCommandRoute[],
    environmentKeys?: readonly string[],
  ) => string;
  commandRecords: () => HostCommandRecord[];
  assertCommandRoutesUsed: () => void;
  run: (
    command: string,
    args: readonly string[],
    options?: Omit<SpawnSyncOptionsWithStringEncoding, "encoding">,
  ) => HostProcessResult;
  runNodeSource: (
    source: string,
    options?: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & { name?: string },
  ) => HostProcessResult;
  remove: () => void;
};

export type HostProcessWorkspaceOptions = {
  separateHome?: boolean;
};

function decodedResult(result: ReturnType<typeof spawnSync>): HostProcessResult {
  const stdout =
    typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "");
  const stderr =
    typeof result.stderr === "string" ? result.stderr : (result.stderr?.toString() ?? "");
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`,
  };
}

function commandSource(
  name: string,
  routes: readonly HostCommandRoute[],
  recordPath: string,
  environmentKeys: readonly string[],
): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const routes = ${JSON.stringify(routes)};
const recordPath = ${JSON.stringify(recordPath)};
const argv = process.argv.slice(2);
const previous = fs.existsSync(recordPath)
  ? fs.readFileSync(recordPath, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse)
  : [];
const used = new Set(previous.filter((entry) => entry.command === ${JSON.stringify(name)} && entry.route !== null).map((entry) => entry.route));
const route = routes.findIndex((candidate, index) =>
  (candidate.repeat || !used.has(index)) &&
  (candidate.args
    ? candidate.args.length === argv.length && candidate.args.every((arg, argIndex) => arg === argv[argIndex])
    : candidate.argsPrefix && candidate.argsPrefix.every((arg, argIndex) => arg === argv[argIndex]))
);
const selected = route === -1
  ? { stdout: "", stderr: "unmatched ${name} command: " + argv.join(" ") + "\\n", exitCode: 97 }
  : routes[route];
const record = {
  command: ${JSON.stringify(name)},
  args: argv,
  environment: Object.fromEntries(${JSON.stringify(environmentKeys)}.map((key) => [key, process.env[key] ?? null])),
  route: route === -1 ? null : route,
  stdout: selected.stdout || "",
  stderr: selected.stderr || "",
  exitCode: selected.exitCode ?? 0,
};
fs.appendFileSync(recordPath, JSON.stringify(record) + "\\n");
if (record.stdout) process.stdout.write(record.stdout);
if (record.stderr) process.stderr.write(record.stderr);
process.exit(record.exitCode);
`;
}

export function createHostProcessWorkspace(
  prefix: string,
  options: HostProcessWorkspaceOptions = {},
): HostProcessWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(root, "bin");
  const homeDir = options.separateHome ? path.join(root, "home") : root;
  const recordPath = path.join(root, "host-commands.jsonl");
  const configuredRoutes = new Map<string, readonly HostCommandRoute[]>();
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  const writeExecutable = (name: string, contents: string): string => {
    const target = path.join(binDir, name);
    fs.writeFileSync(target, contents, { mode: 0o755 });
    return target;
  };
  const commandRecords = (): HostCommandRecord[] => {
    if (!fs.existsSync(recordPath)) return [];
    return fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HostCommandRecord);
  };
  const environment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...overrides,
  });
  const run = (
    command: string,
    args: readonly string[],
    runOptions: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
  ): HostProcessResult =>
    decodedResult(spawnSync(command, [...args], { ...runOptions, encoding: "utf8" }));

  return {
    root,
    homeDir,
    binDir,
    path: (...segments) => path.join(root, ...segments),
    environment,
    writeExecutable,
    writeCommand: (name, routes, environmentKeys = []) => {
      configuredRoutes.set(name, routes);
      return writeExecutable(name, commandSource(name, routes, recordPath, environmentKeys));
    },
    commandRecords,
    assertCommandRoutesUsed: () => {
      const records = commandRecords();
      const unused: string[] = [];
      for (const [name, routes] of configuredRoutes) {
        const used = new Set(
          records.filter((record) => record.command === name).map((record) => record.route),
        );
        routes.forEach((route, index) => {
          if (!route.repeat && !used.has(index)) unused.push(`${name}[${index}]`);
        });
      }
      if (unused.length > 0) throw new Error(`unused host command routes: ${unused.join(", ")}`);
    },
    run,
    runNodeSource: (source, runOptions = {}) => {
      const { name = "scenario.cjs", ...spawnOptions } = runOptions;
      const scriptPath = path.join(root, name);
      fs.writeFileSync(scriptPath, source);
      return run(process.execPath, [scriptPath], spawnOptions);
    },
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function trailingJsonPayload<T>(stdout: string): T {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith("{") && candidate.endsWith("}"));
  if (!line) throw new Error(`expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line) as T;
}
