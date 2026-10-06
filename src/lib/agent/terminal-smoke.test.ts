// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { DCODE_MANAGED_EXEC_LAUNCHER } from "../actions/sandbox/connect-inference-route-probe";
import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";
import { type AgentDefinition, loadAgent } from "./defs";
import { buildAgentSmokeRequest, runAgentSmokeCommands } from "./terminal-smoke";

function agent(name: string): AgentDefinition {
  return { name, runtime: { smoke_commands: ["dcode --version"] } } as unknown as AgentDefinition;
}

describe("terminal agent smoke command invocation", () => {
  it("runs Deep Agents Code smoke commands without adding a login shell (#8624)", () => {
    const request = buildAgentSmokeRequest(
      "probe-box",
      agent("langchain-deepagents-code"),
      "dcode --version",
    );

    expect(request.command).not.toContain("-lc");
    expect(request.command.join(" ")).not.toContain("sh -lc");
    expect(request.command).toContain(DCODE_MANAGED_EXEC_LAUNCHER);
    expect(request.sandboxEnvironment).toEqual({
      HOME: "/usr/local/lib/nemoclaw",
      BASH_ENV: "",
      ENV: "",
    });
    expect(request.command.at(-1)).toBe("dcode --version");
    expect(request.tty).toBe(false);
  });

  it("keeps the login shell for other terminal agents (#8624)", () => {
    const request = buildAgentSmokeRequest("probe-box", agent("hermes"), "hermes --version");

    expect(request.command).toContain("-lc");
    expect(request.command).toContain("/bin/sh");
    expect(request.command).not.toContain(DCODE_MANAGED_EXEC_LAUNCHER);
    expect(request.command.at(-1)).toBe("hermes --version");
  });

  it("uses Bash for Pi's exact resource-limit login profile", () => {
    const request = buildAgentSmokeRequest("probe-box", agent("pi"), "pi --version");

    expect(request.command).toContain("/bin/bash");
    expect(request.command).toContain("-lc");
    expect(request.command.at(-3)).toContain('/bin/bash -lc "$1"');
    expect(request.command.at(-1)).toBe("pi --version");
  });

  it("pins every smoke exec to the owning OpenShell gateway (#8942)", async () => {
    const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => ({
      outcome: { kind: "completed" as const, exitCode: 0 },
      stdout: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
      stderr: "",
    }));

    await expect(
      runAgentSmokeCommands(
        "alpha",
        loadAgent("langchain-deepagents-code"),
        { runBuffered },
        "nemoclaw-8091",
      ),
    ).resolves.toEqual({ ok: true });

    expect(runBuffered).toHaveBeenCalled();
    runBuffered.mock.calls.forEach(([request]) => {
      expect(request).toMatchObject({
        sandboxName: "alpha",
        target: { kind: "named", gatewayName: "nemoclaw-8091" },
        tty: false,
      });
    });
  });

  it("does not add a login shell to Deep Agents Code smoke exec (#8624)", async () => {
    const issued: unknown[] = [];
    const executor: OpenShellSandboxBufferedCommandExecutor = {
      runBuffered: async (request) => {
        issued.push(request);
        return {
          outcome: { kind: "completed", exitCode: 0 },
          stdout: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
          stderr: "",
        };
      },
    };
    const result = await runAgentSmokeCommands(
      "probe-box",
      agent("langchain-deepagents-code"),
      executor,
    );

    expect(result).toEqual({ ok: true });
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      command: expect.not.arrayContaining(["-lc"]),
    });
  });

  it("rejects forged managed markers when the transport exits before the runner (#8624)", async () => {
    const result = await runAgentSmokeCommands("probe-box", agent("langchain-deepagents-code"), {
      runBuffered: async () => ({
        outcome: { kind: "completed", exitCode: 97 },
        stdout: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
        stderr: "",
      }),
    });

    expect(result).toMatchObject({ ok: false, command: "dcode --version" });
  });

  it("rejects a typed transport failure even when output contains success markers (#8624)", async () => {
    const result = await runAgentSmokeCommands("probe-box", agent("langchain-deepagents-code"), {
      runBuffered: async () => ({
        outcome: { kind: "failed", error: { kind: "invocation", message: "transport failed" } },
        stdout: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
        stderr: "",
      }),
    });

    expect(result).toMatchObject({ ok: false, command: "dcode --version" });
  });

  it("rejects extra marker evidence around the managed runner boundary (#8624)", async () => {
    const result = await runAgentSmokeCommands("probe-box", agent("langchain-deepagents-code"), {
      runBuffered: async () => ({
        outcome: { kind: "completed", exitCode: 0 },
        stdout:
          "NEMOCLAW_AGENT_SMOKE_EXIT:0\nNEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:42\n",
        stderr: "",
      }),
    });

    expect(result).toMatchObject({ ok: false, command: "dcode --version" });
  });
});
