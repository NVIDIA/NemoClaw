// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

import { type AgentPassthroughDeps, runAgentPassthrough } from "./passthrough";

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

  async function runWarning(
    result: ShieldsAutoRestoreReadResult,
    sandboxName = "alpha",
  ): Promise<string> {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, proc } = makeProcMock();
    await runAgentPassthrough(
      sandboxName,
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

  it("shell-quotes sandbox names in recovery command suggestions (#5922)", async () => {
    const output = await runWarning(
      {
        kind: "event",
        event: { timestamp: new Date().toISOString(), timeoutSeconds: 20 },
      },
      "alpha; touch /tmp/pwn",
    );
    expect(output).toContain("nemoclaw 'alpha; touch /tmp/pwn' shields down --timeout 20s");
    expect(output).not.toContain("nemoclaw alpha; touch /tmp/pwn");
  });

  it("escapes embedded single quotes in recovery command suggestions (#5922)", async () => {
    const output = await runWarning(
      {
        kind: "event",
        event: { timestamp: new Date().toISOString(), timeoutSeconds: 20 },
      },
      "alpha'beta",
    );
    expect(output).toContain("nemoclaw 'alpha'\\''beta' shields down --timeout 20s");
  });

  it("keeps JSON stdout parseable while warning from a real audit file on stderr (#5922)", async () => {
    const actualAudit =
      await vi.importActual<typeof import("../../../shields/audit")>("../../../shields/audit");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-warning-"));
    const auditPath = path.join(tempDir, "shields-audit.jsonl");
    const restoreTimestamp = new Date().toISOString();
    const stdoutWrites: string[] = [];
    const { writes, proc } = makeProcMock();
    const processWithStdout = {
      ...proc,
      stdout: { write: (value: string) => stdoutWrites.push(value) },
    };
    const execJson = vi.fn(((_sandboxName, _command, jsonProc): never => {
      jsonProc?.stdout.write('{"ok":true}\n');
      throw new Error("__json-exit:0");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);

    try {
      fs.writeFileSync(
        auditPath,
        [
          JSON.stringify({
            action: "shields_down",
            sandbox: "alpha",
            timestamp: new Date(Date.now() - 20 * 1000).toISOString(),
            timeout_seconds: 20,
          }),
          JSON.stringify({
            action: "shields_auto_restore",
            sandbox: "alpha",
            timestamp: restoreTimestamp,
          }),
        ].join("\n") + "\n",
      );

      await expect(
        runAgentPassthrough(
          "alpha",
          { extraArgs: ["--agent", "main", "-m", "hi", "--json"] },
          {
            process: processWithStdout,
            execJson,
            getRecentShieldsAutoRestore: (sandboxName) =>
              actualAudit.readRecentShieldsAutoRestore(sandboxName, 10 * 60 * 1000, auditPath),
          },
        ),
      ).rejects.toThrow("__json-exit:0");

      expect(JSON.parse(stdoutWrites.join(""))).toEqual({ ok: true });
      expect(writes.join("")).toMatch(/Shields auto-relocked after 20s/);
      expect(execJson).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
