// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  GatewayClient,
  HostCliClient,
  SandboxClient,
  type CommandRunner,
} from "../fixtures/clients/index.ts";
import type { E2EScenarioFixtures } from "../fixtures/e2e-test.ts";
import {
  buildBackupContainerName,
  LifecyclePhaseFixture,
  type LifecycleCleanup,
} from "../fixtures/phases/lifecycle.ts";
import type { NemoClawInstance } from "../fixtures/phases/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

interface CleanupCall {
  name: string;
  run: () => Promise<void> | void;
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

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({
      command: command.command,
      args: [...command.args],
      options,
    });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(
        `FakeRunner response missing for command: ${command.command} ${command.args.join(" ")}`,
      );
    }
    return response;
  }
}

class FakeCleanup implements LifecycleCleanup {
  readonly calls: CleanupCall[] = [];

  add(name: string, run: () => Promise<void> | void): void {
    this.calls.push({ name, run });
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

function fixture(runner: FakeRunner, cleanup: FakeCleanup): LifecyclePhaseFixture {
  const host = new HostCliClient(runner);
  const sandbox = new SandboxClient(runner);
  return new LifecyclePhaseFixture(host, sandbox, cleanup);
}

describe("LifecyclePhaseFixture.simulate post-reboot-recovery (stop-original)", () => {
  it("stops the labeled container then runs `nemoclaw <name> status`", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "openshell-cluster-e2e-ubuntu-repo-cloud-openclaw\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(1, "Removed stale local registry entry.\n")); // status (non-zero on unfixed)
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).simulate("post-reboot-recovery", instance());

    expect(result.profile).toBe("post-reboot-recovery");
    expect(result.steps.map((step) => step.id)).toEqual([
      "docker-stop:openshell-cluster-e2e-ubuntu-repo-cloud-openclaw",
      "nemoclaw-status:e2e-ubuntu-repo-cloud-openclaw",
    ]);
    expect(runner.calls.map((call) => ({ command: call.command, args: call.args }))).toEqual([
      {
        command: "docker",
        args: [
          "ps",
          "-a",
          "--filter",
          "label=openshell.ai/sandbox-name=e2e-ubuntu-repo-cloud-openclaw",
          "--format",
          "{{.Names}}",
        ],
      },
      {
        command: "docker",
        args: ["stop", "openshell-cluster-e2e-ubuntu-repo-cloud-openclaw"],
      },
      {
        command: "nemoclaw",
        args: ["e2e-ubuntu-repo-cloud-openclaw", "status"],
      },
    ]);
    expect(cleanup.calls.map((call) => call.name)).toEqual([
      "lifecycle.docker-start:openshell-cluster-e2e-ubuntu-repo-cloud-openclaw",
    ]);
  });

  it("tolerates a non-zero status exit (the bug succeeds at destroying state)", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "container-1\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(1, "Removed stale local registry entry.\n")); // status non-zero
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).simulate("post-reboot-recovery", instance());

    // simulate() does not throw; the post-status invariants belong
    // to the state-validation phase that runs after.
    expect(result.steps.find((step) => step.id.startsWith("nemoclaw-status:"))).toBeTruthy();
  });

  it("fails when no Docker container carries the OpenShell sandbox-name label", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "\n")); // discover returns nothing
    const cleanup = new FakeCleanup();

    await expect(
      fixture(runner, cleanup).simulate("post-reboot-recovery", instance()),
    ).rejects.toThrow(/expected at least one Docker container labeled/);
  });

  it("fails when docker discover returns non-zero", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Cannot connect to the Docker daemon"));
    const cleanup = new FakeCleanup();

    await expect(
      fixture(runner, cleanup).simulate("post-reboot-recovery", instance()),
    ).rejects.toThrow(/could not query Docker for label/);
  });
});

