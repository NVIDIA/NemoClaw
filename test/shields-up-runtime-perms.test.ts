// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runLockAgentConfigProbe(): string[][] {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      String.raw`
const Module = require("node:module");
const originalLoad = Module._load;
const calls = [];
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../adapters/docker/exec") {
    return {
      dockerExecFileSync(args) {
        const separator = args.indexOf("--");
        const command = separator >= 0 ? args.slice(separator + 1) : args;
        calls.push(command);
        if (command[0] === "stat" && command[1] === "-c") {
          return command.at(-1) === "/sandbox/.openclaw"
            ? "755 root:root\n"
            : "444 root:root\n";
        }
        if (command[0] === "lsattr") {
          return "----i----------------- " + command.at(-1) + "\n";
        }
        if (command[0] === "sha256sum") {
          return (
            "0000000000000000000000000000000000000000000000000000000000000001  " +
            command.at(-1) +
            "\n"
          );
        }
        return "";
      },
    };
  }
  if (request === "../sandbox/privileged-exec") {
    return {
      privilegedSandboxExecArgv(_sandboxName, cmd) {
        return [...cmd];
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { lockAgentConfig } = require("./dist/lib/shields/index.js");
lockAgentConfig("sandbox-pod", {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
});
process.stdout.write(JSON.stringify(calls));
`,
    ],
    { encoding: "utf-8", timeout: 5000 },
  );
  expect(probe.status).toBe(0);
  return JSON.parse(probe.stdout) as string[][];
}

function runLockAgentConfigProbeExpectingThrow(
  symlinkedPath: string,
): { stdout: string; stderr: string; status: number | null } {
  return spawnSync(
    process.execPath,
    [
      "-e",
      String.raw`
const Module = require("node:module");
const originalLoad = Module._load;
const symlinkedPath = ${JSON.stringify(symlinkedPath)};
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../adapters/docker/exec") {
    return {
      dockerExecFileSync(args) {
        const separator = args.indexOf("--");
        const command = separator >= 0 ? args.slice(separator + 1) : args;
        if (
          command[0] === "sh" &&
          command[1] === "-c" &&
          typeof command[2] === "string" &&
          !command[2].includes("symlinked-root")
        ) {
          return symlinkedPath + "\n";
        }
        if (command[0] === "stat" && command[1] === "-c") {
          return command.at(-1) === "/sandbox/.openclaw"
            ? "755 root:root\n"
            : "444 root:root\n";
        }
        if (command[0] === "lsattr") {
          return "----i----------------- " + command.at(-1) + "\n";
        }
        if (command[0] === "sha256sum") {
          return (
            "0000000000000000000000000000000000000000000000000000000000000001  " +
            command.at(-1) +
            "\n"
          );
        }
        return "";
      },
    };
  }
  if (request === "../sandbox/privileged-exec") {
    return {
      privilegedSandboxExecArgv(_sandboxName, cmd) {
        return [...cmd];
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
try {
  const { lockAgentConfig } = require("./dist/lib/shields/index.js");
  lockAgentConfig("sandbox-pod", {
    agentName: "openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
    configDir: "/sandbox/.openclaw",
    sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
  });
  process.stdout.write("UNEXPECTED_SUCCESS");
  process.exit(0);
} catch (err) {
  process.stderr.write(err && err.message ? err.message : String(err));
  process.exit(2);
}
`,
    ],
    { encoding: "utf-8", timeout: 5000 },
  );
}

function findStateDirLockShell(commands: string[][]): string[] | undefined {
  return commands.find(
    (command) =>
      command[0] === "sh" &&
      command[1] === "-c" &&
      typeof command[2] === "string" &&
      command[2].includes('chown -R "$owner"') &&
      command.includes("root:sandbox") &&
      command.includes("agents") &&
      command.includes("extensions"),
  );
}

describe("shields-up state-dir lock preserves sandbox-group access + runtime sessions writable", () => {
  it("locks the high-risk state dirs via a single sh-c script with root:sandbox ownership", () => {
    const commands = runLockAgentConfigProbe();

    const stateDirLockShell = findStateDirLockShell(commands);
    expect(stateDirLockShell).toBeDefined();
    expect(stateDirLockShell).toEqual(
      expect.arrayContaining(["root:sandbox", "go-w", "755"]),
    );
    expect(stateDirLockShell).toEqual(
      expect.arrayContaining(["agents", "extensions", "skills", "hooks"]),
    );
  });

  it("guards the state-dir lock script against symlinked roots", () => {
    const commands = runLockAgentConfigProbe();
    const stateDirLockShell = findStateDirLockShell(commands);
    expect(stateDirLockShell).toBeDefined();
    const script = stateDirLockShell?.[2] ?? "";
    expect(script).toContain('if [ -L "$path" ]; then');
    expect(script).toContain('symlinked-root');
    expect(script).toContain('[ -d "$path" ] || continue');
  });

  it("guards the workspace-* lock script against symlinked roots", () => {
    const commands = runLockAgentConfigProbe();
    const workspaceMutationShell = commands.find(
      (command) =>
        command[0] === "sh" &&
        command[1] === "-c" &&
        typeof command[2] === "string" &&
        command[2].includes('workspace-*') &&
        command[2].includes('chown -R "$owner"'),
    );
    expect(workspaceMutationShell).toBeDefined();
    const script = workspaceMutationShell?.[2] ?? "";
    expect(script).toContain('if [ -L "$dir" ]; then');
    expect(script).toContain('symlinked-root');
  });

  it("runs a symlink-preflight script before any mutation", () => {
    const commands = runLockAgentConfigProbe();
    const preflightShell = commands.find(
      (command) =>
        command[0] === "sh" &&
        command[1] === "-c" &&
        typeof command[2] === "string" &&
        command[2].includes('workspace-*') &&
        !command[2].includes("chown") &&
        !command[2].includes("chmod"),
    );
    expect(preflightShell).toBeDefined();
    const script = preflightShell?.[2] ?? "";
    expect(script).toContain('if [ -L "$path" ]; then printf');
    expect(script).toContain('if [ -L "$dir" ]; then printf');
  });

  // A symlinked state-dir root must abort shields-up; otherwise the lock
  // would report success while the dir still points at a writable host
  // path.
  it("throws when shields-up encounters a symlinked state-dir root", () => {
    const result = runLockAgentConfigProbeExpectingThrow(
      "/sandbox/.openclaw/extensions",
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Config not locked");
    expect(result.stderr).toContain("state dir root is a symlink");
    expect(result.stderr).toContain("/sandbox/.openclaw/extensions");
  });

  // Atomicity: when the preflight detects a symlinked state-dir root,
  // no chown/chmod must run on any of the other (non-symlinked) state
  // dirs in the same lock attempt. Without this guarantee, earlier
  // entries in HIGH_RISK_STATE_DIRS could be silently re-owned to
  // root:sandbox before the later symlink is reached and the lock
  // bails out, leaving a half-locked tree behind.
  it("does not mutate any state dir when the preflight reports a symlinked root", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        String.raw`
const Module = require("node:module");
const originalLoad = Module._load;
const calls = [];
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../adapters/docker/exec") {
    return {
      dockerExecFileSync(args) {
        const separator = args.indexOf("--");
        const command = separator >= 0 ? args.slice(separator + 1) : args;
        calls.push(command);
        if (
          command[0] === "sh" &&
          command[1] === "-c" &&
          typeof command[2] === "string" &&
          !command[2].includes("symlinked-root")
        ) {
          return "/sandbox/.openclaw/extensions\n";
        }
        return "";
      },
    };
  }
  if (request === "../sandbox/privileged-exec") {
    return {
      privilegedSandboxExecArgv(_sandboxName, cmd) {
        return [...cmd];
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
try {
  const { lockAgentConfig } = require("./dist/lib/shields/index.js");
  lockAgentConfig("sandbox-pod", {
    agentName: "openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
    configDir: "/sandbox/.openclaw",
    sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
  });
  process.stdout.write("UNEXPECTED_SUCCESS\n");
  process.stdout.write(JSON.stringify(calls));
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify(calls));
  process.stderr.write(err && err.message ? err.message : String(err));
  process.exit(2);
}
`,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(probe.status).toBe(2);
    expect(probe.stderr).toContain("state dir root is a symlink");

    const calls = JSON.parse(probe.stdout) as string[][];
    // Mutation pass scripts contain "symlinked-root\\t" in their script body.
    // If any such call was recorded, atomicity is broken.
    const mutationCalls = calls.filter(
      (command) =>
        command[0] === "sh" &&
        command[1] === "-c" &&
        typeof command[2] === "string" &&
        command[2].includes("symlinked-root"),
    );
    expect(mutationCalls).toEqual([]);
    // Restore-writable-subpaths must also not run (it would mkdir
    // agents/<id>/sessions inside what could be a half-locked tree).
    const restoreCalls = calls.filter(
      (command) =>
        command[0] === "sh" &&
        command[1] === "-c" &&
        typeof command[2] === "string" &&
        command[2].includes("agents/*/sessions"),
    );
    expect(restoreCalls).toEqual([]);
  });

  it("keeps the top-level config dir owned by root:root (lock contract unchanged)", () => {
    const commands = runLockAgentConfigProbe();
    expect(commands).toContainEqual([
      "chown",
      "root:root",
      "/sandbox/.openclaw",
    ]);
    expect(commands).toContainEqual([
      "chown",
      "root:root",
      "/sandbox/.openclaw/openclaw.json",
    ]);
  });

  it("restores agents/*/sessions to sandbox:sandbox 2770 after the main lock loop", () => {
    const commands = runLockAgentConfigProbe();
    const restoreShell = commands.find(
      (command) =>
        command[0] === "sh" &&
        command[1] === "-c" &&
        command.includes("/sandbox/.openclaw") &&
        command.includes("agents/*/sessions") &&
        typeof command[2] === "string" &&
        command[2].includes("chown -R sandbox:sandbox") &&
        command[2].includes("chmod 2770"),
    );
    expect(restoreShell).toBeDefined();
  });

  // Behavioral check against a real filesystem fixture: the restore script
  // must mkdir `agents/<id>/sessions` even when the leaf does not yet exist
  // (fresh sandbox, never-run TUI). The pre-fix script's case-`*` guard
  // skipped the literal pattern when the glob matched nothing, leaving
  // `sessions/` uncreated and the post-lockdown TUI mkdir blocked.
  it("creates agents/<id>/sessions under a fresh agent dir that has no sessions yet", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-runtime-"));
    const configDir = path.join(fixture, ".openclaw");
    const agentDir = path.join(configDir, "agents", "main");
    fs.mkdirSync(agentDir, { recursive: true });

    const restoreShell = runLockAgentConfigProbe().find(
      (command) =>
        command[0] === "sh" &&
        command[1] === "-c" &&
        command.includes("agents/*/sessions"),
    );
    if (!restoreShell) {
      throw new Error("restore-writable-runtime-subpaths shell command not found");
    }
    const script = restoreShell[2];
    // Captured argv: ["sh", "-c", script, "sh", "/sandbox/.openclaw", ...patterns].
    // Drop everything up to and including the probed configDir so the fixture
    // configDir is passed exactly once when re-running the script body.
    const patterns = restoreShell.slice(5);

    const result = spawnSync(
      "sh",
      ["-c", `${script}\n`, "sh", configDir, ...patterns],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(agentDir, "sessions"))).toBe(true);
    expect(fs.statSync(path.join(agentDir, "sessions")).isDirectory()).toBe(true);

    fs.rmSync(fixture, { recursive: true, force: true });
  });

  // If a pre-lockdown agent swaps a high-risk state dir (here `extensions`)
  // for a symlink to a host path, the consolidated state-dir lock script
  // must skip the symlink without recursing into the target.
  it("does not chown/chmod through a symlinked high-risk state dir", () => {
    const fixture = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-shields-statedir-symlink-"),
    );
    const configDir = path.join(fixture, ".openclaw");
    const hostTarget = path.join(fixture, "host-target");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(hostTarget, { recursive: true });
    const innocentFile = path.join(hostTarget, "host-file");
    fs.writeFileSync(innocentFile, "untouched\n", { mode: 0o600 });
    const hostFilePerms = fs.statSync(innocentFile).mode & 0o7777;
    fs.symlinkSync(hostTarget, path.join(configDir, "extensions"));

    const stateDirLockShell = findStateDirLockShell(runLockAgentConfigProbe());
    if (!stateDirLockShell) {
      throw new Error("state-dir lock shell command not found");
    }
    const script = stateDirLockShell[2];
    // Captured argv: ["sh", "-c", script, "sh", configDir, owner,
    // recursiveMode, dirMode, clearSetgid, ...stateDirs]. Drop the probed
    // configDir from index 4 and substitute the fixture path.
    const args = stateDirLockShell.slice(4);
    args[0] = configDir;

    const result = spawnSync(
      "sh",
      ["-c", `${script}\n`, "sh", ...args],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(result.status).toBe(0);
    expect(fs.lstatSync(path.join(configDir, "extensions")).isSymbolicLink()).toBe(true);
    expect(fs.statSync(innocentFile).mode & 0o7777).toBe(hostFilePerms);

    fs.rmSync(fixture, { recursive: true, force: true });
  });

  // Defense in depth: if a malicious agent points `agents/<id>` at /etc or
  // any other host path before shields-up runs, the privileged restore
  // helper must not mkdir/chown/chmod through that symlink. The script
  // must drop symlinked parents (and symlinked targets) before touching
  // them.
  it("refuses to follow a symlinked agents/<id> parent during the runtime-subpath restore", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-symlink-"));
    const configDir = path.join(fixture, ".openclaw");
    const agentsRoot = path.join(configDir, "agents");
    const hostTarget = path.join(fixture, "host-target");
    fs.mkdirSync(agentsRoot, { recursive: true });
    fs.mkdirSync(hostTarget, { recursive: true });
    fs.symlinkSync(hostTarget, path.join(agentsRoot, "main"));

    const restoreShell = runLockAgentConfigProbe().find(
      (command) =>
        command[0] === "sh" &&
        command[1] === "-c" &&
        command.includes("agents/*/sessions"),
    );
    if (!restoreShell) {
      throw new Error("restore-writable-runtime-subpaths shell command not found");
    }
    const script = restoreShell[2];
    const patterns = restoreShell.slice(5);

    const result = spawnSync(
      "sh",
      ["-c", `${script}\n`, "sh", configDir, ...patterns],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(hostTarget, "sessions"))).toBe(false);
    expect(fs.existsSync(path.join(agentsRoot, "main", "sessions"))).toBe(false);

    fs.rmSync(fixture, { recursive: true, force: true });
  });
});
