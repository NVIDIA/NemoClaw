// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const execMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureLiveMock = vi.hoisted(() => vi.fn(async () => ({})));
const getSandboxMock = vi.hoisted(() => vi.fn(() => null as { agent?: string | null } | null));
const loadAgentMock = vi.hoisted(() =>
  vi.fn((name: string) => ({
    name,
    runtime:
      name === "langchain-deepagents-code"
        ? { kind: "terminal", interactive_command: "dcode", headless_command: "dcode -n" }
        : undefined,
  })),
);
const isTerminalAgentMock = vi.hoisted(() =>
  vi.fn((agent: { runtime?: { kind?: string } }) => agent.runtime?.kind === "terminal"),
);

vi.mock("../exec", () => ({ execSandbox: execMock }));
vi.mock("../gateway-state", () => ({ ensureLiveSandboxOrExit: ensureLiveMock }));
vi.mock("../../../state/registry", () => ({ getSandbox: getSandboxMock }));
vi.mock("../../../agent/defs", () => ({
  isTerminalAgent: isTerminalAgentMock,
  loadAgent: loadAgentMock,
}));

import { runAgentPassthrough } from "./passthrough";

describe("runAgentPassthrough", () => {
  function makeProcMock() {
    const writes: string[] = [];
    const exit = vi.fn((code: number) => {
      throw new Error(`__exit:${code}`);
    });
    return {
      writes,
      exit,
      proc: {
        exit: exit as unknown as (code: number) => never,
        stderr: { write: (s: string) => writes.push(s) },
      },
    };
  }

  it("rejects Hermes sandboxes with a redirect to the OpenAI-compatible API", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "hermes" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    expect(writes.join("")).toMatch(/cannot dispatch to sandbox 'alpha' because it runs 'hermes'/);
    expect(writes.join("")).toMatch(/port 8642/);
  });

  it("forwards extraArgs verbatim to `openclaw agent` for OpenClaw sandboxes with --no-tty enforced", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    await runAgentPassthrough("alpha", {
      extraArgs: ["--agent", "work", "--session-id", "s-1", "-m", "ping", "--json"],
    });
    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(execMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--session-id", "s-1", "-m", "ping", "--json"],
      { tty: false },
    );
  });

  it("keeps OpenClaw --help local so wrapper help stays cheap (#5658)", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentPassthrough("alpha", { extraArgs: ["--help"] });
    } finally {
      logSpy.mockRestore();
    }
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("keeps bare OpenClaw invocations local so they do not pay sandbox latency (#5658)", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentPassthrough("alpha");
    } finally {
      logSpy.mockRestore();
    }
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("dispatches Deep Agents Code help to dcode instead of local wrapper help (#5790)", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
    await runAgentPassthrough("dcode-help", { extraArgs: ["--help"] });
    expect(ensureLiveMock).toHaveBeenCalledWith("dcode-help", { allowNonReadyPhase: true });
    expect(execMock).toHaveBeenCalledWith("dcode-help", ["dcode", "--help"], { tty: false });
  });

  it("dispatches bare Deep Agents Code invocations to dcode so upstream owns exit code (#5790)", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
    await runAgentPassthrough("dcode-help");
    expect(execMock).toHaveBeenCalledWith("dcode-help", ["dcode"], { tty: false });
  });

  it("treats a clean registry miss as OpenClaw (preserves bootstrap and recovery paths)", async () => {
    execMock.mockClear();
    getSandboxMock.mockReturnValueOnce(null);
    await runAgentPassthrough("ghost", { extraArgs: ["-m", "hi"] });
    expect(execMock).toHaveBeenCalledWith("ghost", ["openclaw", "agent", "-m", "hi"], {
      tty: false,
    });
  });

  it("fails closed when the registry read throws and never spawns OpenShell exec", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied, open '~/.config/nemoclaw/sandboxes.json'");
    });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/Could not read the local sandbox registry/);
    expect(all).toMatch(/Refusing to forward/);
    expect(all).toMatch(/EACCES/);
  });

  it("fails closed when a registered agent cannot be resolved before OpenShell exec", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "missing-agent" });
    loadAgentMock.mockImplementationOnce(() => {
      throw new Error("Agent manifest not found: agents/missing-agent/manifest.yaml");
    });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/registered agent 'missing-agent'/);
    expect(all).toMatch(/Agent manifest not found/);
    expect(all).toMatch(/Refusing to dispatch/);
  });

  it("fails closed for quoted terminal manifest commands instead of splitting them incorrectly", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "custom-terminal" });
    loadAgentMock.mockReturnValueOnce({
      name: "custom-terminal",
      runtime: {
        kind: "terminal",
        interactive_command: 'tool --profile "Deep Agents"',
        headless_command: "tool -n",
      },
    });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("quoted-terminal", { extraArgs: ["--help"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/registered agent 'custom-terminal'/);
    expect(all).toMatch(/simple whitespace-delimited argv tokens/);
    expect(all).toMatch(/quoted or escaped shell syntax is not supported/);
  });

  it("prints wrapper help when no extraArgs are passed to an OpenClaw fallback", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: null });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentPassthrough("alpha");
    } finally {
      logSpy.mockRestore();
    }
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("treats unknown registry misses as OpenClaw help for bare invocations", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentPassthrough("ghost");
    } finally {
      logSpy.mockRestore();
    }
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("works with explicit args for OpenClaw and still enforces --no-tty", async () => {
    execMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    await runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] });
    expect(execMock).toHaveBeenCalledWith("alpha", ["openclaw", "agent", "-m", "hi"], {
      tty: false,
    });
  });

  it("works with explicit args for OpenClaw fallbacks and still enforces --no-tty", async () => {
    execMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: null });
    await runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] });
    expect(execMock).toHaveBeenCalledWith("alpha", ["openclaw", "agent", "-m", "hi"], {
      tty: false,
    });
  });
});
