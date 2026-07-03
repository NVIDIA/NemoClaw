// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testTimeoutOptions } from "./helpers/timeouts";

const GUARD_PATH = path.resolve("scripts/state-dir-guard.py");
const fixtures: string[] = [];

const RUN_GUARD_AS_CURRENT_USER = String.raw`
import importlib.util
import os
import sys

guard_path, action, config_dir = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(),
    root_gid=os.getgid(),
    sandbox_uid=os.getuid(),
    sandbox_gid=os.getgid(),
)
module.os.geteuid = lambda: 0
module._production_identity = lambda: identity
if os.environ.get("NEMOCLAW_TEST_MAX_ENTRIES"):
    module.MAX_ENTRIES_PER_PASS = int(os.environ["NEMOCLAW_TEST_MAX_ENTRIES"])
if os.environ.get("NEMOCLAW_TEST_MAX_COPY_BYTES"):
    module.MAX_COPIED_BYTES_PER_PASS = int(os.environ["NEMOCLAW_TEST_MAX_COPY_BYTES"])
raise SystemExit(module.main([action, "--config-dir", config_dir]))
`;

const RUN_FAKE_IMMUTABLE_TRANSITION = String.raw`
import importlib.util
import json
import os
import struct
import sys

guard_path, config_dir, file_path = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard_flags", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(), root_gid=os.getgid(),
    sandbox_uid=os.getuid(), sandbox_gid=os.getgid(),
)
flags = {}
initial = os.stat(file_path)
flags[(initial.st_dev, initial.st_ino)] = module.FS_IMMUTABLE_FL

def fake_ioctl(fd, operation, payload):
    st = os.fstat(fd)
    key = (st.st_dev, st.st_ino)
    if operation == module.FS_IOC_GETFLAGS:
        return struct.pack("I", flags.get(key, 0))
    if operation == module.FS_IOC_SETFLAGS:
        flags[key] = struct.unpack("I", payload)[0]
        return payload
    raise AssertionError(operation)

module.fcntl.ioctl = fake_ioctl
locked = module.run_guard("lock", config_dir, identity)
locked_stat = os.stat(file_path)
locked_flags = flags.get((locked_stat.st_dev, locked_stat.st_ino), 0)
unlocked = module.run_guard("unlock", config_dir, identity)
unlocked_stat = os.stat(file_path)
unlocked_flags = flags.get((unlocked_stat.st_dev, unlocked_stat.st_ino), 0)
print(json.dumps({
    "lock_ok": locked.ok,
    "unlock_ok": unlocked.ok,
    "inode_replaced": locked_stat.st_ino != initial.st_ino,
    "locked_flags": locked_flags,
    "unlocked_flags": unlocked_flags,
}))
`;

interface GuardLine {
  type: "issue" | "result";
  code?: string;
  path?: string;
  detail?: string;
  action?: string;
  status?: string;
  issueCount?: number;
  removedEntries?: number;
}

function fixture(): { root: string; configDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-dir-guard-"));
  fixtures.push(root);
  const configDir = path.join(root, ".agent");
  fs.mkdirSync(configDir, { recursive: true });
  // macOS exposes /var through a symlink. The production helper refuses
  // symlinked ancestors, so pass the descriptor-resolved fixture path too.
  return { root, configDir: fs.realpathSync(configDir) };
}

function runGuard(
  action: "preflight" | "lock" | "unlock",
  configDir: string,
  env: Record<string, string> = {},
) {
  const result = spawnSync(
    "python3",
    ["-c", RUN_GUARD_AS_CURRENT_USER, GUARD_PATH, action, configDir],
    { encoding: "utf-8", timeout: 15_000, env: { ...process.env, ...env } },
  );
  const lines = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GuardLine);
  return { ...result, lines };
}

