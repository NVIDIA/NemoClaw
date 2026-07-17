// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSandboxMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/actions/sandbox/exec", () => ({
  execSandbox: execSandboxMock,
}));

import { log } from "../../lib/cli/logger";
import SandboxExecCommand from "./exec";

const rootDir = process.cwd();

describe("SandboxExecCommand oclif parse path", () => {
  beforeEach(() => {
    execSandboxMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards everything after -- as the inner command argv", async () => {
    await SandboxExecCommand.run(
      ["alpha", "--", "openclaw", "agent", "--agent", "main", "-m", "hi"],
      rootDir,
    );
    expect(execSandboxMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "main", "-m", "hi"],
      { workdir: undefined, tty: null, timeoutSeconds: undefined, stdin: undefined },
    );
  });

  it("does not assign host meaning to logging flags after --", async () => {
    const configure = vi.spyOn(log, "configure").mockImplementation(() => undefined);

    await SandboxExecCommand.run(["alpha", "--", "agent-cli", "--debug", "--quiet"], rootDir);

    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["agent-cli", "--debug", "--quiet"], {
      workdir: undefined,
      tty: null,
      timeoutSeconds: undefined,
    });
    expect(configure).toHaveBeenCalledWith({ debug: false, quiet: false });
    expect(configure).not.toHaveBeenCalledWith({ debug: true, quiet: false });
    expect(configure).not.toHaveBeenCalledWith({ debug: false, quiet: true });
  });

  it("preserves repeated flag/value pairs after -- in their original order", async () => {
    await SandboxExecCommand.run(
      [
        "alpha",
        "--",
        "env",
        "-u",
        "ALL_PROXY",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "HTTP_PROXY",
        "-u",
        "all_proxy",
        "-u",
        "https_proxy",
        "-u",
        "http_proxy",
        "/opt/venv/bin/python3",
        "-I",
        "-c",
        "pass",
      ],
      rootDir,
    );
    expect(execSandboxMock).toHaveBeenCalledWith(
      "alpha",
      [
        "env",
        "-u",
        "ALL_PROXY",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "HTTP_PROXY",
        "-u",
        "all_proxy",
        "-u",
        "https_proxy",
        "-u",
        "http_proxy",
        "/opt/venv/bin/python3",
        "-I",
        "-c",
        "pass",
      ],
      { workdir: undefined, tty: null, timeoutSeconds: undefined, stdin: undefined },
    );
  });

  it("parses --workdir before -- and keeps the inner command intact", async () => {
    await SandboxExecCommand.run(
      ["alpha", "--workdir", "/sandbox/workspace", "--", "ls", "-la"],
      rootDir,
    );
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["ls", "-la"], {
      workdir: "/sandbox/workspace",
      tty: null,
      timeoutSeconds: undefined,
      stdin: undefined,
    });
  });

  it("forwards a multi-line heredoc command verbatim to the action", async () => {
    // The action dispatches this exact argument through OpenShell. Its
    // byte-preserving boundary is asserted directly in the action test.
    const heredoc = "cat <<EOF\nline1\nline2\nEOF";
    await SandboxExecCommand.run(["alpha", "--", "bash", "-lc", heredoc], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["bash", "-lc", heredoc], {
      workdir: undefined,
      tty: null,
      timeoutSeconds: undefined,
      stdin: undefined,
    });
  });

  it("forwards a semicolon-joined command unchanged", async () => {
    await SandboxExecCommand.run(["alpha", "--", "bash", "-lc", "echo line1; echo line2"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith(
      "alpha",
      ["bash", "-lc", "echo line1; echo line2"],
      { workdir: undefined, tty: null, timeoutSeconds: undefined, stdin: undefined },
    );
  });

  it("preserves --workdir and forwards a single-line command unchanged", async () => {
    await SandboxExecCommand.run(
      ["alpha", "--workdir", "/sandbox", "--", "bash", "-lc", "echo line1; echo line2"],
      rootDir,
    );
    expect(execSandboxMock).toHaveBeenCalledWith(
      "alpha",
      ["bash", "-lc", "echo line1; echo line2"],
      { workdir: "/sandbox", tty: null, timeoutSeconds: undefined, stdin: undefined },
    );
  });

  it("parses --tty / --no-tty and --timeout into typed options", async () => {
    await SandboxExecCommand.run(["alpha", "--tty", "--timeout", "30", "--", "hostname"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["hostname"], {
      workdir: undefined,
      tty: true,
      timeoutSeconds: 30,
      stdin: undefined,
    });
    execSandboxMock.mockReset();

    await SandboxExecCommand.run(["alpha", "--no-tty", "--", "hostname"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["hostname"], {
      workdir: undefined,
      tty: false,
      timeoutSeconds: undefined,
      stdin: undefined,
    });
  });

  it("parses --stdin as explicit stdin forwarding", async () => {
    await SandboxExecCommand.run(["alpha", "--stdin", "--", "cat"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["cat"], {
      workdir: undefined,
      tty: null,
      timeoutSeconds: undefined,
      stdin: true,
    });
  });

  it("parses --no-stdin as explicit stdin closure", async () => {
    await SandboxExecCommand.run(["alpha", "--no-stdin", "--", "pwd"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["pwd"], {
      workdir: undefined,
      tty: null,
      timeoutSeconds: undefined,
      stdin: false,
    });
  });

  it("leaves stdin mode unset for the production spawner to auto-detect", async () => {
    await SandboxExecCommand.run(["alpha", "--", "bash"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["bash"], {
      workdir: undefined,
      tty: null,
      timeoutSeconds: undefined,
      stdin: undefined,
    });
  });
});
