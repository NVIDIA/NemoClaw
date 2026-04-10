// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export class ConfigPermissionError extends Error {
  filePath: string;

  constructor(filePath: string, action: "read" | "write" | "create directory") {
    super(
      `Cannot ${action} config file at ${filePath}. ` +
        "Check that HOME points to a user-owned directory and that ~/.nemoclaw is writable.",
    );
    this.name = "ConfigPermissionError";
    this.filePath = filePath;
  }
}

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM"),
  );
}

export function ensureConfigDir(dirPath: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (isPermissionError(error)) {
      throw new ConfigPermissionError(dirPath, "create directory");
    }
    throw error;
  }
}

export function readConfigFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    if (isPermissionError(error)) {
      throw new ConfigPermissionError(filePath, "read");
    }
    return fallback;
  }
}

export function writeConfigFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureConfigDir(dir);

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
      throw new ConfigPermissionError(filePath, "write");
    }
    throw error;
  }
}
