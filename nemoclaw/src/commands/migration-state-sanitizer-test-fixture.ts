// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isSensitiveFile, stripCredentials } from "../security/credential-filter.js";

interface TestFsEntry {
  type: "file" | "dir" | "symlink";
  content?: string;
}

/** Model the sanitizer's public data contract for migration-state's in-memory filesystem tests. */
export function buildMigrationStateSanitizerMock(store: Map<string, TestFsEntry>) {
  function sanitizeJsonAt(filePath: string): boolean {
    const entry = store.get(filePath);
    if (entry?.type !== "file") return false;
    try {
      const parsed: unknown = JSON.parse(entry.content ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        delete (parsed as Record<string, unknown>)["gateway"];
      }
      store.set(filePath, {
        type: "file",
        content: JSON.stringify(stripCredentials(parsed), null, 2),
      });
      return true;
    } catch {
      return false;
    }
  }

  return {
    sanitizeMigrationDirectory: (rootPath: string) => {
      for (const [filePath, entry] of [...store.entries()]) {
        if (entry.type !== "file" || !filePath.startsWith(`${rootPath}/`)) continue;
        if (isSensitiveFile(filePath.split("/").at(-1) ?? "")) {
          store.delete(filePath);
        } else if (filePath.toLowerCase().endsWith(".json") && !sanitizeJsonAt(filePath)) {
          store.delete(filePath);
        }
      }
    },
    sanitizeOpenClawConfigFile: sanitizeJsonAt,
  };
}
