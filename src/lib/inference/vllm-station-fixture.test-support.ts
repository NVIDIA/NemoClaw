// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function resolveStationFixturePython(): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory) || path.normalize(directory) !== directory) {
      continue;
    }
    try {
      const candidate = fs.realpathSync(path.join(directory, "python3"));
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep searching PATH for an executable fixture interpreter.
    }
  }
  throw new Error("python3 is required for the Station fixtures");
}
