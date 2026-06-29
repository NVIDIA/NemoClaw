// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

// execSandbox dynamically requires the OpenShell runtime adapter; stub it so the
// dispatch-path tests stay hermetic. The actual spawn is injected via the
// SandboxExecRunner parameter, so we never touch node:child_process here.
vi.mock("../../adapters/openshell/runtime", () => ({
  getOpenshellBinary: () => "openshell",
}));

import {
  buildOpenshellExecArgs,
  buildWorkdirProbeArgs,
  computeExitCode,
  evaluateWorkdirProbe,
  execSandbox,
  findMultilineExecArg,
  multilineExecMessage,
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

describe("findMultilineExecArg", () => {
  it("returns -1 when every argument is single-line", () => {
    expect(findMultilineExecArg(["bash", "-lc", "echo line1; echo line2"])).toBe(-1);
  });

  it("returns the index of the first argument containing a newline", () => {
    expect(findMultilineExecArg(["bash", "-lc", "cat <<EOF\nline1\nline2\nEOF"])).toBe(2);
  });

  it("detects a bare carriage return as well as a newline", () => {
    expect(findMultilineExecArg(["printf", "a\rb"])).toBe(1);
  });

  it("reports the earliest offending argument when several are multi-line", () => {
    expect(findMultilineExecArg(["a", "b\nc", "d\ne"])).toBe(1);
  });
});

describe("multilineExecMessage", () => {
  it("names the 1-based argument position and offers the semicolon, pipe, and script workarounds", () => {
    const message = multilineExecMessage(
      "nemoclaw",
      "bug5980test",
      ["bash", "-lc", "cat <<EOF\nline1\nEOF"],
      2,
    );
    expect(message).toContain("command argument 3");
    expect(message).toContain("contains a newline or carriage return");
    expect(message).toContain('nemoclaw bug5980test exec -- bash -lc "cmd1; cmd2"');
    expect(message).toContain("| nemoclaw bug5980test exec -- bash");
    expect(message).toContain("nemoclaw bug5980test exec -- bash <script-path>");
  });

  it("uses the active CLI name so the Hermes surface gets nemohermes guidance", () => {
    const message = multilineExecMessage("nemohermes", "alpha", ["bash", "-lc", "a\nb"], 2);
    expect(message).toContain("nemohermes alpha exec -- bash");
    expect(message).not.toContain("nemoclaw");
  });

  it("describes the argument by size without echoing its contents (avoids leaking secrets)", () => {
    // A multi-line value can carry pasted secrets; the message must never
    // reproduce its contents. Use a neutral sentinel so the secret-scanner
    // hooks do not flag the test fixture itself.
    const sensitive = "SENSITIVE_LINE_ONE\nSENSITIVE_LINE_TWO\nSENSITIVE_LINE_THREE";
    const message = multilineExecMessage("nemoclaw", "alpha", ["bash", "-lc", sensitive], 2);
    // The neutral size description appears...
    expect(message).toContain(`${sensitive.length} characters spanning 3 lines`);
    // ...but no fragment of the payload is ever printed.
    expect(message).not.toContain("SENSITIVE_LINE");
    // Each line of the rendered message is itself free of stray carriage
    // returns (the message is multi-line by design, joined with "\n").
    for (const line of message.split("\n")) {
      expect(line).not.toMatch(/\r/);
    }
  });

  it("uses singular units for a single-character single-line argument", () => {
    const message = multilineExecMessage("nemoclaw", "alpha", ["printf", "\r"], 1);
    expect(message).toContain("1 character spanning 2 lines");
  });
});

describe("execSandbox multi-line guard (#5980)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a multi-line command argument before dispatch with actionable guidance", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error(`exit:${_code}`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: 0 }));

    await expect(
      execSandbox("bug5980test", ["bash", "-lc", "cat <<EOF\nline1\nline2\nEOF"], {}, run),
    ).rejects.toThrow("exit:2");

    expect(exitSpy).toHaveBeenCalledWith(2);
    // The guard short-circuits before OpenShell is ever invoked: the injected
    // exec runner is never called and dispatch never happens.
    expect(run).not.toHaveBeenCalled();
    const printed = errSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("contains a newline or carriage return");
    expect(printed).toContain('bash -lc "cmd1; cmd2"');
  });

  it("does not reject a single-line command at the guard (the semicolon workaround proceeds to dispatch)", () => {
    // The argv forwarded to OpenShell for the reporter's confirmed single-line
    // workaround is built unchanged and carries no newline/carriage return, so
    // the guard lets it through to dispatch. (The dispatch itself is exercised
    // by the real worktree-CLI transcript on the PR, not here, because
    // execSandbox resolves the OpenShell binary via a process-exiting lookup.)
    const command = ["bash", "-lc", "echo line1; echo line2"];
    expect(findMultilineExecArg(command)).toBe(-1);
    expect(buildOpenshellExecArgs("bug5980test", command)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "bug5980test",
      "--",
      "bash",
      "-lc",
      "echo line1; echo line2",
    ]);
  });
});

describe("computeExitCode", () => {
  it("returns the remote command's status when it exits normally", () => {
    expect(computeExitCode({ status: 0 })).toEqual({ code: 0 });
    expect(computeExitCode({ status: 42 })).toEqual({ code: 42 });
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
