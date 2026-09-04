// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");

describe("reviewed npm audit entry point", () => {
  it("can be imported when the process entry-point path does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-missing-audit-entry-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          `process.argv[1] = ${JSON.stringify(path.join(root, "missing-entrypoint"))}; await import(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "scripts/audit-reviewed-npm-graph.mts")).href)});`,
        ],
        { encoding: "utf8" },
      );

      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
