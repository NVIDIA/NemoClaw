// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  GatewayClient,
  HostCliClient,
  SandboxClient,
  type CommandRunner,
} from "../framework/clients/index.ts";
import type { E2EScenarioFixtures } from "../framework/e2e-test.ts";
import { StateValidationPhaseFixture, type NemoClawInstance } from "../framework/phases/index.ts";
import type { ShellProbeResult, ShellProbeRunOptions, TrustedShellCommand } from "../framework/shell-probe.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

function shellResult(exitCode: number, output = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout: exitCode === 0 ? output : "",
    stderr: exitCode === 0 ? "" : output,
    artifacts: {
      stdout: "/tmp/stdout.txt",
      stderr: "/tmp/stderr.txt",
      result: "/tmp/result.json",
    },
  };
}

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  private readonly responses: ShellProbeResult[] = [];

  enqueue(response: ShellProbeResult): void {
    this.responses.push(response);
  }

  async run(command: TrustedShellCommand, options?: ShellProbeRunOptions): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    return this.responses.shift() ?? shellResult(0);
  }
}

function instance(overrides: Partial<NemoClawInstance> = {}): NemoClawInstance {
  return {
    onboarding: "cloud-openclaw",
    sandboxName: "e2e-ubuntu-repo-cloud-openclaw",
    agent: "openclaw",
    provider: "nvidia",
    providerEnv: "cloud",
    gatewayUrl: "http://127.0.0.1:18789",
    result: shellResult(0),
    ...overrides,
  };
}

function fixture(runner: FakeRunner): StateValidationPhaseFixture {
  const host = new HostCliClient(runner);
  return new StateValidationPhaseFixture(host, new GatewayClient(host), new SandboxClient(runner));
}

describe("state-validation phase fixture", () => {
  it("validates a ready expected state through CLI, gateway, and sandbox probes", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "gateway healthy\n"));
    runner.enqueue(shellResult(0, "running\n"));

    const result = await fixture(runner).from("cloud-openclaw-ready", instance());

    expect(result.state.id).toBe("cloud-openclaw-ready");
    expect(result.probes.map((probe) => probe.id)).toEqual([
      "cli-installed",
      "gateway-healthy",
      "sandbox-running",
    ]);
    expect(runner.calls).toEqual([
      {
        command: "nemoclaw",
        args: ["--version"],
        options: { artifactName: "nemoclaw-version", inheritEnv: true },
      },
      {
        command: "nemoclaw",
        args: ["gateway", "status"],
        options: { artifactName: "gateway-status", inheritEnv: true },
      },
      {
        command: "openshell",
        args: ["sandbox", "status", "e2e-ubuntu-repo-cloud-openclaw"],
        options: {
          artifactName: "sandbox-status-e2e-ubuntu-repo-cloud-openclaw",
          inheritEnv: true,
        },
      },
    ]);
  });

  it("validates an expected preflight failure with absent gateway and sandbox probes", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
    runner.enqueue(shellResult(0, "other-sandbox\n"));

    const result = await fixture(runner).from(
      "preflight-failure-no-sandbox",
      instance({
        onboarding: "cloud-openclaw-no-docker",
        sandboxName: "e2e-no-docker",
        expectedFailure: {
          phase: "preflight",
          errorClass: "docker-missing",
        },
      }),
    );

    expect(result.probes.map((probe) => probe.id)).toEqual([
      "cli-installed",
      "gateway-absent",
      "sandbox-absent",
    ]);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["gateway", "status"],
      ["list"],
      ["sandbox", "list"],
    ]);
  });

  it("fails a gateway-absent probe if the gateway is running", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "gateway healthy\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /expected gateway to be absent/,
    );
  });

  it("fails a sandbox-absent probe if NemoClaw lists the sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(0, "NAME\ne2e-ubuntu-repo-cloud-openclaw\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /nemoclaw listed it/,
    );
  });

  it("requires an instance for sandbox probes", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "gateway healthy\n"));

    await expect(fixture(runner).from("cloud-openclaw-ready")).rejects.toThrow(
      /probe 'sandbox-running' requires a NemoClaw instance/,
    );
  });

  it("runs only the CLI probe for optional platform state", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));

    const result = await fixture(runner).from("macos-cli-ready-docker-optional");

    expect(result.probes.map((probe) => probe.id)).toEqual(["cli-installed"]);
    expect(runner.calls.map((call) => call.args)).toEqual([["--version"]]);
  });

  it("rejects unknown expected-state IDs", async () => {
    const runner = new FakeRunner();

    await expect(fixture(runner).from("missing-state", instance())).rejects.toThrow(/Unknown expected_state/);
  });

  it("exposes the state-validation phase on the Vitest scenario context", () => {
    expectTypeOf<E2EScenarioFixtures["stateValidation"]>().toEqualTypeOf<StateValidationPhaseFixture>();
  });
});
