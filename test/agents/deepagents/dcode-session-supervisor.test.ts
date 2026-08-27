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

  it("switches to bounded waiting when disconnect arrives after child spawn", () => {
    const probe = [
      "import importlib.util",
      "import os",
      "import signal",
      `spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})`,
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.sys.platform = 'linux'",
      "module._enable_child_subreaper = lambda: None",
      "module._cleanup_adopted_descendants = lambda: None",
      "real_kill = os.kill",
      "forwarded = []",
      "module.os.kill = lambda pid, sig: forwarded.append((pid, sig))",
      "class FakeChild:",
      "    pid = 4242",
      "    waits = 0",
      "    def __init__(self, _argv): pass",
      "    def wait(self, timeout=None):",
      "        if self.waits == 0:",
      "            self.waits += 1",
      "            real_kill(os.getpid(), signal.SIGHUP)",
      "            raise module.subprocess.TimeoutExpired(['/fake/dcode'], timeout)",
      "        return 0",
      "module.subprocess.Popen = FakeChild",
      "status = module.run(['/fake/dcode'])",
      "expected = [(4242, signal.SIGHUP)]",
      "raise SystemExit(0 if status == 0 and forwarded == expected else 1)",
    ].join("\n");
    const result = spawnSync("python3", ["-c", probe], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
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
      "    def wait(self, timeout=None):",
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

  it("bounds disconnect cleanup when the direct child ignores signals (#6678)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-disconnect-"));
    const pidFile = path.join(dir, "processes.pid");
    const session = path.join(dir, "session.py");
    const harness = path.join(dir, "harness.py");
    fs.writeFileSync(
      session,
      [
        "import os",
        "import pathlib",
        "import signal",
        "import subprocess",
        "import sys",
        "import time",
        "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        "descendant = subprocess.Popen([sys.executable, '-c', 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_DFL); time.sleep(30)'])",
        `pathlib.Path(${JSON.stringify(pidFile)}).write_text(f'{os.getpid()}\\n{descendant.pid}\\n', encoding='utf-8')`,
        "time.sleep(30)",
      ].join("\n"),
    );
    fs.writeFileSync(
      harness,
      [
        "import importlib.util",
        "import os",
        "import pathlib",
        "import signal",
        "import sys",
        "import time",
        `spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})`,
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "module._TERM_GRACE_SECONDS = 0.1",
        "module._KILL_GRACE_SECONDS = 0.1",
        `pid_file = pathlib.Path(${JSON.stringify(pidFile)})`,
        "notifier_pid = os.fork()",
        "if notifier_pid == 0:",
        "    deadline = time.monotonic() + 5",
        "    while not pid_file.exists() and time.monotonic() < deadline:",
        "        time.sleep(0.05)",
        "    os.kill(os.getppid(), signal.SIGHUP)",
        "    os._exit(0)",
        `status = module.run([sys.executable, ${JSON.stringify(session)}])`,
        "if not pid_file.exists():",
        "    raise SystemExit('session did not publish process ids')",
        "pids = [int(value) for value in pid_file.read_text(encoding='utf-8').splitlines()]",
        "if status == 0:",
        "    raise SystemExit('supervisor unexpectedly preserved a successful child status')",
        "for pid in pids:",
        "    try:",
        "        os.kill(pid, 0)",
        "    except ProcessLookupError:",
        "        continue",
        "    raise SystemExit(f'process still alive: {pid}')",
      ].join("\n"),
    );

    try {
      const result = spawnSync("python3", [harness], { encoding: "utf8", timeout: 15_000 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
