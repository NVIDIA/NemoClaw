#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TRUSTED_IMPLEMENTATION = "tools/pr-review-advisor/local-review-implementation.mts";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function trustedHostEnvironment(source: string): NodeJS.ProcessEnv {
  const homeBin = process.env.HOME ? path.join(process.env.HOME, ".local", "bin") : undefined;
  const allowed = [homeBin, path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"]
    .filter((entry): entry is string => typeof entry === "string" && fs.existsSync(entry))
    .map((entry) => fs.realpathSync(entry))
    .filter((entry) => {
      const relative = path.relative(source, entry);
      return relative === ".." || relative.startsWith(".." + path.sep);
    });
  return {
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    PATH: [...new Set(allowed)].join(path.delimiter),
    PR_REVIEW_ADVISOR_API_KEY: process.env.PR_REVIEW_ADVISOR_API_KEY,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    ...(homeBin ? { XDG_BIN_HOME: homeBin } : {}),
  };
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function dependencyEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
  globalConfig: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: hostEnvironment.PATH,
    HOME: hostEnvironment.HOME,
    TMPDIR: hostEnvironment.TMPDIR,
    TMP: hostEnvironment.TMP,
    TEMP: hostEnvironment.TEMP,
    npm_config_userconfig: os.devNull,
    npm_config_globalconfig: globalConfig,
  };
  const cache = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE;
  if (cache) env.npm_config_cache = cache;
  return env;
}

async function main(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (process.argv.length !== 2) throw new Error("review:local does not accept options");
  const source = fs.realpathSync(process.cwd());
  const hostEnvironment = trustedHostEnvironment(source);
  const baseCommit = git(
    source,
    ["rev-parse", "--verify", "origin/main^{commit}"],
    hostEnvironment,
  );
  try {
    git(source, ["cat-file", "-e", baseCommit + ":" + TRUSTED_IMPLEMENTATION], hostEnvironment);
  } catch {
    throw new Error(
      "origin/main does not contain the trusted local review implementation. This feature can run only after the bootstrap repair is merged; update origin/main and try again.",
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-review-bootstrap-"));
  const trustedCheckout = path.join(root, "advisor");
  const handlers = new Map<NodeJS.Signals, () => void>();
  let activeChild: ChildProcess | undefined;
  let forwardedSignal: NodeJS.Signals | undefined;
  let cleaned = false;
  let cleanupError: unknown;
  let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const cleanup = (): void => {
    if (cleaned) return;
    try {
      fs.rmSync(root, { recursive: true, force: true });
      cleaned = true;
    } catch (error) {
      cleanupError = error;
    }
  };
  for (const signal of SIGNALS) {
    const handler = (): void => {
      forwardedSignal ??= signal;
      activeChild?.kill(signal);
      cleanup();
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  const run = async (
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" } = {},
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? hostEnvironment,
      stdio: options.stdio ?? ["ignore", "ignore", "inherit"],
    });
    activeChild = child;
    try {
      return await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    } finally {
      if (activeChild === child) activeChild = undefined;
    }
  };

  const requireSuccess = async (
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<boolean> => {
    const childResult = await run(command, args, options);
    if (forwardedSignal) {
      result = { code: childResult.code, signal: forwardedSignal };
      return false;
    }
    if (childResult.code !== 0 || childResult.signal)
      throw new Error(`${command} failed while preparing the trusted local review checkout`);
    return true;
  };

  try {
    fs.mkdirSync(trustedCheckout);
    const globalConfig = path.join(root, "npm-global-config");
    fs.writeFileSync(globalConfig, "", { mode: 0o600 });
    const archive = path.join(root, "trusted.tar");
    if (
      !(await requireSuccess("git", ["archive", "--format=tar", "--output", archive, baseCommit], {
        cwd: source,
      }))
    )
      return result!;
    if (!(await requireSuccess("tar", ["-xf", archive, "-C", trustedCheckout]))) return result!;
    fs.rmSync(archive, { force: true });
    if (
      !(await requireSuccess("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: trustedCheckout,
        env: dependencyEnvironment(hostEnvironment, globalConfig),
      }))
    )
      return result!;
    const childResult = await run(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        path.join(trustedCheckout, TRUSTED_IMPLEMENTATION),
        source,
      ],
      { cwd: trustedCheckout, env: hostEnvironment, stdio: "inherit" },
    );
    result = { code: childResult.code, signal: forwardedSignal ?? childResult.signal };
    return result;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    cleanup();
    if (cleanupError !== undefined) {
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const original = result?.signal
        ? `trusted implementation terminated by ${result.signal}`
        : result?.code !== undefined && result.code !== null
          ? `trusted implementation exited with status ${result.code}`
          : "trusted checkout preparation failed";
      const message = `${original}; cleanup also failed for ${root}: ${cleanup}`;
      if (result && (result.code !== 0 || result.signal)) console.error(message);
      else throw new Error(message);
    }
  }
}

try {
  const result = await main();
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
