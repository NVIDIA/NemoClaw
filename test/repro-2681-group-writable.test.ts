// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral regression coverage for the group-writable mutable-default
 * contract (#2681 and the Hermes root-entrypoint gateway split).
 *
 * These tests execute the entrypoint's permission-normalization function
 * against a temporary OpenClaw config tree instead of asserting on production
 * source text. The contract is what matters: when shields are down, mutable
 * config roots have the write modes needed by their gateway model; when
 * shields are up (root-owned), startup must not weaken the lock.
 */

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const MUTABLE_CONFIG_NORMALIZER = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "normalize_mutable_config_perms.py",
);
const OPENCLAW_CONFIG_GUARD = "/usr/local/lib/nemoclaw/openclaw-config-guard.py";
const STATE_DIR_GUARD = "/usr/local/lib/nemoclaw/state-dir-guard.py";
const HERMES_RUNTIME_CONFIG_GUARD = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py";
const HERMES_LOCK_TOKEN = "a".repeat(64);
const HERMES_SEALED_GUARD_HELP = [
  "begin-shields-transition",
  "run-state-dir-transition",
  "apply-shields-transition",
  "finish-shields-transition",
  "prepare-shields-abort",
  "abort-shields-transition",
  "--rollback-shields-mode",
].join(" ");

function extractShellFunctionFromSource(src: string, name: string): string {
  const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

function replaceRequired(source: string, target: string, replacement: string): string {
  const parts = source.split(target);
  expect(parts, `Expected exactly one replacement target: ${target}`).toHaveLength(2);
  return `${parts[0]}${replacement}${parts[1]}`;
}

function normalizeMutableConfigPermsFor(configDir: string): string {
  const startScript = fs.readFileSync(START_SCRIPT, "utf-8");
  const normalizeFunction = replaceRequired(
    extractShellFunctionFromSource(startScript, "normalize_mutable_config_perms"),
    'local config_dir="/sandbox/.openclaw"',
    `local config_dir=${JSON.stringify(configDir)}`,
  );
  const resolveNormalizerFunction = extractShellFunctionFromSource(
    startScript,
    "resolve_mutable_config_normalizer",
  );
  const reclaimFunction = extractShellFunctionFromSource(
    startScript,
    "reclaim_collapsed_mutable_config",
  );
  const classifyFunction = extractShellFunctionFromSource(
    startScript,
    "classify_openclaw_config_seal",
  );
  return [resolveNormalizerFunction, classifyFunction, reclaimFunction, normalizeFunction].join(
    "\n",
  );
}

function modeBits(filePath: string): number {
  return fs.statSync(filePath).mode;
}

function runMutableConfigNormalizer(configDir: string, ownedPaths: string[]) {
  const testRoot = path.dirname(configDir);
  const normalizerPath = path.join(testRoot, "normalize_mutable_config_perms.py");
  fs.copyFileSync(MUTABLE_CONFIG_NORMALIZER, normalizerPath);
  fs.chmodSync(normalizerPath, 0o755);
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf-8",
    env: {
      ...process.env,
      BASH_ENV: "",
      HOME: testRoot,
      NEMOCLAW_MUTABLE_CONFIG_NORMALIZER: normalizerPath,
    },
    timeout: 5000,
  };
  switch (process.getuid?.()) {
    case 0: {
      const unprivilegedId = 65534;
      for (const ownedPath of [...ownedPaths, normalizerPath]) {
        fs.chownSync(ownedPath, unprivilegedId, unprivilegedId);
      }
      spawnOptions.uid = unprivilegedId;
      spawnOptions.gid = unprivilegedId;
      break;
    }
  }
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        normalizeMutableConfigPermsFor(configDir),
        "normalize_mutable_config_perms",
      ].join("\n"),
    ],
    spawnOptions,
  );
}

