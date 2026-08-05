// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const GUARD = path.resolve(import.meta.dirname, "..", "agents/hermes/restore-cron-guard.py");

function runGuardModule(source: string, args: string[] = []) {
  return spawnSync("python3", ["-c", source, GUARD, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

const LOAD_GUARD = `
import importlib.util
import pathlib
import sys
spec = importlib.util.spec_from_file_location("nemoclaw_restore_cron_guard", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;

describe("Hermes restore cron guard (#7806)", () => {
  it("waits for the gateway drain acknowledgement that includes all active work", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    try {
      const result = runGuardModule(
        `${LOAD_GUARD}
class Drain:
    marker = None
    def drain_requested(self, *, home): return self.marker is not None
    def write_drain_request(self, *, principal, home): self.marker = {"principal": principal}
    def read_drain_request(self, *, home): return self.marker
    def clear_drain_request(self, *, home): self.marker = None; return True
class Status:
    states = [("running", 2), ("draining", 1), ("draining", 0)]
    def get_running_pid(self): return 42
    def read_runtime_status(self):
        state, active = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        return {"pid": 42, "gateway_state": state, "active_agents": active}
    def parse_active_agents(self, value): return max(0, int(value))
drain = Drain()
status = Status()
module._gateway_modules = lambda: (drain, status)
module.secrets.token_hex = lambda _size: "a" * 32
module.time.sleep = lambda _seconds: None
token = module.begin_drain(pathlib.Path(sys.argv[2]), 1)
print(token)
print(drain.marker["principal"])
`,
        [home],
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "nemoclaw-state-restore:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "nemoclaw-state-restore:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("holds a drain marker while the gateway is not running", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    try {
      const result = runGuardModule(
        `${LOAD_GUARD}
class Drain:
    marker = None
    def drain_requested(self, *, home): return self.marker is not None
    def write_drain_request(self, *, principal, home): self.marker = {"principal": principal}
    def read_drain_request(self, *, home): return self.marker
    def clear_drain_request(self, *, home): self.marker = None; return True
class Status:
    def get_running_pid(self): return None
    def read_runtime_status(self): return None
    def parse_active_agents(self, value): return 0
drain = Drain()
status = Status()
module._gateway_modules = lambda: (drain, status)
module.secrets.token_hex = lambda _size: "c" * 32
home = pathlib.Path(sys.argv[2])
token = module.begin_drain(home, 1)
print(token)
print(drain.marker["principal"])
module.release_drain(home, token)
print(drain.marker, module._ownership_path(home).exists())
`,
        [home],
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "nemoclaw-state-restore:cccccccccccccccccccccccccccccccc",
        "nemoclaw-state-restore:cccccccccccccccccccccccccccccccc",
        "None False",
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a second restore while another restore owns the drain", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    try {
      const result = runGuardModule(
        `${LOAD_GUARD}
class Drain:
    marker = None
    def drain_requested(self, *, home): return self.marker is not None
    def write_drain_request(self, *, principal, home): self.marker = {"principal": principal}
    def read_drain_request(self, *, home): return self.marker
    def clear_drain_request(self, *, home): self.marker = None; return True
class Status:
    def get_running_pid(self): return None
    def read_runtime_status(self): return None
    def parse_active_agents(self, value): return 0
drain = Drain()
status = Status()
module._gateway_modules = lambda: (drain, status)
home = pathlib.Path(sys.argv[2])
first = module.begin_drain(home, 1)
try:
    module.begin_drain(home, 1)
except RuntimeError as error:
    print(error)
print(drain.marker["principal"] == first)
`,
        [home],
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "Another NemoClaw restore already owns the Hermes drain",
        "True",
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves an operator-owned drain and releases only its own marker", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    try {
      const result = runGuardModule(
        `${LOAD_GUARD}
class Drain:
    marker = {"principal": "operator"}
    cleared = 0
    def drain_requested(self, *, home): return True
    def write_drain_request(self, *, principal, home): raise AssertionError("must not overwrite")
    def read_drain_request(self, *, home): return self.marker
    def clear_drain_request(self, *, home): self.cleared += 1; self.marker = None; return True
class Status:
    def get_running_pid(self): return 42
    def read_runtime_status(self): return {"pid": 42, "gateway_state": "draining", "active_agents": 0}
    def parse_active_agents(self, value): return int(value)
drain = Drain()
status = Status()
module._gateway_modules = lambda: (drain, status)
home = pathlib.Path(sys.argv[2])
print(module.begin_drain(home, 1))
print(module._ownership_path(home).exists())
module.release_drain(home, "nemoclaw-state-restore:" + "b" * 32)
print(drain.marker["principal"], drain.cleared)
drain.marker = {"principal": "nemoclaw-state-restore:" + "b" * 32}
module.release_drain(home, "nemoclaw-state-restore:" + "b" * 32)
print(drain.marker, drain.cleared)
`,
        [home],
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "preserved",
        "False",
        "operator 0",
        "None 1",
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts only enabled jobs whose referenced scripts resolve to readable files", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    try {
      const scripts = path.join(fixture, "scripts");
      const cron = path.join(fixture, "cron");
      fs.mkdirSync(scripts);
      fs.mkdirSync(cron);
      fs.writeFileSync(path.join(scripts, "digest.sh"), "echo ok\n", { mode: 0o600 });
      fs.writeFileSync(
        path.join(cron, "jobs.json"),
        JSON.stringify({
          jobs: [
            { enabled: true, script: "digest.sh" },
            { enabled: false, script: "missing-disabled.sh" },
          ],
        }),
      );

      const result = runGuardModule(
        `${LOAD_GUARD}
module._gateway_identity = lambda: None
module.validate_enabled_scripts(pathlib.Path(sys.argv[2]))
`,
        [fixture],
      );
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", "missing.sh"],
    ["path escape", "../outside.sh"],
  ])("rejects an enabled job with a %s script", (_case, script) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    try {
      fs.mkdirSync(path.join(fixture, "scripts"));
      fs.mkdirSync(path.join(fixture, "cron"));
      fs.writeFileSync(path.join(fixture, "outside.sh"), "echo outside\n");
      fs.writeFileSync(
        path.join(fixture, "cron", "jobs.json"),
        JSON.stringify({ jobs: [{ enabled: true, script }] }),
      );

      const result = runGuardModule(
        `${LOAD_GUARD}\nmodule.validate_enabled_scripts(pathlib.Path(sys.argv[2]))`,
        [fixture],
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/missing or unreadable|outside the scripts directory/u);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects an enabled job whose script the gateway account cannot read", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    try {
      fs.mkdirSync(path.join(fixture, "scripts"));
      fs.mkdirSync(path.join(fixture, "cron"));
      fs.writeFileSync(path.join(fixture, "scripts", "digest.sh"), "echo ok\n", { mode: 0o600 });
      fs.writeFileSync(
        path.join(fixture, "cron", "jobs.json"),
        JSON.stringify({ jobs: [{ enabled: true, script: "digest.sh" }] }),
      );

      const result = runGuardModule(
        `${LOAD_GUARD}
import os
module._gateway_identity = lambda: (os.geteuid() + 1, set())
module.validate_enabled_scripts(pathlib.Path(sys.argv[2]))
`,
        [fixture],
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing or unreadable");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects an enabled job whose script sits behind a directory the gateway cannot search", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    const nested = path.join(fixture, "scripts", "private");
    try {
      fs.mkdirSync(path.join(fixture, "scripts"));
      fs.mkdirSync(path.join(fixture, "cron"));
      fs.mkdirSync(nested, { mode: 0o700 });
      fs.writeFileSync(path.join(nested, "digest.sh"), "echo ok\n", { mode: 0o644 });
      fs.writeFileSync(
        path.join(fixture, "cron", "jobs.json"),
        JSON.stringify({ jobs: [{ enabled: true, script: "private/digest.sh" }] }),
      );

      const result = runGuardModule(
        `${LOAD_GUARD}
import os
module._gateway_identity = lambda: (os.geteuid() + 1, set())
module.validate_enabled_scripts(pathlib.Path(sys.argv[2]))
`,
        [fixture],
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cannot reach through its directories");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("accepts an enabled job whose script directories the gateway can search", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    const nested = path.join(fixture, "scripts", "shared");
    try {
      fs.mkdirSync(path.join(fixture, "scripts"), { mode: 0o755 });
      fs.mkdirSync(path.join(fixture, "cron"));
      fs.mkdirSync(nested, { mode: 0o755 });
      fs.writeFileSync(path.join(nested, "digest.sh"), "echo ok\n", { mode: 0o644 });
      fs.writeFileSync(
        path.join(fixture, "cron", "jobs.json"),
        JSON.stringify({ jobs: [{ enabled: true, script: "shared/digest.sh" }] }),
      );

      const result = runGuardModule(
        `${LOAD_GUARD}
import os
module._gateway_identity = lambda: (os.geteuid() + 1, set())
module.validate_enabled_scripts(pathlib.Path(sys.argv[2]))
`,
        [fixture],
      );
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects an enabled no-agent job without a script", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-guard-"));
    try {
      fs.mkdirSync(path.join(fixture, "scripts"));
      fs.mkdirSync(path.join(fixture, "cron"));
      fs.writeFileSync(
        path.join(fixture, "cron", "jobs.json"),
        JSON.stringify({ jobs: [{ enabled: true, no_agent: true }] }),
      );

      const result = runGuardModule(
        `${LOAD_GUARD}\nmodule.validate_enabled_scripts(pathlib.Path(sys.argv[2]))`,
        [fixture],
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("has no script");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
