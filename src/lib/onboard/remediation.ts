// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export function printRemediationActions(
  actions:
    | readonly {
        id: string;
        title: string;
        reason: string;
        commands?: readonly string[];
      }[]
    | null
    | undefined,
): void {
  if (!Array.isArray(actions) || actions.length === 0) {
    return;
  }

  console.error("");
  console.error("  Suggested fix:");
  console.error("");
  for (const action of actions) {
    console.error(`  - ${action.title} (${action.id}): ${action.reason}`);
    for (const command of action.commands || []) {
      console.error(`    ${command}`);
    }
  }
}

export function getFutureShellPathHint(
  binDir: string,
  pathValue = process.env.PATH || "",
): string | null {
  const parts = String(pathValue).split(path.delimiter).filter(Boolean);
  if (parts[0] === binDir) {
    return null;
  }
  return `export PATH="${binDir}:$PATH"`;
}
