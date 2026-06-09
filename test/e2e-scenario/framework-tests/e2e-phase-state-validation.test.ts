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

const GATEWAY_HEALTH_CURL_ARGS = [
  "-fsS",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "--max-time",
  "5",
  "http://127.0.0.1:18789/health",
];
const GATEWAY_BASE_CURL_ARGS = [
  "-fsS",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "--max-time",
  "5",
  "http://127.0.0.1:18789/",
];
const GATEWAY_ABSENT_HEALTH_CURL_ARGS = [
  "-fsS",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "--max-time",
  "3",
  "http://127.0.0.1:18789/health",
];

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
  private readonly responses: Array<ShellProbeResult | Error> = [];

  enqueue(response: ShellProbeResult): void {
    this.responses.push(response);
  }

  enqueueError(error: Error): void {
    this.responses.push(error);
  }

  async run(command: TrustedShellCommand, options?: ShellProbeRunOptions): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response ?? shellResult(0);
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
  it("validates a ready expected state through CLI, gateway health, and sandbox registry probes", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "200"));
    runner.enqueue(shellResult(0, "NAME\ne2e-ubuntu-repo-cloud-openclaw\n"));

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
        options: {
          artifactName: "nemoclaw-version",
          env: expect.objectContaining({
            PATH: expect.any(String),
          }),
        },
      },
      {
        command: "curl",
        args: GATEWAY_HEALTH_CURL_ARGS,
        options: {
          artifactName: "gateway-health",
          env: expect.objectContaining({
            PATH: expect.any(String),
          }),
          redactionValues: ["http://127.0.0.1:18789/health"],
        },
      },
      {
        command: "nemoclaw",
        args: ["list"],
        options: {
          artifactName: "sandbox-running-nemoclaw-list",
          env: expect.objectContaining({
            PATH: expect.any(String),
          }),
        },
      },
    ]);
  });

  it("accepts a healthy gateway base URL fallback when the health endpoint is unavailable", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "204"));
    runner.enqueue(shellResult(0, "NAME\ne2e-ubuntu-repo-cloud-openclaw\n"));

    const result = await fixture(runner).from("cloud-openclaw-ready", instance());

    expect(result.probes.find((probe) => probe.id === "gateway-healthy")?.results).toHaveLength(2);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      GATEWAY_HEALTH_CURL_ARGS,
      GATEWAY_BASE_CURL_ARGS,
      ["list"],
    ]);
  });

  it("accepts the sandbox-local Ollama gateway fallback", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "401"));
    runner.enqueue(shellResult(0, "NAME\ne2e-ubuntu-repo-cloud-openclaw\n"));

    const result = await fixture(runner).from(
      "local-ollama-openclaw-ready",
      instance({
        provider: "ollama",
        providerEnv: "local",
      }),
    );

    expect(result.probes.find((probe) => probe.id === "gateway-healthy")?.results).toHaveLength(3);
    expect(runner.calls[3]).toMatchObject({
      command: "openshell",
      args: [
        "sandbox",
        "exec",
        "e2e-ubuntu-repo-cloud-openclaw",
        "--",
        "curl",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "5",
        "http://localhost:18789/health",
      ],
    });
  });

  it("fails a gateway-healthy probe if the gateway HTTP probes are unhealthy", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(7, "connection refused"));

    await expect(fixture(runner).from("cloud-openclaw-ready", instance())).rejects.toThrow(
      /expected gateway .* to be healthy/,
    );
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      GATEWAY_HEALTH_CURL_ARGS,
      GATEWAY_BASE_CURL_ARGS,
    ]);
  });

  it("fails a sandbox-running probe if NemoClaw does not list the sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "200"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));

    await expect(fixture(runner).from("cloud-openclaw-ready", instance())).rejects.toThrow(
      /nemoclaw did not list it/,
    );
  });

  it("validates an expected preflight failure with absent gateway and sandbox probes", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
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
      GATEWAY_ABSENT_HEALTH_CURL_ARGS,
      ["list"],
      ["sandbox", "list"],
    ]);
    expect(result.probes.find((probe) => probe.id === "gateway-absent")?.results).toHaveLength(2);
  });

  it("fails a gateway-absent probe if the gateway is running", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "gateway healthy\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /expected gateway to be absent/,
    );
  });

  it("fails a gateway-absent probe if the gateway health endpoint responds", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway status unavailable\n"));
    runner.enqueue(shellResult(0, "ok\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /health responded healthy/,
    );
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["gateway", "status"],
      GATEWAY_ABSENT_HEALTH_CURL_ARGS,
    ]);
  });

  it("requires a loopback gateway URL for gateway-absent health probes", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));

    await expect(
      fixture(runner).from(
        "preflight-failure-no-sandbox",
        instance({
          gatewayUrl: "http://10.0.0.1:18789",
        }),
      ),
    ).rejects.toThrow(/private or link-local/);
  });

  it("fails a sandbox-absent probe if NemoClaw lists the sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\ne2e-ubuntu-repo-cloud-openclaw\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /nemoclaw listed it/,
    );
  });

  it("fails a sandbox-absent probe if OpenShell lists the sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
    runner.enqueue(shellResult(0, "NAME\ne2e-ubuntu-repo-cloud-openclaw\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /OpenShell listed it/,
    );
  });

  it("tolerates an unavailable OpenShell list after NemoClaw list reports no sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
    runner.enqueueError(new Error("spawn openshell ENOENT"));

    const result = await fixture(runner).from("preflight-failure-no-sandbox", instance());

    const sandboxAbsent = result.probes.find((probe) => probe.id === "sandbox-absent");
    expect(sandboxAbsent?.results).toHaveLength(1);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["gateway", "status"],
      GATEWAY_ABSENT_HEALTH_CURL_ARGS,
      ["list"],
      ["sandbox", "list"],
    ]);
  });

  it("fails a sandbox-absent probe if OpenShell list errors unexpectedly", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
    runner.enqueueError(new Error("openshell permission denied"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /could not verify OpenShell sandbox absence/,
    );
  });

  it("does not treat sandbox name substrings as present", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\ne2e-ubuntu-repo-cloud-openclaw-old\n"));
    runner.enqueue(shellResult(0, "NAME\nold-e2e-ubuntu-repo-cloud-openclaw\n"));

    const result = await fixture(runner).from("preflight-failure-no-sandbox", instance());

    expect(result.probes.map((probe) => probe.id)).toEqual([
      "cli-installed",
      "gateway-absent",
      "sandbox-absent",
    ]);
  });

  it("does not pass unrelated secret environment values to status probes", async () => {
    const original = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = "nvapi-test-secret-value";
    try {
      const runner = new FakeRunner();
      runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
      runner.enqueue(shellResult(1, "gateway stopped"));
      runner.enqueue(shellResult(7, "connection refused"));
      runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
      runner.enqueue(shellResult(0, "other-sandbox\n"));

      await fixture(runner).from("preflight-failure-no-sandbox", instance());

      for (const call of runner.calls.slice(1)) {
        expect(call.options).not.toHaveProperty("inheritEnv");
        expect(call.options?.env).toEqual(expect.objectContaining({ PATH: expect.any(String) }));
        expect(call.options?.env).not.toHaveProperty("NVIDIA_API_KEY");
      }
    } finally {
      if (original === undefined) {
        delete process.env.NVIDIA_API_KEY;
      } else {
        process.env.NVIDIA_API_KEY = original;
      }
    }
  });

  it("requires an instance for probes that use instance context", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));

    await expect(fixture(runner).from("cloud-openclaw-ready")).rejects.toThrow(
      /probe 'gateway-healthy' requires a NemoClaw instance/,
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
