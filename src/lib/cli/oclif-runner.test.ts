// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { flushMock, handleMock, loadMock, runCommandMock, runMock } = vi.hoisted(() => ({
  flushMock: vi.fn(),
  handleMock: vi.fn(),
  loadMock: vi.fn(),
  runCommandMock: vi.fn(),
  runMock: vi.fn(),
}));

vi.mock("@oclif/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oclif/core")>();
  return {
    ...actual,
    Config: { load: loadMock },
    flush: flushMock,
    handle: handleMock,
    run: runMock,
  };
});

import * as receiptAuthority from "../onboard/experimental/hermes-portable-receipt";
import { NemoClawCommand } from "./nemoclaw-oclif-command";
import { runOclifArgv, runOclifCommandById } from "./oclif-runner";
import { PUBLIC_HELP_SANDBOX_NAME_PROPERTY } from "./public-help";

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

class RunnerUnsupportedCommand extends NemoClawCommand {
  static id = "sandbox:destroy";
  static ran = false;

  public async run(): Promise<void> {
    RunnerUnsupportedCommand.ran = true;
  }
}

function useHermesPortableAuthority(): void {
  const authority = {
    kind: "hermes",
    snapshot: { receipt: { phase: "active" } } as never,
  } as const;
  vi.spyOn(receiptAuthority, "inspectPortableAgentReceiptAuthority").mockReturnValue(authority);
  vi.spyOn(
    receiptAuthority,
    "inspectPortableAgentReceiptAuthorityForClassification",
  ).mockReturnValue(authority);
}

describe("Hermes portable command admission through both oclif runners", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oclif-runner-"));
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
    flushMock.mockReset();
    handleMock.mockReset();
    loadMock.mockReset();
    runCommandMock.mockReset();
    runMock.mockReset();
    loadMock.mockResolvedValue(makeConfig());
    RunnerUnsupportedCommand.ran = false;
    process.exitCode = undefined;
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it("rejects direct command-id execution before the raw action body (#9203)", async () => {
    useHermesPortableAuthority();
    runCommandMock.mockImplementation(() => RunnerUnsupportedCommand.run(["alpha"], process.cwd()));

    await expect(
      runOclifCommandById("sandbox:destroy", ["alpha"], { rootDir: "/repo" }),
    ).rejects.toThrow("not supported for an experimental Hermes portable sandbox");
    expect(RunnerUnsupportedCommand.ran).toBe(false);
  });

  it("rejects native argv execution before the raw action body (#9203)", async () => {
    useHermesPortableAuthority();
    runMock.mockImplementation(() => RunnerUnsupportedCommand.run(["alpha"], process.cwd()));

    await runOclifArgv(["sandbox", "destroy", "alpha"], { rootDir: "/repo" });

    expect(RunnerUnsupportedCommand.ran).toBe(false);
    expect(handleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "not supported for an experimental Hermes portable sandbox",
        ),
      }),
    );
  });

  it("preserves native raw-argv help without action admission (#9203)", async () => {
    useHermesPortableAuthority();
    runMock.mockImplementation(() =>
      RunnerUnsupportedCommand.run(["alpha", "--help"], process.cwd()),
    );

    await runOclifArgv(["sandbox", "destroy", "alpha", "--help"], { rootDir: "/repo" });

    expect(RunnerUnsupportedCommand.ran).toBe(true);
    expect(handleMock).not.toHaveBeenCalled();
  });
});

