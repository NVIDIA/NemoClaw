#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TRUSTED_IMPLEMENTATION = "tools/pr-review-advisor/local-review-implementation.mts";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_KILL_TIMEOUT_MS = 5_000;
const PROCESS_POLL_INTERVAL_MS = 25;

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

function restrictedGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(
    "git",
    [
      "-c",
      `core.hooksPath=${os.devNull}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: restrictedGitEnvironment(env),
      maxBuffer: Number.POSITIVE_INFINITY,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
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
  let activeCancellation: (() => Promise<void>) | undefined;
  let forwardedSignal: NodeJS.Signals | undefined;
  let cleaned = false;
  let cleanupAllowed = true;
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
      void activeCancellation?.().catch(() => undefined);
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
      detached: true,
      env: options.env ?? hostEnvironment,
      stdio: options.stdio ?? ["ignore", "ignore", "inherit"],
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error(command + " did not report a process-group identifier");
    let cancelPromise: Promise<void> | undefined;
    let finishInterruption: (() => void) | undefined;
    const interruption = new Promise<void>((resolve) => (finishInterruption = resolve));
    const groupExists = (): boolean => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    const waitForGroupExit = async (timeout: number): Promise<boolean> => {
      const deadline = Date.now() + timeout;
      while (groupExists() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_INTERVAL_MS));
      }
      return !groupExists();
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const cancel = (): Promise<void> => {
      cancelPromise ??= (async () => {
        try {
          signalGroup("SIGTERM");
          if (!(await waitForGroupExit(PROCESS_TERMINATION_GRACE_MS))) {
            signalGroup("SIGKILL");
            if (!(await waitForGroupExit(PROCESS_KILL_TIMEOUT_MS))) {
              cleanupAllowed = false;
              throw new Error(
                command +
                  " process group " +
                  pid +
                  " did not exit after SIGKILL; bootstrap retained at " +
                  root +
                  " for manual cleanup",
              );
            }
          }
        } catch (error) {
          cleanupAllowed = false;
          const diagnostic = error instanceof Error ? error.message : String(error);
          throw new Error(
            command +
              " process group " +
              pid +
              " cleanup was not confirmed; bootstrap retained at " +
              root +
              " for manual cleanup: " +
              diagnostic,
            { cause: error },
          );
        } finally {
          finishInterruption?.();
        }
      })();
      void cancelPromise.catch((error) => {
        cleanupError ??= error;
      });
      return cancelPromise;
    };
    activeCancellation = cancel;
    if (forwardedSignal) void cancel();
    try {
      const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      const interrupted = interruption.then(() => ({
        code: null,
        signal: forwardedSignal ?? null,
      }));
      return await Promise.race([completion, interrupted]);
    } finally {
      if (forwardedSignal) await cancel().catch(() => undefined);
      if (activeCancellation === cancel) activeCancellation = undefined;
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
    const globalConfig = path.join(root, "npm-global-config");
    fs.writeFileSync(globalConfig, "", { mode: 0o600 });
    if (
      !(await requireSuccess(
        "git",
        [
          "-c",
          `core.hooksPath=${os.devNull}`,
          "-c",
          "core.fsmonitor=false",
          "-c",
          "diff.external=",
          "clone",
          "--no-hardlinks",
          "--no-checkout",
          source,
          trustedCheckout,
        ],
        { env: restrictedGitEnvironment(hostEnvironment) },
      ))
    )
      return result!;
    git(trustedCheckout, ["checkout", "--detach", "--force", baseCommit], hostEnvironment);
    if (forwardedSignal) {
      result = { code: null, signal: forwardedSignal };
      return result;
    }
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
    if (cleanupAllowed) cleanup();
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
