// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// The default exec runner shells out via spawn with stdio: "inherit"; the
// stdin-pipe workaround relies on that inheritance to deliver piped script
// content to the sandbox shell. Mock node:child_process so a single test can
// assert the inherited-stdio wiring at the execSandbox boundary without
// spawning a real process. Every other test injects a runner/probe seam, so
// this default spawn is exercised only by that one test.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

// execSandbox dynamically requires the OpenShell binary lookup, which exits the
// process when OpenShell is absent. The dispatch-path tests inject a
// resolveBinary seam (plus a runner and workdir probe) so they stay hermetic
// without spawning a real process or hitting that process-exiting lookup.
import {
  buildOpenshellExecArgs,
  execSandbox,
  findMultilineExecArg,
  multilineExecMessage,
} from "./exec";

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

  it("treats Unicode line separators (U+2028/U+2029) as single-line because OpenShell rejects only CR/LF", () => {
    // The guard deliberately mirrors OpenShell's CR/LF-only rejection, so these
    // code points are valid argv that dispatch unchanged. Broadening the guard
    // to match them would reject commands OpenShell would otherwise run.
    expect(findMultilineExecArg(["printf", "a\u2028b"])).toBe(-1);
    expect(findMultilineExecArg(["printf", "a\u2029b"])).toBe(-1);
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

  it("counts a trailing newline as a second (empty) line", () => {
    // A single trailing "\n" splits into ["first", ""], so the size description
    // reports 2 lines even though only one line carries text. This pins the
    // documented bare-CR/trailing-break counting behavior.
    const message = multilineExecMessage("nemoclaw", "alpha", ["bash", "-lc", "first\n"], 2);
    expect(message).toContain("6 characters spanning 2 lines");
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

  it("forwards the semicolon workaround to dispatch and exits with the inner status", async () => {
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

  it("forwards a Unicode line-separator argument through dispatch (OpenShell accepts U+2028/U+2029; only CR/LF are guarded)", async () => {
    // The guard mirrors OpenShell's CR/LF-only rejection, so an argument that
    // carries U+2028 passes the guard and dispatches unchanged at the
    // execSandbox boundary — confirming the documented assumption end-to-end on
    // the dispatch path, not just in findMultilineExecArg.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: 0 }));

    await expect(
      execSandbox(
        "bug5980test",
        ["printf", "a\u2028b"],
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
      "printf",
      "a\u2028b",
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

  it("rejects a multi-line command before probing --workdir (guard runs first)", async () => {
    // Ordering guarantee: when both a multi-line argv and --workdir are present,
    // the multi-line guard must exit 2 *before* the workdir probe runs, so the
    // probe is never reached and nothing is dispatched.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: 0 }));
    const probeWorkdir = vi.fn(() => ({ status: 0 }));

    await expect(
      execSandbox(
        "alpha",
        ["bash", "-lc", "printf 'a\nb'"],
        { workdir: "/workspace" },
        { run, resolveBinary: () => "openshell", probeWorkdir },
      ),
    ).rejects.toThrow("exit:2");

    expect(probeWorkdir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "contains a newline or carriage return",
    );
  });

  it("forwards the stdin-pipe workaround argv to dispatch (script travels over stdin, not argv)", async () => {
    // `printf 'cmd1\ncmd2\n' | nemoclaw <sb> exec -- bash` puts the multi-line
    // script on stdin; the forwarded argv is just `bash` (no newline), so it
    // passes the guard and dispatches. This test pins the argv shape only; the
    // adjacent "inherits stdio" test proves the runner actually forwards stdin.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: 0 }));

    await expect(
      execSandbox("bug5980test", ["bash"], {}, { run, resolveBinary: () => "openshell" }),
    ).rejects.toThrow("exit:0");

    expect(run).toHaveBeenCalledWith("openshell", [
      "sandbox",
      "exec",
      "--name",
      "bug5980test",
      "--",
      "bash",
    ]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("dispatches the default runner with inherited stdio so the stdin-pipe workaround receives piped input", async () => {
    // The argv-only test above cannot catch a regression that stops the runner
    // from inheriting stdin (#5980). Exercise the *default* runner (no injected
    // `run`) and assert the async child is spawned with stdio: "inherit", which
    // is the observable mechanism the documented `printf ... | exec -- bash`
    // workaround depends on. Only resolveBinary is injected, to avoid the
    // process-exiting OpenShell binary lookup.
    const childEvents = new EventEmitter();
    const child = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: ((event: string, listener: (...args: unknown[]) => void) =>
        childEvents.once(event, listener)) as never,
    };
    vi.mocked(spawn).mockImplementation(((): never => {
      // Resolve the runner once the close handler is registered.
      queueMicrotask(() => childEvents.emit("close", 0, null));
      return child as never;
    }) as never);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      execSandbox("bug5980test", ["bash"], {}, { resolveBinary: () => "openshell" }),
    ).rejects.toThrow("exit:0");

    expect(spawn).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "exec", "--name", "bug5980test", "--", "bash"],
      { stdio: "inherit" },
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("forwards the script-file workaround to dispatch (bash <script-path>)", async () => {
    // `nemoclaw <sb> exec -- bash <script-path>` runs a script already written
    // into the sandbox; the argv carries no newline and dispatches unchanged.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: 0 }));

    await expect(
      execSandbox(
        "bug5980test",
        ["bash", "/sandbox/run.sh"],
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
      "/sandbox/run.sh",
    ]);
    expect(exitSpy).toHaveBeenCalledWith(0);
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
