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
  "import os, sqlite3, sys",
  "src, dst = sys.argv[1], sys.argv[2]",
  "os.makedirs(os.path.dirname(dst), exist_ok=True)",
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
  "os.chmod(dst, 0o660)",
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
    return [
      `dst=${quotedRemotePath}`,
      'parent="$(dirname "$dst")"',
      '[ ! -L "$parent" ] || { echo "refusing symlinked state parent: $parent" >&2; exit 10; }',
      '[ ! -L "$dst" ] || { echo "refusing symlinked sqlite target: $dst" >&2; exit 11; }',
      'mkdir -p "$parent"',
      'tmp="$(mktemp /tmp/nemoclaw-sqlite-restore.XXXXXX)"',
      "trap 'rm -f \"$tmp\"' EXIT",
      'cat > "$tmp"',
      'chmod 600 "$tmp"',
      `umask 0007; python3 -c ${shellQuote(SQLITE_RESTORE_PY)} "$tmp" "$dst"`,
    ].join("; ");
  }

  const steps = [
    `dst=${quotedRemotePath}`,
    'parent="$(dirname "$dst")"',
    '[ ! -L "$parent" ] || { echo "refusing symlinked state parent: $parent" >&2; exit 10; }',
    '[ ! -L "$dst" ] || { echo "refusing symlinked state target: $dst" >&2; exit 11; }',
    'mkdir -p "$parent"',
    'tmp="$(mktemp "${parent}/.nemoclaw-restore.XXXXXX")"',
    'trap \'rm -f "$tmp" "${anchor_tmp:-}"\' EXIT',
    'cat > "$tmp"',
    'chmod 640 "$tmp"',
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
