// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

// execSandbox dynamically requires the OpenShell binary lookup, which exits the
// process when OpenShell is absent. The dispatch-path tests inject a
// resolveBinary seam (plus a runner and workdir probe) so they stay hermetic
// without spawning a real process or hitting that process-exiting lookup.
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
      execSandbox("bug5980test", ["bash", "-lc", "cat <<EOF\nline1\nline2\nEOF"], {}, { run }),
    ).rejects.toThrow("exit:2");

    expect(exitSpy).toHaveBeenCalledWith(2);
    // The guard short-circuits before OpenShell is ever invoked: the injected
    // exec runner is never called and dispatch never happens.
    expect(run).not.toHaveBeenCalled();
    const printed = errSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("contains a newline or carriage return");
    expect(printed).toContain('bash -lc "cmd1; cmd2"');
  });

  it("forwards the single-line semicolon workaround to dispatch and exits with the inner status", async () => {
    // The reporter's confirmed workaround (`bash -lc "cmd1; cmd2"`) carries no
    // newline/carriage return, so it passes the guard and dispatches. Injecting
    // resolveBinary avoids the process-exiting OpenShell lookup, and the runner
    // returns success so we can assert the argv forwarded and the exit code.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: 0 }));

    await expect(
      execSandbox(
        "bug5980test",
        ["bash", "-lc", "echo line1; echo line2"],
        {},
        { run, resolveBinary: () => "openshell" },
      ),
    ).rejects.toThrow("exit:0");

    expect(run).toHaveBeenCalledWith("openshell", [
      "sandbox",
      "exec",
      "--name",
      "bug5980test",
      "--",
      "bash",
      "-lc",
      "echo line1; echo line2",
    ]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("still validates --workdir for a single-line command and fails with the workdir error, not the multi-line error", async () => {
    // Guard ordering: the multi-line check runs before the workdir probe. A
    // valid single-line command with a missing --workdir must surface the
    // workdir error (exit 1), proving the workdir probe still runs after the
    // guard and that the guard did not swallow the command.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: 0 }));
    const probeWorkdir = vi.fn(() => ({ status: 1 })); // `test -d` failure -> missing

    await expect(
      execSandbox(
        "alpha",
        ["bash", "-lc", "echo ok"],
        { workdir: "/no/such/dir" },
        { run, resolveBinary: () => "openshell", probeWorkdir },
      ),
    ).rejects.toThrow("exit:1");

    expect(probeWorkdir).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("does not exist inside the sandbox");
    expect(printed).not.toContain("newline or carriage return");
    // The workdir probe failed, so the command is never dispatched.
    expect(run).not.toHaveBeenCalled();
  });

  it("builds the forwarded argv unchanged for the single-line semicolon workaround", () => {
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
