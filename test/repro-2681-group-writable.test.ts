// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral regression coverage for the group-writable mutable-default
 * contract (#2681).
 *
 * These tests execute the entrypoint's permission-normalization function
 * against a temporary OpenClaw config tree instead of asserting on production
 * source text. The contract is what matters: when shields are down, OpenClaw's
 * config tree is group-writable and setgid; when shields are up (root-owned),
 * startup must not weaken the lock.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractShellFunctionFromSource(src: string, name: string): string {
  const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

function normalizeMutableConfigPermsFor(configDir: string): string {
  const startScript = fs.readFileSync(START_SCRIPT, "utf-8");
  return extractShellFunctionFromSource(startScript, "normalize_mutable_config_perms").replace(
    'local config_dir="/sandbox/.openclaw"',
    `local config_dir=${JSON.stringify(configDir)}`,
  );
}

function modeBits(filePath: string): number {
  return fs.statSync(filePath).mode;
}

function withMockedDockerExecFileSync<T>(calls: string[][], run: () => T): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerExecModule = require("../dist/lib/docker/exec.js") as {
    dockerExecFileSync: (args: readonly string[]) => string;
  };
  const originalDockerExecFileSync = dockerExecModule.dockerExecFileSync;
  const shieldsModulePath = require.resolve("../dist/lib/shields.js");
  delete require.cache[shieldsModulePath];

  dockerExecModule.dockerExecFileSync = vi.fn((args: readonly string[]) => {
    const separator = args.indexOf("--");
    const command = separator >= 0 ? args.slice(separator + 1) : [...args];
    calls.push(command);
    if (command[0] === "stat" && command[1] === "-c") {
      return command.at(-1) === "/sandbox/.openclaw"
        ? "2770 sandbox:sandbox\n"
        : "660 sandbox:sandbox\n";
    }
    if (command[0] === "lsattr") {
      return `---------------------- ${command.at(-1)}\n`;
    }
    return "";
  });

  try {
    return run();
  } finally {
    dockerExecModule.dockerExecFileSync = originalDockerExecFileSync;
    delete require.cache[shieldsModulePath];
  }
}

function mkdtempOnPosixFs(prefix: string): string {
  const roots = process.platform === "linux" ? ["/tmp", os.tmpdir()] : [os.tmpdir()];
  let lastError: unknown = null;
  for (const root of roots) {
    try {
      return fs.mkdtempSync(path.join(root, prefix));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("Issue #2681 — mutable OpenClaw config permissions", () => {
  it("restores group-write and setgid on mutable config trees during non-root startup", () => {
    const tmpDir = mkdtempOnPosixFs("nemoclaw-2681-perms-");
    const configDir = path.join(tmpDir, ".openclaw");
    const nestedDir = path.join(configDir, "agents", "main");
    const configFile = path.join(configDir, "openclaw.json");

    try {
      fs.mkdirSync(nestedDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(configFile, "{}\n", { mode: 0o600 });
      fs.chmodSync(configDir, 0o700);
      fs.chmodSync(nestedDir, 0o700);
      fs.chmodSync(configFile, 0o600);

      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
            'stat() { if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U" ]; then printf "sandbox\\n"; else command stat "$@"; fi; }',
            normalizeMutableConfigPermsFor(configDir),
            "normalize_mutable_config_perms",
          ].join("\n"),
        ],
        { encoding: "utf-8", timeout: 5000 },
      );

      expect(result.status).toBe(0);
      expect(modeBits(configDir) & 0o7777).toBe(0o2770);
      expect(modeBits(configFile) & 0o7777).toBe(0o660);
      expect(modeBits(configDir) & 0o070).toBe(0o070);
      expect(modeBits(configDir) & 0o020).toBe(0o020);
      expect(modeBits(configFile) & 0o060).toBe(0o060);
      expect(modeBits(configFile) & 0o020).toBe(0o020);
      expect(modeBits(configDir) & 0o2000).toBe(0o2000);
      expect(modeBits(nestedDir) & 0o070).toBe(0o070);
      expect(modeBits(nestedDir) & 0o2000).toBe(0o2000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shields-down restores OpenClaw group-writable file modes and setgid dirs", () => {
    const commands: string[][] = [];
    withMockedDockerExecFileSync(commands, () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { unlockAgentConfig } = require("../dist/lib/shields.js") as {
        unlockAgentConfig: (
          sandboxName: string,
          target: {
            agentName?: string;
            configPath: string;
            configDir: string;
            sensitiveFiles?: string[];
          },
        ) => void;
      };

      unlockAgentConfig("sandbox-pod", {
        agentName: "openclaw",
        configPath: "/sandbox/.openclaw/openclaw.json",
        configDir: "/sandbox/.openclaw",
        sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
      });
    });

    expect(commands).toContainEqual(["chmod", "660", "/sandbox/.openclaw/openclaw.json"]);
    expect(commands).toContainEqual(["chmod", "660", "/sandbox/.openclaw/.config-hash"]);
    expect(commands).toContainEqual(["chmod", "2770", "/sandbox/.openclaw"]);
    expect(commands).toContainEqual(["chmod", "2770", "/sandbox/.openclaw/workspace"]);
    expect(commands).toContainEqual(["chmod", "-R", "g+rwX,o-rwx", "/sandbox/.openclaw/workspace"]);
    expect(commands.find((command) => command[0] === "sh" && command[1] === "-c")).toEqual(
      expect.arrayContaining(["/sandbox/.openclaw", "sandbox:sandbox", "g+rwX,o-rwx", "2770"]),
    );
  });

  it("shields-up strips setgid from the OpenClaw config root before verifying lock", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        String.raw`
const Module = require("node:module");
const originalLoad = Module._load;
const calls = [];
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./docker/exec") {
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
const { lockAgentConfig } = require("./dist/lib/shields.js");
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
    const commands = JSON.parse(probe.stdout) as string[][];
    const stateDirLockIndex = commands.findIndex(
      (command) =>
        command[0] === "sh" &&
        command[1] === "-c" &&
        command.includes("/sandbox/.openclaw") &&
        command.includes("root:root") &&
        command.includes("go-w") &&
        command.includes("755"),
    );
    const stripSetgidIndex = commands.findIndex((command) =>
      command.join("\0") === ["chmod", "g-s", "/sandbox/.openclaw"].join("\0"),
    );
    expect(stateDirLockIndex).toBeGreaterThan(-1);
    expect(stripSetgidIndex).toBeGreaterThan(stateDirLockIndex);
    expect(commands).toContainEqual(["chmod", "755", "/sandbox/.openclaw"]);
  });

  it("shields-up strips setgid from the OpenClaw config root before verifying lock", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        String.raw`
const Module = require("node:module");
const originalLoad = Module._load;
const calls = [];
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./docker/exec") {
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
const { lockAgentConfig } = require("./dist/lib/shields.js");
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
    const commands = JSON.parse(probe.stdout) as string[][];
    const stateDirLockIndex = commands.findIndex(
      (command) =>
        command[0] === "sh" &&
        command[1] === "-c" &&
        command.includes("/sandbox/.openclaw") &&
        command.includes("root:root") &&
        command.includes("go-w") &&
        command.includes("755"),
    );
    const stripSetgidIndex = commands.findIndex((command) =>
      command.join("\0") === ["chmod", "g-s", "/sandbox/.openclaw"].join("\0"),
    );
    expect(stateDirLockIndex).toBeGreaterThan(-1);
    expect(stripSetgidIndex).toBeGreaterThan(stateDirLockIndex);
    expect(commands).toContainEqual(["chmod", "755", "/sandbox/.openclaw"]);
  });

  it("does not relax a root-owned config tree while shields are up", () => {
    const tmpDir = mkdtempOnPosixFs("nemoclaw-2681-locked-");
    const configDir = path.join(tmpDir, ".openclaw");

    try {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            'id() { if [ "${1:-}" = "-u" ]; then printf "0"; else command id "$@"; fi; }',
            'stat() { if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U" ]; then printf "root\\n"; else command stat "$@"; fi; }',
            'chmod() { printf "CHMOD %s\\n" "$*" >&2; exit 66; }',
            'find() { printf "FIND %s\\n" "$*" >&2; exit 67; }',
            normalizeMutableConfigPermsFor(configDir),
            "normalize_mutable_config_perms",
            'printf "done\\n"',
          ].join("\n"),
        ],
        { encoding: "utf-8", timeout: 5000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("done\n");
      expect(result.stderr).not.toContain("CHMOD");
      expect(result.stderr).not.toContain("FIND");
      expect(modeBits(configDir) & 0o020).toBe(0);
      expect(modeBits(configDir) & 0o2000).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
