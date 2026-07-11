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

describe("managed DCode session supervisor platform boundary", () => {
  it("fails closed instead of silently bypassing supervision outside Linux", () => {
    const probe = [
      "import importlib.util",
      "spec = importlib.util.spec_from_file_location('supervisor', " +
        JSON.stringify(supervisor) +
        ")",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.sys.platform = 'darwin'",
      "module.os.execvp = lambda *_args: (_ for _ in ()).throw(RuntimeError('child executed'))",
      "raise SystemExit(module.run(['/fake/dcode']))",
    ].join("\n");
    const result = spawnSync("python3", ["-c", probe], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("dcode: session supervision requires a Linux OpenShell sandbox.\n");
  });
});

describe.runIf(canRun)("managed DCode session supervisor", () => {
  it("queues rapid pre-spawn disconnect signals and forwards them in order", () => {
    const probe = [
      "import importlib.util",
      "import os",
      "import signal",
      "import sys",
      `spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})`,
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "forwarded = []",
      "real_kill = os.kill",
      "module._enable_child_subreaper = lambda: None",
      "module._cleanup_adopted_descendants = lambda: None",
      "module.os.kill = lambda pid, sig: forwarded.append((pid, sig))",
      "class FakeChild:",
      "    pid = 4242",
      "    def __init__(self, _argv):",
      "        real_kill(os.getpid(), signal.SIGHUP)",
      "        real_kill(os.getpid(), signal.SIGTERM)",
      "    def wait(self):",
      "        return 0",
      "module.subprocess.Popen = FakeChild",
      "status = module.run(['/fake/dcode'])",
      "expected = [(4242, signal.SIGHUP), (4242, signal.SIGTERM)]",
      "raise SystemExit(0 if status == 0 and forwarded == expected else 1)",
    ].join("\n");

    const result = spawnSync("python3", ["-c", probe], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
  });

  it("preserves the DCode exit code after session cleanup", () => {
    const result = spawnSync("python3", [supervisor, "/bin/sh", "-c", "exit 7"], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(7);
  });

  it("preserves the managed empty-prompt exit contract through the supervisor", () => {
    const diagnostic = "NemoClaw: empty non-interactive prompt for -n; provide prompt text.";
    const result = spawnSync(
      "python3",
      [supervisor, "/bin/sh", "-c", `printf '%s\\n' ${JSON.stringify(diagnostic)} >&2; exit 2`],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toBe(`${diagnostic}\n`);
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
