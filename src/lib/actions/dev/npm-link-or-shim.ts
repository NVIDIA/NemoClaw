// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDevShimContents,
  classifyDevShim,
  pathContainsDirectory,
} from "../../domain/dev/npm-link-or-shim";

export type ProcessResult = Pick<SpawnSyncReturns<string>, "stderr" | "stdout" | "status">;

export interface NpmLinkOrShimDeps {
  chmod?: (filePath: string, mode: number) => void;
  commandPath?: (command: string, env: NodeJS.ProcessEnv) => string | null;
  exists?: (filePath: string) => boolean;
  isExecutable?: (filePath: string) => boolean;
  logError?: (message: string) => void;
  mkdir?: (dir: string) => void;
  mktemp?: (dir: string) => string;
  readFile?: (filePath: string) => string;
  rename?: (from: string, to: string) => void;
  run?: (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => ProcessResult;
  unlink?: (filePath: string) => void;
  writeFile?: (filePath: string, contents: string) => void;
}

export interface NpmLinkOrShimOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot: string;
}

export interface NpmLinkOrShimResult {
  shimPath?: string;
  status: number;
}

function defaultRun(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    env: options.env,
  });
}

function defaultCommandPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${JSON.stringify(command)} 2>/dev/null`], {
    encoding: "utf-8",
    env,
  });
  const resolved = result.stdout.trim();
  return result.status === 0 && resolved ? resolved : null;
}

function formatNpmLinkFailure(output: string): string[] {
  const lines = ["[nemoclaw] npm link failed; falling back to user-local shim."];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    lines.push(`[nemoclaw]   ${line}`);
  }
  return lines;
}

function safeRead(readFile: (filePath: string) => string, filePath: string): string | null {
  try {
    return readFile(filePath);
  } catch {
    return null;
  }
}

function findNodePath(env: NodeJS.ProcessEnv, deps: Required<Pick<NpmLinkOrShimDeps, "commandPath" | "isExecutable">>): string | null {
  for (const candidate of [env.NEMOCLAW_NODE, env.NODE]) {
    if (candidate && deps.isExecutable(candidate)) return candidate;
  }
  const fromPath = deps.commandPath("node", env);
  return fromPath && deps.isExecutable(fromPath) ? fromPath : null;
}

export function runNpmLinkOrShim(
  options: NpmLinkOrShimOptions,
  deps: NpmLinkOrShimDeps = {},
): NpmLinkOrShimResult {
  const env = { ...process.env, ...(options.env ?? {}) };
  const repoRoot = options.repoRoot;
  const binPath = path.join(repoRoot, "bin", "nemoclaw.js");
  const home = env.HOME || os.homedir();
  const shimDir = path.join(home, ".local", "bin");
  const shimPath = path.join(shimDir, "nemoclaw");

  const logError = deps.logError ?? ((message: string) => console.error(message));
  const exists = deps.exists ?? ((filePath: string) => fs.existsSync(filePath));
  const isExecutable = deps.isExecutable ?? ((filePath: string) => {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf-8"));
  const writeFile = deps.writeFile ?? ((filePath: string, contents: string) => fs.writeFileSync(filePath, contents));
  const mkdir = deps.mkdir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
  const chmod = deps.chmod ?? ((filePath: string, mode: number) => fs.chmodSync(filePath, mode));
  const rename = deps.rename ?? ((from: string, to: string) => fs.renameSync(from, to));
  const unlink = deps.unlink ?? ((filePath: string) => fs.rmSync(filePath, { force: true }));
  const mktemp =
    deps.mktemp ??
    ((dir: string) =>
      path.join(
        dir,
        `nemoclaw.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
      ));
  const run = deps.run ?? defaultRun;
  const commandPath = deps.commandPath ?? defaultCommandPath;

  if (env.NEMOCLAW_INSTALLING) return { status: 0 };

  if (!isExecutable(binPath)) {
    logError(`[nemoclaw] cannot expose CLI: ${binPath} is missing or not executable`);
    return { status: 0 };
  }

  const installEnv = { ...env, NEMOCLAW_INSTALLING: "1" };
  const linkResult = run("npm", ["link"], { cwd: repoRoot, env: installEnv });
  if (linkResult.status === 0) return { status: 0 };

  for (const line of formatNpmLinkFailure(`${linkResult.stdout}${linkResult.stderr}`)) logError(line);

  const nodePath = findNodePath(installEnv, { commandPath, isExecutable });
  if (!nodePath) {
    logError("[nemoclaw] cannot create shim: node is not on PATH");
    return { status: 1 };
  }
  const nodeDir = path.dirname(nodePath);

  if (exists(shimPath)) {
    const classification = classifyDevShim(safeRead(readFile, shimPath));
    if (classification === "foreign") {
      logError(`[nemoclaw] ${shimPath} already exists and is not managed by NemoClaw; not overwriting.`);
      logError("[nemoclaw] Move it aside and re-run 'npm install' to install the dev shim.");
      return { shimPath, status: 1 };
    }
  }

  let shimTmp: string | null = null;
  try {
    mkdir(shimDir);
    shimTmp = mktemp(shimDir);
    writeFile(shimTmp, buildDevShimContents({ binPath, nodeDir }));
    chmod(shimTmp, 0o755);
    rename(shimTmp, shimPath);
    shimTmp = null;
  } catch (error) {
    logError(`[nemoclaw] shim creation failed: ${error instanceof Error ? error.message : String(error)}`);
    return { shimPath, status: 1 };
  } finally {
    if (shimTmp) unlink(shimTmp);
  }

  if (!isExecutable(shimPath)) {
    logError(`[nemoclaw] shim creation failed: ${shimPath} is not executable after write`);
    return { shimPath, status: 1 };
  }

  logError(`[nemoclaw] Created user-local shim at ${shimPath} -> ${binPath}`);
  if (!pathContainsDirectory(env.PATH, shimDir)) {
    logError(`[nemoclaw] ${shimDir} is not on PATH. Add it to your shell profile, e.g.:`);
    logError(`[nemoclaw]   echo 'export PATH="${shimDir}:$PATH"' >> ~/.bashrc`);
  }
  return { shimPath, status: 0 };
}
