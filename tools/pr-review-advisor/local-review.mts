#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Keep this bootstrap built-in-only: contributor imports execute before the trusted origin/main checkout exists.
const IMPLEMENTATION = "tools/pr-review-advisor/local-review-implementation.mts";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
function hostEnv(source: string): NodeJS.ProcessEnv {
  const homeBin = process.env.HOME && path.join(process.env.HOME, ".local", "bin");
  const entries = [homeBin, path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"]
    .filter((value): value is string => typeof value === "string" && fs.existsSync(value))
    .map((value) => fs.realpathSync(value))
    .filter((value) => path.relative(source, value).startsWith(".."));
  return {
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    PATH: [...new Set(entries)].join(path.delimiter),
    PR_REVIEW_ADVISOR_API_KEY: process.env.PR_REVIEW_ADVISOR_API_KEY,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    ...(homeBin ? { XDG_BIN_HOME: homeBin } : {}),
  };
}
function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: env.HOME,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL,
    PATH: env.PATH,
    TEMP: env.TEMP,
    TMP: env.TMP,
    TMPDIR: env.TMPDIR,
  };
}
const gitFlags = [
  "-c",
  `core.hooksPath=${os.devNull}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
];
function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", [...gitFlags, ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv(env),
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function stopGroup(pid: number): Promise<void> {
  const wait = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (groupExists(pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return !groupExists(pid);
  };
  const signal = (value: NodeJS.Signals): void => {
    try {
      process.kill(-pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  if (await wait(30_000)) return;
  signal("SIGKILL");
  if (!(await wait(5_000))) throw new Error(`process group ${pid} did not exit after SIGKILL`);
}
async function main(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (process.argv.length !== 2) throw new Error("review:local does not accept options");
  const source = fs.realpathSync(process.cwd());
  const env = hostEnv(source);
  const base = git(source, ["rev-parse", "--verify", "origin/main^{commit}"], env);
  try {
    git(source, ["cat-file", "-e", base + ":" + IMPLEMENTATION], env);
  } catch {
    throw new Error(
      "origin/main does not contain the trusted local review implementation. This feature can run only after the bootstrap repair is merged; update origin/main and try again.",
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-review-bootstrap-"));
  const checkout = path.join(root, "advisor");
  let received: NodeJS.Signals | undefined;
  let activeStop: (() => Promise<void>) | undefined;
  let cancellationError: unknown;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of SIGNALS) {
    const handler = (): void => {
      received ??= signal;
      void activeStop?.().catch((error) => (cancellationError ??= error));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  const run = async (
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
  ) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: true,
      env: options.env ?? env,
      stdio: options.inherit ? "inherit" : ["ignore", "ignore", "inherit"],
    });
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", (error) =>
          reject(new Error(`${command} could not start in the trusted PATH: ${error.message}`)),
        );
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    if (child.pid === undefined) return await completion;
    let stopped: Promise<void> | undefined;
    let finishInterruption!: () => void;
    const interruption = new Promise<void>((resolve) => (finishInterruption = resolve));
    activeStop = () => (stopped ??= stopGroup(child.pid!).finally(() => finishInterruption()));
    if (received) void activeStop().catch((error) => (cancellationError ??= error));
    try {
      return await Promise.race([
        completion,
        interruption.then(() => ({ code: null, signal: received ?? null })),
      ]);
    } finally {
      if (received) await activeStop().catch((error) => (cancellationError ??= error));
      activeStop = undefined;
    }
  };
  let cleanupAllowed = true;
  try {
    let result = await run(
      "git",
      [...gitFlags, "clone", "--no-hardlinks", "--no-checkout", source, checkout],
      { env: gitEnv(env) },
    );
    if (received) return { code: result.code, signal: received };
    if (result.code !== 0 || result.signal)
      throw new Error("git failed while preparing the trusted local review checkout");
    git(checkout, ["checkout", "--detach", "--force", base], env);
    const globalConfig = path.join(root, "npm-global-config");
    fs.writeFileSync(globalConfig, "", { mode: 0o600 });
    result = await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: checkout,
      env: {
        HOME: env.HOME,
        PATH: env.PATH,
        TEMP: env.TEMP,
        TMP: env.TMP,
        TMPDIR: env.TMPDIR,
        npm_config_userconfig: os.devNull,
        npm_config_globalconfig: globalConfig,
        npm_config_cache: process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE,
      },
    });
    if (received) return { code: result.code, signal: received };
    if (result.code !== 0 || result.signal)
      throw new Error("npm failed while preparing the trusted local review checkout");
    result = await run(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", path.join(checkout, IMPLEMENTATION), source],
      { cwd: checkout, env, inherit: true },
    );
    return { code: result.code, signal: received ?? result.signal };
  } catch (error) {
    if (activeStop)
      try {
        await activeStop();
      } catch (stopError) {
        cancellationError ??= stopError;
        cleanupAllowed = false;
      }
    throw error;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    cleanupAllowed &&= cancellationError === undefined;
    if (cleanupAllowed) fs.rmSync(root, { recursive: true, force: true });
    else {
      let reason =
        cancellationError instanceof Error ? cancellationError.message : String(cancellationError);
      for (const [name, value] of Object.entries(process.env))
        if (value && /(auth|credential|key|password|secret|token)/iu.test(name))
          reason = reason.replaceAll(value, "[REDACTED]");
      console.error(
        `${received ? `received ${received}; ` : ""}process group cleanup was not confirmed: ${reason}; bootstrap retained at ${root} for manual cleanup`,
      );
    }
  }
}
try {
  const result = await main();
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
