// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShieldsAutoRestoreReadResult } from "../../../shields/audit";

const execMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureLiveMock = vi.hoisted(() =>
  vi.fn(async () => ({ state: "present", output: "Phase: Ready" }) as { output?: string }),
);
const getSandboxMock = vi.hoisted(() => vi.fn(() => ({ agent: "openclaw" })));
const listAgentsMock = vi.hoisted(() => vi.fn(() => ["langchain-deepagents-code", "openclaw"]));
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
vi.mock("../../../shields/audit", () => ({
  readRecentShieldsAutoRestore: vi.fn(() => ({ kind: "none" })),
}));

import { runAgentPassthrough } from "./passthrough";

function makeProcMock() {
  const writes: string[] = [];
  return {
    writes,
    proc: {
      exit: ((code: number): never => {
        throw new Error(`__exit:${code}`);
      }) as (code: number) => never,
      stderr: { write: (value: string) => writes.push(value) },
    },
  };
}

describe("runAgentPassthrough shields-relock warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runWarning(result: ShieldsAutoRestoreReadResult): Promise<string> {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, proc } = makeProcMock();
    await runAgentPassthrough(
      "alpha",
      { extraArgs: ["--agent", "main", "-m", "hi"] },
      { process: proc, getRecentShieldsAutoRestore: () => result },
    );
    return writes.join("");
  }

  it("emits the original timeout after a recent auto-relock (#5922)", async () => {
    const output = await runWarning({
      kind: "event",
      event: { timestamp: new Date().toISOString(), timeoutSeconds: 20 },
    });
    expect(execMock).toHaveBeenCalled();
    expect(output).toMatch(/[Ss]hields auto-relocked after 20s/);
    expect(output).toMatch(/shields down --timeout 20s/);
  });

  it("uses the safe fallback timeout when the original timeout is unavailable (#5922)", async () => {
    const output = await runWarning({
      kind: "event",
      event: { timestamp: new Date().toISOString(), timeoutSeconds: null },
    });
    expect(execMock).toHaveBeenCalled();
    expect(output).toMatch(/[Ss]hields auto-relocked/);
    expect(output).toMatch(/shields down --timeout 60s/);
  });

  it("defensively rejects an invalid injected timeout from the command suggestion (#5922)", async () => {
    const output = await runWarning({
      kind: "event",
      event: { timestamp: new Date().toISOString(), timeoutSeconds: 9999 },
    });
    expect(output).not.toContain("9999s");
    expect(output).toMatch(/shields down --timeout 60s/);
  });

  it("emits no relock warning when the audit has no recent event (#5922)", async () => {
    const output = await runWarning({ kind: "none" });
    expect(execMock).toHaveBeenCalled();
    expect(output).not.toMatch(/[Ss]hields auto-relocked/);
  });

  it("reports unreadable audit history without blocking agent dispatch (#5922)", async () => {
    const output = await runWarning({ kind: "unreadable" });
    expect(execMock).toHaveBeenCalled();
    expect(output).toMatch(/Could not read shields audit history/);
    expect(output).toMatch(/shields status/);
  });

  it("does not consult OpenClaw relock history for terminal-runtime passthroughs (#5922)", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
    const getRecentShieldsAutoRestore = vi.fn(
      (): ShieldsAutoRestoreReadResult => ({
        kind: "event",
        event: { timestamp: new Date().toISOString(), timeoutSeconds: 20 },
      }),
    );
    const { writes, proc } = makeProcMock();

    await runAgentPassthrough(
      "alpha",
      { extraArgs: ["--help"] },
      { process: proc, getRecentShieldsAutoRestore },
    );

    expect(execMock).toHaveBeenCalledWith("alpha", ["dcode", "--help"], { tty: false });
    expect(getRecentShieldsAutoRestore).not.toHaveBeenCalled();
    expect(writes.join("")).not.toMatch(/[Ss]hields auto-relocked/);
  });
});
