// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BEDROCK_RUNTIME_ADAPTER_STATE_VERSION,
  canonicalPid,
  isBedrockRuntimeAdapterState,
  readPrivateBedrockRuntimeFile,
  resolveBedrockRuntimeAdapterLifecyclePaths,
  stopExactBedrockRuntimeAdapterProcess,
  withBedrockRuntimeAdapterLifecycleLock,
  writeDurablePrivateBedrockRuntimeJson,
} from "./lifecycle";
import { readMcpLockProcessIdentity } from "../../state/mcp-lifecycle-lock-identity";

describe("Bedrock Runtime adapter lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records stable owner identity so a live lock cannot be reclaimed by age", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-lifecycle-lock-"));
    const lifecycle = resolveBedrockRuntimeAdapterLifecyclePaths(home, 8080);
    const expectedIdentity = readMcpLockProcessIdentity(process.pid, true);

    try {
      expect(expectedIdentity).not.toBeNull();
      withBedrockRuntimeAdapterLifecycleLock(lifecycle, () => {
        const owner = JSON.parse(fs.readFileSync(lifecycle.lockPath, "utf8"));
        expect(owner).toMatchObject({
          pid: process.pid,
          processIdentity: expectedIdentity,
        });
      });
      expect(fs.existsSync(lifecycle.lockPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps process-bound locks in the owner-private lifecycle tree", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-lifecycle-path-"));
    const lifecycle = resolveBedrockRuntimeAdapterLifecyclePaths(home, 8080);

    try {
      expect(lifecycle.lockStateDir).toBe(
        path.join(home, ".local", "state", "nemoclaw-bedrock-runtime-adapter", "locks"),
      );
      withBedrockRuntimeAdapterLifecycleLock(lifecycle, () => undefined);
      const stat = fs.lstatSync(lifecycle.lockStateDir);
      expect(stat.mode & 0o777).toBe(0o700);
      expect(stat.uid).toBe(process.getuid?.());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects unsafe private-file shapes and noncanonical PIDs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-private-file-"));
    const target = path.join(home, "state.json");

    try {
      fs.writeFileSync(target, "{}\n", { mode: 0o644 });
      expect(readPrivateBedrockRuntimeFile(target)).toBeNull();
      expect(canonicalPid("42\n")).toBe(42);
      expect(canonicalPid("42 trailing\n")).toBeNull();
      expect(canonicalPid("042\n")).toBeNull();
      expect(isBedrockRuntimeAdapterState({ version: BEDROCK_RUNTIME_ADAPTER_STATE_VERSION })).toBe(
        false,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes owner-only durable files and rejects symlink and hard-link reads", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-durable-file-"));
    const target = path.join(home, "private", "state.json");
    const symlink = path.join(home, "state-link.json");
    const hardLink = path.join(home, "state-hard-link.json");

    try {
      writeDurablePrivateBedrockRuntimeJson(target, { ok: true });
      expect(fs.lstatSync(target).mode & 0o777).toBe(0o600);
      expect(readPrivateBedrockRuntimeFile(target)).toContain('"ok": true');
      fs.symlinkSync(target, symlink);
      fs.linkSync(target, hardLink);
      expect(readPrivateBedrockRuntimeFile(symlink)).toBeNull();
      expect(readPrivateBedrockRuntimeFile(target)).toBeNull();
      expect(readPrivateBedrockRuntimeFile(hardLink)).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a lifecycle lock directory owned by another user", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-foreign-lock-"));
    const lifecycle = resolveBedrockRuntimeAdapterLifecyclePaths(home, 8080);
    fs.mkdirSync(lifecycle.lockStateDir, { recursive: true, mode: 0o700 });
    const originalLstat = fs.lstatSync;
    const current = originalLstat(lifecycle.lockStateDir);
    vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
      const stat = originalLstat(target);
      return String(target) === lifecycle.lockStateDir
        ? new Proxy(stat, {
            get(value, property) {
              const result = Reflect.get(value, property, value);
              return property === "uid"
                ? current.uid + 1
                : typeof result === "function"
                  ? result.bind(value)
                  : result;
            },
          })
        : stat;
    }) as typeof fs.lstatSync);

    try {
      expect(() => withBedrockRuntimeAdapterLifecycleLock(lifecycle, () => undefined)).toThrow(
        "owned by another user",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the synchronous lock wrapper synchronous at compile time", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-sync-lock-"));
    const lifecycle = resolveBedrockRuntimeAdapterLifecyclePaths(home, 8080);

    try {
      const rejectsPromiseCallback = () => {
        // @ts-expect-error The synchronous lifecycle lock must reject Promise callbacks.
        withBedrockRuntimeAdapterLifecycleLock(lifecycle, async () => undefined);
      };
      expect(rejectsPromiseCallback).toBeTypeOf("function");
      expect(withBedrockRuntimeAdapterLifecycleLock(lifecycle, () => "done")).toBe("done");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("revalidates the exact generation before TERM and KILL", () => {
    vi.useFakeTimers();
    const expected = {
      generation: "1".repeat(32),
      pid: 4242,
      processStart: "linux:test-boot:42",
      user: "testuser",
      uid: 501,
      executablePath: "/usr/bin/node",
      scriptPath: "/opt/nemoclaw/bedrock-runtime-adapter.mts",
      adapterPort: 11_436,
      tokenHash: "a".repeat(64),
    };
    let generation = expected.generation;
    const kills: NodeJS.Signals[] = [];
    const runtime = {
      env: {} as NodeJS.ProcessEnv,
      kill: (_pid: number, signal?: NodeJS.Signals | number) => {
        kills.push(signal as NodeJS.Signals);
        generation = signal === "SIGTERM" ? "2".repeat(32) : generation;
        return true;
      },
      readProcessArgv: () => [expected.executablePath, expected.scriptPath],
      readProcessExecutable: () => expected.executablePath,
      readProcessEnvironment: () => ({
        NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_GENERATION: generation,
        NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT: String(expected.adapterPort),
      }),
      readProcessIdentity: () => expected.processStart,
      run: (_command: string, args: readonly string[]) => {
        const field = args.at(-1);
        return {
          status: 0,
          stdout:
            field === "pid="
              ? `${String(expected.pid)}\n`
              : field === "uid="
                ? `${String(expected.uid)}\n`
                : field === "user="
                  ? `${expected.user}\n`
                  : "",
          stderr: "",
        };
      },
      sleep: (milliseconds: number) => vi.advanceTimersByTime(milliseconds),
    };

    expect(stopExactBedrockRuntimeAdapterProcess(expected, runtime)).toEqual({
      ok: false,
      reason: "authority-drift",
    });
    expect(kills).toEqual(["SIGTERM"]);
  });

  it("returns unresolved after exact TERM and KILL exhaustion", () => {
    vi.useFakeTimers();
    const expected = {
      generation: "1".repeat(32),
      pid: 4242,
      processStart: "linux:test-boot:42",
      user: "testuser",
      uid: 501,
      executablePath: "/usr/bin/node",
      scriptPath: "/opt/nemoclaw/bedrock-runtime-adapter.mts",
      adapterPort: 11_436,
      tokenHash: "a".repeat(64),
    };
    const kills: NodeJS.Signals[] = [];
    const runtime = {
      env: {} as NodeJS.ProcessEnv,
      kill: (_pid: number, signal?: NodeJS.Signals | number) => {
        kills.push(signal as NodeJS.Signals);
        return true;
      },
      readProcessArgv: () => [expected.executablePath, expected.scriptPath],
      readProcessExecutable: () => expected.executablePath,
      readProcessEnvironment: () => ({
        NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_GENERATION: expected.generation,
        NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT: String(expected.adapterPort),
      }),
      readProcessIdentity: () => expected.processStart,
      run: (_command: string, args: readonly string[]) => ({
        status: 0,
        stdout:
          args.at(-1) === "pid="
            ? `${String(expected.pid)}\n`
            : args.at(-1) === "uid="
              ? `${String(expected.uid)}\n`
              : args.at(-1) === "user="
                ? `${expected.user}\n`
                : "",
        stderr: "",
      }),
      sleep: (milliseconds: number) => vi.advanceTimersByTime(milliseconds),
    };

    expect(stopExactBedrockRuntimeAdapterProcess(expected, runtime)).toEqual({
      ok: false,
      reason: "unresolved",
    });
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not signal when the live adapter port differs from authority", () => {
    const expected = {
      generation: "1".repeat(32),
      pid: 4242,
      processStart: "linux:test-boot:42",
      user: "testuser",
      uid: 501,
      executablePath: "/usr/bin/node",
      scriptPath: "/opt/nemoclaw/bedrock-runtime-adapter.mts",
      adapterPort: 11_436,
      tokenHash: "a".repeat(64),
    };
    const kill = vi.fn(() => true);
    const runtime = {
      env: {} as NodeJS.ProcessEnv,
      kill,
      readProcessArgv: () => [expected.executablePath, expected.scriptPath],
      readProcessExecutable: () => expected.executablePath,
      readProcessEnvironment: () => ({
        NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_GENERATION: expected.generation,
        NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT: "11437",
      }),
      readProcessIdentity: () => expected.processStart,
      run: (_command: string, args: readonly string[]) => ({
        status: 0,
        stdout:
          args.at(-1) === "pid="
            ? `${String(expected.pid)}\n`
            : args.at(-1) === "uid="
              ? `${String(expected.uid)}\n`
              : args.at(-1) === "user="
                ? `${expected.user}\n`
                : "",
        stderr: "",
      }),
    };

    expect(stopExactBedrockRuntimeAdapterProcess(expected, runtime)).toEqual({
      ok: false,
      reason: "authority-drift",
    });
    expect(kill).not.toHaveBeenCalled();
  });
});
