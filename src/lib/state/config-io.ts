// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Safe config file I/O with permission-aware errors and atomic writes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "../core/shell-quote";
import { isErrnoException, isPermissionError } from "../core/errno";

// Strict JSON types for file serialization — unlike json-types.ts,
// these exclude undefined since actual JSON cannot contain it.
type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type SerializableConfig = JsonScalar | JsonValue[] | object;

function toError(error: Error | string | number | boolean | null | undefined): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function cleanupTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best effort — cleanup only.
  }
}

function buildRemediation(): string {
  const home = process.env.HOME ?? os.homedir();
  const nemoclawDir = path.join(home, ".nemoclaw");
  const backupDir = `${nemoclawDir}.backup.${String(process.pid)}`;
  const recoveryHome = path.join(
    os.tmpdir(),
    `nemoclaw-home-${String(process.getuid?.() ?? "user")}`,
  );

  return [
    "  To fix, try one of these recovery paths:",
    "",
    "    # If you can use sudo, repair the existing config directory:",
    `    sudo chown -R $(whoami) ${shellQuote(nemoclawDir)}`,
    "    # or recreate it if it was created by another user:",
    `    sudo rm -rf ${shellQuote(nemoclawDir)} && nemoclaw onboard`,
    "",
    "    # If sudo is unavailable, move the bad config aside from a writable HOME:",
    `    mv ${shellQuote(nemoclawDir)} ${shellQuote(backupDir)} && nemoclaw onboard`,
    "    # or, if you already own the directory, remove it without sudo:",
    `    rm -rf ${shellQuote(nemoclawDir)} && nemoclaw onboard`,
    "",
    "    # If HOME itself is not writable, start NemoClaw with a writable HOME:",
    `    mkdir -p ${shellQuote(recoveryHome)} && HOME=${shellQuote(recoveryHome)} nemoclaw onboard`,
    "",
    "  This usually happens when NemoClaw was first run with sudo",
    "  or the config directory was created by a different user.",
  ].join("\n");
}

export class ConfigPermissionError extends Error {
  code = "EACCES";
  configPath: string;
  filePath: string;
  remediation: string;

  constructor(filePath: string, action: "read" | "write" | "create directory");
  constructor(message: string, configPath: string, cause?: Error);
  constructor(messageOrPath: string, configPathOrAction: string, cause?: Error) {
    const action =
      configPathOrAction === "read" ||
      configPathOrAction === "write" ||
      configPathOrAction === "create directory"
        ? configPathOrAction
        : null;

    const configPath = action ? messageOrPath : configPathOrAction;
    const message = action
      ? action === "create directory"
        ? `Cannot create config directory: ${configPath}`
        : `Cannot ${action} config file: ${configPath}`
      : messageOrPath;

    const remediation = buildRemediation();
    super(`${message}\n\n${remediation}`);
    this.name = "ConfigPermissionError";
    this.configPath = configPath;
    this.filePath = configPath;
    this.remediation = remediation;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Reject a path if it — or any ancestor up to the user's home — is a symlink.
 * This prevents an attacker from planting e.g. ~/.nemoclaw as a symlink to an
 * attacker-controlled directory, which would cause credentials to be written
 * to the wrong location. Throws when a planted symlink is found; returns
 * normally otherwise.
 */
export function rejectSymlinksOnPath(dirPath: string): void {
  const home = process.env.HOME || os.homedir();
  const resolved = path.resolve(dirPath);
  const resolvedHome = path.resolve(home);

  // Only check the path components between HOME and dirPath — those are
  // the user-controllable segments where a symlink attack could be planted.
  // System-level symlinks above HOME (e.g. /var -> private/var on macOS)
  // are legitimate and must not trigger rejection.
  const relToHome = path.relative(resolvedHome, resolved);
  if (relToHome === "" || relToHome.startsWith("..") || path.isAbsolute(relToHome)) {
    // dirPath is not under HOME — nothing user-controllable to check.
    return;
  }

  // Walk from dirPath up to (but not including) HOME.
  let current = resolved;
  while (current !== resolvedHome && current !== path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(current);
        throw new Error(
          `Refusing to use config directory: ${current} is a symbolic link ` +
            `(target: ${target}). This may indicate a symlink attack. ` +
            `Remove the symlink and retry: rm ${shellQuote(current)}`,
        );
      }
    } catch (error) {
      const errnoError = error instanceof Error ? error : null;
      // ENOENT is fine — the directory doesn't exist yet; keep walking up
      // to check ancestors that DO exist (an ancestor might be a symlink).
      if (!(isErrnoException(errnoError) && errnoError.code === "ENOENT")) {
        throw error;
      }
    }
    current = path.dirname(current);
  }
}