function withMockedDockerExecFileSync<T>(
  calls: string[][],
  run: () => T,
  options: { hermesLockedTransaction?: boolean; symlinkedPaths?: ReadonlySet<string> } = {},
): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerExecModule = require("../src/lib/adapters/docker/exec.js") as {
    dockerExecFileSync: (args: readonly string[]) => string;
    dockerSpawnSync: (args: readonly string[]) => unknown;
  };
  const originalDockerExecFileSync = dockerExecModule.dockerExecFileSync;
  const originalDockerSpawnSync = dockerExecModule.dockerSpawnSync;
  const shieldsModulePath = require.resolve("../src/lib/shields/index.js");
  const privilegedExecPath = require.resolve("../src/lib/sandbox/privileged-exec.js");
  const priorPrivilegedExec = require.cache[privilegedExecPath];
  delete require.cache[shieldsModulePath];
  require.cache[privilegedExecPath] = {
    id: privilegedExecPath,
    filename: privilegedExecPath,
    loaded: true,
    exports: {
      privilegedSandboxExecArgv: (_sandboxName: string, cmd: readonly string[]) => [...cmd],
    },
  } as any;

  let hermesFinished = false;
  dockerExecModule.dockerExecFileSync = vi.fn((args: readonly string[]) => {
    const separator = args.indexOf("--");
    const command = separator >= 0 ? args.slice(separator + 1) : [...args];
    calls.push(command);
    const hermesGuardIndex = command.indexOf(HERMES_RUNTIME_CONFIG_GUARD);
    const hermesAction = command[hermesGuardIndex + 1] ?? "";
    switch (hermesAction) {
      case "finish-shields-transition":
        hermesFinished = true;
        break;
    }
    const hermesResponse =
      hermesGuardIndex < 0
        ? undefined
        : (new Map<string, string>([
            ["--help", HERMES_SEALED_GUARD_HELP],
            ["begin-shields-transition", `lock_token=${HERMES_LOCK_TOKEN} original_locked=0`],
            [
              "apply-shields-transition",
              options.hermesLockedTransaction
                ? "shields_mode=locked chattr_applied=1"
                : "shields_mode=mutable chattr_applied=0",
            ],
          ]).get(hermesAction) ?? "");
    switch (hermesResponse) {
      case undefined:
        break;
      default:
        return hermesResponse;
    }
    if (command[0] === "python3" && command[1] === "-I" && command[2] === "-c") {
      for (const target of command.slice(7)) {
        if (options.symlinkedPaths?.has(target)) {
          throw new Error(`refusing symlink path: ${target}`);
        }
      }
      return "";
    }
    if (command[0] === "stat" && command[1] === "-c") {
      const target = command.at(-1);
      switch (target) {
        case "/sandbox":
          return options.hermesLockedTransaction
            ? hermesFinished
              ? "1775 root:sandbox\n"
              : "755 root:root\n"
            : "755 sandbox:sandbox\n";
        case "/sandbox/.openclaw":
          return "2770 sandbox:sandbox\n";
        case "/sandbox/.hermes":
          return options.hermesLockedTransaction ? "755 root:root\n" : "3770 sandbox:sandbox\n";
      }
      if (typeof target === "string" && target.startsWith("/sandbox/.hermes/")) {
        return options.hermesLockedTransaction ? "444 root:root\n" : "640 sandbox:sandbox\n";
      }
      return "660 sandbox:sandbox\n";
    }
    if (command[0] === "lsattr") {
      return `${options.hermesLockedTransaction ? "----i-----------------" : "----------------------"} ${command.at(-1)}\n`;
    }
    switch (command[0]) {
      case "sha256sum":
        return `${"a".repeat(64)}  ${command.at(-1)}\n`;
    }
    return "";
  });

  dockerExecModule.dockerSpawnSync = vi.fn((args: readonly string[]) => {
    const separator = args.indexOf("--");
    const command = separator >= 0 ? args.slice(separator + 1) : [...args];
    calls.push(command);

    const openClawGuardIndex = command.indexOf(OPENCLAW_CONFIG_GUARD);
    const stateDirGuardIndex = command.indexOf(STATE_DIR_GUARD);
    switch (true) {
      case command[0] === "test" &&
        command[1] === "-r" &&
        (command[2] === OPENCLAW_CONFIG_GUARD || command[2] === STATE_DIR_GUARD):
        return {
          status: 0,
          signal: null,
          stdout: "",
          stderr: "",
          pid: 0,
          output: [],
        } as never;
      case openClawGuardIndex >= 0: {
        const action = command[openClawGuardIndex + 1];
        const symlinkedTarget = [...(options.symlinkedPaths ?? [])].find((target) =>
          target.startsWith("/sandbox/.openclaw/"),
        );
        const refused = action === "preflight" && symlinkedTarget !== undefined;
        const records = refused
          ? [
              {
                type: "issue",
                code: "unsafe-path",
                path: symlinkedTarget,
                detail: `refusing symlink path: ${symlinkedTarget}`,
              },
              { type: "result", action, status: "failed" },
            ]
          : [
              {
                type: "result",
                action,
                status: "ok",
                configDir: "/sandbox/.openclaw",
                files: ["openclaw.json", ".config-hash"],
                chattrApplied: action === "lock",
              },
            ];
        return {
          status: refused ? 1 : 0,
          signal: null,
          stdout: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
          stderr: "",
          pid: 0,
          output: [],
        } as never;
      }
      case stateDirGuardIndex >= 0: {
        const action = command[stateDirGuardIndex + 1];
        return {
          status: 0,
          signal: null,
          stdout: `${JSON.stringify({
            type: "result",
            action,
            status: "ok",
            issueCount: 0,
          })}\n`,
          stderr: "",
          pid: 0,
          output: [],
        } as never;
      }
      default:
        return {
          status: 0,
          signal: null,
          stdout: "",
          stderr: "",
          pid: 0,
          output: [],
        } as never;
    }
  });

  try {
    return run();
  } finally {
    dockerExecModule.dockerExecFileSync = originalDockerExecFileSync;
    dockerExecModule.dockerSpawnSync = originalDockerSpawnSync;
    delete require.cache[shieldsModulePath];
    if (priorPrivilegedExec) require.cache[privilegedExecPath] = priorPrivilegedExec;
    else delete require.cache[privilegedExecPath];
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

describe("mutable agent config permissions", () => {
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

      const result = runMutableConfigNormalizer(configDir, [
        tmpDir,
        configDir,
        path.join(configDir, "agents"),
        nestedDir,
        configFile,
      ]);

      expect(result.status, result.stderr).toBe(0);
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

  it("re-normalizes a tree that `openclaw doctor --fix` tightened to 700/600 (#4538)", () => {
    // OpenClaw's `doctor --fix` enforces a single-user 700/600 state layout,
    // which silently breaks NemoClaw's group-writable mutable contract so the
    // gateway UID can no longer persist config edits. A (re)start must restore
    // the setgid + group-writable contract.
    const tmpDir = mkdtempOnPosixFs("nemoclaw-4538-doctor-fix-");
    const configDir = path.join(tmpDir, ".openclaw");
    const nestedDir = path.join(configDir, "agents", "main");
    const configFile = path.join(configDir, "openclaw.json");
    const hashFile = path.join(configDir, ".config-hash");

    try {
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(configFile, "{}\n");
      fs.writeFileSync(hashFile, "deadbeef\n");
      // Simulate the post-`doctor --fix` single-user 700/600 layout.
      fs.chmodSync(configFile, 0o600);
      fs.chmodSync(hashFile, 0o600);
      fs.chmodSync(nestedDir, 0o700);
      fs.chmodSync(configDir, 0o700);

      // Sanity-check the starting (tightened) state.
      expect(modeBits(configDir) & 0o7777).toBe(0o700);
      expect(modeBits(configFile) & 0o7777).toBe(0o600);

      const result = runMutableConfigNormalizer(configDir, [
        tmpDir,
        configDir,
        path.join(configDir, "agents"),
        nestedDir,
        configFile,
        hashFile,
      ]);

      expect(result.status, result.stderr).toBe(0);
      // Mutable contract restored: setgid + group rwx dir, group rw files.
      expect(modeBits(configDir) & 0o7777).toBe(0o2770);
      expect(modeBits(configFile) & 0o7777).toBe(0o660);
      expect(modeBits(hashFile) & 0o7777).toBe(0o660);
      expect(modeBits(configDir) & 0o2000).toBe(0o2000);
      expect(modeBits(nestedDir) & 0o2000).toBe(0o2000);
      expect(modeBits(nestedDir) & 0o070).toBe(0o070);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a hardlinked fixed config before changing either alias mode", () => {
    const tmpDir = mkdtempOnPosixFs("nemoclaw-6047-hardlink-");
    const configDir = path.join(tmpDir, ".openclaw");
    const configFile = path.join(configDir, "openclaw.json");
    const earlierTreeAlias = path.join(configDir, ".a");
    const externalAlias = path.join(tmpDir, "external-config");

    try {
      fs.mkdirSync(configDir, { mode: 0o700 });
      fs.writeFileSync(externalAlias, "{}\n", { mode: 0o600 });
      fs.chmodSync(externalAlias, 0o600);
      fs.linkSync(externalAlias, earlierTreeAlias);
      fs.linkSync(externalAlias, configFile);

      const result = runMutableConfigNormalizer(configDir, [tmpDir, configDir, externalAlias]);

      expect(result.status).not.toBe(0);
      expect(fs.statSync(configFile).ino).toBe(fs.statSync(externalAlias).ino);
      expect(fs.statSync(earlierTreeAlias).ino).toBe(fs.statSync(externalAlias).ino);
      expect(modeBits(configFile) & 0o7777).toBe(0o600);
      expect(modeBits(earlierTreeAlias) & 0o7777).toBe(0o600);
      expect(modeBits(externalAlias) & 0o7777).toBe(0o600);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shields-down restores OpenClaw group-writable file modes and setgid dirs", () => {
    const commands: string[][] = [];
    withMockedDockerExecFileSync(commands, () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { unlockAgentConfig } = require("../src/lib/shields/index.js") as {
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

    const openClawActions = commands
      .filter((command) => command.includes(OPENCLAW_CONFIG_GUARD))
      .map((command) => command[command.indexOf(OPENCLAW_CONFIG_GUARD) + 1])
      .filter((action): action is string => typeof action === "string");
    const stateDirActions = commands
      .filter((command) => command.includes(STATE_DIR_GUARD))
      .map((command) => command[command.indexOf(STATE_DIR_GUARD) + 1])
      .filter((action): action is string => typeof action === "string");
    expect(openClawActions).toEqual(["preflight", "unlock"]);
    expect(stateDirActions).toEqual(["unlock"]);
    expect(commands).toContainEqual(["test", "-r", OPENCLAW_CONFIG_GUARD]);
    expect(commands).toContainEqual(["test", "-r", STATE_DIR_GUARD]);
    expect(commands).toContainEqual(["stat", "-c", "%a %U:%G", "/sandbox/.openclaw/openclaw.json"]);
    expect(commands).toContainEqual(["stat", "-c", "%a %U:%G", "/sandbox/.openclaw/.config-hash"]);
    expect(
      commands.some(
        (command) =>
          command[0] === "sh" &&
          command[1] === "-c" &&
          typeof command[2] === "string" &&
          command[2].includes("chown -R"),
      ),
    ).toBe(false);
  });

  it("refuses to unlock OpenClaw config when a config path is a symlink", () => {
    const commands: string[][] = [];
    expect(() =>
      withMockedDockerExecFileSync(
        commands,
        () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { unlockAgentConfig } = require("../src/lib/shields/index.js") as {
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
        },
        {
          symlinkedPaths: new Set(["/sandbox/.openclaw/openclaw.json"]),
        },
      ),
    ).toThrow("refusing symlink path");

    const openClawPreflight = commands.find((command) => {
      const guardIndex = command.indexOf(OPENCLAW_CONFIG_GUARD);
      return guardIndex >= 0 && command[guardIndex + 1] === "preflight";
    });
    expect(openClawPreflight).toEqual(
      expect.arrayContaining([
        "python3",
        "-I",
        OPENCLAW_CONFIG_GUARD,
        "preflight",
        "--config-dir",
        "/sandbox/.openclaw",
      ]),
    );
    expect(commands).toContainEqual(["test", "-r", OPENCLAW_CONFIG_GUARD]);
    expect(commands.some((command) => command.includes(STATE_DIR_GUARD))).toBe(false);
    expect(
      commands.some(
        (command) =>
          command[0] === "sh" &&
          command[1] === "-c" &&
          typeof command[2] === "string" &&
          command[2].includes("chown -R"),
      ),
    ).toBe(false);
  });

  it("shields-down restores Hermes sticky group-writable config root without group-writable config files", () => {
    const commands: string[][] = [];
    withMockedDockerExecFileSync(commands, () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { unlockAgentConfig } = require("../src/lib/shields/index.js") as {
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
        agentName: "hermes",
        configPath: "/sandbox/.hermes/config.yaml",
        configDir: "/sandbox/.hermes",
        sensitiveFiles: ["/sandbox/.hermes/.env"],
      });
    });

    const hermesActions = commands
      .filter((command) => command.includes(HERMES_RUNTIME_CONFIG_GUARD))
      .map((command) => command[command.indexOf(HERMES_RUNTIME_CONFIG_GUARD) + 1]);
    expect(hermesActions).toEqual([
      "--help",
      "begin-shields-transition",
      "run-state-dir-transition",
      "apply-shields-transition",
      "finish-shields-transition",
    ]);
    const begin = commands.find((command) => command.includes("begin-shields-transition"));
    expect(begin).toEqual(
      expect.arrayContaining(["--shields-mode", "mutable", "--rollback-shields-mode", "mutable"]),
    );
    for (const action of [
      "run-state-dir-transition",
      "apply-shields-transition",
      "finish-shields-transition",
    ]) {
      const command = commands.find((candidate) => candidate.includes(action));
      expect(command).toEqual(expect.arrayContaining(["--lock-token", HERMES_LOCK_TOKEN]));
    }
    expect(commands).toContainEqual(["stat", "-c", "%a %U:%G", "/sandbox/.hermes/config.yaml"]);
    expect(commands).toContainEqual(["stat", "-c", "%a %U:%G", "/sandbox/.hermes/.env"]);
  });

  it("verifies the frozen Hermes tree before publishing and checking the locked parent", () => {
    const commands: string[][] = [];
    withMockedDockerExecFileSync(
      commands,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { lockAgentConfig } = require("../src/lib/shields/index.js") as {
          lockAgentConfig: (
            sandboxName: string,
            target: {
              agentName?: string;
              configPath: string;
              configDir: string;
              sensitiveFiles?: string[];
            },
          ) => void;
        };

        lockAgentConfig("sandbox-pod", {
          agentName: "hermes",
          configPath: "/sandbox/.hermes/config.yaml",
          configDir: "/sandbox/.hermes",
          sensitiveFiles: ["/sandbox/.hermes/.env", "/sandbox/.hermes/.config-hash"],
        });
      },
      { hermesLockedTransaction: true },
    );

    const finishIndex = commands.findIndex((command) =>
      command.includes("finish-shields-transition"),
    );
    const parentStats = commands
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => command.at(-1) === "/sandbox" && command[0] === "stat");
    expect(finishIndex).toBeGreaterThan(0);
    expect(parentStats).toHaveLength(1);
    expect(parentStats[0].index).toBeGreaterThan(finishIndex);
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
const OPENCLAW_CONFIG_GUARD = ${JSON.stringify(OPENCLAW_CONFIG_GUARD)};
const STATE_DIR_GUARD = ${JSON.stringify(STATE_DIR_GUARD)};
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../adapters/docker/exec") {
    return {
      dockerExecFileSync(args) {
        const separator = args.indexOf("--");
        const command = separator >= 0 ? args.slice(separator + 1) : args;
        calls.push(command);
        if (command[0] === "stat" && command[1] === "-c") {
          const target = command.at(-1);
          if (target === "/sandbox") return "1775 root:sandbox\n";
          return target === "/sandbox/.openclaw" ? "755 root:root\n" : "444 root:root\n";
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
      dockerSpawnSync(args) {
        const separator = args.indexOf("--");
        const command = separator >= 0 ? args.slice(separator + 1) : args;
        calls.push(command);
        if (
          command[0] === "test" &&
          command[1] === "-r" &&
          (command[2] === OPENCLAW_CONFIG_GUARD || command[2] === STATE_DIR_GUARD)
        ) {
          return { status: 0, signal: null, stdout: "", stderr: "", pid: 0, output: [] };
        }
        const openClawGuardIndex = command.indexOf(OPENCLAW_CONFIG_GUARD);
        if (openClawGuardIndex >= 0) {
          const action = command[openClawGuardIndex + 1];
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({
              type: "result",
              action,
              status: "ok",
              configDir: "/sandbox/.openclaw",
              files: ["openclaw.json", ".config-hash"],
              chattrApplied: action === "lock",
            }) + "\n",
            stderr: "",
            pid: 0,
            output: [],
          };
        }
        const stateDirGuardIndex = command.indexOf(STATE_DIR_GUARD);
        if (stateDirGuardIndex >= 0) {
          const action = command[stateDirGuardIndex + 1];
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({
              type: "result",
              action,
              status: "ok",
              issueCount: 0,
            }) + "\n",
            stderr: "",
            pid: 0,
            output: [],
          };
        }
        return { status: 0, signal: null, stdout: "", stderr: "", pid: 0, output: [] };
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
const { lockAgentConfig } = require("./src/lib/shields/index.ts");
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

    expect(probe.status, probe.stderr).toBe(0);
    const commands = JSON.parse(probe.stdout) as string[][];
    const openClawCapabilityIndex = commands.findIndex(
      (command) => command.join("\0") === ["test", "-r", OPENCLAW_CONFIG_GUARD].join("\0"),
    );
    const openClawLockIndex = commands.findIndex((command) => {
      const guardIndex = command.indexOf(OPENCLAW_CONFIG_GUARD);
      return guardIndex >= 0 && command[guardIndex + 1] === "lock";
    });
    const stateDirCapabilityIndex = commands.findIndex(
      (command) => command.join("\0") === ["test", "-r", STATE_DIR_GUARD].join("\0"),
    );
    const stateDirLockIndex = commands.findIndex((command) => {
      const guardIndex = command.indexOf(STATE_DIR_GUARD);
      return guardIndex >= 0 && command[guardIndex + 1] === "lock";
    });
    const verificationIndex = commands.findIndex(
      (command, index) =>
        index > stateDirLockIndex &&
        command[0] === "stat" &&
        command[1] === "-c" &&
        command.at(-1) === "/sandbox/.openclaw",
    );
    expect(openClawCapabilityIndex).toBeGreaterThan(-1);
    expect(openClawLockIndex).toBeGreaterThan(openClawCapabilityIndex);
    expect(stateDirCapabilityIndex).toBeGreaterThan(openClawLockIndex);
    expect(stateDirLockIndex).toBeGreaterThan(-1);
    expect(stateDirLockIndex).toBeGreaterThan(stateDirCapabilityIndex);
    expect(verificationIndex).toBeGreaterThan(stateDirLockIndex);
    expect(commands).not.toContainEqual(["chmod", "g-s", "/sandbox/.openclaw"]);
    expect(commands).not.toContainEqual(["chmod", "755", "/sandbox/.openclaw"]);
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
            // Model the descriptor observing root ownership without requiring
            // the test runner itself to own this fixture as root: the initial
            // classification reports uid 0, and classify-seal reports a
            // sealed tree, so normalize must never reach chmod or find.
            'python3() { if [ "${2:-}" = "-" ]; then cat >/dev/null; printf "0\\n"; return 0; fi; if [ "${3:-}" = "classify-seal" ]; then return 0; fi; printf "unexpected helper invocation\\n" >&2; return 68; }',
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
