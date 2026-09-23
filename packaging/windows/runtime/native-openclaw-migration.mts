// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { readOpenedRegularFile } from "./native-security.mts";

const failure = () =>
  new Error(
    "Chat history could not be upgraded safely. Original files and migration archives are retained. Close OpenClaw and contact support before retrying.",
  );

function inspectPath(file: string) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (!stat.isFile() && !stat.isDirectory()) ||
    (stat.isFile() && stat.nlink !== 1) ||
    path.relative(path.resolve(file), fs.realpathSync(file)) !== ""
  )
    throw failure();
  return stat;
}

/** The caller holds the private state lease; no sandbox may be using this tree. */
export function inspectLegacyOpenClawSessions(home: string): string | null {
  if (!path.isAbsolute(home)) throw failure();
  for (let current = path.resolve(home); ; current = path.dirname(current)) {
    if (!inspectPath(current).isDirectory()) throw failure();
    if (path.dirname(current) === current) break;
  }
  const state = path.join(home, ".openclaw");
  const sessions = path.join(state, "agents", "main", "sessions");
  const store = path.join(sessions, "sessions.json");
  // Check each ancestor before testing existence, including dangling links.
  for (const file of [state, path.join(state, "agents"), path.dirname(sessions), sessions, store]) {
    try {
      inspectPath(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  // A sandbox-authored dotenv file must not configure this host maintenance process.
  for (const file of [
    path.join(state, ".env"),
    path.join(home, ".config", "openclaw", "gateway.env"),
  ])
    if (fs.existsSync(file)) throw failure();
  let entries = 0;
  const pending = [home];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of fs.readdirSync(directory)) {
      if (++entries > 100_000) throw failure();
      const file = path.join(directory, name);
      if (inspectPath(file).isDirectory()) pending.push(file);
    }
  }
  const content = readOpenedRegularFile(store, {
    encoding: "utf8",
    rejectLinks: true,
    maxBytes: 16 * 1024 * 1024,
  });
  if (content === null) throw failure();
  let records;
  try {
    records = JSON.parse(content);
  } catch {
    throw failure();
  }
  if (!records || typeof records !== "object" || Array.isArray(records)) throw failure();
  for (const record of Object.values(records) as Record<string, unknown>[]) {
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      typeof record.sessionId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(record.sessionId)
    )
      throw failure();
    if (
      record.sessionFile !== undefined &&
      (typeof record.sessionFile !== "string" ||
        !path.isAbsolute(record.sessionFile) ||
        path.relative(sessions, path.dirname(path.resolve(record.sessionFile))) !== "" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.jsonl$/u.test(path.basename(record.sessionFile)))
    )
      throw failure();
  }
  return store;
}

export async function migrateNativeOpenClawSessions(options: {
  home: string;
  node: string;
  runtimeRoot: string;
  entry: string;
  signal?: AbortSignal;
  assertHeld: () => void;
  onProgress?: () => void;
}) {
  options.assertHeld();
  options.signal?.throwIfAborted();
  const store = inspectLegacyOpenClawSessions(options.home);
  if (!store) return false;
  options.onProgress?.();
  const state = path.join(options.home, ".openclaw");
  const workers = path.join(options.runtimeRoot, "workers");
  const config = path.join(workers, "openclaw-migration-config.json");
  for (const mode of ["dry-run", "import"]) {
    options.assertHeld();
    options.signal?.throwIfAborted();
    if (inspectLegacyOpenClawSessions(options.home) !== store) throw failure();
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        options.node,
        [
          // Host maintenance needs upstream hard-link publication and descriptor permission checks.
          // It runs sealed code without agent plugins, credentials, or the chat sandbox.
          path.join(workers, "openclaw-migrate.cjs"),
          options.entry,
          mode,
          store,
        ],
        {
          cwd: options.runtimeRoot,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            HOME: options.home,
            USERPROFILE: options.home,
            LOCALAPPDATA: options.home,
            TEMP: state,
            TMP: state,
            OPENCLAW_HOME: options.home,
            OPENCLAW_STATE_DIR: state,
            OPENCLAW_CONFIG_PATH: config,
            OPENCLAW_NO_RESPAWN: "1",
            NODE_DISABLE_COMPILE_CACHE: "1",
            OPENCLAW_COMPILED_ASSET_ROOT: path.dirname(options.entry),
          },
        },
      );
      let output = "";
      let bytes = 0;
      let stopped = false;
      const stop = () => {
        stopped = true;
        child.kill();
      };
      const timeout = setTimeout(stop, 120_000);
      const guard = setInterval(() => {
        try {
          options.assertHeld();
        } catch {
          stop();
        }
      }, 250);
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) stop();
        else output += chunk.toString("utf8");
      });
      // Upstream diagnostics can contain transcript paths and content. Do not forward them.
      child.stderr.resume();
      child.once("error", () => {
        stopped = true;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        clearInterval(guard);
        options.signal?.removeEventListener("abort", stop);
        if (stopped || code !== 0) reject(failure());
        else resolve(output);
      });
    });
    options.assertHeld();
    options.signal?.throwIfAborted();
    let report;
    try {
      report = JSON.parse(result);
    } catch {
      throw failure();
    }
    if (report.mode !== mode || report.totals?.issues !== 0 || report.totals?.targets !== 1)
      throw failure();
  }
  if (fs.existsSync(store)) throw failure();
  return true;
}
