// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { type CommandRunner, SandboxClient } from "../fixtures/clients/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

type FakeRunnerResponse = Partial<Pick<ShellProbeResult, "exitCode" | "stderr" | "stdout">>;

class FakeRunner implements CommandRunner {
  readonly calls: { args: string[]; options?: ShellProbeRunOptions }[] = [];
  readonly responses: FakeRunnerResponse[] = [];

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ args: [...command.args], options });
    const response = this.responses.shift();
    return {
      command: [command.command, ...command.args],
      exitCode: response?.exitCode ?? 0,
      signal: null,
      timedOut: false,
      stdout: response?.stdout ?? "",
      stderr: response?.stderr ?? "",
      artifacts: {
        stdout: "/tmp/stdout.txt",
        stderr: "/tmp/stderr.txt",
        result: "/tmp/result.json",
      },
    };
  }
}

const GATEWAY_INFO = ["gateway", "info", "-g", "nemoclaw", "-o", "json"];

describe("SandboxClient abort cleanup", () => {
  it("skips sandbox deletion after onboarding removes the gateway registration", async () => {
    const runner = new FakeRunner();
    runner.responses.push({
      exitCode: 1,
      stderr:
        "Error:   × No gateway configured.\n  │ Register a gateway with: openshell gateway add <endpoint>",
    });
    const sandbox = new SandboxClient(runner);

    await expect(
      sandbox.cleanupSandboxWhileGatewayRegistered("assistant"),
    ).resolves.toBeUndefined();
    expect(runner.calls.map(({ args }) => args)).toEqual([GATEWAY_INFO]);
    expect(runner.calls[0].options).toMatchObject({ artifactName: "cleanup-gateway-info" });
  });

  it("deletes the sandbox while its gateway is registered", async () => {
    const runner = new FakeRunner();
    runner.responses.push({ stdout: JSON.stringify({ gateway: "nemoclaw", status: "healthy" }) });
    const sandbox = new SandboxClient(runner);

    await sandbox.cleanupSandboxWhileGatewayRegistered("assistant", { timeoutMs: 60_000 });
    expect(runner.calls.map(({ args }) => args)).toEqual([
      GATEWAY_INFO,
      ["sandbox", "delete", "assistant"],
    ]);
    expect(runner.calls[1].options).toMatchObject({
      artifactName: "cleanup-openshell-sandbox-assistant",
    });
  });
});
