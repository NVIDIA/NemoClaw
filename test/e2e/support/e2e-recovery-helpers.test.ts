// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../fixtures/clients/index.ts";
import { GatewayClient, HostCliClient, SandboxClient } from "../fixtures/clients/index.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
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

interface ScriptedReply {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

/**
 * Test runner that returns scripted replies in order. Each `run()` call
 * advances through the queue; falls back to a benign success once exhausted.
 *
 * Designed for the recovery helpers because they issue multiple shell
 * probes per assertion (e.g. `expectPidStable` polls N times) and the
 * test needs to control each reply independently.
 */
class ScriptedRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  private replies: ScriptedReply[] = [];

  queue(...replies: ScriptedReply[]): void {
    this.replies.push(...replies);
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    const reply = this.replies.shift() ?? {};
    return {
      command: [command.command, ...command.args],
      exitCode: reply.exitCode ?? 0,
      signal: null,
      timedOut: false,
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
      artifacts: {
        stdout: "/tmp/stdout.txt",
        stderr: "/tmp/stderr.txt",
        result: "/tmp/result.json",
      },
    };
  }
}

function fakeInstance(sandboxName = "e2e-2701"): NemoClawInstance {
  return {
    onboarding: "openclaw-nvidia",
    sandboxName,
    agent: "openclaw",
    provider: "nvidia",
    providerEnv: "cloud",
    platformOs: "ubuntu",
    gatewayUrl: "https://localhost:18789",
    result: {
      command: ["nemoclaw", "onboard"],
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      artifacts: { stdout: "", stderr: "", result: "" },
    },
  };
}

function buildGateway(runner: ScriptedRunner): GatewayClient {
  const host = new HostCliClient(runner, { cliPath: "nemoclaw" });
  const sandbox = new SandboxClient(runner);
  return new GatewayClient(host, sandbox);
}

