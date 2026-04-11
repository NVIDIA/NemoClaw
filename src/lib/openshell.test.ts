// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  captureOpenshellCommand,
  getInstalledOpenshellVersion,
  parseVersionFromText,
  runOpenshellCommand,
  stripAnsi,
  versionGte,
} from "./openshell";

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
      spawnSyncImpl: (() => ({
        status: 1,
        stdout: "hello\n",
        stderr: "boom\n",
      })) as never,
    });
    expect(result).toEqual({ status: 1, output: "hello\nboom" });
  });

  it("omits stderr from capture output when ignoreError is set", () => {
    const result = captureOpenshellCommand("openshell", ["status"], {
      ignoreError: true,
      spawnSyncImpl: (() => ({
        status: 1,
        stdout: "hello\n",
        stderr: "boom\n",
      })) as never,
    });
    expect(result).toEqual({ status: 1, output: "hello" });
  });

  it("returns the spawn result when the command succeeds", () => {
    const result = runOpenshellCommand("openshell", ["status"], {
      spawnSyncImpl: (() => ({
        status: 0,
        stdout: "ok\n",
        stderr: "",
      })) as never,
    });
    expect(result.status).toBe(0);
  });

  it("uses the injected exit handler on failure", () => {
    expect(() =>
      runOpenshellCommand("openshell", ["status"], {
        spawnSyncImpl: (() => ({
          status: 17,
          stdout: "",
          stderr: "bad\n",
        })) as never,
        errorLine: () => {},
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).toThrow("exit:17");
  });

  it("treats run spawn failures as fatal errors", () => {
    const errors: string[] = [];
    expect(() =>
      runOpenshellCommand("openshell", ["status"], {
        spawnSyncImpl: (() => ({
          status: null,
          stdout: "",
          stderr: "",
          error: new Error("spawn EACCES"),
        })) as never,
        errorLine: (message) => errors.push(message),
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).toThrow("exit:1");
    expect(errors).toEqual(["  Failed to start openshell status: spawn EACCES"]);
  });

  it("treats capture spawn failures as fatal errors", () => {
    const errors: string[] = [];
    expect(() =>
      captureOpenshellCommand("openshell", ["status"], {
        spawnSyncImpl: (() => ({
          status: null,
          stdout: "",
          stderr: "",
          error: new Error("spawn ENOENT"),
        })) as never,
        errorLine: (message) => errors.push(message),
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).toThrow("exit:1");
    expect(errors).toEqual(["  Failed to start openshell status: spawn ENOENT"]);
  });

  it("reads the installed openshell version through the capture helper", () => {
    const version = getInstalledOpenshellVersion("openshell", {
      spawnSyncImpl: (() => ({
        status: 0,
        stdout: "openshell 0.0.11\n",
        stderr: "",
      })) as never,
    });
    expect(version).toBe("0.0.11");
  });
});
