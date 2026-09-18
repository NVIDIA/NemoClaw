// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

const SANITIZER = path.join(
  import.meta.dirname,
  "../../..",
  "scripts",
  "lib",
  "sanitize-npm-debug-log.mts",
);

it("bounds and redacts retained npm bootstrap diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-debug-"));
  const log = path.join(root, "debug-0.log");
  const token = `ghp_${"A".repeat(24)}`;
  const password = "registry-password-value";
  try {
    fs.writeFileSync(
      log,
      `${"discarded\n".repeat(20_000)}error code EACCES\npassword=${password}\ntoken=${token}\n`,
    );
    const result = spawnSync(process.execPath, [SANITIZER, log], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(129 * 1024);
    expect(result.stdout).toContain("error code EACCES");
    expect(result.stdout).not.toContain(token);
    expect(result.stdout).not.toContain(password);
    expect(result.stdout).toContain("<REDACTED>");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
