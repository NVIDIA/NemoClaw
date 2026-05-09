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

  it("treats oclif graceful ExitError(0) as silent success", async () => {
    // Mirrors what `Command.exit(0)` and `--help` actually throw in oclif: an
    // ExitError instance whose synthetic `EEXIT: 0` message must NOT leak to
    // the user.
    class ExitError extends Error {
      oclif = { exit: 0 };
    }
    runCommandMock.mockRejectedValue(new ExitError("EEXIT: 0"));
    const errorLine = vi.fn();

    await runRegisteredOclifCommand("list", ["--help"], { rootDir: "/repo", error: errorLine });

    expect(process.exitCode).toBe(0);
    expect(errorLine).not.toHaveBeenCalled();
  });

  it("#2666: surfaces errors that happen to carry oclif.exit === 0 instead of swallowing them", async () => {
    // Before #2666 this branch silently set exit 0 and produced no output.
    // The bug was an arbitrary error riding the same `oclif.exit === 0`
    // channel, e.g. propagated from inside a command's run(). Surface the
    // message so the user gets signal.
    class WeirdError extends Error {
      oclif = { exit: 0 };
    }
    runCommandMock.mockRejectedValue(new WeirdError("Could not verify sandbox 'my-assist' against the live OpenShell gateway"));
    const errorLine = vi.fn();

    await runRegisteredOclifCommand("status", ["my-assist"], { rootDir: "/repo", error: errorLine });

    expect(process.exitCode).toBe(0);
    expect(errorLine).toHaveBeenCalledWith(
      "  Could not verify sandbox 'my-assist' against the live OpenShell gateway",
    );
  });

  it("#2666: falls back to a generic line when the error message is empty", async () => {
    // Closes the residual silent path: if a non-ExitError(0) carries an
    // empty message (or one that trims to empty), still emit *something*
    // so the user is never left looking at exit 0 + blank stdout/stderr.
    class BlankError extends Error {
      oclif = { exit: 0 };
    }
    runCommandMock.mockRejectedValue(new BlankError(""));
    const errorLine = vi.fn();

    await runRegisteredOclifCommand("status", ["my-assist"], { rootDir: "/repo", error: errorLine });

    expect(process.exitCode).toBe(0);
    expect(errorLine).toHaveBeenCalledOnce();
    const [line] = errorLine.mock.calls[0];
    expect(String(line).trim().length).toBeGreaterThan(0);
  });

  it("rethrows non-parse command failures", async () => {
    const error = new Error("boom");
    runCommandMock.mockRejectedValue(error);

    await expect(runRegisteredOclifCommand("list", [], { rootDir: "/repo" })).rejects.toBe(error);
  });

  it("exits cleanly without rethrowing when oclif Command.exit(code) bubbles up", async () => {
    // NCQ #3180: throwing an ExitError out of the runner leaks a raw
    // @oclif/core stack trace to the user. Treat any non-zero ExitError
    // (carrying `oclif.exit`) as a graceful exit with that code.
    class ExitError extends Error {
      oclif = { exit: 1 };
    }
    runCommandMock.mockRejectedValue(new ExitError("EEXIT: 1"));
    const errorLine = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runRegisteredOclifCommand("sandbox:gateway:token", ["hermes"], {
        rootDir: "/repo",
        error: errorLine,
        exit,
      }),
    ).rejects.toThrow("exit:1");

    expect(errorLine).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("rethrows other oclif error classes that carry oclif.exit", async () => {
    // RequiredArgsError and friends ride the same `oclif.exit` channel as
    // ExitError but carry a user-visible message that oclif's own handler
    // is responsible for printing. Don't swallow those.
    class RequiredArgsError extends Error {
      oclif = { exit: 2 };
    }
    const error = new RequiredArgsError("Missing 1 required arg: path");
    runCommandMock.mockRejectedValue(error);

    await expect(runRegisteredOclifCommand("skill:install", [], { rootDir: "/repo" })).rejects.toBe(
      error,
    );
  });
});