describe("runOclifArgv", () => {
  let originalArgv: string[];

  beforeEach(() => {
    flushMock.mockReset();
    handleMock.mockReset();
    loadMock.mockReset();
    runCommandMock.mockReset();
    runMock.mockReset();
    loadMock.mockResolvedValue(makeConfig());
    originalArgv = process.argv;
    process.argv = ["/usr/bin/node", "/repo/bin/nemoclaw.js", "alpha", "status"];
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
  });

  it("executes native oclif argv with branded package metadata", async () => {
    const config = makeConfig();
    loadMock.mockResolvedValue(config);
    runMock.mockImplementation(async () => {
      expect(process.argv).toEqual([
        "/usr/bin/node",
        "/repo/bin/nemoclaw.js",
        "sandbox",
        "channels",
        "start",
        "--help",
      ]);
    });

    await runOclifArgv(["sandbox", "channels", "start", "--help"], {
      rootDir: "/repo",
      publicSandboxName: "alpha",
    });

    expect(process.argv).toEqual(["/usr/bin/node", "/repo/bin/nemoclaw.js", "alpha", "status"]);

    expect(loadMock).toHaveBeenCalledWith("/repo");
    expect(runMock).toHaveBeenCalledWith(["sandbox", "channels", "start", "--help"], {
      root: "/repo",
      pjson: config.pjson,
    });
    expect(flushMock).toHaveBeenCalled();
    expect(handleMock).not.toHaveBeenCalled();
    expect(config.pjson.oclif.bin).toBe("nemoclaw");
    expect(config.options.pjson.oclif.bin).toBe("nemoclaw");
    expect(config.plugins.get("root")?.pjson.oclif.bin).toBe("nemoclaw");
    expect((config.pjson.oclif as Record<string, unknown>)[PUBLIC_HELP_SANDBOX_NAME_PROPERTY]).toBe(
      "alpha",
    );
    expect(
      (config.plugins.get("root")?.pjson.oclif as Record<string, unknown>)[
        PUBLIC_HELP_SANDBOX_NAME_PROPERTY
      ],
    ).toBe("alpha");
  });

  it("delegates ordinary native-route failures to oclif's handler and restores argv", async () => {
    const error = new Error("Missing 1 required arg: channel");
    runMock.mockImplementation(async () => {
      expect(process.argv).toEqual([
        "/usr/bin/node",
        "/repo/bin/nemoclaw.js",
        "sandbox",
        "channels",
        "add",
        "alpha",
      ]);
      throw error;
    });

    await runOclifArgv(["sandbox", "channels", "add", "alpha"], { rootDir: "/repo" });

    // oclif's handle() owns pretty-printing and process exit for ordinary
    // failures (it never returns control for a real error), so we just forward.
    expect(handleMock).toHaveBeenCalledWith(error);
    expect(process.argv).toEqual(["/usr/bin/node", "/repo/bin/nemoclaw.js", "alpha", "status"]);
  });

  it("forces a non-zero exit for native-route errors riding oclif.exit === 0 (#5974)", async () => {
    // oclif's handle() would Exit.exit(0) for this error, silently reporting
    // success on the native `internal`/`sandbox` routes. The native path must
    // mirror runOclifCommandById: surface the message and exit non-zero, never
    // delegating to handle() (which would exit 0).
    class WeirdError extends Error {
      oclif = { exit: 0 };
    }
    runMock.mockRejectedValue(new WeirdError("sandbox transport closed unexpectedly"));
    const errorLine = vi.fn();

    await runOclifArgv(["sandbox", "list"], { rootDir: "/repo", error: errorLine });

    expect(process.exitCode).toBe(1);
    expect(errorLine).toHaveBeenCalledWith("  sandbox transport closed unexpectedly");
    expect(handleMock).not.toHaveBeenCalled();
    expect(process.argv).toEqual(["/usr/bin/node", "/repo/bin/nemoclaw.js", "alpha", "status"]);
  });

  it("falls back to a generic line for blank-message native-route oclif.exit === 0 errors (#5974)", async () => {
    class BlankError extends Error {
      oclif = { exit: 0 };
    }
    runMock.mockRejectedValue(new BlankError(""));
    const errorLine = vi.fn();

    await runOclifArgv(["sandbox", "list"], { rootDir: "/repo", error: errorLine });

    expect(process.exitCode).toBe(1);
    expect(errorLine).toHaveBeenCalledOnce();
    const [line] = errorLine.mock.calls[0];
    expect(String(line).trim().length).toBeGreaterThan(0);
    expect(handleMock).not.toHaveBeenCalled();
  });

  it("keeps a genuine native-route ExitError(0) as a graceful exit (#5974)", async () => {
    // Command.exit(0) / --help on the native route must stay silent and
    // delegate to oclif's handler, which performs the graceful exit 0.
    // This mocks handleOclif to assert delegation; the runtime counterpart
    // (real `nemoclaw sandbox --help` → exit 0 through the actual binary) is
    // locked by test/cli/exit-code-user-error-surfaces.test.ts
    // ("a native-route --help stays a clean exit 0").
    class ExitError extends Error {
      oclif = { exit: 0 };
    }
    const exitError = new ExitError("EEXIT: 0");
    runMock.mockRejectedValue(exitError);
    const errorLine = vi.fn();

    await runOclifArgv(["sandbox", "list"], { rootDir: "/repo", error: errorLine });

    expect(errorLine).not.toHaveBeenCalled();
    // The runner must NOT force a failure code here — handle() owns the
    // graceful exit 0 for a genuine ExitError(0).
    expect(process.exitCode).toBeUndefined();
    expect(handleMock).toHaveBeenCalledWith(exitError);
  });
});

