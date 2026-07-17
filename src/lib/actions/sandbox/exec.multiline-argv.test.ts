// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// The default exec runner shells out via spawn and chooses whether to inherit
// or ignore stdin. Mock node:child_process so the tests can assert that wiring
// at the execSandbox boundary without spawning a real process. Every other test
// injects a runner/probe seam.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { buildOpenshellExecArgs, execSandbox, wrapExecCommandWithRuntimeEnv } from "./exec";

function expectedExecArgs(sandboxName: string, command: readonly string[]): string[] {
  return buildOpenshellExecArgs(sandboxName, wrapExecCommandWithRuntimeEnv(command));
}

function exitWithCode(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
}

describe("execSandbox multi-line argv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "LF",
      command: ["python3", "-c", "print('one')\nprint('two')"],
    },
    {
      label: "CR",
      command: ["python3", "-c", "one\rtwo"],
    },
    {
      label: "CRLF",
      command: ["python3", "-c", "print('one')\r\nprint('two')"],
    },
    {
      label: "embedded single and double quotes",
      command: ["python3", "-c", 'print("it\'s byte-exact")\nprint(\'a \\"quote\\"\')'],
    },
    {
      label: "heredoc",
      command: ["bash", "-lc", "cat <<'EOF'\nline one\nline 'two'\nEOF"],
    },
  ])("forwards $label bytes unchanged through the OpenShell argv boundary", async ({ command }) => {
    const exitSpy = exitWithCode();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn((_binary: string, _args: readonly string[]) => ({ status: 0 }));

    await expect(
      execSandbox("multiline-test", command, {}, { run, resolveBinary: () => "openshell" }),
    ).rejects.toThrow("exit:0");

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("openshell", expectedExecArgs("multiline-test", command));
    const forwarded = vi.mocked(run).mock.calls[0][1];
    expect(forwarded.slice(-command.length)).toEqual(command);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("still rejects a NUL-bearing command argument before dispatch", async () => {
    const exitSpy = exitWithCode();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: 0 }));

    await expect(execSandbox("multiline-test", ["printf", "a\0b"], {}, { run })).rejects.toThrow(
      "exit:2",
    );

    expect(run).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      "error: command argument 2 contains a NUL byte, which OpenShell exec does not accept",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it.each([
    "/sandbox/line-one\nline-two",
    "/sandbox/line-one\rline-two",
    "/sandbox/line-one\r\nline-two",
  ])("still rejects a multi-line --workdir before probing or dispatch: %j", async (workdir) => {
    const exitSpy = exitWithCode();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const probeWorkdir = vi.fn(() => ({ status: 0 }));
    const run = vi.fn(() => ({ status: 0 }));

    await expect(
      execSandbox(
        "multiline-test",
        ["pwd"],
        { workdir },
        { run, resolveBinary: () => "openshell", probeWorkdir },
      ),
    ).rejects.toThrow("exit:2");

    expect(probeWorkdir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      "error: --workdir must not contain newlines or carriage returns",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("still rejects a NUL-bearing --workdir before probing or dispatch", async () => {
    const exitSpy = exitWithCode();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const probeWorkdir = vi.fn(() => ({ status: 0 }));
    const run = vi.fn(() => ({ status: 0 }));

    await expect(
      execSandbox(
        "multiline-test",
        ["pwd"],
        { workdir: "/sandbox/a\0b" },
        { run, resolveBinary: () => "openshell", probeWorkdir },
      ),
    ).rejects.toThrow("exit:2");

    expect(probeWorkdir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith("error: --workdir must not contain NUL bytes");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("does not populate OpenShell's separately validated request-environment field", () => {
    const argv = buildOpenshellExecArgs("multiline-test", ["printf", "line one\nline two"]);

    // NemoClaw's public exec surface has no request-environment option. Runtime
    // metadata is sourced inside the command wrapper, so allowing line breaks
    // in command argv cannot broaden OpenShell's environment-value contract.
    expect(argv).not.toContain("--env");
    expect(argv.slice(-2)).toEqual(["printf", "line one\nline two"]);
  });

  it("still validates a single-line --workdir before dispatch", async () => {
    const exitSpy = exitWithCode();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const probeWorkdir = vi.fn(() => ({ status: 1 }));
    const run = vi.fn(() => ({ status: 0 }));

    await expect(
      execSandbox(
        "multiline-test",
        ["pwd"],
        { workdir: "/no/such/dir" },
        { run, resolveBinary: () => "openshell", probeWorkdir },
      ),
    ).rejects.toThrow("exit:1");

    expect(probeWorkdir).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      "error: --workdir: /no/such/dir does not exist inside the sandbox",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([
    { label: "inherits stdin after explicit --stdin", stdin: true, expectedStdio: "inherit" },
    {
      label: "closes stdin after explicit --no-stdin",
      stdin: false,
      expectedStdio: ["ignore", "inherit", "inherit"],
    },
  ])("dispatches the default runner and $label", async ({ stdin, expectedStdio }) => {
    const childEvents = new EventEmitter();
    const child = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: ((event: string, listener: (...args: unknown[]) => void) =>
        childEvents.once(event, listener)) as never,
    };
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(((): never => {
      queueMicrotask(() => childEvents.emit("close", 0, null));
      return child as never;
    }) as never);
    const exitSpy = exitWithCode();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      execSandbox("multiline-test", ["bash"], { stdin }, { resolveBinary: () => "openshell" }),
    ).rejects.toThrow("exit:0");

    expect(spawn).toHaveBeenCalledWith("openshell", expectedExecArgs("multiline-test", ["bash"]), {
      stdio: expectedStdio,
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
