// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { DCODE_MANAGED_EXEC_LAUNCHER } from "../actions/sandbox/connect-inference-route-probe";
import { type AgentDefinition, loadAgent } from "./defs";
import { buildAgentSmokeArgs, runAgentSmokeCommands } from "./terminal-smoke";

function agent(name: string): AgentDefinition {
  return { name, runtime: { smoke_commands: ["dcode --version"] } } as unknown as AgentDefinition;
}

describe("terminal agent smoke command invocation", () => {
  it("runs Deep Agents Code smoke commands without adding a login shell (#8624)", () => {
    const args = buildAgentSmokeArgs(
      "probe-box",
      agent("langchain-deepagents-code"),
      "dcode --version",
    );

    expect(args).not.toContain("-lc");
    expect(args.join(" ")).not.toContain("sh -lc");
    expect(args).toContain(DCODE_MANAGED_EXEC_LAUNCHER);
    expect(args).toContain("HOME=/usr/local/lib/nemoclaw");
    expect(args).toContain("BASH_ENV=");
    expect(args).toContain("ENV=");
    expect(args.at(-1)).toBe("dcode --version");
  });

  it("keeps the login shell for other terminal agents (#8624)", () => {
    const args = buildAgentSmokeArgs("probe-box", agent("hermes"), "hermes --version");

    expect(args).toContain("-lc");
    expect(args).toContain("/bin/sh");
    expect(args).not.toContain(DCODE_MANAGED_EXEC_LAUNCHER);
    expect(args.at(-1)).toBe("hermes --version");
  });

  it("uses Bash for Pi's exact resource-limit login profile", () => {
    const args = buildAgentSmokeArgs("probe-box", agent("pi"), "pi --version");

    expect(args).toContain("/bin/bash");
    expect(args).toContain("-lc");
    expect(args.at(-3)).toContain('/bin/bash -lc "$1"');
    expect(args.at(-1)).toBe("pi --version");
  });

  it("pins every smoke exec to the owning OpenShell gateway (#8942)", () => {
    const capture = vi.fn((_args: string[]) => ({
      status: 0,
      output: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
    }));

    expect(
      runAgentSmokeCommands(
        "alpha",
        loadAgent("langchain-deepagents-code"),
        capture,
        "nemoclaw-8091",
      ),
    ).toEqual({ ok: true });

    expect(capture).toHaveBeenCalled();
    capture.mock.calls.forEach(([args]) => {
      expect(args.slice(0, 7)).toEqual([
        "sandbox",
        "exec",
        "-n",
        "alpha",
        "-g",
        "nemoclaw-8091",
        "--no-tty",
      ]);
    });
  });

  it("does not add a login shell to Deep Agents Code smoke exec (#8624)", () => {
    const issued: string[][] = [];
    const result = runAgentSmokeCommands(
      "probe-box",
      agent("langchain-deepagents-code"),
      (args) => {
        issued.push(args);
        return {
          status: 0,
          output: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
        };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(issued).toHaveLength(1);
    expect(issued[0]).not.toContain("-lc");
    expect(issued[0]!.join(" ")).not.toContain("sh -lc");
  });

  it("rejects forged managed markers when the transport exits before the runner (#8624)", () => {
    const result = runAgentSmokeCommands("probe-box", agent("langchain-deepagents-code"), () => ({
      status: 97,
      output: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
    }));

    expect(result).toMatchObject({ ok: false, command: "dcode --version" });
  });

  it("rejects string-only managed smoke evidence without transport status (#8624)", () => {
    const result = runAgentSmokeCommands(
      "probe-box",
      agent("langchain-deepagents-code"),
      () => "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
    );

    expect(result).toMatchObject({ ok: false, command: "dcode --version" });
  });

  it("rejects extra marker evidence around the managed runner boundary (#8624)", () => {
    const result = runAgentSmokeCommands("probe-box", agent("langchain-deepagents-code"), () => ({
      status: 0,
      output:
        "NEMOCLAW_AGENT_SMOKE_EXIT:0\nNEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:42\n",
    }));

    expect(result).toMatchObject({ ok: false, command: "dcode --version" });
  });
});
