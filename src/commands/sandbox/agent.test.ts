// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAgentPassthroughMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/actions/sandbox/agent/passthrough", () => ({
  runAgentPassthrough: runAgentPassthroughMock,
}));

import SandboxAgentCommand from "./agent";

const rootDir = process.cwd();

describe("SandboxAgentCommand oclif parse path", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runAgentPassthroughMock.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("forwards the OpenClaw argv verbatim to runAgentPassthrough", async () => {
    await SandboxAgentCommand.run(["alpha", "--agent", "work", "-m", "hi"], rootDir);
    expect(runAgentPassthroughMock).toHaveBeenCalledWith("alpha", {
      extraArgs: ["--agent", "work", "-m", "hi"],
    });
  });

  it("does not call runAgentPassthrough when --help follows the sandbox name", async () => {
    await SandboxAgentCommand.run(["alpha", "--help"], rootDir);
    expect(runAgentPassthroughMock).not.toHaveBeenCalled();
    const help = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(help).toMatch(/openclaw agent/);
  });

  it("does not call runAgentPassthrough when no sandbox name is supplied", async () => {
    await SandboxAgentCommand.run([], rootDir);
    expect(runAgentPassthroughMock).not.toHaveBeenCalled();
    const help = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(help).toMatch(/Pass-through to/);
  });

  it("treats sandbox name '--help' as a help request, not a name", async () => {
    await SandboxAgentCommand.run(["--help"], rootDir);
    expect(runAgentPassthroughMock).not.toHaveBeenCalled();
  });
});
