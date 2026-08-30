#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TRUSTED_IMPLEMENTATION = "tools/pr-review-advisor/local-review-implementation.mts";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function main(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (process.argv.length !== 2) throw new Error("review:local does not accept options");
  const source = fs.realpathSync(process.cwd());
  const baseCommit = git(source, ["rev-parse", "--verify", "origin/main^{commit}"]);
  try {
    git(source, ["cat-file", "-e", baseCommit + ":" + TRUSTED_IMPLEMENTATION]);
  } catch {
    throw new Error(
      "origin/main does not contain the trusted local review implementation. This feature can run only after the bootstrap repair is merged; update origin/main and try again.",
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-review-bootstrap-"));
  const trustedCheckout = path.join(root, "trusted");
  const handlers = new Map<NodeJS.Signals, () => void>();
  let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  try {
    fs.mkdirSync(trustedCheckout);
    const archive = path.join(root, "trusted.tar");
    execFileSync("git", ["archive", "--format=tar", "--output", archive, baseCommit], {
      cwd: source,
      stdio: "pipe",
    });
    execFileSync("tar", ["-xf", archive, "-C", trustedCheckout], { stdio: "pipe" });
    const dependencies = path.join(source, "node_modules");
    if (!fs.statSync(dependencies, { throwIfNoEntry: false })?.isDirectory())
      throw new Error("Run npm install before local review");
    fs.cpSync(dependencies, path.join(trustedCheckout, "node_modules"), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        path.join(trustedCheckout, TRUSTED_IMPLEMENTATION),
        source,
      ],
      { cwd: trustedCheckout, env: process.env, stdio: "inherit" },
    );
    let forwardedSignal: NodeJS.Signals | undefined;
    for (const signal of SIGNALS) {
      const handler = (): void => {
        forwardedSignal ??= signal;
        child.kill(signal);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    const childResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    result = { code: childResult.code, signal: forwardedSignal ?? childResult.signal };
    return result;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if (!result || (result.code === 0 && !result.signal)) throw error;
      console.error(
        `Local review bootstrap cleanup also failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
