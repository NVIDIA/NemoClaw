// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureResolvedOpenshell } from "./runtime";

const directories: string[] = [];

function executable(name: string, output: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-capture-test-"));
  directories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `#!/bin/sh\nprintf ${output}`, { mode: 0o755 });
  return filePath;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("captureResolvedOpenshell", () => {
  it("invokes the exact canonical executable supplied by CUA authority", () => {
    const decoy = executable("decoy", "decoy");
    const snapshot = executable("snapshot", "snapshot");

    const result = captureResolvedOpenshell([], {
      openshellBinary: snapshot,
      env: { NEMOCLAW_OPENSHELL_BIN: decoy },
      replaceEnv: true,
    });

    expect(result.status).toBe(0);
    expect(result.output).toBe("snapshot");
  });
});
