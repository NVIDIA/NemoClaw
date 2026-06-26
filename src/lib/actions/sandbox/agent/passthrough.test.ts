// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const execMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureLiveMock = vi.hoisted(() =>
  vi.fn(async () => ({ state: "present", output: "Phase: Ready" }) as { output?: string }),
);
const getSandboxMock = vi.hoisted(() => vi.fn(() => null as { agent?: string } | null));

vi.mock("../exec", () => ({ execSandbox: execMock }));
vi.mock("../gateway-state", () => ({ ensureLiveSandboxOrExit: ensureLiveMock }));
vi.mock("../../../state/registry", () => ({ getSandbox: getSandboxMock }));

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
    expect(writes.join("")).toMatch(
      /Only OpenClaw sandboxes support the `sandbox agent` wrapper today \(sandbox 'alpha' runs 'hermes'\)/,
    );
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

  it("treats a clean registry miss as OpenClaw (preserves bootstrap and recovery paths)", async () => {
    execMock.mockClear();
    getSandboxMock.mockReturnValueOnce(null);
    await runAgentPassthrough("ghost", { extraArgs: ["--agent", "main", "-m", "hi"] });
    expect(execMock).toHaveBeenCalledWith(
      "ghost",
      ["openclaw", "agent", "--agent", "main", "-m", "hi"],
      { tty: false },
    );
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

  it("rejects with exit 2 when no target selector flag is present on a Ready sandbox", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
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

  it("rejects with exit 2 when extraArgs is empty on a Ready sandbox", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { exit, proc } = makeProcMock();
    await expect(runAgentPassthrough("alpha", {}, { process: proc })).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("prints recovery hints with exit 1 before selector rejection when the sandbox phase is non-Ready (covers the literal #5655 stopped-sandbox repro `agent -m ping`)", async () => {
    execMock.mockClear();
    ensureLiveMock.mockClear();
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
    execMock.mockClear();
    ensureLiveMock.mockClear();
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
    execMock.mockClear();
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
    execMock.mockClear();
    ensureLiveMock.mockClear();
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
    execMock.mockClear();
    ensureLiveMock.mockClear();
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
    expect(all).toMatch(/Refusing to forward/);
  });
});
