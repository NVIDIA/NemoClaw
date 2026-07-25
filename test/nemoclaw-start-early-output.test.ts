// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

describe("early entrypoint output capture", () => {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");

  it("copies early stdout and stderr to a restricted diagnostic log", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-log-"));
    const logPath = path.join(tempDir, "nemoclaw-start.log");
    const start = source.indexOf("# ── Early stderr/stdout capture");
    const end = source.indexOf("# ── Source shared sandbox initialisation library", start);
    const block = source.slice(start, end).replaceAll("/tmp/nemoclaw-start.log", logPath);
    const wrapperPath = path.join(tempDir, "run.sh");
    fs.writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        block,
        "echo stdout-line",
        "echo stderr-line >&2",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("stdout-line");
      expect(result.stderr).toContain("stderr-line");
      const log = fs.readFileSync(logPath, "utf-8");
      expect(log).toContain("stdout-line");
      expect(log).toContain("stderr-line");
      expect((fs.statSync(logPath).mode & 0o777).toString(8)).toBe("600");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
