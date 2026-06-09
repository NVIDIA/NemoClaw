// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  captureOpenshellCommand,
  captureOpenshellCommandAsync,
  captureSandboxSshConfigCommand,
  getInstalledOpenshellVersion,
  type OpenshellSpawnSync,
  parseVersionFromText,
  runOpenshellCommand,
  stripAnsi,
  versionGte,
} from "./client";

interface SpawnResultSpec {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

function makeSpawnResult(spec: SpawnResultSpec): SpawnSyncReturns<string> {
  return {
    pid: 123,
    output: [spec.stdout, spec.stderr],
    stdout: spec.stdout,
    stderr: spec.stderr,
    status: spec.status,
    signal: spec.signal ?? null,
    error: spec.error,
  };
}

function stubSpawnSync(spec: SpawnResultSpec): OpenshellSpawnSync {
  return () => makeSpawnResult(spec);
}

function timeoutError(): Error {
  return Object.assign(new Error("spawnSync openshell ETIMEDOUT"), { code: "ETIMEDOUT" });
}

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("openshell helpers", () => {
  it("strips ANSI sequences", () => {
    expect(stripAnsi("\u001b[32mConnected\u001b[0m")).toBe("Connected");
  });

  it("parses semantic versions from CLI output", () => {
    expect(parseVersionFromText("openshell 0.0.9")).toBe("0.0.9");
    expect(parseVersionFromText("v1.2.3\n")).toBe("1.2.3");
    expect(parseVersionFromText("no version here")).toBeNull();
  });

  it("compares semantic versions", () => {
    expect(versionGte("0.0.9", "0.0.7")).toBe(true);
    expect(versionGte("0.0.7", "0.0.7")).toBe(true);
    expect(versionGte("0.0.6", "0.0.7")).toBe(false);
  });

  it("captures stdout and stderr like the legacy helper", () => {
    const result = captureOpenshellCommand("openshell", ["status"], {
      spawnSyncImpl: stubSpawnSync({
        status: 1,
        stdout: "hello\n",
        stderr: "boom\n",
      }),
    });
    expect(result).toEqual({ status: 1, output: "hello\nboom" });
  });

  it("omits stderr from capture output when ignoreError is set", () => {
    const result = captureOpenshellCommand("openshell", ["status"], {
      ignoreError: true,
      spawnSyncImpl: stubSpawnSync({
        status: 1,
        stdout: "hello\n",
        stderr: "boom\n",
      }),
    });
    expect(result).toEqual({ status: 1, output: "hello" });
  });

  it("returns the spawn result when the command succeeds", () => {
    const result = runOpenshellCommand("openshell", ["status"], {
      spawnSyncImpl: stubSpawnSync({
        status: 0,
        stdout: "ok\n",
        stderr: "",
      }),
    });
    expect(result.status).toBe(0);
  });

  it("passes timeout options through to OpenShell spawn calls", () => {
    const timeouts: Array<number | undefined> = [];
    const spawnSyncImpl: OpenshellSpawnSync = (_command, _args, options) => {
      timeouts.push(options.timeout);
      return makeSpawnResult({ status: 0, stdout: "ok\n", stderr: "" });
    };

    runOpenshellCommand("openshell", ["status"], { timeout: 4321, spawnSyncImpl });
    captureOpenshellCommand("openshell", ["status"], { timeout: 9876, spawnSyncImpl });

    expect(timeouts).toEqual([4321, 9876]);
  });

  it("returns ignored run timeouts so callers can fall back", () => {
    const result = runOpenshellCommand("openshell", ["status"], {
      ignoreError: true,
      timeout: 1,
      spawnSyncImpl: stubSpawnSync({
        status: null,
        stdout: "",
        stderr: "",
        error: timeoutError(),
        signal: "SIGTERM",
      }),
      exit: exitWithCode,
    });

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.error?.message).toContain("ETIMEDOUT");
  });

  it("returns ignored capture timeouts with timeout metadata", () => {
    const result = captureOpenshellCommand("openshell", ["sandbox", "list"], {
      ignoreError: true,
      timeout: 1,
      spawnSyncImpl: stubSpawnSync({
        status: null,
        stdout: "partial\n",
        stderr: "timeout detail\n",
        error: timeoutError(),
        signal: "SIGTERM",
      }),
      exit: exitWithCode,
    });

    expect(result).toEqual({
      status: null,
      output: "partial",
      error: expect.objectContaining({ message: expect.stringContaining("ETIMEDOUT") }),
      signal: "SIGTERM",
    });
  });

  it("verifies sandbox existence before requesting SSH config", () => {
    const calls: string[][] = [];
    const spawnSyncImpl: OpenshellSpawnSync = (_command, args) => {
      calls.push([...args]);
      if (args.join(" ") === "sandbox get alpha") {
        return makeSpawnResult({ status: 0, stdout: "alpha Ready\n", stderr: "" });
      }
      return makeSpawnResult({
        status: 0,
        stdout: "Host openshell-alpha\n",
        stderr: "",
      });
    };

    const result = captureSandboxSshConfigCommand("openshell", "alpha", { spawnSyncImpl });

    expect(result).toEqual({ status: 0, output: "Host openshell-alpha" });
    expect(calls).toEqual([
      ["sandbox", "get", "alpha"],
      ["sandbox", "ssh-config", "alpha"],
    ]);
  });

  it("does not request SSH config when the sandbox is missing", () => {
    const calls: string[][] = [];
    const spawnSyncImpl: OpenshellSpawnSync = (_command, args) => {
      calls.push([...args]);
      return makeSpawnResult({ status: 1, stdout: "", stderr: "sandbox not found\n" });
    };

    const result = captureSandboxSshConfigCommand("openshell", "bogus", { spawnSyncImpl });

    expect(result).toEqual({ status: 1, output: "sandbox 'bogus' not found" });
    expect(calls).toEqual([["sandbox", "get", "bogus"]]);
  });

  it("preserves non-NotFound sandbox lookup failures", () => {
    const calls: string[][] = [];
    const spawnSyncImpl: OpenshellSpawnSync = (_command, args) => {
      calls.push([...args]);
      return makeSpawnResult({
        status: 1,
        stdout: "",
        stderr: "transport error\nConnection refused\n",
      });
    };

    const result = captureSandboxSshConfigCommand("openshell", "alpha", { spawnSyncImpl });

    expect(result).toEqual({ status: 1, output: "transport error\nConnection refused" });
    expect(calls).toEqual([["sandbox", "get", "alpha"]]);
  });

  it("bounds async captures and reports timeout metadata", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
      "setInterval(() => {}, 1000);",
    ].join("");

    const started = Date.now();
    const result = await captureOpenshellCommandAsync(process.execPath, ["-e", script], {
      ignoreError: true,
      timeout: 50,
      killGraceMs: 10,
    });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBeNull();
    expect(result.error).toEqual(expect.objectContaining({ code: "ETIMEDOUT" }));
    expect(result.signal).toBeTruthy();
  });

  it("includes stderr in async capture output when requested", async () => {
    const result = await captureOpenshellCommandAsync(
      process.execPath,
      [
        "-e",
        "process.stdout.write('hello\\n'); process.stderr.write('boom\\n'); process.exitCode = 1;",
      ],
      { ignoreError: true, includeStderr: true },
    );

    expect(result).toEqual({ status: 1, output: "hello\nboom", signal: null });
  });

  it("uses the injected exit handler on failure", () => {
    expect(() =>
      runOpenshellCommand("openshell", ["status"], {
        spawnSyncImpl: stubSpawnSync({
          status: 17,
          stdout: "",
          stderr: "bad\n",
        }),
        errorLine: () => {},
        exit: exitWithCode,
      }),
    ).toThrow("exit:17");
  });

  it("treats run spawn failures as fatal errors", () => {
    const errors: string[] = [];
    expect(() =>
      runOpenshellCommand("openshell", ["status"], {
        spawnSyncImpl: stubSpawnSync({
          status: null,
          stdout: "",
          stderr: "",
          error: new Error("spawn EACCES"),
        }),
        errorLine: (message) => errors.push(message),
        exit: exitWithCode,
      }),
    ).toThrow("exit:1");
    expect(errors).toEqual(["  Failed to start OpenShell command: spawn EACCES"]);
  });

  it("treats capture spawn failures as fatal errors", () => {
    const errors: string[] = [];
    expect(() =>
      captureOpenshellCommand("openshell", ["status"], {
        spawnSyncImpl: stubSpawnSync({
          status: null,
          stdout: "",
          stderr: "",
          error: new Error("spawn ENOENT"),
        }),
        errorLine: (message) => errors.push(message),
        exit: exitWithCode,
      }),
    ).toThrow("exit:1");
    expect(errors).toEqual(["  Failed to start OpenShell command: spawn ENOENT"]);
  });

  it("reads the installed openshell version through the capture helper", () => {
    const version = getInstalledOpenshellVersion("openshell", {
      spawnSyncImpl: stubSpawnSync({
        status: 0,
        stdout: "openshell 0.0.11\n",
        stderr: "",
      }),
    });
    expect(version).toBe("0.0.11");
  });
});
