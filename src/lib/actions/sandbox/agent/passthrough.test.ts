// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureLiveMock = vi.hoisted(() =>
  vi.fn(async () => ({ state: "present", output: "Phase: Ready" }) as { output?: string }),
);
const getSandboxMock = vi.hoisted(() => vi.fn(() => null as { agent?: string | null } | null));
const listAgentsMock = vi.hoisted(() =>
  vi.fn(() => ["custom-terminal", "hermes", "langchain-deepagents-code", "openclaw"]),
);
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
  listAgents: listAgentsMock,
  loadAgent: loadAgentMock,
}));

import { type AgentPassthroughDeps, runAgentPassthrough } from "./passthrough";

describe("runAgentPassthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    await runAgentPassthrough("alpha", {
      extraArgs: ["--agent", "work", "--session-id", "s-1", "-m", "ping"],
    });
    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(execMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--session-id", "s-1", "-m", "ping"],
      { tty: false },
    );
  });

  it("uses the captured JSON path for `openclaw agent --json` so provenance can be emitted on stderr", async () => {
    const execJson = vi.fn(() => {
      throw new Error("__exit:0");
    });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { proc } = makeProcMock();

    await expect(
      runAgentPassthrough(
        "alpha",
        {
          extraArgs: ["--agent", "work", "--session-id", "s-1", "-m", "ping", "--json"],
        },
        { execJson, process: proc },
      ),
    ).rejects.toThrow("__exit:0");

    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(execMock).not.toHaveBeenCalled();
    expect(execJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--session-id", "s-1", "-m", "ping", "--json"],
      expect.objectContaining({ stderr: proc.stderr }),
    );
  });

  it("keeps --json as a message value on the normal passthrough path", async () => {
    const execJson = vi.fn(((): never => {
      throw new Error("__unexpected-json");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });

    await runAgentPassthrough(
      "alpha",
      { extraArgs: ["--agent", "work", "-m", "--json"] },
      { execJson },
    );

    expect(execJson).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "-m", "--json"],
      { tty: false },
    );
  });

  it("keeps --json after the argv terminator on the normal passthrough path", async () => {
    const execJson = vi.fn(((): never => {
      throw new Error("__unexpected-json");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });

    await runAgentPassthrough(
      "alpha",
      { extraArgs: ["--agent", "work", "--", "--json"] },
      { execJson },
    );

    expect(execJson).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--", "--json"],
      { tty: false },
    );
  });

  it("keeps --json after an unknown future value flag on the normal passthrough path", async () => {
    const execJson = vi.fn(((): never => {
      throw new Error("__unexpected-json");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });

    await runAgentPassthrough(
      "alpha",
      { extraArgs: ["--agent", "work", "--some-future-value-flag", "--json"] },
      { execJson },
    );

    expect(execJson).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--some-future-value-flag", "--json"],
      { tty: false },
    );
  });

  it("uses the captured JSON path after documented OpenClaw boolean flags", async () => {
    const execJson = vi.fn(() => {
      throw new Error("__exit:0");
    });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { proc } = makeProcMock();

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "work", "--deliver", "--json", "-m", "ping"] },
        { execJson, process: proc },
      ),
    ).rejects.toThrow("__exit:0");

    expect(execMock).not.toHaveBeenCalled();
    expect(execJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--deliver", "--json", "-m", "ping"],
      expect.objectContaining({ stderr: proc.stderr }),
    );
  });

  it("uses the captured JSON path after documented equals-form value flags", async () => {
    const execJson = vi.fn(() => {
      throw new Error("__exit:0");
    });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { proc } = makeProcMock();

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--session-id=s1", "--json", "-m", "ping"] },
        { execJson, process: proc },
      ),
    ).rejects.toThrow("__exit:0");

    expect(execMock).not.toHaveBeenCalled();
    expect(execJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--session-id=s1", "--json", "-m", "ping"],
      expect.objectContaining({ stderr: proc.stderr }),
    );
  });

  it.each([
    ["-a", "--json"],
    ["--agent", "--json"],
    ["-m", "--json"],
    ["--message", "--json"],
    ["--model", "--json"],
    ["--provider", "--json"],
    ["--reply-channel", "--json"],
    ["--session-id", "--json"],
    ["--session-key", "--json"],
    ["--thinking", "--json"],
    ["--timeout", "--json"],
    ["--to", "--json"],
  ])("keeps --json consumed by %s on the normal passthrough path", async (flag, value) => {
    const execJson = vi.fn(((): never => {
      throw new Error("__unexpected-json");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });

    await runAgentPassthrough(
      "alpha",
      { extraArgs: ["--session-id", "s-1", flag, value] },
      { execJson },
    );

    expect(execJson).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--session-id", "s-1", flag, value],
      { tty: false },
    );
  });

  it("keeps OpenClaw --help local so wrapper docs parity stays offline", async () => {
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

  it("dispatches Deep Agents Code help to dcode instead of local wrapper help (#5790)", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
    await runAgentPassthrough("dcode-help", { extraArgs: ["--help"] });
    expect(ensureLiveMock).toHaveBeenCalledWith("dcode-help", { allowNonReadyPhase: true });
    expect(execMock).toHaveBeenCalledWith("dcode-help", ["dcode", "--help"], { tty: false });
  });

  it("dispatches bare Deep Agents Code invocations to dcode so upstream owns exit code (#5790)", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
    await runAgentPassthrough("dcode-help");
    expect(execMock).toHaveBeenCalledWith("dcode-help", ["dcode"], { tty: false });
  });

  it("propagates bare Deep Agents Code non-zero exits from the sandbox exec path (#5790)", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
    execMock.mockRejectedValueOnce(new Error("__exit:42"));

    await expect(runAgentPassthrough("dcode-fail")).rejects.toThrow("__exit:42");

    expect(ensureLiveMock).toHaveBeenCalledWith("dcode-fail", { allowNonReadyPhase: true });
    expect(execMock).toHaveBeenCalledWith("dcode-fail", ["dcode"], { tty: false });
  });

  it("treats a clean registry miss as OpenClaw (preserves bootstrap and recovery paths)", async () => {
    getSandboxMock.mockReturnValueOnce(null);
    await runAgentPassthrough("ghost", { extraArgs: ["--agent", "main", "-m", "hi"] });
    expect(execMock).toHaveBeenCalledWith(
      "ghost",
      ["openclaw", "agent", "--agent", "main", "-m", "hi"],
      { tty: false },
    );
  });

  it("keeps registry-miss --help local for offline docs parity", async () => {
    getSandboxMock.mockReturnValueOnce(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentPassthrough("placeholder-sandbox", { extraArgs: ["--help"] });
    } finally {
      logSpy.mockRestore();
    }
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("fails closed when the registry read throws and never spawns OpenShell exec", async () => {
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

  it("fails closed when a registered agent is not in the manifest allowlist", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "../missing-agent" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("../missing-agent", { extraArgs: ["--help"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(loadAgentMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/registered agent '\.\.\/missing-agent'/);
    expect(all).toMatch(/not present in the local agent manifest allowlist/);
    expect(all).toMatch(/Refusing to dispatch/);
  });

  it("fails closed when a known registered agent cannot be resolved before OpenShell exec", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "missing-agent" });
    listAgentsMock.mockReturnValueOnce(["missing-agent"]);
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

  it("rejects with exit 2 when no target selector flag is present on a Ready OpenClaw sandbox", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/No target session selected/);
    expect(all).toMatch(/--agent <id>/);
    expect(all).toMatch(/openclaw agents list/);
  });

  it("rejects with exit 2 when extraArgs is empty on a Ready OpenClaw sandbox", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { exit, proc } = makeProcMock();
    await expect(runAgentPassthrough("alpha", {}, { process: proc })).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("prints recovery hints with exit 1 before selector rejection for the literal stopped-sandbox repro `agent -m ping` (#5655)", async () => {
    ensureLiveMock.mockResolvedValueOnce({ output: "Phase: Error" });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("my-assistant", { extraArgs: ["-m", "ping"] }, { process: proc }),
    ).rejects.toThrow("__exit:1");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).toHaveBeenCalledWith("my-assistant", { allowNonReadyPhase: true });
    expect(exit).toHaveBeenCalledWith(1);
    const all = writes.join("");
    expect(all).toMatch(
      /Sandbox 'my-assistant' is not ready for the agent wrapper \(phase: Error\)/,
    );
    expect(all).toMatch(/my-assistant recover/);
    expect(all).not.toMatch(/No target session selected/);
  });

  it("rejects with exit 2 when the selector token appears after the `--` argv separator", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--", "--agent", "work", "-m", "hi"] },
        { process: proc },
      ),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    expect(writes.join("")).toMatch(/No target session selected/);
  });

  it("accepts selector in --flag=value form and forwards verbatim", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    await runAgentPassthrough("alpha", {
      extraArgs: ["--session-key=abc-123", "-m", "ping"],
    });
    expect(execMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--session-key=abc-123", "-m", "ping"],
      { tty: false },
    );
  });

  it("rejects with exit 1 + recovery hints when sandbox phase is non-Ready", async () => {
    ensureLiveMock.mockResolvedValueOnce({ output: "Phase: Error" });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough(
        "my-assistant",
        { extraArgs: ["--agent", "main", "-m", "hi"] },
        { process: proc },
      ),
    ).rejects.toThrow("__exit:1");
    expect(execMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    const all = writes.join("");
    expect(all).toMatch(
      /Sandbox 'my-assistant' is not ready for the agent wrapper \(phase: Error\)/,
    );
    expect(all).toMatch(/my-assistant recover/);
    expect(all).toMatch(/my-assistant rebuild --yes/);
    expect(all).toMatch(/onboard --resume/);
  });

  it("fails closed with exit 2 when ensureLive returns output without a parseable Phase line, never invoking exec", async () => {
    ensureLiveMock.mockResolvedValueOnce({ output: "Name: alpha\n(no phase line here)\n" });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "main", "-m", "hi"] },
        { process: proc },
      ),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/Could not parse a 'Phase:' line/);
    expect(all).toMatch(/Refusing to dispatch/);
  });
});