describe("runOclifCommandById", () => {
  let originalArgv: string[];

  beforeEach(() => {
    flushMock.mockReset();
    handleMock.mockReset();
    runCommandMock.mockReset();
    loadMock.mockReset();
    loadMock.mockResolvedValue(makeConfig());
    originalArgv = process.argv;
    process.argv = ["/usr/bin/node", "/repo/bin/nemoclaw.js", "alpha", "status"];
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = originalArgv;
    process.exitCode = undefined;
  });

  it("loads the oclif config, applies branded bin metadata, and runs the command", async () => {
    const config = makeConfig();
    loadMock.mockResolvedValue(config);
    runCommandMock.mockImplementation(async () => {
      expect(process.argv).toEqual(["/usr/bin/node", "/repo/bin/nemoclaw.js", "list", "--json"]);
    });

    await runOclifCommandById("list", ["--json"], {
      rootDir: "/repo",
      publicSandboxName: "alpha",
    });

    expect(process.argv).toEqual(["/usr/bin/node", "/repo/bin/nemoclaw.js", "alpha", "status"]);
    expect(loadMock).toHaveBeenCalledWith("/repo");
    expect(runCommandMock).toHaveBeenCalledWith("list", ["--json"]);
    expect(config.bin).toBe("nemoclaw");
    expect(config.pjson.oclif.bin).toBe("nemoclaw");
    expect(config.options.pjson.oclif.bin).toBe("nemoclaw");
    expect(config.plugins.get("root")?.pjson.oclif.bin).toBe("nemoclaw");
    expect((config.pjson.oclif as Record<string, unknown>)[PUBLIC_HELP_SANDBOX_NAME_PROPERTY]).toBe(
      "alpha",
    );
    expect(
      (config.plugins.get("root")?.pjson.oclif as Record<string, unknown>)[
        PUBLIC_HELP_SANDBOX_NAME_PROPERTY
      ],
    ).toBe("alpha");
  });

  it("formats oclif flag parse errors and exits with the oclif exit code", async () => {
    const error = new NonExistentFlagsError("Nonexistent flag: --bogus\nSee more help");
    runCommandMock.mockRejectedValue(error);
    const errorLine = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runOclifCommandById("list", ["--bogus"], { rootDir: "/repo", error: errorLine, exit }),
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
      runOclifCommandById("status", ["extra"], { rootDir: "/repo", error: errorLine, exit }),
    ).rejects.toThrow("exit:2");

    expect(errorLine).toHaveBeenCalledWith("  Unexpected argument: extra");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("formats an invalid enum flag value instead of rethrowing it (#8123)", async () => {
    class FlagInvalidOptionError extends Error {
      oclif = { exit: 2 };
      parse = {};
      showHelp = false;
    }
    runCommandMock.mockRejectedValue(
      new FlagInvalidOptionError(
        "Expected --reasoning-effort=ultra to be one of: low, medium, high, default\nSee more help with --help",
      ),
    );
    const errorLine = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runOclifCommandById("inference:set", ["--reasoning-effort", "ultra"], {
        rootDir: "/repo",
        error: errorLine,
        exit,
      }),
    ).rejects.toThrow("exit:2");

    expect(errorLine).toHaveBeenCalledWith(
      "  Expected --reasoning-effort=ultra to be one of: low, medium, high, default\nSee more help with --help",
    );
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("formats an invalid enum argument value instead of rethrowing it (#8123)", async () => {
    class ArgInvalidOptionError extends Error {
      oclif = { exit: 2 };
      parse = {};
      showHelp = false;
    }
    runCommandMock.mockRejectedValue(
      new ArgInvalidOptionError("Expected powershell to be one of: bash, zsh, fish"),
    );
    const errorLine = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runOclifCommandById("completion", ["powershell"], {
        rootDir: "/repo",
        error: errorLine,
        exit,
      }),
    ).rejects.toThrow("exit:2");

    expect(errorLine).toHaveBeenCalledWith("  Expected powershell to be one of: bash, zsh, fish");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("recognizes a parse error by shape when its class name is unknown (#8123)", async () => {
    class SomeLaterParserError extends Error {
      oclif = { exit: 2 };
      parse = {};
      showHelp = true;
    }
    runCommandMock.mockRejectedValue(new SomeLaterParserError("A parser rule rejected the input"));
    const errorLine = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runOclifCommandById("list", ["--json"], { rootDir: "/repo", error: errorLine, exit }),
    ).rejects.toThrow("exit:2");

    expect(errorLine).toHaveBeenCalledWith("  A parser rule rejected the input");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("keeps rethrowing a command failure that carries an unrelated parse property (#8123)", async () => {
    class CommandFailure extends Error {
      oclif = { exit: 2 };
      parse = { source: "sandboxes.json" };
    }
    const error = new CommandFailure("Could not read the sandbox registry");
    runCommandMock.mockRejectedValue(error);
    const errorLine = vi.fn();

    await expect(
      runOclifCommandById("list", [], { rootDir: "/repo", error: errorLine }),
    ).rejects.toBe(error);
    expect(errorLine).not.toHaveBeenCalled();
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

    await runOclifCommandById("list", ["--help"], { rootDir: "/repo", error: errorLine });

    expect(process.exitCode).toBe(0);
    expect(errorLine).not.toHaveBeenCalled();
  });

  it("surfaces AND fails on errors that merely carry oclif.exit === 0 (#2666, #5974)", async () => {
    // #2666 stopped this branch silently swallowing an arbitrary error that
    // rode the same `oclif.exit === 0` channel (e.g. propagated from inside a
    // command's run()) — but it still reported success. #5974: such an error
    // is a genuine failure, so surface the message AND exit non-zero so `$?`
    // stays scriptable. Only a real oclif ExitError(0) stays exit 0.
    class WeirdError extends Error {
      oclif = { exit: 0 };
    }
    runCommandMock.mockRejectedValue(
      new WeirdError("Could not verify sandbox 'my-assist' against the live OpenShell gateway"),
    );
    const errorLine = vi.fn();

    await runOclifCommandById("status", ["my-assist"], { rootDir: "/repo", error: errorLine });

    expect(process.exitCode).toBe(1);
    expect(errorLine).toHaveBeenCalledWith(
      "  Could not verify sandbox 'my-assist' against the live OpenShell gateway",
    );
  });

  it("falls back to a generic line and still fails when the message is empty (#2666, #5974)", async () => {
    // Closes the residual silent path: if a non-ExitError(0) carries an
    // empty message (or one that trims to empty), still emit *something* and
    // exit non-zero so the user is never left looking at exit 0 + blank
    // stdout/stderr.
    class BlankError extends Error {
      oclif = { exit: 0 };
    }
    runCommandMock.mockRejectedValue(new BlankError(""));
    const errorLine = vi.fn();

    await runOclifCommandById("status", ["my-assist"], { rootDir: "/repo", error: errorLine });

    expect(process.exitCode).toBe(1);
    expect(errorLine).toHaveBeenCalledOnce();
    const [line] = errorLine.mock.calls[0];
    expect(String(line).trim().length).toBeGreaterThan(0);
  });

  it("rethrows non-parse command failures", async () => {
    const error = new Error("boom");
    runCommandMock.mockImplementation(async () => {
      expect(process.argv).toEqual(["/usr/bin/node", "/repo/bin/nemoclaw.js", "list"]);
      throw error;
    });

    await expect(runOclifCommandById("list", [], { rootDir: "/repo" })).rejects.toBe(error);
    expect(process.argv).toEqual(["/usr/bin/node", "/repo/bin/nemoclaw.js", "alpha", "status"]);
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
      runOclifCommandById("sandbox:gateway:token", ["hermes"], {
        rootDir: "/repo",
        error: errorLine,
        exit,
      }),
    ).rejects.toThrow("exit:1");

    expect(errorLine).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("formats required-argument parse errors and exits with the oclif exit code", async () => {
    class RequiredArgsError extends Error {
      oclif = { exit: 2 };
    }
    const error = new RequiredArgsError("Missing 1 required arg: path");
    runCommandMock.mockRejectedValue(error);
    const errorLine = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runOclifCommandById("skill:install", [], { rootDir: "/repo", error: errorLine, exit }),
    ).rejects.toThrow("exit:2");

    expect(errorLine).toHaveBeenCalledWith("  Missing 1 required arg: path");
    expect(exit).toHaveBeenCalledWith(2);
  });
});
