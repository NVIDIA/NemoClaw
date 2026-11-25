// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Load trusted code once; file data travels over stdin, never through executable arguments.
const helper = readFileSync(
  new URL("./protected-openshell-filesystem.py", import.meta.url),
  "utf8",
);

/** Use POSIX dir_fd support without inheriting credentials, import hooks, or shell parsing. */
function operate(root: string, path: string, request: Record<string, unknown>): string {
  try {
    return execFileSync("/usr/bin/python3", ["-I", "-S", "-c", helper], {
      input: JSON.stringify({ ...request, root: resolve(root), path }),
      encoding: "utf8",
      env: {},
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new Error(`Unsafe protected OpenShell file: ${path}`, { cause });
  }
}

/** Read the same opened file beneath a pinned, non-link parent chain. */
export function safeFile(
  root: string,
  path: string,
): { path: string; mode: number; source: string } {
  const file = JSON.parse(operate(root, path, { operation: "read" })) as {
    mode: number;
    source: string;
  };
  return { ...file, path: join(resolve(root), path) };
}

/** Publish through one pinned parent descriptor and reject a detached directory chain. */
export function replaceSource(
  root: string,
  path: string,
  source: string,
  mode: number,
  expectedSource?: string,
): void {
  operate(root, path, { operation: "replace", source, mode, expectedSource });
}
