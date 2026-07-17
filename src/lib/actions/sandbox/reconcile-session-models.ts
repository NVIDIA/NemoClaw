// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { shellQuote } from "../../core/shell-quote";
import { MANAGED_PROVIDER_ID } from "../../inference/config";
import { isSafeModelId } from "../../validation";
import { executeSandboxCommand } from "./process-recovery";
import type { RebuildLog } from "./rebuild-credential-preflight";
import { DEFAULT_AGENT_ID } from "./sessions/paths";

const OPENCLAW_CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";
const MAX_PRIMARY_MODEL_REF_LENGTH = 512;

const SESSION_STORE_REPLACE_PYTHON = String.raw`
import base64
import hashlib
import os
import secrets
import stat
import sys

target_path = sys.argv[1]
payload = base64.b64decode(sys.argv[2], validate=True)
expected_sha256 = sys.argv[3]
parent_path, target_name = os.path.split(target_path)
if not os.path.isabs(target_path) or not parent_path or not target_name:
    raise ValueError("session store path must be absolute with a parent and basename")
for flag_name in ("O_DIRECTORY", "O_NOFOLLOW"):
    if not hasattr(os, flag_name):
        raise OSError(f"{flag_name} is required for safe session store replacement")

parent_fd = -1
source_fd = -1
staged_fd = -1
staged_name = ""
staged_identity = None
installed = False
try:
    directory_flags = (
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    )
    parent_fd = os.open(os.sep, directory_flags)
    for component in (part for part in parent_path.split(os.sep) if part):
        next_fd = os.open(component, directory_flags, dir_fd=parent_fd)
        os.close(parent_fd)
        parent_fd = next_fd
    source_fd = os.open(
        target_name,
        os.O_RDONLY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0),
        dir_fd=parent_fd,
    )
    source_stat = os.fstat(source_fd)
    if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_nlink != 1:
        raise ValueError("session store must be a single regular file")
    source_chunks = []
    while True:
        chunk = os.read(source_fd, 1024 * 1024)
        if not chunk:
            break
        source_chunks.append(chunk)
    if hashlib.sha256(b"".join(source_chunks).strip()).hexdigest() != expected_sha256:
        raise ValueError("session store changed before atomic replacement")

    create_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )
    for _attempt in range(100):
        staged_name = f".sessions.json.nemoclaw.{secrets.token_hex(16)}"
        try:
            staged_fd = os.open(staged_name, create_flags, 0o600, dir_fd=parent_fd)
            break
        except FileExistsError:
            continue
    if staged_fd < 0:
        raise OSError("could not create a private session store staging file")
    staged_identity = os.fstat(staged_fd)
    if not stat.S_ISREG(staged_identity.st_mode) or staged_identity.st_nlink != 1:
        raise ValueError("session store staging path is not a single regular file")

    written = 0
    while written < len(payload):
        count = os.write(staged_fd, payload[written:])
        if count <= 0:
            raise OSError("session store staging write made no progress")
        written += count
    os.fchown(staged_fd, source_stat.st_uid, source_stat.st_gid)
    os.fchmod(staged_fd, stat.S_IMODE(source_stat.st_mode))
    os.fsync(staged_fd)

    current_stat = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
    current_identity = (
        current_stat.st_dev,
        current_stat.st_ino,
        current_stat.st_size,
        current_stat.st_mtime_ns,
        current_stat.st_ctime_ns,
    )
    source_identity = (
        source_stat.st_dev,
        source_stat.st_ino,
        source_stat.st_size,
        source_stat.st_mtime_ns,
        source_stat.st_ctime_ns,
    )
    if current_identity != source_identity:
        raise ValueError("session store changed before atomic replacement")
    latest_staged = os.stat(staged_name, dir_fd=parent_fd, follow_symlinks=False)
    if (latest_staged.st_dev, latest_staged.st_ino) != (
        staged_identity.st_dev,
        staged_identity.st_ino,
    ):
        raise ValueError("session store staging file changed before atomic replacement")

    os.replace(staged_name, target_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    installed = True
    os.fsync(parent_fd)
finally:
    if not installed and staged_name and staged_identity is not None and parent_fd >= 0:
        try:
            latest_staged = os.stat(staged_name, dir_fd=parent_fd, follow_symlinks=False)
            if (latest_staged.st_dev, latest_staged.st_ino) == (
                staged_identity.st_dev,
                staged_identity.st_ino,
            ):
                os.unlink(staged_name, dir_fd=parent_fd)
        except OSError:
            pass
    for descriptor in (staged_fd, source_fd, parent_fd):
        if descriptor >= 0:
            os.close(descriptor)
`.trim();

function defaultAgentSessionsPath(agentId: string): string {
  return `/sandbox/.openclaw/agents/${agentId}/sessions/sessions.json`;
}

