// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOpenshellExecArgs,
  buildWorkdirProbeArgs,
  computeExitCode,
  evaluateWorkdirProbe,
  validateWorkdirOrFail,
  workdirMissingMessage,
} from "./exec";

describe("buildOpenshellExecArgs", () => {
  it("targets the sandbox by name and forwards the user command after --", () => {
    expect(
      buildOpenshellExecArgs("my-assistant", ["openclaw", "agent", "--agent", "main", "-m", "hi"]),
    ).toEqual([
      "sandbox",
      "exec",
      "--name",
      "my-assistant",
      "--",
      "openclaw",
      "agent",
      "--agent",
      "main",
      "-m",
      "hi",
    ]);
  });

  it("places --workdir before the command separator", () => {
    expect(
      buildOpenshellExecArgs("alpha", ["ls", "-la"], { workdir: "/sandbox/workspace" }),
    ).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--workdir",
      "/sandbox/workspace",
      "--",
      "ls",
      "-la",
    ]);
  });

  it("emits --tty when tty is explicitly true and --no-tty when false", () => {
    expect(buildOpenshellExecArgs("alpha", ["hostname"], { tty: true })).toContain("--tty");
    expect(buildOpenshellExecArgs("alpha", ["hostname"], { tty: false })).toContain("--no-tty");
  });

  it("omits the tty flag entirely when tty is null or undefined (auto-detect)", () => {
    const auto = buildOpenshellExecArgs("alpha", ["hostname"], { tty: null });
    expect(auto).not.toContain("--tty");
    expect(auto).not.toContain("--no-tty");
    const omitted = buildOpenshellExecArgs("alpha", ["hostname"]);
    expect(omitted).not.toContain("--tty");
    expect(omitted).not.toContain("--no-tty");
  });

  it("forwards --timeout as a stringified integer", () => {
    expect(buildOpenshellExecArgs("alpha", ["sleep", "1"], { timeoutSeconds: 30 })).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--timeout",
      "30",
      "--",
      "sleep",
      "1",
    ]);
  });

  it("preserves an empty user command (caller is responsible for guarding)", () => {
    expect(buildOpenshellExecArgs("alpha", [])).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
    ]);
  });

  it("does not interpolate the sandbox name into argv strings", () => {
    const argv = buildOpenshellExecArgs("name; rm -rf /", ["echo", "ok"]);
    expect(argv).toContain("name; rm -rf /");
    expect(argv).toEqual(["sandbox", "exec", "--name", "name; rm -rf /", "--", "echo", "ok"]);
  });
});

describe("computeExitCode", () => {
  it("returns the remote command's status when it exits normally", () => {
    expect(computeExitCode({ status: 0 })).toEqual({ code: 0 });
    expect(computeExitCode({ status: 42 })).toEqual({ code: 42 });
  });

  it("translates a terminating signal into 128 + signal number", () => {
    expect(computeExitCode({ status: null, signal: "SIGTERM" })).toEqual({ code: 128 + 15 });
    expect(computeExitCode({ status: null, signal: "SIGKILL" })).toEqual({ code: 128 + 9 });
  });

  it("falls back to 1 when the signal is unknown to os.constants.signals", () => {
    expect(computeExitCode({ status: null, signal: "SIGBOGUS" as NodeJS.Signals })).toEqual({
      code: 1,
    });
  });

  it("falls back to 1 when neither status nor signal is set", () => {
    expect(computeExitCode({ status: null })).toEqual({ code: 1 });
    expect(computeExitCode({ status: null, signal: null })).toEqual({ code: 1 });
  });

  it("surfaces spawn transport errors with the error message and code 1", () => {
    const error = new Error("openshell: command not found");
    expect(computeExitCode({ status: null, error })).toEqual({
      code: 1,
      errorMessage: "openshell: command not found",
    });
  });
});

describe("buildWorkdirProbeArgs", () => {
  it("targets the sandbox by name and probes the directory with test -d", () => {
    expect(buildWorkdirProbeArgs("alpha", "/sandbox/workspace")).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "test",
      "-d",
      "/sandbox/workspace",
    ]);
  });

  it("does not split a path argument that contains whitespace", () => {
    const argv = buildWorkdirProbeArgs("alpha", "/sandbox/with spaces/dir");
    expect(argv[argv.length - 1]).toBe("/sandbox/with spaces/dir");
  });
});

describe("workdirMissingMessage", () => {
  it("renders a user-facing CLI error with the offending path", () => {
    expect(workdirMissingMessage("/sandbox/workspace")).toBe(
      "error: --workdir: /sandbox/workspace does not exist inside the sandbox",
    );
  });
});

describe("evaluateWorkdirProbe", () => {
  it("returns 'ok' when the probe exits 0", () => {
    expect(evaluateWorkdirProbe({ status: 0 })).toBe("ok");
  });

  it("returns 'missing' only for the canonical test -d failure (exit 1)", () => {
    expect(evaluateWorkdirProbe({ status: 1 })).toBe("missing");
  });

  it("returns 'unclear' for any other exit code so the main exec surfaces it", () => {
    expect(evaluateWorkdirProbe({ status: 2 })).toBe("unclear");
    expect(evaluateWorkdirProbe({ status: 127 })).toBe("unclear");
    expect(evaluateWorkdirProbe({ status: null })).toBe("unclear");
  });

  it("returns 'unclear' when spawn reports a transport error", () => {
    expect(evaluateWorkdirProbe({ status: null, error: new Error("ENOENT") })).toBe("unclear");
  });
});

describe("validateWorkdirOrFail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes through when the directory exists", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("process.exit should not be called for ok outcome");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    validateWorkdirOrFail("openshell", "alpha", "/sandbox/workspace", run);

    expect(run).toHaveBeenCalledWith("openshell", [
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "test",
      "-d",
      "/sandbox/workspace",
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("prints a friendly error and exits 1 when the directory is missing", () => {
    const run = vi.fn(() => ({ status: 1 }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => validateWorkdirOrFail("openshell", "alpha", "/sandbox/workspace", run)).toThrow(
      "exit",
    );
    expect(errSpy).toHaveBeenCalledWith(
      "error: --workdir: /sandbox/workspace does not exist inside the sandbox",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not abort when the probe outcome is unclear (lets main exec surface it)", () => {
    const run = vi.fn(() => ({ status: 127 }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("process.exit should not be called for unclear outcome");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    validateWorkdirOrFail("openshell", "alpha", "/sandbox/workspace", run);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });
});