describe("GatewayClient recovery helpers (#2701)", () => {
  describe("expectGuardChainActive", () => {
    it("passes when proxy-env.sh contains the default safety-net + ciao markers", async () => {
      const runner = new ScriptedRunner();
      runner.queue({
        stdout:
          'export NODE_OPTIONS="--require /tmp/nemoclaw-sandbox-safety-net.js ' +
          '--require /tmp/nemoclaw-ciao-network-guard.js"\n',
      });
      const gateway = buildGateway(runner);

      await gateway.expectGuardChainActive(fakeInstance());

      expect(runner.calls[0]?.args.slice(-1)[0]).toContain("cat /tmp/nemoclaw-proxy-env.sh");
    });

    it("fails when proxy-env.sh is empty (post pod-recreate target)", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "" });
      const gateway = buildGateway(runner);

      await expect(gateway.expectGuardChainActive(fakeInstance())).rejects.toThrow(
        /missing or empty/,
      );
    });

    it("fails when proxy-env.sh exists but a marker is absent", async () => {
      const runner = new ScriptedRunner();
      runner.queue({
        stdout: 'export NODE_OPTIONS="--require /tmp/nemoclaw-sandbox-safety-net.js"\n',
      });
      const gateway = buildGateway(runner);

      await expect(gateway.expectGuardChainActive(fakeInstance())).rejects.toThrow(
        /missing markers.*nemoclaw-ciao-network-guard/,
      );
    });

    it("honors a caller-supplied marker list", async () => {
      const runner = new ScriptedRunner();
      runner.queue({
        stdout: 'export NODE_OPTIONS="--require /tmp/nemoclaw-slack-channel-guard.js"\n',
      });
      const gateway = buildGateway(runner);

      await gateway.expectGuardChainActive(fakeInstance(), {
        expectedMarkers: ["nemoclaw-slack-channel-guard"],
      });
    });
  });

  describe("expectLogContains / expectLogDoesNotContain", () => {
    it("expectLogContains passes when the tail matches", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "[gateway-recovery] WARNING: /tmp/nemoclaw-proxy-env.sh missing\n" });
      const gateway = buildGateway(runner);

      await gateway.expectLogContains(fakeInstance(), /\[gateway-recovery\] WARNING/);
    });

    it("expectLogContains fails when the tail does not match", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "boring log line\n" });
      const gateway = buildGateway(runner);

      await expect(
        gateway.expectLogContains(fakeInstance(), /\[gateway-recovery\] WARNING/),
      ).rejects.toThrow(/did not match/);
    });

    it("expectLogDoesNotContain passes when the tail is clean", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "openclaw started\n" });
      const gateway = buildGateway(runner);

      await gateway.expectLogDoesNotContain(fakeInstance(), /\[gateway-recovery\] WARNING/);
    });

    it("expectLogDoesNotContain fails when the forbidden marker appears", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "[gateway-recovery] WARNING\n" });
      const gateway = buildGateway(runner);

      await expect(
        gateway.expectLogDoesNotContain(fakeInstance(), /\[gateway-recovery\] WARNING/),
      ).rejects.toThrow(/unexpectedly matched/);
    });

    it("rejects non-positive line counts", async () => {
      const runner = new ScriptedRunner();
      const gateway = buildGateway(runner);

      await expect(gateway.expectLogContains(fakeInstance(), /x/, { lines: 0 })).rejects.toThrow(
        /positive integer/,
      );
    });
  });

  describe("resolveGatewayPid", () => {
    it("accepts the recorded PID when its process start identity still matches", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "1234 987654 987654 S\n" });
      const gateway = buildGateway(runner);

      await expect(gateway.resolveGatewayPid(fakeInstance())).resolves.toBe(1234);
    });

    it("returns null when the PID probe fails despite valid-looking output", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ exitCode: 1, stdout: "1234 987654 987654 S\n" });
      const gateway = buildGateway(runner);

      await expect(gateway.resolveGatewayPid(fakeInstance())).resolves.toBeNull();
    });

    it("rejects a reused PID whose process start identity no longer matches", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "1234 987654 123456 S\n" });
      const gateway = buildGateway(runner);

      await expect(gateway.resolveGatewayPid(fakeInstance())).resolves.toBeNull();
    });

    it.each(["Z", "X"])("rejects a gateway process in terminal state %s", async (state) => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: `1234 987654 987654 ${state}\n` });
      const gateway = buildGateway(runner);

      await expect(gateway.resolveGatewayPid(fakeInstance())).resolves.toBeNull();
    });

    it("returns null when the script prints non-numeric output", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "" });
      const gateway = buildGateway(runner);

      await expect(gateway.resolveGatewayPid(fakeInstance())).resolves.toBeNull();
    });
  });

  describe("expectPidStable", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("returns the PID when it is stable across all samples", async () => {
      const runner = new ScriptedRunner();
      // initial sample + 3 stable samples
      runner.queue(
        { stdout: "100 111 111 S\n" },
        { stdout: "100 111 111 S\n" },
        { stdout: "100 111 111 S\n" },
        { stdout: "100 111 111 S\n" },
      );
      const gateway = buildGateway(runner);

      const observation = gateway.expectPidStable(fakeInstance(), {
        durationSeconds: 3,
        pollIntervalSeconds: 1,
      });
      await vi.runAllTimersAsync();
      await expect(observation).resolves.toBe(100);
    });

    it("throws when the PID changes (crash-loop)", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "100 111 111 S\n" }, { stdout: "201 222 222 S\n" });
      const gateway = buildGateway(runner);

      const observation = expect(
        gateway.expectPidStable(fakeInstance(), {
          durationSeconds: 2,
          pollIntervalSeconds: 1,
        }),
      ).rejects.toThrow(/PID changed 100→201.*crash-loop/);
      await vi.runAllTimersAsync();
      await observation;
    });

    it("throws when the gateway disappears mid-window", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "100 111 111 S\n" }, { stdout: "" });
      const gateway = buildGateway(runner);

      const observation = expect(
        gateway.expectPidStable(fakeInstance(), {
          durationSeconds: 2,
          pollIntervalSeconds: 1,
        }),
      ).rejects.toThrow(/gateway disappeared/);
      await vi.runAllTimersAsync();
      await observation;
    });

    it("throws when no gateway exists at the start of the window", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "" });
      const gateway = buildGateway(runner);

      await expect(
        gateway.expectPidStable(fakeInstance(), {
          durationSeconds: 1,
          pollIntervalSeconds: 1,
        }),
      ).rejects.toThrow(/no gateway process.*at start/);
    });

    it.each([
      {
        name: "zero duration",
        durationSeconds: 0,
        pollIntervalSeconds: 1,
        message: /durationSeconds must be > 0/,
      },
      {
        name: "NaN duration",
        durationSeconds: Number.NaN,
        pollIntervalSeconds: 1,
        message: /durationSeconds must be > 0/,
      },
      {
        name: "infinite duration",
        durationSeconds: Number.POSITIVE_INFINITY,
        pollIntervalSeconds: 1,
        message: /durationSeconds must be > 0/,
      },
      {
        name: "zero poll interval",
        durationSeconds: 1,
        pollIntervalSeconds: 0,
        message: /pollIntervalSeconds must be > 0/,
      },
      {
        name: "NaN poll interval",
        durationSeconds: 1,
        pollIntervalSeconds: Number.NaN,
        message: /pollIntervalSeconds must be > 0/,
      },
      {
        name: "infinite poll interval",
        durationSeconds: 1,
        pollIntervalSeconds: Number.POSITIVE_INFINITY,
        message: /pollIntervalSeconds must be > 0/,
      },
    ])("rejects $name before any probe or timer", async (options) => {
      const runner = new ScriptedRunner();
      const gateway = buildGateway(runner);

      await expect(gateway.expectPidStable(fakeInstance(), options)).rejects.toThrow(
        options.message,
      );
      expect(runner.calls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("SandboxClient disruption helpers (#2701)", () => {
  it("wipeGuardChain removes the seven guard files plus proxy-env.sh", async () => {
    const runner = new ScriptedRunner();
    const sandbox = new SandboxClient(runner);

    await sandbox.wipeGuardChain("e2e-2701");

    const call = runner.calls[0];
    expect(call?.args).toContain("--");
    const removeArgs = call?.args.slice(call.args.indexOf("--") + 1) ?? [];
    expect(removeArgs[0]).toBe("rm");
    expect(removeArgs[1]).toBe("-f");
    expect(removeArgs).toContain("/tmp/nemoclaw-proxy-env.sh");
    expect(removeArgs).toContain("/tmp/nemoclaw-ciao-network-guard.js");
    expect(removeArgs).toContain("/tmp/nemoclaw-sandbox-safety-net.js");
    expect(removeArgs).toContain("/tmp/nemoclaw-slack-channel-guard.js");
    expect(removeArgs).toContain("/tmp/nemoclaw-http-proxy-fix.js");
    expect(removeArgs).toContain("/tmp/nemoclaw-ws-proxy-fix.js");
    expect(removeArgs).toContain("/tmp/nemoclaw-nemotron-inference-fix.js");
    expect(removeArgs).toContain("/tmp/nemoclaw-seccomp-guard.js");
  });

  it("wipeGuardChain throws when the sandbox returns a non-zero exit", async () => {
    const runner = new ScriptedRunner();
    runner.queue({ exitCode: 1, stderr: "permission denied" });
    const sandbox = new SandboxClient(runner);

    await expect(sandbox.wipeGuardChain("e2e-2701")).rejects.toThrow(/wipe guard chain/);
  });

  it("killGatewayTree pkills the openclaw tree and verifies nothing remains", async () => {
    const runner = new ScriptedRunner();
    const sandbox = new SandboxClient(runner);

    await sandbox.killGatewayTree("e2e-2701");

    const args = runner.calls[0]?.args ?? [];
    const script = args[args.length - 1];
    expect(script).toContain("pkill -9 -f '[o]penclaw'");
    expect(script).toContain("pgrep -af '[o]penclaw'");
  });

  it("killGatewayTree throws if openclaw processes survive the kill", async () => {
    const runner = new ScriptedRunner();
    runner.queue({ exitCode: 1 });
    const sandbox = new SandboxClient(runner);

    await expect(sandbox.killGatewayTree("e2e-2701")).rejects.toThrow(/kill gateway tree/);
  });

  it("rejects sandbox names that fail validation", async () => {
    const runner = new ScriptedRunner();
    const sandbox = new SandboxClient(runner);

    await expect(sandbox.wipeGuardChain("../bad")).rejects.toThrow(/sandbox name is invalid/);
    await expect(sandbox.killGatewayTree("../bad")).rejects.toThrow(/sandbox name is invalid/);
  });
});
