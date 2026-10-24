// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readOpenedRegularFile } from "./native-security.mts";

const failure = () =>
  new Error(
    "Chat history could not be upgraded safely. Keep any remaining original files and migration archives. Close OpenClaw and contact support before retrying.",
  );

function pendingMigration(home: string) {
  return path.join(home, ".openclaw", ".nemoclaw-history-migration-pending");
}

function beginImport(home: string) {
  // The caller inspected this private tree while holding its exclusive state lease.
  // Persist intent before the importer can move the legacy index. A failed or
  // interrupted import must not look like a completed migration on the next launch.
  try {
    const descriptor = fs.openSync(pendingMigration(home), "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, "History migration verification is incomplete.\n");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    throw failure();
  }
}

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

function storeDigest(file: string): string {
  try {
    const content = readOpenedRegularFile(file, {
      rejectLinks: true,
      rejectHardLinks: true,
      maxBytes: 16 * 1024 * 1024,
    });
    if (content === null) throw failure();
    try {
      return createHash("sha256").update(content).digest("hex");
    } finally {
      content.fill(0);
    }
  } catch {
    throw failure();
  }
}

function verifyArchivedStore(
  store: string,
  originalDigest: string,
  report: {
    targets?: { agentId?: unknown; storePath?: unknown; archivedLegacyStoreFiles?: unknown }[];
    totals?: { archivedLegacyStoreFiles?: unknown };
  },
) {
  const target =
    Array.isArray(report.targets) && report.targets.length === 1 ? report.targets[0] : undefined;
  const archives = target?.archivedLegacyStoreFiles;
  if (
    target?.agentId !== "main" ||
    typeof target.storePath !== "string" ||
    !path.isAbsolute(target.storePath) ||
    path.relative(store, target.storePath) !== "" ||
    report.totals?.archivedLegacyStoreFiles !== 1 ||
    !Array.isArray(archives) ||
    archives.length !== 1 ||
    typeof archives[0] !== "string"
  )
    throw failure();
  const archive: string = archives[0];
  // Pinned OpenClaw publishes the original store into this sibling directory.
  const archiveDirectory = path.join(
    path.dirname(path.dirname(store)),
    "session-sqlite-import-archive",
  );
  if (
    !path.isAbsolute(archive) ||
    path.relative(archiveDirectory, path.dirname(archive)) !== "" ||
    !/^legacy-store\.sessions\.json\.imported-[0-9]+(?:\.[0-9]+)?$/u.test(path.basename(archive))
  )
    throw failure();
  try {
    for (let current = archiveDirectory; ; current = path.dirname(current)) {
      if (!inspectPath(current).isDirectory()) throw failure();
      if (path.dirname(current) === current) break;
    }
    if (!inspectPath(archive).isFile() || storeDigest(archive) !== originalDigest) throw failure();
  } catch {
    throw failure();
  }
  // A dangling link at the old name is not proof that the legacy store was removed.
  try {
    fs.lstatSync(store);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw failure();
  }
  throw failure();
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
    if (file === state) {
      try {
        // Any object at this name, including a dangling link, blocks automatic
        // continuation. Never follow, overwrite, or discard an incomplete import.
        fs.lstatSync(pendingMigration(home));
        throw failure();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure();
      }
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
  const originalDigest = storeDigest(store);
  options.onProgress?.();
  const state = path.join(options.home, ".openclaw");
  const workers = path.join(options.runtimeRoot, "workers");
  const config = path.join(workers, "openclaw-migration-config.json");
  for (const mode of ["dry-run", "import"]) {
    options.assertHeld();
    options.signal?.throwIfAborted();
    if (inspectLegacyOpenClawSessions(options.home) !== store) throw failure();
    if (storeDigest(store) !== originalDigest) throw failure();
    if (mode === "import") beginImport(options.home);
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
      let leaseFailure: { error: unknown } | undefined;
      const stop = () => {
        stopped = true;
        child.kill();
      };
      const timeout = setTimeout(stop, 120_000);
      const guard = setInterval(() => {
        try {
          options.assertHeld();
        } catch (error) {
          leaseFailure ??= { error };
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
        if (leaseFailure) reject(leaseFailure.error);
        else if (stopped || code !== 0) reject(failure());
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
    if (
      !report ||
      report.mode !== mode ||
      report.totals?.issues !== 0 ||
      report.totals?.targets !== 1
    )
      throw failure();
    if (mode === "import") verifyArchivedStore(store, originalDigest, report);
  }
  options.assertHeld();
  options.signal?.throwIfAborted();
  // Clear intent only after every import check and the final lease/abort checks.
  // Do not clear it in a failure handler: the old index may already be archived.
  try {
    fs.unlinkSync(pendingMigration(options.home));
  } catch {
    throw failure();
  }
  return true;
}