export function buildSessionStoreReplaceCommand(
  sessionsPath: string,
  content: string,
  expectedSource: string,
): string {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const expectedSha256 = createHash("sha256").update(expectedSource).digest("hex");
  return [
    "python3",
    "-I",
    "-c",
    shellQuote(SESSION_STORE_REPLACE_PYTHON),
    shellQuote(sessionsPath),
    shellQuote(encoded),
    shellQuote(expectedSha256),
  ].join(" ");
}

export interface SessionModelReconcileResult {
  changed: boolean;
  content: string;
  clearedSessionKeys: string[];
}

/**
 * #7102: OpenClaw pins a `{ modelProvider, model }` on each stored session in
 * `agents/<id>/sessions/sessions.json`. `nemoclaw inference set` + `rebuild`
 * update the config default (`agents.defaults.model.primary`) but leave those
 * per-session pins on the pre-switch model, so the TUI status bar shows the old
 * model when it resumes the last session on the first connect after a switch.
 *
 * This reconciles the persisted pins: for a session whose pin is the *managed*
 * provider and no longer matches the current default, clear the pin so the
 * session falls back to the config default — matching OpenClaw's own clean-entry
 * semantics after `sessions.reset`. Sessions already on the default, and
 * sessions pinned to a different provider (an intentional per-session choice),
 * are left untouched. Pure so the contract is unit-tested without a sandbox.
 */
export function reconcilePinnedSessionModels(
  sessionsRaw: string,
  primaryModelRef: string | null,
): SessionModelReconcileResult {
  const noChange: SessionModelReconcileResult = {
    changed: false,
    content: sessionsRaw,
    clearedSessionKeys: [],
  };
  if (!primaryModelRef) return noChange;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionsRaw);
  } catch {
    return noChange;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return noChange;
  const store = parsed as Record<string, unknown>;
  const clearedSessionKeys: string[] = [];
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const provider = record.modelProvider;
    const model = record.model;
    // Only touch pins on the managed provider; a different provider is an
    // intentional per-session choice.
    if (provider !== MANAGED_PROVIDER_ID || typeof model !== "string") continue;
    // Already following the current default → nothing to reconcile.
    if (`${provider}/${model}` === primaryModelRef) continue;
    delete record.model;
    delete record.modelProvider;
    clearedSessionKeys.push(key);
  }
  if (clearedSessionKeys.length === 0) return noChange;
  return {
    changed: true,
    content: `${JSON.stringify(store, null, 2)}\n`,
    clearedSessionKeys,
  };
}

function readPrimaryModelRef(sandboxName: string): string | null {
  const res = executeSandboxCommand(sandboxName, `cat ${OPENCLAW_CONFIG_PATH} 2>/dev/null`);
  if (!res || res.status !== 0 || !res.stdout.trim()) return null;
  try {
    const config = JSON.parse(res.stdout) as {
      agents?: { defaults?: { model?: { primary?: unknown } } };
    };
    const primary = config.agents?.defaults?.model?.primary;
    if (typeof primary !== "string") return null;
    const normalized = primary.trim();
    return normalized.length > 0 &&
      normalized.length <= MAX_PRIMARY_MODEL_REF_LENGTH &&
      isSafeModelId(normalized)
      ? normalized
      : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort reconcile of stale pinned session models after a rebuild restore.
 * MUST run in the post-restore window (gateway down): OpenClaw owns
 * `sessions.json` while it is live, so editing it during `inference set` would
 * race its writes, while omitting the session store from rebuild restore would
 * discard conversation state. This recovery can be removed when OpenClaw
 * exposes an offline, race-free session-model reset operation.
 */
export function reconcileStalePinnedSessionModelsAfterRebuild(
  sandboxName: string,
  log: RebuildLog,
): void {
  const primary = readPrimaryModelRef(sandboxName);
  if (!primary) {
    log("Session model reconcile skipped: could not read agents.defaults.model.primary");
    return;
  }
  const sessionsPath = defaultAgentSessionsPath(DEFAULT_AGENT_ID);
  const readResult = executeSandboxCommand(sandboxName, `cat ${sessionsPath} 2>/dev/null`);
  if (!readResult || readResult.status !== 0 || !readResult.stdout.trim()) {
    log(`Session model reconcile skipped: no session store at ${sessionsPath}`);
    return;
  }
  const reconciled = reconcilePinnedSessionModels(readResult.stdout, primary);
  if (!reconciled.changed) {
    log("Session model reconcile: no stale pinned session models");
    return;
  }
  const writeResult = executeSandboxCommand(
    sandboxName,
    buildSessionStoreReplaceCommand(sessionsPath, reconciled.content, readResult.stdout),
  );
  if (!writeResult || writeResult.status !== 0) {
    log(
      `Session model reconcile: failed to write ${sessionsPath} (status=${writeResult?.status ?? "null"})`,
    );
    return;
  }
  log(
    `Session model reconcile: cleared stale pinned model on ${reconciled.clearedSessionKeys.length} session(s) so they follow ${primary}`,
  );
}
