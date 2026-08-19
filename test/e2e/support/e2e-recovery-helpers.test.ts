// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CommandRunner } from "../fixtures/clients/index.ts";
import { GatewayClient, HostCliClient, SandboxClient } from "../fixtures/clients/index.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import { startTestProgress, type TestProgress } from "../fixtures/progress.ts";
import { redactString } from "../fixtures/redaction.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";
import { ShellProbe, trustedShellCommand } from "../fixtures/shell-probe.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

interface ScriptedReply {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
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

  constructor(private readonly observe?: (call: RunnerCall, reply: ScriptedReply) => void) {}

  queue(...replies: ScriptedReply[]): void {
    this.replies.push(...replies);
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    const call = { command: command.command, args: [...command.args], options };
    this.calls.push(call);
    const reply = this.replies.shift() ?? {};
    this.observe?.(call, reply);
    return {
      command: [command.command, ...command.args],
      exitCode: reply.exitCode ?? 0,
      signal: reply.signal ?? null,
      timedOut: reply.timedOut ?? false,
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

class LocalGuardChainRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  readonly results: ShellProbeResult[] = [];
  private readonly probe: ShellProbe;
  private readonly progress: TestProgress;

  constructor(
    private readonly proxyEnvPath: string,
    artifactRoot: string,
  ) {
    this.progress = startTestProgress(
      "Guard-chain extraction support",
      ["run guard-chain marker check", "verify guard-chain sentinel"],
      { logLine: () => undefined },
    );
    this.probe = new ShellProbe({
      artifacts: new ArtifactSink(artifactRoot),
      progress: this.progress,
      redact: redactString,
      signal: new AbortController().signal,
    });
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    const call = { command: command.command, args: [...command.args], options };
    this.calls.push(call);
    const separator = command.args.indexOf("--");
    expect(separator).toBeGreaterThanOrEqual(0);
    const [innerCommand, ...innerArgs] = command.args.slice(separator + 1);
    expect(innerCommand).toBeTruthy();
    const localArgs = innerArgs.map((argument) =>
      argument.replaceAll("/tmp/nemoclaw-proxy-env.sh", this.proxyEnvPath),
    );
    const result = await this.probe.run(
      trustedShellCommand({
        command: innerCommand!,
        args: localArgs,
        reason: "exercise the generated guard-chain marker check",
      }),
      options,
    );
    this.results.push(result);
    return result;
  }

  stop(): void {
    this.progress.stop();
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

function buildGateway(runner: CommandRunner): GatewayClient {
  const host = new HostCliClient(runner, { cliPath: "nemoclaw" });
  const sandbox = new SandboxClient(runner);
  return new GatewayClient(host, sandbox);
}

describe("GatewayClient recovery helpers (#2701)", () => {
  describe("waitForMissingManagedSupervisor", () => {
    it("waits for the exact missing-supervisor proof and a quiet settle", async () => {
      const events: string[] = [];
      const runner = new ScriptedRunner((_call, reply) => {
        events.push(
          reply.stderr === "SUPERVISOR_NOT_RUNNING\n" ? "probe-not-running" : "probe-unavailable",
        );
      });
      runner.queue(
        {
          exitCode: 1,
          stderr: "SUPERVISOR_UNAVAILABLE\nNEMOCLAW_CONTROL_STAGE=discover-supervisor\n",
        },
        { exitCode: 1, stderr: "SUPERVISOR_NOT_RUNNING\n" },
        { exitCode: 1, stderr: "SUPERVISOR_NOT_RUNNING\n" },
      );
      const gateway = buildGateway(runner);
      const sleep = vi.fn(async (milliseconds: number) => {
        events.push(`sleep-${milliseconds}`);
      });
      const onRetry = vi.fn();

      await gateway.waitForMissingManagedSupervisor("container-123", {
        attempts: 3,
        delayMs: 3_000,
        settleMs: 3_000,
        sleep,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledOnce();
      expect(onRetry).toHaveBeenCalledWith(1);
      expect(events).toEqual([
        "probe-unavailable",
        "sleep-3000",
        "probe-not-running",
        "sleep-3000",
        "probe-not-running",
      ]);
      expect(runner.calls).toHaveLength(3);
      runner.calls.forEach((call) => {
        expect(call.command).toBe("docker");
        expect(call.args.slice(0, -1)).toEqual([
          "exec",
          "--env",
          "LD_PRELOAD=",
          "--env",
          "PYTHONPATH=",
          "--user",
          "root",
          "container-123",
          "/usr/local/bin/nemoclaw-gateway-control",
          "probe",
        ]);
        expect(call.args.at(-1)).toMatch(/^[0-9a-f]{64}$/);
      });
    });

    it("does not accept a composite missing-supervisor diagnostic", async () => {
      const runner = new ScriptedRunner();
      runner.queue({
        exitCode: 1,
        stderr: "SUPERVISOR_NOT_RUNNING\nNEMOCLAW_CONTROL_STAGE=discover-supervisor\n",
      });
      const gateway = buildGateway(runner);

      await expect(
        gateway.waitForMissingManagedSupervisor("container-123", {
          attempts: 1,
          delayMs: 0,
          settleMs: 0,
        }),
      ).rejects.toThrow(/polling exhausted/);
    });

    it("does not accept missing-supervisor output with stdout", async () => {
      const runner = new ScriptedRunner();
      runner.queue({
        exitCode: 1,
        stdout: "unexpected output\n",
        stderr: "SUPERVISOR_NOT_RUNNING\n",
      });
      const gateway = buildGateway(runner);

      await expect(
        gateway.waitForMissingManagedSupervisor("container-123", {
          attempts: 1,
          delayMs: 0,
          settleMs: 0,
        }),
      ).rejects.toThrow(/polling exhausted/);
    });

    it.each([
      { condition: "timed out", reply: { timedOut: true } },
      { condition: "was terminated by a signal", reply: { signal: "SIGTERM" as const } },
    ])("does not accept a probe that $condition", async ({ reply }) => {
      const runner = new ScriptedRunner();
      runner.queue({ exitCode: 1, stderr: "SUPERVISOR_NOT_RUNNING\n", ...reply });
      const gateway = buildGateway(runner);

      await expect(
        gateway.waitForMissingManagedSupervisor("container-123", {
          attempts: 1,
          delayMs: 0,
          settleMs: 0,
        }),
      ).rejects.toThrow(/polling exhausted/);
    });

    it("retries when supervisor absence changes during the settle interval", async () => {
      const runner = new ScriptedRunner();
      runner.queue(
        { exitCode: 1, stderr: "SUPERVISOR_NOT_RUNNING\n" },
        { exitCode: 0, stdout: "SUPERVISOR_RUNNING\n" },
        { exitCode: 1, stderr: "SUPERVISOR_NOT_RUNNING\n" },
        { exitCode: 0, stdout: "SUPERVISOR_RUNNING\n" },
      );
      const gateway = buildGateway(runner);
      const sleep = vi.fn(async () => undefined);
      const onRetry = vi.fn();

      await expect(
        gateway.waitForMissingManagedSupervisor("container-123", {
          attempts: 2,
          delayMs: 0,
          settleMs: 3_000,
          sleep,
          onRetry,
        }),
      ).rejects.toThrow(/polling exhausted/);

      expect(sleep).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1);
      expect(onRetry).toHaveBeenNthCalledWith(2, 2);
      expect(runner.calls).toHaveLength(4);
    });
  });

  describe("expectGuardChainActive", () => {
    it("returns only the fixed sentinel and excludes an opaque credential from results and artifacts", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-chain-proof-"));
      const proxyEnvPath = path.join(tmp, "proxy-env.sh");
      const opaqueValue = "opaqueMintedGatewayMaterial_7qR2v9XcL4n8";
      const expectedMarkers = [
        "nemoclaw-sandbox-safety-net",
        "nemoclaw-ciao-network-guard",
        "-leading",
        "literal;$(false)",
      ];
      const proxyEnv =
        'export NODE_OPTIONS="--require /tmp/nemoclaw-sandbox-safety-net.js ' +
        '--require /tmp/nemoclaw-ciao-network-guard.js -leading literal;$(false)"\n' +
        `export HTTPS_PROXY="http://gateway-user:${opaqueValue}@127.0.0.1:3128"\n`;
      expect(redactString(proxyEnv)).toBe(proxyEnv);
      fs.writeFileSync(proxyEnvPath, proxyEnv, { mode: 0o600 });
      const runner = new LocalGuardChainRunner(proxyEnvPath, path.join(tmp, "artifacts"));
      const gateway = buildGateway(runner);

      try {
        await gateway.expectGuardChainActive(fakeInstance(), { expectedMarkers });

        const result = runner.results.at(-1);
        expect(result).toMatchObject({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "NEMOCLAW_GUARD_CHAIN_ACTIVE\n",
          stderr: "",
        });
        const call = runner.calls.at(-1);
        const separator = call?.args.indexOf("--") ?? -1;
        const innerArgs = call?.args.slice(separator + 1) ?? [];
        expect(innerArgs.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(innerArgs.slice(4)).toEqual([
          "/tmp/nemoclaw-proxy-env.sh",
          "NEMOCLAW_GUARD_CHAIN_ACTIVE",
          ...expectedMarkers,
        ]);
        expect(JSON.stringify(result)).not.toContain(opaqueValue);
        expect(JSON.stringify(result)).not.toMatch(/<REDACTED>|\[REDACTED\]/u);
        const artifacts = result!.artifacts;
        const artifactContents =
          fs.readFileSync(artifacts.stdout, "utf8") +
          fs.readFileSync(artifacts.stderr, "utf8") +
          fs.readFileSync(artifacts.result, "utf8");
        expect(artifactContents).not.toContain(opaqueValue);
        expect(artifactContents).not.toMatch(/<REDACTED>|\[REDACTED\]/u);

        fs.writeFileSync(
          proxyEnvPath,
          proxyEnv.replace("literal;$(false)", "missing-custom-marker"),
        );
        await expect(
          gateway.expectGuardChainActive(fakeInstance(), { expectedMarkers }),
        ).rejects.toThrow(/missing an expected marker/);
        const failedResult = runner.results.at(-1);
        expect(failedResult).toMatchObject({ stdout: "", stderr: "" });
        expect(JSON.stringify(failedResult)).not.toContain(opaqueValue);
        expect(JSON.stringify(failedResult)).not.toMatch(/<REDACTED>|\[REDACTED\]/u);
        const failedArtifacts = failedResult!.artifacts;
        const failedArtifactContents =
          fs.readFileSync(failedArtifacts.stdout, "utf8") +
          fs.readFileSync(failedArtifacts.stderr, "utf8") +
          fs.readFileSync(failedArtifacts.result, "utf8");
        expect(failedArtifactContents).not.toContain(opaqueValue);
        expect(failedArtifactContents).not.toMatch(/<REDACTED>|\[REDACTED\]/u);
      } finally {
        runner.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("passes only when the sandbox returns the fixed guard-chain sentinel", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "NEMOCLAW_GUARD_CHAIN_ACTIVE\n" });
      const gateway = buildGateway(runner);

      await gateway.expectGuardChainActive(fakeInstance());

      const separator = runner.calls[0]?.args.indexOf("--") ?? -1;
      expect(runner.calls[0]?.args.slice(separator + 4)).toEqual([
        "nemoclaw-guard-chain-proof",
        "/tmp/nemoclaw-proxy-env.sh",
        "NEMOCLAW_GUARD_CHAIN_ACTIVE",
        "nemoclaw-sandbox-safety-net",
        "nemoclaw-ciao-network-guard",
      ]);
    });

    it("fails when proxy-env.sh is empty (post pod-recreate target)", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ exitCode: 20 });
      const gateway = buildGateway(runner);

      await expect(gateway.expectGuardChainActive(fakeInstance())).rejects.toThrow(
        /missing, unreadable, or empty/,
      );
    });

    it("fails when proxy-env.sh exists but a marker is absent", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ exitCode: 21 });
      const gateway = buildGateway(runner);

      await expect(gateway.expectGuardChainActive(fakeInstance())).rejects.toThrow(
        /missing an expected marker/,
      );
    });

    it("honors a caller-supplied marker list", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "NEMOCLAW_GUARD_CHAIN_ACTIVE\n" });
      const gateway = buildGateway(runner);

      await gateway.expectGuardChainActive(fakeInstance(), {
        expectedMarkers: ["nemoclaw-slack-channel-guard"],
      });

      expect(runner.calls[0]?.args.at(-1)).toBe("nemoclaw-slack-channel-guard");
    });

    it.each([
      { condition: "an empty marker list", expectedMarkers: [] },
      { condition: "an empty marker value", expectedMarkers: [""] },
      {
        condition: "a marker with a line feed",
        expectedMarkers: ["nemoclaw-sandbox-safety-net\n"],
      },
      {
        condition: "a marker with a carriage return",
        expectedMarkers: ["nemoclaw-sandbox-safety-net\r"],
      },
    ])("rejects $condition before running a sandbox command", async ({ expectedMarkers }) => {
      const runner = new ScriptedRunner();
      const gateway = buildGateway(runner);

      await expect(
        gateway.expectGuardChainActive(fakeInstance(), { expectedMarkers }),
      ).rejects.toThrow(
        /expectedMarkers must be a non-empty list of non-empty single-line markers/,
      );
      expect(runner.calls).toHaveLength(0);
    });

    it.each([
      { condition: "returns a nonzero exit", reply: { exitCode: 1 } },
      { condition: "times out", reply: { timedOut: true } },
      { condition: "is terminated", reply: { signal: "SIGTERM" as const } },
      { condition: "omits stdout", reply: { stdout: "" } },
      { condition: "adds stdout", reply: { stdout: "NEMOCLAW_GUARD_CHAIN_ACTIVE\nextra\n" } },
      {
        condition: "adds stderr",
        reply: { stdout: "NEMOCLAW_GUARD_CHAIN_ACTIVE\n", stderr: "unexpected\n" },
      },
    ])("rejects a guard-chain check that $condition", async ({ reply }) => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "NEMOCLAW_GUARD_CHAIN_ACTIVE\n", ...reply });
      const gateway = buildGateway(runner);

      await expect(gateway.expectGuardChainActive(fakeInstance())).rejects.toThrow(
        /guard-chain check was invalid/,
      );
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

    it("returns the recorded PID and process start identity together", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "1234 987654 987654 S\n" });
      const gateway = buildGateway(runner);

      await expect(gateway.resolveGatewayIdentity(fakeInstance())).resolves.toEqual({
        pid: 1234,
        startIdentity: "987654",
      });
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
      await expect(observation).resolves.toEqual({ pid: 100, startIdentity: "111" });
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
      ).rejects.toThrow(/identity changed 100:111→201:222.*crash-loop/);
      await vi.runAllTimersAsync();
      await observation;
    });

    it("throws when a numeric PID is reused by a different process identity", async () => {
      const runner = new ScriptedRunner();
      runner.queue({ stdout: "100 111 111 S\n" }, { stdout: "100 222 222 S\n" });
      const gateway = buildGateway(runner);

      const observation = expect(
        gateway.expectPidStable(fakeInstance(), {
          durationSeconds: 2,
          pollIntervalSeconds: 1,
        }),
      ).rejects.toThrow(/identity changed 100:111→100:222.*crash-loop/);
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
  it("wipeGuardChain removes the five guard files plus proxy-env.sh", async () => {
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
    expect(removeArgs).toContain("/tmp/nemoclaw-nemotron-inference-fix.js");
  });

  it("wipeGuardChain throws when the sandbox returns a non-zero exit", async () => {
    const runner = new ScriptedRunner();
    runner.queue({ exitCode: 1, stderr: "permission denied" });
    const sandbox = new SandboxClient(runner);

    await expect(sandbox.wipeGuardChain("e2e-2701")).rejects.toThrow(/wipe guard chain/);
  });

  it("killGatewayTree kills the observed OpenClaw tree without racing its watchdog", async () => {
    const runner = new ScriptedRunner();
    const sandbox = new SandboxClient(runner);

    await sandbox.killGatewayTree("e2e-2701");

    expect(runner.calls).toHaveLength(1);
    const args = runner.calls[0]?.args ?? [];
    const script = args[args.length - 1];
    expect(script).toBe("pkill -9 -f '[o]penclaw'");
  });

  it("killGatewayTree throws when no OpenClaw process was killed", async () => {
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
