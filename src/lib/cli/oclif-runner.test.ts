// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadMock, runCommandMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  runCommandMock: vi.fn(),
}));

vi.mock("@oclif/core", () => ({
  Config: {
    load: loadMock,
  },
}));

import { runRegisteredOclifCommand } from "./oclif-runner";

function makeConfig() {
  const rootPlugin = {
    root: "/repo",
    pjson: { oclif: { bin: "nemoclaw" } },
    options: { pjson: { oclif: { bin: "nemoclaw" } } },
  };
  return {
    root: "/repo",
    bin: "nemoclaw",
    pjson: { oclif: { bin: "nemoclaw" } },
    options: { pjson: { oclif: { bin: "nemoclaw" } } },
    plugins: new Map([["root", rootPlugin]]),
    runCommand: runCommandMock,
  };
}

class NonExistentFlagsError extends Error {
  oclif = { exit: 2 };
}

class UnexpectedArgsError extends Error {
  oclif = { exit: 2 };
}

describe("runRegisteredOclifCommand", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    loadMock.mockReset();
    loadMock.mockResolvedValue(makeConfig());
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("loads the oclif config, applies branded bin metadata, and runs the command", async () => {
    const config = makeConfig();
    loadMock.mockResolvedValue(config);
    runCommandMock.mockResolvedValue(undefined);

    await runRegisteredOclifCommand("list", ["--json"], { rootDir: "/repo" });

    expect(loadMock).toHaveBeenCalledWith("/repo");
    expect(runCommandMock).toHaveBeenCalledWith("list", ["--json"]);
    expect(config.bin).toBe("nemoclaw");
    expect(config.pjson.oclif.bin).toBe("nemoclaw");
    expect(config.options.pjson.oclif.bin).toBe("nemoclaw");
    expect(config.plugins.get("root")?.pjson.oclif.bin).toBe("nemoclaw");
  });

  it("formats oclif flag parse errors and exits with the oclif exit code", async () => {
    const error = new NonExistentFlagsError("Nonexistent flag: --bogus\nSee more help");
    runCommandMock.mockRejectedValue(error);
    const errorLine = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runRegisteredOclifCommand("list", ["--bogus"], { rootDir: "/repo", error: errorLine, exit }),
    ).rejects.toThrow("exit:2");

    expect(errorLine).toHaveBeenCalledWith("  Nonexistent flag: --bogus\nSee more help");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("formats unexpected-argument parse errors", async () => {
    runCommandMock.mockRejectedValue(new UnexpectedArgsError("Unexpected argument: extra"));
    const errorLine = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runRegisteredOclifCommand("status", ["extra"], { rootDir: "/repo", error: errorLine, exit }),
    ).rejects.toThrow("exit:2");

    expect(errorLine).toHaveBeenCalledWith("  Unexpected argument: extra");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("treats oclif help exits as success", async () => {
    runCommandMock.mockRejectedValue({ oclif: { exit: 0 } });

    await runRegisteredOclifCommand("list", ["--help"], { rootDir: "/repo" });

    expect(process.exitCode).toBe(0);
  });

  it("rethrows non-parse command failures", async () => {
    const error = new Error("boom");
    runCommandMock.mockRejectedValue(error);

    await expect(runRegisteredOclifCommand("list", [], { rootDir: "/repo" })).rejects.toBe(error);
  });
});