describe("LifecyclePhaseFixture.simulate post-reboot-recovery (rename-to-gpu-backup)", () => {
  it("stops, then renames the labeled container to a *-nemoclaw-gpu-backup-* sibling", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "openshell-cluster-e2e-x\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(0)); // docker rename
    runner.enqueue(shellResult(1, "Removed stale local registry entry.\n")); // status
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).simulate(
      "post-reboot-recovery",
      instance({ sandboxName: "e2e-x" }),
      { mode: "rename-to-gpu-backup" },
    );

    expect(result.steps.map((step) => step.id.split("->")[0])).toContain(
      "docker-rename:openshell-cluster-e2e-x",
    );
    const renameCall = runner.calls.find(
      (call) => call.command === "docker" && call.args[0] === "rename",
    );
    expect(renameCall).toBeTruthy();
    expect(renameCall!.args[1]).toBe("openshell-cluster-e2e-x");
    expect(renameCall!.args[2]).toMatch(/^openshell-cluster-e2e-x-nemoclaw-gpu-backup-\d+$/);

    // Cleanup queue now has both docker-start and docker-rename-back.
    expect(cleanup.calls.map((call) => call.name.split(":")[0])).toEqual([
      "lifecycle.docker-start",
      "lifecycle.docker-rename-back",
    ]);
  });
});

describe("LifecyclePhaseFixture gateway runtime restart helpers", () => {
  it("stops PID/container runtimes, starts the previous runtime shape, and polls health", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "12345\n")); // resolveHostRuntime pid probe
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(0)); // gateway stop
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0)); // container stop
    runner.enqueue(shellResult(1, "")); // expectHostRuntimeStopped pid probe
    runner.enqueue(shellResult(0, "")); // expectHostRuntimeStopped container probe
    runner.enqueue(shellResult(0)); // lifecycle-gateway-stopped true artifact
    runner.enqueue(shellResult(0, "status recovered\n")); // start through nemoclaw status
    runner.enqueue(shellResult(0, "Connected to nemoclaw\n")); // waitForGatewayConnected
    const cleanup = new FakeCleanup();
    const host = new HostCliClient(runner);
    const sandbox = new SandboxClient(runner);
    const fx = new LifecyclePhaseFixture(host, sandbox, cleanup, new GatewayClient(host, sandbox));

    await expect(fx.restartGatewayRuntime({ delayMs: 0 })).resolves.toEqual({
      kind: "pid",
      id: "12345",
    });
    await fx.waitForGatewayConnected({ attempts: 1, intervalMs: 1 });

    expect(runner.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      expect.stringContaining("sh -lc pid_file="),
      "sh -lc command -v openshell >/dev/null 2>&1 && openshell forward stop 18789 || true",
      "sh -lc command -v openshell >/dev/null 2>&1 && openshell gateway stop -g nemoclaw || true",
      expect.stringContaining("sh -lc pid_file="),
      expect.stringContaining("sh -lc cid="),
      expect.stringContaining("sh -lc pid_file="),
      "docker ps -qf name=openshell-cluster-nemoclaw",
      "true ",
      "nemoclaw status",
      "openshell status",
    ]);
  });

  it("can recover a PID runtime through sandbox-specific status", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "status recovered\n"));
    const cleanup = new FakeCleanup();

    await expect(
      fixture(runner, cleanup).startGatewayRuntime(
        { kind: "pid", id: "12345" },
        {
          sandboxName: "e2e-survival",
        },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(runner.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "nemoclaw e2e-survival status",
    ]);
  });
});

describe("LifecyclePhaseFixture profile dispatch", () => {
  it("rejects unknown lifecycle profiles", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();

    await expect(
      // @ts-expect-error — exhaustiveness check
      fixture(runner, cleanup).simulate("not-a-profile", instance()),
    ).rejects.toThrow(/Unsupported lifecycle profile/);
  });

  it("exposes the lifecycle phase on the Vitest scenario context", () => {
    expectTypeOf<E2EScenarioFixtures["lifecycle"]>().toEqualTypeOf<LifecyclePhaseFixture>();
  });
});

describe("buildBackupContainerName", () => {
  it("appends -nemoclaw-gpu-backup-<ts> to the original name", () => {
    expect(buildBackupContainerName("openshell-cluster-foo", 1717280000000)).toBe(
      "openshell-cluster-foo-nemoclaw-gpu-backup-1717280000000",
    );
  });

  it("truncates the original name to fit within Docker's 253-char limit", () => {
    const longName = "a".repeat(253);
    const result = buildBackupContainerName(longName, 1717280000000);
    expect(result.length).toBeLessThanOrEqual(253);
    expect(result.endsWith("-nemoclaw-gpu-backup-1717280000000")).toBe(true);
  });
});
