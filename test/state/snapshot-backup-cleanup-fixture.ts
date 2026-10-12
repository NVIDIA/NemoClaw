// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { vi } from "vitest";

export function beforeNextBackupDirectoryCreate(sandboxRoot: string, create: () => void): void {
  const originalMkdirSync = fs.mkdirSync;
  const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation((directory, options) => {
    if (path.dirname(String(directory)) === sandboxRoot) {
      mkdir.mockRestore();
      syncBuiltinESMExports();
      create();
    }
    return Reflect.apply(originalMkdirSync, undefined, [directory, options]);
  });
  syncBuiltinESMExports();
}
