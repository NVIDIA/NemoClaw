// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const execSandboxMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/actions/sandbox/exec", () => ({
  execSandbox: execSandboxMock,
}));

import SandboxExecCommand from "./exec";

const rootDir = process.cwd();

describe("SandboxExecCommand oclif parse path", () => {
  beforeEach(() => {
    execSandboxMock.mockReset();
  });

  it("forwards everything after -- as the inner command argv", async () => {
    await SandboxExecCommand.run(
      ["alpha", "--", "openclaw", "agent", "--agent", "main", "-m", "hi"],
      rootDir,
    );
    expect(execSandboxMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "main", "-m", "hi"],
      { workdir: undefined, tty: null, timeoutSeconds: undefined },
    );
  });

  it("parses --workdir before -- and keeps the inner command intact", async () => {
    await SandboxExecCommand.run(
      ["alpha", "--workdir", "/sandbox/workspace", "--", "ls", "-la"],
      rootDir,
    );
    expect(execSandboxMock).toHaveBeenCalledWith(
      "alpha",
      ["ls", "-la"],
      { workdir: "/sandbox/workspace", tty: null, timeoutSeconds: undefined },
    );
  });

  it("parses --tty / --no-tty and --timeout into typed options", async () => {
    await SandboxExecCommand.run(["alpha", "--tty", "--timeout", "30", "--", "hostname"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith(
      "alpha",
      ["hostname"],
      { workdir: undefined, tty: true, timeoutSeconds: 30 },
    );
    execSandboxMock.mockReset();

    await SandboxExecCommand.run(["alpha", "--no-tty", "--", "hostname"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith(
      "alpha",
      ["hostname"],
      { workdir: undefined, tty: false, timeoutSeconds: undefined },
    );
  });
});
