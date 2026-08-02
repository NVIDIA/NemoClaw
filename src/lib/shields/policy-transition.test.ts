// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const SHIELDS_MODULE = "./index.js";
const TRANSITION_LOCK_MODULE = "./transition-lock.js";

describe("shields policy transition", () => {
  let homeDir: string;
  let runSpy: MockInstance;
  let runCaptureSpy: MockInstance;
  let shields: typeof import("./index.js");

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-policy-transition-"));
    vi.stubEnv("HOME", homeDir);
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];

    const runner = requireSource("../runner.js");
    const agentConfig = requireSource("../sandbox/agent-config.js");
    vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
    runSpy = vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
    runCaptureSpy = vi.spyOn(runner, "runCapture").mockImplementation(() => {
      throw new Error("policy get failed with status 42");
    });
    vi.spyOn(agentConfig, "resolveAgentConfig").mockReturnValue({
      agentName: "langchain-deepagents-code",
      configDir: "/sandbox/.deepagents",
      configFile: "config.json",
      configPath: "/sandbox/.deepagents/config.json",
      format: "json",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    shields = requireSource(SHIELDS_MODULE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("never relaxes policy or persists mutable state when the base-policy read fails", () => {
    expect(() => shields.shieldsDown("openclaw", { skipTimer: true, throwOnError: true })).toThrow(
      "Cannot capture current policy",
    );
    expect(runSpy).not.toHaveBeenCalled();

    const stateFiles = fs.readdirSync(path.join(homeDir, ".nemoclaw", "state"));
    expect(stateFiles.filter((name) => /^(policy-snapshot-|shields-openclaw)/.test(name))).toEqual(
      [],
    );
  });

  it.each([
    ["message", "message: gateway unavailable"],
    ["details", "details: grpc unavailable"],
    ["arbitrary diagnostic", "reason: gateway unavailable\nretryable: true"],
  ])("never relaxes policy or persists mutable state for exit-zero %s output", (_name, output) => {
    runCaptureSpy.mockReturnValue(output);

    expect(() => shields.shieldsDown("openclaw", { skipTimer: true, throwOnError: true })).toThrow(
      "Cannot capture current policy",
    );
    expect(runSpy).not.toHaveBeenCalled();

    const stateFiles = fs.readdirSync(path.join(homeDir, ".nemoclaw", "state"));
    expect(stateFiles.filter((name) => /^(policy-snapshot-|shields-openclaw)/.test(name))).toEqual(
      [],
    );
  });
});

describe("shields config lock without a shipped config hash", () => {
  const CONFIG_DIR = "/sandbox/.deepagents";
  const CONFIG_PATH = `${CONFIG_DIR}/config.toml`;
  const HASH_PATH = `${CONFIG_DIR}/.config-hash`;

  type SandboxEntry = { mode: string; owner: string };

  let homeDir: string;
  let shields: typeof import("./index.js");
  let entries: Map<string, SandboxEntry>;
  let repairCalls: string[][];
  let commandHandlers: Map<string, (args: string[], command: string[]) => string>;

  function target() {
    return {
      agentName: "langchain-deepagents-code",
      configDir: CONFIG_DIR,
      configFile: "config.toml",
      configPath: CONFIG_PATH,
      format: "toml",
      sensitiveFiles: [HASH_PATH],
    };
  }

  function missingEntry(pathname: string, operation: string): never {
    throw new Error(`${operation}: cannot access '${pathname}': No such file or directory`);
  }

  function requireEntry(pathname: string, operation: string): SandboxEntry {
    return entries.get(pathname) ?? missingEntry(pathname, operation);
  }

  function unsupportedCommand(command: string[]): never {
    throw new Error(`unsupported sandbox command in fixture: ${command.join(" ")}`);
  }

  function runSandboxCommand(cmd: string[]): string {
    const [head, ...rest] = cmd;
    const handler = commandHandlers.get(head) ?? unsupportedCommand(cmd);
    return handler(rest, cmd);
  }

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-config-lock-"));
    vi.stubEnv("HOME", homeDir);
    repairCalls = [];
    entries = new Map<string, SandboxEntry>([
      ["/sandbox", { mode: "1775", owner: "root:sandbox" }],
      [CONFIG_DIR, { mode: "2770", owner: "sandbox:sandbox" }],
      [CONFIG_PATH, { mode: "660", owner: "sandbox:sandbox" }],
    ]);
    commandHandlers = new Map<string, (args: string[], command: string[]) => string>([
      [
        "python3",
        (_args, command) => {
          repairCalls.push(command);
          entries.set(CONFIG_DIR, { mode: "700", owner: "root:root" });
          entries.set(HASH_PATH, { mode: "600", owner: "sandbox:sandbox" });
          return "";
        },
      ],
      [
        "chmod",
        ([mode, pathname]) => {
          const entry = requireEntry(pathname, "chmod");
          const applyMode =
            new Map<string, () => void>([["g-s", () => undefined]]).get(mode) ??
            (() => {
              entry.mode = mode;
            });
          applyMode();
          return "";
        },
      ],
      [
        "chown",
        ([owner, pathname]) => {
          requireEntry(pathname, "chown").owner = owner;
          return "";
        },
      ],
      [
        "chattr",
        (_args, command) => {
          requireEntry(String(command.at(-1)), "chattr");
          return "";
        },
      ],
      [
        "lsattr",
        (_args, command) => {
          const pathname = String(command.at(-1));
          requireEntry(pathname, "lsattr");
          return `----i---------e----- ${pathname}`;
        },
      ],
      [
        "stat",
        (_args, command) => {
          const pathname = String(command.at(-1));
          const entry = requireEntry(pathname, "stat");
          return `${entry.mode} ${entry.owner}`;
        },
      ],
      [
        "sha256sum",
        (_args, command) => {
          const pathname = String(command.at(-1));
          requireEntry(pathname, "sha256sum");
          return `${"a".repeat(64)}  ${pathname}`;
        },
      ],
      ["sh", () => ""],
    ]);
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];

    const runner = requireSource("../runner.js");
    const sandboxConfig = requireSource("../sandbox/config.js");
    const privilegedExec = requireSource("../sandbox/privileged-exec.js");
    const dockerExec = requireSource("../adapters/docker/exec.js");
    const stateDirLock = requireSource("./state-dir-lock.js");

    vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
    vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
    vi.spyOn(runner, "runCapture").mockReturnValue("");
    vi.spyOn(sandboxConfig, "resolveAgentConfig").mockImplementation(() => target());
    vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
      (_sandboxName: unknown, cmd: unknown) => cmd as string[],
    );
    vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((cmd: unknown) =>
      runSandboxCommand(cmd as string[]),
    );
    vi.spyOn(stateDirLock, "preflightStateDirLock").mockReturnValue([]);
    vi.spyOn(stateDirLock, "applyStateDirLockMode").mockReturnValue([]);
    vi.spyOn(stateDirLock, "restoreStateDirLockPosture").mockReturnValue([]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    shields = requireSource(SHIELDS_MODULE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("repairs the absent hash record before locking the protected files", () => {
    const result = shields.lockAgentConfig("dcode-safety", target(), false);

    expect(repairCalls).toHaveLength(1);
    expect(repairCalls[0].slice(-2)).toEqual([CONFIG_DIR, CONFIG_PATH]);
    expect(entries.get(CONFIG_PATH)).toEqual({ mode: "444", owner: "root:root" });
    expect(entries.get(HASH_PATH)).toEqual({ mode: "444", owner: "root:root" });
    expect(Object.keys(result.fileHashes)).toEqual([CONFIG_PATH, HASH_PATH]);
  });

  it("leaves the config unlocked when the hash record cannot be repaired", () => {
    const dockerExec = requireSource("../adapters/docker/exec.js");
    const injectedFailures = new Map<string, () => string>([
      [
        "python3",
        () => {
          throw new Error("not a regular file: /sandbox/.deepagents/.config-hash");
        },
      ],
    ]);
    vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((cmd: unknown) => {
      const argv = cmd as string[];
      const execute = injectedFailures.get(argv[0]) ?? (() => runSandboxCommand(argv));
      return execute();
    });

    expect(() => shields.lockAgentConfig("dcode-safety", target(), false)).toThrow(
      /not a regular file/,
    );

    expect(entries.get(CONFIG_PATH)).toEqual({ mode: "660", owner: "sandbox:sandbox" });
    expect(entries.has(HASH_PATH)).toBe(false);
  });

  it("restores the managed sandbox parent when the config is unlocked", () => {
    entries.set(CONFIG_DIR, { mode: "755", owner: "root:root" });
    entries.set(CONFIG_PATH, { mode: "444", owner: "root:root" });
    entries.set(HASH_PATH, { mode: "444", owner: "root:root" });
    commandHandlers.set("python3", (_args, command) => {
      expect(command.slice(4, 9)).toEqual(["660", "2770", "sandbox:sandbox", "1", CONFIG_DIR]);
      entries.set("/sandbox", { mode: "755", owner: "sandbox:sandbox" });
      entries.set(CONFIG_DIR, { mode: "2770", owner: "sandbox:sandbox" });
      entries.set(CONFIG_PATH, { mode: "660", owner: "sandbox:sandbox" });
      entries.set(HASH_PATH, { mode: "660", owner: "sandbox:sandbox" });
      return "";
    });
    commandHandlers.set("lsattr", () => "----------------------");

    shields.unlockAgentConfig("dcode-safety", target(), true);

    expect(entries.get("/sandbox")).toEqual({ mode: "755", owner: "sandbox:sandbox" });
    expect(entries.get(CONFIG_DIR)).toEqual({ mode: "2770", owner: "sandbox:sandbox" });
  });
});
