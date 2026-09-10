// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { StateFileRestoreOwnership } from "../agent/defs.js";
import { shellQuote } from "../runner.js";
import { buildOpenClawConfigRestoreInputFromSandbox } from "./openclaw-config-restore-input.js";
import type { OpenClawImagePluginInstall } from "./openclaw-plugin-restore.js";
import { buildKeyAllowlistMergeRestoreCommand } from "./state-file-key-merge.js";

export interface StateFileRestoreSpec {
  path: string;
  strategy: "copy" | "sqlite_backup";
}

const SQLITE_RESTORE_PY = [
  "import sqlite3, sys",
  "src, dst = sys.argv[1], sys.argv[2]",
  "src_conn = sqlite3.connect('file:' + src + '?mode=ro', uri=True, timeout=30)",
  "dst_conn = sqlite3.connect(dst, timeout=30)",
  "try:",
  "    dst_conn.execute('PRAGMA busy_timeout=30000')",
  "    src_conn.backup(dst_conn)",
  "    ok = dst_conn.execute('PRAGMA quick_check').fetchone()[0]",
  "    if ok != 'ok':",
  "        raise SystemExit('sqlite quick_check failed: ' + str(ok))",
  "finally:",
  "    dst_conn.close()",
  "    src_conn.close()",
].join("\n");

const SQLITE_WRITE_CHECK_PY = [
  "import sqlite3, sys",
  "dst = sys.argv[1]",
  "conn = sqlite3.connect(dst, timeout=30)",
  "try:",
  "    conn.execute('PRAGMA busy_timeout=30000')",
  "    conn.execute('BEGIN IMMEDIATE')",
  "    conn.execute('ROLLBACK')",
  "finally:",
  "    conn.close()",
].join("\n");

function stateFileRemotePath(dir: string, filePath: string): string {
  return `${dir.replace(/\/+$/, "")}/${filePath}`;
}

export function buildStateFileRestoreCommand(
  dir: string,
  spec: StateFileRestoreSpec,
  refreshOpenClawConfigHash = false,
): string {
  const remotePath = stateFileRemotePath(dir, spec.path);
  const quotedRemotePath = shellQuote(remotePath);
  if (spec.strategy === "sqlite_backup") {
    // The agent gateway can own the live database under a distinct uid, so
    // restoring in place can fail for the sandbox user and expose a partially
    // replaced SQLite file to the gateway (#7312). Validate the backup into a
    // staged database this user owns, then replace the target atomically;
    // replacement only needs write permission on the parent directory. The
    // stale WAL/SHM sidecars belong to the replaced database, so drop them.
    //
    // A successful swap does not prove the agent can persist to the result, so
    // open a write transaction against the replaced database before reporting
    // success. The check runs under the same umask as the restore so its own
    // sidecars stay group-writable, and both sidecar pairs are dropped: the
    // stale ones before the check reads them, the check's own after it ends.
    return [
      `dst=${quotedRemotePath}`,
      'parent="$(dirname "$dst")"',
      '[ ! -L "$parent" ] || { echo "refusing symlinked state parent: $parent" >&2; exit 10; }',
      '[ ! -L "$dst" ] || { echo "refusing symlinked sqlite target: $dst" >&2; exit 11; }',
      'mkdir -p "$parent"',
      'tmp="$(mktemp /tmp/nemoclaw-sqlite-restore.XXXXXX)"',
      'staged="$(mktemp "${parent}/.nemoclaw-sqlite-staged.XXXXXX")"',
      'trap \'rm -f "$tmp" "$staged" "${staged}-wal" "${staged}-shm"\' EXIT',
      'cat > "$tmp"',
      'chmod 600 "$tmp"',
      `(umask 0007; /usr/bin/python3 -I -S -c ${shellQuote(SQLITE_RESTORE_PY)} "$tmp" "$staged")`,
      'chmod 660 "$staged"',
      'mv -f "$staged" "$dst"',
      'rm -f -- "${dst}-wal" "${dst}-shm"',
      `(umask 0007; /usr/bin/python3 -I -S -c ${shellQuote(SQLITE_WRITE_CHECK_PY)} "$dst") || { echo "restored database is not writable: $dst" >&2; exit 12; }`,
      'rm -f -- "${dst}-wal" "${dst}-shm"',
    ].join(" && ");
  }

  const steps = [
    // Steps join with ";", so only the last step sets the exit status and the
    // OpenClaw path ends with `|| true`. "&&" is not a substitute: an earlier
    // failure then falls into the next step's `|| { ...; exit N; }` guard.
    "set -e",
    `dst=${quotedRemotePath}`,
    'parent="$(dirname "$dst")"',
    '[ ! -L "$parent" ] || { echo "refusing symlinked state parent: $parent" >&2; exit 10; }',
    '[ ! -L "$dst" ] || { echo "refusing symlinked state target: $dst" >&2; exit 11; }',
    'mkdir -p "$parent"',
    'tmp="$(mktemp "${parent}/.nemoclaw-restore.XXXXXX")"',
    'trap \'rm -f "$tmp" "${anchor_tmp:-}"\' EXIT',
    'cat > "$tmp"',
    // The managed OpenClaw restart preflight accepts only the exact mutable
    // sandbox:sandbox 0660 configuration posture. Apply that mode to the
    // staged inode before the atomic swap so the gateway and its trusted
    // controller never observe the restored config with the generic 0640
    // state-file mode.
    refreshOpenClawConfigHash ? 'chmod 660 "$tmp"' : 'chmod 640 "$tmp"',
  ];

  if (refreshOpenClawConfigHash) {
    // Stage the OpenClaw recovery anchor before swapping the live config so
    // the integrity watcher can never observe a restored config paired with a
    // stale `.last-good` recovery target.
    steps.push(
      'last_good="${dst}.last-good"',
      '[ ! -L "$last_good" ] || { echo "refusing symlinked last-good target: $last_good" >&2; exit 13; }',
      'anchor_tmp="$(mktemp "${parent}/.nemoclaw-lastgood.XXXXXX")" || { echo "failed to stage last-good anchor" >&2; exit 14; }',
      'cat "$tmp" > "$anchor_tmp" || { echo "failed to write last-good anchor" >&2; exit 14; }',
      'chmod 660 "$anchor_tmp" 2>/dev/null || true',
      'mv -f "$anchor_tmp" "$last_good" || { echo "failed to install last-good anchor" >&2; exit 14; }',
    );
  }

  steps.push('mv -f "$tmp" "$dst"');

  if (refreshOpenClawConfigHash) {
    steps.push(
      'hash_file="${parent}/.config-hash"',
      '[ ! -L "$hash_file" ] || { echo "refusing symlinked config hash target: $hash_file" >&2; exit 12; }',
      '(cd "$parent" && sha256sum "$(basename "$dst")" > .config-hash)',
      'chmod 660 "$hash_file" 2>/dev/null || true',
    );
  }

  return steps.join("; ");
}

