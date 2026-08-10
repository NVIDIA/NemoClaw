// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { type CommandRunner, HostCliClient, SandboxClient } from "../fixtures/clients/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";
import {
  assertHermesReloadRollback,
  reopenHermesMcpMaintenanceWindow,
} from "../live/mcp-bridge-hermes-lifecycle.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

function shellResult(exitCode = 0): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: {
      stdout: "/tmp/stdout",
      stderr: "/tmp/stderr",
      result: "/tmp/result",
    },
  };
}

class RecordingRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  private readonly responses: ShellProbeResult[];

  constructor(responses: ShellProbeResult[] = []) {
    this.responses = [...responses];
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    return this.responses.shift() ?? shellResult();
  }
}

function sandboxWithInspectionState(state: string): SandboxClient {
  return new SandboxClient({
    run: async () => ({
      command: ["openshell"],
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `${JSON.stringify({ ok: true, state })}\n`,
      stderr: "",
      artifacts: {
        stdout: "/tmp/stdout",
        stderr: "/tmp/stderr",
        result: "/tmp/result",
      },
    }),
  });
}

describe("Hermes MCP live rollback inspection", () => {
  it("accepts the managed inspection helper's matched result", async () => {
    await expect(
      assertHermesReloadRollback(
        sandboxWithInspectionState("matched"),
        "hermes-e2e",
        "https://mcp.example.test",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects the internal integrity state's current label", async () => {
    await expect(
      assertHermesReloadRollback(
        sandboxWithInspectionState("current"),
        "hermes-e2e",
        "https://mcp.example.test",
      ),
    ).rejects.toMatchObject({
      actual: { ok: true, state: "current" },
      expected: { ok: true, state: "matched" },
    });
  });
});

describe("Hermes MCP post-rebuild maintenance", () => {
  it("opens a fresh Shields-down timer before the final config mutation", async () => {
    const runner = new RecordingRunner();
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await reopenHermesMcpMaintenanceWindow(host, "hermes-e2e");

    expect(runner.calls).toEqual([
      expect.objectContaining({
        command: "nemoclaw",
        args: ["hermes-e2e", "shields", "up"],
        options: expect.objectContaining({
          artifactName: "hermes-mcp-shields-up-before-post-rebuild-remove",
          timeoutMs: 3 * 60_000,
        }),
      }),
      expect.objectContaining({
        command: "nemoclaw",
        args: [
          "hermes-e2e",
          "shields",
          "down",
          "--timeout",
          "15m",
          "--reason",
          "Post-rebuild MCP removal E2E",
        ],
        options: expect.objectContaining({
          artifactName: "hermes-mcp-shields-down-before-post-rebuild-remove",
          timeoutMs: 3 * 60_000,
        }),
      }),
    ]);
  });

  it("keeps Shields up when posture normalization fails", async () => {
    const runner = new RecordingRunner([shellResult(1)]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(reopenHermesMcpMaintenanceWindow(host, "hermes-e2e")).rejects.toThrow(
      "normalize Hermes shields before post-rebuild MCP removal failed: exit=1",
    );

    expect(runner.calls).toEqual([
      expect.objectContaining({
        command: "nemoclaw",
        args: ["hermes-e2e", "shields", "up"],
      }),
    ]);
  });
});
