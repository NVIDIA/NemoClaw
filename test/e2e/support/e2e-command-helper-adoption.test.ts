// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const LIVE_ROOT = path.resolve(import.meta.dirname, "../live");
const LOCAL_COMMAND_HELPER =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s+(?:resultText|expectExitZero)\s*\(|(?:const|let|var)\s+(?:resultText|expectExitZero)\b\s*(?::[^=]+)?=)/m;

function typescriptFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const nestedFiles = entry.isDirectory() ? typescriptFiles(target) : [];
    files.push(...nestedFiles);

    const currentFile = entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
    files.push(...currentFile);
  }

  return files;
}

describe("E2E command helper adoption", () => {
  it("keeps live targets on the shared command result helpers", () => {
    const violations = typescriptFiles(LIVE_ROOT)
      .filter((file) => LOCAL_COMMAND_HELPER.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(LIVE_ROOT, file));

    expect(violations).toEqual([]);
  });
});