export function restoreStateFile(
  sshArgs: readonly string[],
  dir: string,
  spec: StateFileRestoreSpec,
  backupPath: string,
  ownership: StateFileRestoreOwnership | undefined,
  allowCustomImageWholeStateFileRestore: boolean,
  log: (message: string) => void,
  freshImagePluginInstalls?: readonly OpenClawImagePluginInstall[],
  previousImagePluginInstalls?: readonly OpenClawImagePluginInstall[],
  env?: NodeJS.ProcessEnv,
): boolean {
  const localPath = path.join(backupPath, spec.path);
  if (!existsSync(localPath)) return true;

  const backupContents = readFileSync(localPath);
  log(`Restoring state file ${spec.path} (${spec.strategy})`);

  let command: string;
  let input: Buffer | null;
  if (ownership?.merge === "openclaw-config") {
    command = buildStateFileRestoreCommand(dir, spec, true);
    const result = buildOpenClawConfigRestoreInputFromSandbox({
      backupContents,
      dir,
      env,
      freshImagePluginInstalls,
      log,
      previousImagePluginInstalls,
      specPath: spec.path,
      sshArgs,
    });
    if (result.ok) {
      input = result.input;
    } else {
      log(`FAILED: ${result.error}`);
      input = null;
    }
  } else if (ownership?.merge === "key-allowlist") {
    command = allowCustomImageWholeStateFileRestore
      ? buildStateFileRestoreCommand(dir, spec, false)
      : buildKeyAllowlistMergeRestoreCommand(dir, spec, ownership);
    input = backupContents;
  } else {
    command = buildStateFileRestoreCommand(dir, spec, false);
    input = backupContents;
  }
  if (input === null) return false;

  const result = spawnSync("ssh", [...sshArgs, command], {
    ...(env ? { env } : {}),
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });

  if (result.status === 0 && !result.error && !result.signal) return true;

  const detail =
    (result.stderr?.toString() || "").trim() ||
    result.error?.message ||
    (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
  log(`FAILED: state file restore ${spec.path}: ${detail.substring(0, 200)}`);
  return false;
}
