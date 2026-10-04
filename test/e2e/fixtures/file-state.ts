// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export type FileSnapshot =
  | { exists: false }
  | {
      exists: true;
      content: string;
    };

export function snapshotFile(file: string): FileSnapshot {
  return fs.existsSync(file)
    ? { exists: true, content: fs.readFileSync(file, "utf8") }
    : { exists: false };
}

export function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (!snapshot.exists) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, snapshot.content, "utf8");
}

export function readJsonFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** Returns the fallback only when the file is absent; malformed JSON still throws. */
export function readJsonFileOr<T>(file: string, fallback: T): T {
  return fs.existsSync(file) ? readJsonFile<T>(file) : fallback;
}

/** Returns the fallback when the file is absent or its JSON cannot be parsed. */
export function readJsonFileOrFallback<T>(file: string, fallback: T): T {
  try {
    return readJsonFileOr(file, fallback);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return fallback;
    }
    throw error;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
