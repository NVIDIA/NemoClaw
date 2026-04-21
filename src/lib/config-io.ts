// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Safe config file I/O with permission-aware errors and atomic writes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "./shell-quote";

function buildRemediation(): string {
  const home = process.env.HOME || os.homedir();
  const nemoclawDir = path.join(home, ".nemoclaw");
  const backupDir = `${nemoclawDir}.backup.${process.pid}`;
  const recoveryHome = path.join(os.tmpdir(), `nemoclaw-home-${process.getuid?.() ?? "user"}`);

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

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM"),
  );
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

export function ensureConfigDir(dirPath: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });

    const stat = fs.statSync(dirPath);
    if ((stat.mode & 0o077) !== 0) {
      fs.chmodSync(dirPath, 0o700);
    }
  } catch (error) {
    if (isPermissionError(error)) {
      throw new ConfigPermissionError(`Cannot create config directory: ${dirPath}`, dirPath, error as Error);
    }
    throw error;
  }

  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
  } catch (error) {
    if (isPermissionError(error)) {
      throw new ConfigPermissionError(
        `Config directory exists but is not writable: ${dirPath}`,
        dirPath,
        error as Error,
      );
    }
    throw error;
  }
}

export function readConfigFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    if (isPermissionError(error)) {
      throw new ConfigPermissionError(`Cannot read config file: ${filePath}`, filePath, error as Error);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    return fallback;
  }
}

export function writeConfigFile(filePath: string, data: unknown): void {
  const dirPath = path.dirname(filePath);
  ensureConfigDir(dirPath);

  const tmpFile = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* best effort */
    }
    if (isPermissionError(error)) {
      throw new ConfigPermissionError(`Cannot write config file: ${filePath}`, filePath, error as Error);
    }
    throw error;
  }
}
