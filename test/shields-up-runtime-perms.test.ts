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
        return "";
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

describe("shields-up state-dir lock preserves sandbox-group access + runtime sessions writable", () => {
  it("locks each high-risk state dir to root:sandbox so the gateway keeps r-x via the sandbox group", () => {
    const commands = runLockAgentConfigProbe();

    const stateDirChowns = commands.filter(
      (command) =>
        command[0] === "chown" &&
        command[1] === "-R" &&
        typeof command[3] === "string" &&
        command[3].startsWith("/sandbox/.openclaw/"),
    );

    expect(stateDirChowns.length).toBeGreaterThan(0);
    for (const command of stateDirChowns) {
      expect(command[2]).toBe("root:sandbox");
    }
    expect(stateDirChowns.map((command) => command[3])).toContain(
      "/sandbox/.openclaw/extensions",
    );
    expect(stateDirChowns.map((command) => command[3])).toContain(
      "/sandbox/.openclaw/agents",
    );
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
    const patterns = restoreShell.slice(4);

    const result = spawnSync(
      "bash",
      ["-c", `${script}\n`, "sh", configDir, ...patterns],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(agentDir, "sessions"))).toBe(true);
    expect(fs.statSync(path.join(agentDir, "sessions")).isDirectory()).toBe(true);

    fs.rmSync(fixture, { recursive: true, force: true });
  });
});
