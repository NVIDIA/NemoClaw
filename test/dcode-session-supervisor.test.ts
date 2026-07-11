// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const supervisor = path.join(
  process.cwd(),
  "agents",
  "langchain-deepagents-code",
  "dcode-session-supervisor.py",
);
const canRun = process.platform === "linux" && spawnSync("python3", ["--version"]).status === 0;

describe.runIf(canRun)("managed DCode session supervisor", () => {
  it("preserves the DCode exit code after session cleanup", () => {
    const result = spawnSync("python3", [supervisor, "/bin/sh", "-c", "exit 7"], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(7);
  });

  it("terminates an orphaned LangGraph-like descendant when its session exits (#6678)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-supervisor-"));
    const pidFile = path.join(dir, "descendant.pid");
    const child = path.join(dir, "session.py");
    fs.writeFileSync(
      child,
      [
        "import pathlib",
        "import subprocess",
        "import sys",
        "descendant = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])",
        `pathlib.Path(${JSON.stringify(pidFile)}).write_text(str(descendant.pid), encoding='utf-8')`,
      ].join("\n"),
    );

    try {
      const result = spawnSync("python3", [supervisor, "python3", child], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(() => process.kill(descendantPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