/**
 * Tighten group/world bits on every regular file directly inside `dirPath`.
 * Symlinks are skipped (we use `lstat`; a chmod on a symlink follows to the
 * target, which would mutate something outside the config dir). Subdirectories
 * are skipped — this is intentionally root-level only, matching the issue's
 * acceptance criteria (#4546). Best-effort: a single file's chmod failure
 * does not abort the walk.
 */
function healRootLevelFiles(dirPath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    // If we can't list (e.g. dir does not exist), nothing to heal.
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const full = path.join(dirPath, entry.name);
    try {
      // lstat (not stat) so a TOCTOU-swapped symlink between readdir and
      // chmod doesn't trick us into chmodding a target outside the dir.
      const st = fs.lstatSync(full);
      if (!st.isFile()) continue;
      if ((st.mode & 0o077) !== 0) {
        fs.chmodSync(full, 0o600);
      }
    } catch {
      // Best effort — keep walking.
    }
  }
}

export function ensureConfigDir(dirPath: string): void {
  // SECURITY: Block symlink attacks before creating or writing to the directory.
  rejectSymlinksOnPath(dirPath);

  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });

    const stat = fs.statSync(dirPath);
    if ((stat.mode & 0o077) !== 0) {
      fs.chmodSync(dirPath, 0o700);
    }
  } catch (error) {
    const errnoError = error instanceof Error ? error : null;
    if (isPermissionError(errnoError)) {
      throw new ConfigPermissionError(
        `Cannot create config directory: ${dirPath}`,
        dirPath,
        toError(errnoError),
      );
    }
    throw error;
  }

  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
  } catch (error) {
    const errnoError = error instanceof Error ? error : null;
    if (isPermissionError(errnoError)) {
      throw new ConfigPermissionError(
        `Config directory exists but is not writable: ${dirPath}`,
        dirPath,
        toError(errnoError),
      );
    }
    throw error;
  }

  // Heal every root-level file in the dir, not just the one being read.
  // Issue #4546 expects auto-repair across all root-level files
  // (sandboxes.json, onboard-session.json, ollama-auth-proxy.pid,
  // ollama-proxy-token, usage-notice.json, etc.) — most of which are written
  // by code paths that don't flow through readConfigFile/writeConfigFile.
  // Doing the walk here means every nemoclaw invocation that touches the
  // config dir restores the entire root level to mode 600.
  healRootLevelFiles(dirPath);
}

export function readConfigFile<T>(filePath: string, fallback: T): T {
  try {
    ensureConfigDir(path.dirname(filePath));
  } catch (error) {
    if (error instanceof ConfigPermissionError) {
      throw error;
    }
    // Directory doesn't exist and can't be created — fall through to let
    // readFileSync produce the appropriate ENOENT / fallback path.
  }

  try {
    const content = parseJson<T>(fs.readFileSync(filePath, "utf-8"));

    // Heal file-level permission drift: tighten group/world bits.
    // lstat (not stat) so we don't chmod through a symlink to a target
    // outside the config dir — defensive duplicate of healRootLevelFiles
    // for read paths whose dirname differs from what ensureConfigDir saw.
    try {
      const st = fs.lstatSync(filePath);
      if (st.isFile() && (st.mode & 0o077) !== 0) {
        fs.chmodSync(filePath, 0o600);
      }
    } catch {
      // Best effort — don't fail the read if we can't heal permissions.
    }

    return content;
  } catch (error) {
    const errnoError = error instanceof Error ? error : null;
    if (isPermissionError(errnoError)) {
      throw new ConfigPermissionError(
        `Cannot read config file: ${filePath}`,
        filePath,
        toError(errnoError),
      );
    }
    if (isErrnoException(errnoError) && errnoError.code === "ENOENT") {
      return fallback;
    }
    return fallback;
  }
}

export function writeConfigFile(filePath: string, data: SerializableConfig): void {
  const dirPath = path.dirname(filePath);
  ensureConfigDir(dirPath);

  const tmpFile = `${filePath}.tmp.${String(process.pid)}`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, filePath);
  } catch (error) {
    cleanupTempFile(tmpFile);
    const errnoError = error instanceof Error ? error : null;
    if (isPermissionError(errnoError)) {
      throw new ConfigPermissionError(
        `Cannot write config file: ${filePath}`,
        filePath,
        toError(errnoError),
      );
    }
    throw error;
  }
}