function mode(filePath: string): number {
  return fs.lstatSync(filePath).mode & 0o7777;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.chmodSync(root, 0o700);
    const configDir = path.join(root, ".agent");
    for (const existingConfigDir of fs.existsSync(configDir) ? [configDir] : []) {
      fs.chmodSync(existingConfigDir, 0o700);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("state-dir-guard", () => {
  it("rejects an external nested symlink without touching its target", () => {
    const { root, configDir } = fixture();
    const pluginDir = path.join(configDir, "plugins", "nested");
    const externalDir = path.join(root, "outside");
    const externalFile = path.join(externalDir, "innocent.txt");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(externalDir);
    fs.writeFileSync(externalFile, "untouched\n", { mode: 0o666 });
    const externalMode = mode(externalFile);
    fs.symlinkSync(externalDir, path.join(pluginDir, "escape"));

    const result = runGuard("preflight", configDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          code: "symlink-outside-protected-root",
          path: path.join(pluginDir, "escape"),
        }),
        expect.objectContaining({
          type: "result",
          action: "preflight",
          status: "failed",
          issueCount: 1,
        }),
      ]),
    );
    expect(fs.readFileSync(externalFile, "utf-8")).toBe("untouched\n");
    expect(mode(externalFile)).toBe(externalMode);
  });

  it("allows a symlink whose fully resolved target stays in a protected root", () => {
    const { configDir } = fixture();
    const pluginDir = path.join(configDir, "plugins");
    const versionDir = path.join(pluginDir, "versions", "v1");
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, "plugin.js"), "export {};\n", { mode: 0o664 });
    fs.symlinkSync("versions/v1", path.join(pluginDir, "current"));

    const preflight = runGuard("preflight", configDir);
    const locked = runGuard("lock", configDir);

    expect(preflight.status).toBe(0);
    expect(locked.status).toBe(0);
    expect(fs.readlinkSync(path.join(pluginDir, "current"))).toBe("versions/v1");
    expect(mode(pluginDir)).toBe(0o755);
    expect(mode(path.join(versionDir, "plugin.js"))).toBe(0o644);
  });

  it("rejects links from protected code into the writable sessions carveout", () => {
    const { configDir } = fixture();
    const pluginDir = path.join(configDir, "plugins");
    const pluginPath = path.join(pluginDir, "trusted.js");
    const sessionsDir = path.join(configDir, "agents", "main", "sessions");
    const sessionPayload = path.join(sessionsDir, "payload.js");
    fs.mkdirSync(pluginDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(pluginPath, "trusted\n");
    fs.writeFileSync(sessionPayload, "mutable\n");
    fs.symlinkSync("../agents/main/sessions/payload.js", path.join(pluginDir, "evil"));

    const result = runGuard("preflight", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          code: "symlink-crosses-runtime-carveout",
          path: path.join(pluginDir, "evil"),
        }),
      ]),
    );
  });

  it("fresh-replaces locked files so an old writable FD cannot mutate the visible path", () => {
    const { configDir } = fixture();
    const nestedDir = path.join(configDir, "extensions", "nested");
    const toolPath = path.join(nestedDir, "tool.sh");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(toolPath, "stable\n", { mode: 0o775 });
    const preservedTime = new Date("2025-01-02T03:04:05.000Z");
    fs.utimesSync(toolPath, preservedTime, preservedTime);
    const timestampsBefore = fs.statSync(toolPath);
    const oldInode = fs.statSync(toolPath).ino;
    const staleFd = fs.openSync(toolPath, "r+");

    try {
      const result = runGuard("lock", configDir);
      expect(result.status).toBe(0);
      expect(result.lines.at(-1)).toEqual(
        expect.objectContaining({ type: "result", action: "lock", status: "ok" }),
      );
      expect(fs.statSync(toolPath).ino).not.toBe(oldInode);
      expect(mode(nestedDir)).toBe(0o755);
      expect(mode(toolPath)).toBe(0o755);
      const timestampsAfter = fs.statSync(toolPath);
      // The guard publishes the requested atime, but its verification read can
      // advance atime on relatime filesystems after ctime changes.
      expect(timestampsAfter.mtimeMs).toBe(timestampsBefore.mtimeMs);

      fs.writeSync(staleFd, Buffer.from("MUTATE\n"), 0, 7, 0);
      fs.fsyncSync(staleFd);
      expect(fs.readFileSync(toolPath, "utf-8")).toBe("stable\n");
    } finally {
      fs.closeSync(staleFd);
    }
  });

  it(
    "fresh-seals a file even while an attacker continuously writes an old descriptor",
    testTimeoutOptions(20_000),
    async () => {
      const { root, configDir } = fixture();
      const pluginDir = path.join(configDir, "plugins");
      const pluginPath = path.join(pluginDir, "racing.bin");
      const readyPath = path.join(root, "writer-ready");
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(pluginPath, Buffer.alloc(8 * 1024 * 1024, 0x41), { mode: 0o660 });
      const oldInode = fs.statSync(pluginPath).ino;
      const writer = spawn(
        process.execPath,
        [
          "-e",
          [
            "const fs=require('fs')",
            "const file=process.argv[1]",
            "const ready=process.argv[2]",
            "const fd=fs.openSync(file,'r+')",
            "const chunk=Buffer.alloc(1024*1024,0x5a)",
            "fs.writeFileSync(ready,'ready')",
            "setInterval(()=>{try{fs.writeSync(fd,chunk,0,chunk.length,0)}catch{}},0)",
          ].join(";"),
          pluginPath,
          readyPath,
        ],
        { stdio: "ignore" },
      );

      try {
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(readyPath) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(fs.existsSync(readyPath)).toBe(true);

        const result = runGuard("lock", configDir);

        expect(result.status, result.stderr).toBe(0);
        expect(fs.statSync(pluginPath).ino).not.toBe(oldInode);
        expect(mode(pluginPath)).toBe(0o640);
      } finally {
        writer.kill("SIGKILL");
      }
    },
  );

  it(
    "streams a large file into a fresh inode while preserving read and execute bits",
    testTimeoutOptions(20_000),
    () => {
      const { configDir } = fixture();
      const workspaceDir = path.join(configDir, "workspace-large");
      const payloadPath = path.join(workspaceDir, "model.bin");
      const payload = Buffer.alloc(1024 * 1024, 0xa5);
      fs.mkdirSync(workspaceDir);
      fs.writeFileSync(payloadPath, payload, { mode: 0o751 });
      const oldInode = fs.statSync(payloadPath).ino;

      const result = runGuard("lock", configDir);

      expect(result.status).toBe(0);
      expect(fs.statSync(payloadPath).ino).not.toBe(oldInode);
      expect(mode(payloadPath)).toBe(0o751);
      expect(fs.readFileSync(payloadPath)).toEqual(payload);
    },
  );

  it("preserves sparse holes instead of expanding logical size into copied bytes", () => {
    const { configDir } = fixture();
    const workspaceDir = path.join(configDir, "workspace-sparse");
    const payloadPath = path.join(workspaceDir, "sparse.bin");
    fs.mkdirSync(workspaceDir);
    const fd = fs.openSync(payloadPath, "w", 0o660);
    try {
      fs.writeSync(fd, Buffer.from("head"), 0, 4, 0);
      fs.writeSync(fd, Buffer.from("tail"), 0, 4, 64 * 1024 * 1024 - 4);
    } finally {
      fs.closeSync(fd);
    }
    const before = fs.statSync(payloadPath);

    const result = runGuard("lock", configDir, {
      NEMOCLAW_TEST_MAX_COPY_BYTES: String(1024 * 1024),
    });

    expect(result.status).toBe(0);
    const after = fs.statSync(payloadPath);
    expect(after.size).toBe(before.size);
    const verifyFd = fs.openSync(payloadPath, "r");
    try {
      const head = Buffer.alloc(4);
      const tail = Buffer.alloc(4);
      fs.readSync(verifyFd, head, 0, 4, 0);
      fs.readSync(verifyFd, tail, 0, 4, after.size - 4);
      expect(head.toString()).toBe("head");
      expect(tail.toString()).toBe("tail");
    } finally {
      fs.closeSync(verifyFd);
    }
    // st_blocks is 512-byte units. Allow filesystem metadata variance while
    // proving the 64 MiB logical hole was not materialized.
    expect(after.blocks * 512).toBeLessThan(1024 * 1024);
  });

  it("rejects adversarial entry and copy budgets before unbounded work", () => {
    const { configDir } = fixture();
    const pluginsDir = path.join(configDir, "plugins");
    fs.mkdirSync(pluginsDir);
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(pluginsDir, `entry-${index}.txt`), "payload\n");
    }

    const result = runGuard("preflight", configDir, {
      NEMOCLAW_TEST_MAX_ENTRIES: "3",
    });

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "work-entry-limit" }),
      ]),
    );
  });

  it.each([
    ["OpenClaw", "NEMOCLAW_TEST_OPENCLAW_FAIL_CLOSED"],
    ["Hermes", "NEMOCLAW_TEST_HERMES_FAIL_CLOSED"],
  ])("leaves the %s config root fail-closed when a state-tree budget aborts lock", (_agent, env) => {
    const { configDir } = fixture();
    const pluginsDir = path.join(configDir, "plugins");
    const pluginPath = path.join(pluginsDir, "entry-0.txt");
    fs.mkdirSync(pluginsDir);
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(pluginsDir, `entry-${index}.txt`), "payload\n");
    }
    const staleFd = fs.openSync(pluginPath, "r+");

    try {
      const result = runGuard("lock", configDir, {
        NEMOCLAW_TEST_MAX_ENTRIES: "3",
        [env]: "1",
      });

      expect(result.status).toBe(1);
      expect(result.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "issue", code: "work-entry-limit" }),
        ]),
      );
      expect(mode(configDir)).toBe(0o500);
      fs.writeSync(staleFd, Buffer.from("stale\n"), 0, 6, 0);
      expect(mode(configDir)).not.toBe(0o755);
    } finally {
      fs.closeSync(staleFd);
    }
  });

  it("serializes an orphaned recursive unlock ahead of the restoring lock", async () => {
    const { root, configDir } = fixture();
    const pluginDir = path.join(configDir, "plugins");
    const pluginFile = path.join(pluginDir, "plugin.js");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(pluginFile, "module.exports = true;\n", { mode: 0o660 });
    const ready = path.join(root, "unlock-holds-mutex");
    const commonEnv = {
      ...process.env,
      NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1",
    };
    const unlock = spawn(
      "python3",
      ["-c", RUN_GUARD_AS_CURRENT_USER, GUARD_PATH, "unlock", configDir],
      {
        env: {
          ...commonEnv,
          NEMOCLAW_TEST_TRANSACTION_LOCK_HOLD_MS: "700",
          NEMOCLAW_TEST_TRANSACTION_LOCK_READY: ready,
        },
        stdio: "ignore",
      },
    );

    try {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(ready)).toBe(true);

      const startedAt = Date.now();
      const locked = spawnSync(
        "python3",
        ["-c", RUN_GUARD_AS_CURRENT_USER, GUARD_PATH, "lock", configDir],
        { env: commonEnv, encoding: "utf-8", timeout: 10_000 },
      );

      expect(locked.status, locked.stderr).toBe(0);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
      expect(mode(pluginFile)).toBe(0o640);
    } finally {
      unlock.kill("SIGKILL");
    }
  });

  it("charges empty workspace roots against the same bounded inventory", () => {
    const { configDir } = fixture();
    for (let index = 0; index < 5; index += 1) {
      fs.mkdirSync(path.join(configDir, `workspace-${index}`));
    }

    const result = runGuard("preflight", configDir, {
      NEMOCLAW_TEST_MAX_ENTRIES: "3",
    });

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "work-entry-limit" }),
      ]),
    );
  });

  it("descriptor-clears legacy immutable flags and reapplies them only to the locked inode", () => {
    const { configDir } = fixture();
    const pluginsDir = path.join(configDir, "plugins");
    const pluginPath = path.join(pluginsDir, "legacy-immutable.js");
    fs.mkdirSync(pluginsDir);
    fs.writeFileSync(pluginPath, "export {};\n", { mode: 0o660 });

    const result = spawnSync(
      "python3",
      ["-c", RUN_FAKE_IMMUTABLE_TRANSITION, GUARD_PATH, configDir, pluginPath],
      { encoding: "utf-8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      lock_ok: true,
      unlock_ok: true,
      inode_replaced: true,
      locked_flags: 0x10,
      unlocked_flags: 0,
    });
  });

  it("applies distinct confidentiality, workspace, mutable, and session-carveout modes", () => {
    const { configDir } = fixture();
    const secretDir = path.join(configDir, "credentials");
    const secretPath = path.join(secretDir, "token.json");
    const workspaceDir = path.join(configDir, "workspace-research");
    const executablePath = path.join(workspaceDir, "run.sh");
    const agentDir = path.join(configDir, "agents", "main");
    const sessionsDir = path.join(agentDir, "sessions");
    const sessionPath = path.join(sessionsDir, "active.jsonl");
    const sessionBacklink = path.join(sessionsDir, "runtime-link");
    const sessionFifo = path.join(sessionsDir, "runtime-events.fifo");
    const agentCodePath = path.join(agentDir, "agent.js");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.mkdirSync(workspaceDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(secretPath, "secret\n", { mode: 0o640 });
    fs.writeFileSync(executablePath, "#!/bin/sh\n", { mode: 0o775 });
    fs.writeFileSync(sessionPath, "runtime\n", { mode: 0o660 });
    fs.writeFileSync(agentCodePath, "export {};\n", { mode: 0o664 });
    fs.symlinkSync("../../../plugins/runtime-only", sessionBacklink);
    expect(spawnSync("mkfifo", [sessionFifo]).status).toBe(0);
    const initialSessionMode = mode(sessionPath);
    const oldSessionInode = fs.statSync(sessionPath).ino;
    const oldAgentCodeInode = fs.statSync(agentCodePath).ino;

    const locked = runGuard("lock", configDir);

    expect(locked.status).toBe(0);
    expect(mode(secretDir)).toBe(0o700);
    expect(mode(secretPath)).toBe(0o600);
    expect(mode(workspaceDir)).toBe(0o755);
    expect(mode(executablePath)).toBe(0o755);
    expect(mode(path.join(configDir, "agents"))).toBe(0o755);
    expect(mode(agentDir)).toBe(0o755);
    expect(fs.statSync(agentCodePath).ino).not.toBe(oldAgentCodeInode);
    expect(mode(sessionsDir)).toBe(0o2770);
    expect(mode(sessionPath)).toBe(initialSessionMode);
    expect(fs.statSync(sessionPath).ino).toBe(oldSessionInode);
    expect(fs.readlinkSync(sessionBacklink)).toBe("../../../plugins/runtime-only");
    expect(fs.lstatSync(sessionFifo).isFIFO()).toBe(true);

    const unlocked = runGuard("unlock", configDir);

    expect(unlocked.status).toBe(0);
    expect(mode(secretDir)).toBe(0o2770);
    expect(mode(secretPath)).toBe(0o660);
    expect(mode(workspaceDir)).toBe(0o2770);
    expect(mode(executablePath)).toBe(0o770);
    expect(mode(path.join(configDir, "agents"))).toBe(0o2770);
    expect(mode(agentDir)).toBe(0o2770);
  });

  it("rejects hardlinks and special entries during the read-only preflight", () => {
    const { configDir } = fixture();
    const skillsDir = path.join(configDir, "skills");
    const firstPath = path.join(skillsDir, "first.txt");
    fs.mkdirSync(skillsDir);
    fs.writeFileSync(firstPath, "same inode\n");
    fs.linkSync(firstPath, path.join(skillsDir, "second.txt"));
    const fifo = spawnSync("mkfifo", [path.join(skillsDir, "events.fifo")]);
    expect(fifo.status).toBe(0);

    const result = runGuard("preflight", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "hardlinked-entry" }),
        expect.objectContaining({ type: "issue", code: "special-entry" }),
      ]),
    );
  });

  it("contains unsupported state entries during lock without following their targets", () => {
    const { root, configDir } = fixture();
    const skillsDir = path.join(configDir, "skills");
    const firstPath = path.join(skillsDir, "first.txt");
    const secondPath = path.join(skillsDir, "second.txt");
    const fifoPath = path.join(skillsDir, "events.fifo");
    const externalDir = path.join(root, "outside");
    const externalFile = path.join(externalDir, "untouched.txt");
    const escapePath = path.join(skillsDir, "escape");
    const invalidRoot = path.join(configDir, "workspace-host");
    fs.mkdirSync(skillsDir);
    fs.mkdirSync(externalDir);
    fs.writeFileSync(firstPath, "same inode\n");
    fs.linkSync(firstPath, secondPath);
    fs.writeFileSync(externalFile, "untouched\n");
    fs.symlinkSync(externalDir, escapePath);
    fs.symlinkSync(externalDir, invalidRoot);
    expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);

    const result = runGuard("lock", configDir);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(firstPath).ino).not.toBe(fs.statSync(secondPath).ino);
    expect(fs.existsSync(fifoPath)).toBe(false);
    expect(fs.existsSync(escapePath)).toBe(false);
    expect(fs.existsSync(invalidRoot)).toBe(false);
    expect(fs.readFileSync(externalFile, "utf-8")).toBe("untouched\n");
    expect(result.lines.at(-1)).toEqual(
      expect.objectContaining({ type: "result", status: "ok", removedEntries: 3 }),
    );
  });
});
