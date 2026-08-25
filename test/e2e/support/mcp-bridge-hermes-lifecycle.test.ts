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
  assertHermesConfig,
  assertHermesReloadRollback,
  lowerHermesShieldsForCleanup,
  reopenHermesMcpMaintenanceWindow,
} from "../live/mcp-bridge-hermes-lifecycle.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

function shellResult(exitCode = 0, stdout = "", stderr = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
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

describe("Hermes MCP managed configuration assertion", () => {
  it("requires the revision-scoped OpenShell credential placeholder (#10155)", async () => {
    const runner = new RecordingRunner();
    const sandbox = new SandboxClient(runner);

    await assertHermesConfig(sandbox, "hermes-e2e", "https://mcp.example.test/mcp");

    const command = runner.calls[0]?.args.at(-1) ?? "";
    expect(command).toContain("Bearer openshell:resolve:env:v[0-9]{1,20}_FAKE_MCP_SECRET");
    expect(command).not.toContain("== 'Bearer openshell:resolve:env:FAKE_MCP_SECRET'");
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

describe("Hermes MCP cleanup posture", () => {
  it("accepts an already-down Shields posture", async () => {
    const runner = new RecordingRunner([
      shellResult(1, "", "Config is already unlocked for hermes-e2e"),
      shellResult(0, "  Shields: DOWN (temporarily unlocked)\n"),
    ]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await lowerHermesShieldsForCleanup(host, "hermes-e2e");

    expect(runner.calls).toEqual([
      expect.objectContaining({
        command: "nemoclaw",
        args: ["hermes-e2e", "shields", "down", "--timeout", "5m", "--reason", "E2E cleanup"],
      }),
      expect.objectContaining({
        command: "nemoclaw",
        args: ["hermes-e2e", "shields", "status"],
      }),
    ]);
  });

  it("rejects cleanup when Shields remain up", async () => {
    const runner = new RecordingRunner([
      shellResult(1, "", "required executable does not exist"),
      shellResult(0, "  Shields: UP\n"),
    ]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(lowerHermesShieldsForCleanup(host, "hermes-e2e")).rejects.toThrow(
      "Hermes Shields cleanup could not confirm DOWN posture",
    );
  });

  it("rejects unrelated absence output from Shields status", async () => {
    const runner = new RecordingRunner([
      shellResult(1, "", "Config transition failed"),
      shellResult(1, "", "provider configuration not found"),
    ]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(lowerHermesShieldsForCleanup(host, "hermes-e2e")).rejects.toThrow(
      "Hermes Shields cleanup could not confirm DOWN posture",
    );
  });

  it("accepts cleanup after the sandbox is removed", async () => {
    const runner = new RecordingRunner([
      shellResult(1, "", "  Sandbox 'hermes-e2e' does not exist.\n"),
    ]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await lowerHermesShieldsForCleanup(host, "hermes-e2e");

    expect(runner.calls).toHaveLength(1);
  });
});
