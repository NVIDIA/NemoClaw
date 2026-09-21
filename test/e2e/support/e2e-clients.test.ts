// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  assertExitCode,
  assertExitZero,
  type CommandRunner,
  GatewayClient,
  HISTORICAL_SANDBOX_MAIN_PROCESS,
  HostCliClient,
  ProviderClient,
  SandboxClient,
  StateClient,
  shellQuote,
  type TrustedSandboxShellScript,
  trustedProviderEndpoint,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/index.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { assertCleanupPassed, CleanupRegistry } from "../fixtures/cleanup.ts";
import { ShellProbe, trustedShellCommand } from "../fixtures/shell-probe.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";
import { LAUNCH_TURN_SCRIPT, runOpenClawLaunchSession } from "../live/launch-agent-turn.ts";
import { precleanSandbox, sandboxShWithArgs } from "../live/phase6-messaging-helpers.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

type FakeRunnerResponse = Partial<
  Pick<ShellProbeResult, "exitCode" | "signal" | "stderr" | "stdout" | "timedOut">
>;

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  readonly responses: FakeRunnerResponse[] = [];
  stdout = "";
  stderr = "";
  exitCode: number | null = 0;
  signal: NodeJS.Signals | null = null;

  enqueue(response: FakeRunnerResponse): void {
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
    return {
      command: [command.command, ...command.args],
      exitCode: response?.exitCode === undefined ? this.exitCode : response.exitCode,
      signal: response?.signal === undefined ? this.signal : response.signal,
      timedOut: response?.timedOut ?? false,
      stdout: response?.stdout ?? this.stdout,
      stderr: response?.stderr ?? this.stderr,
      artifacts: {
        stdout: "/tmp/stdout.txt",
        stderr: "/tmp/stderr.txt",
        result: "/tmp/result.json",
      },
    };
  }
}

describe("E2E fixture clients", () => {
  it("keeps historical rebuild sandboxes alive until the rebuild owns their lifecycle", () => {
    expect(HISTORICAL_SANDBOX_MAIN_PROCESS).toEqual(["sleep", "infinity"]);
  });

  it.each([
    "a2345678901234567890",
    "e2e--sandbox",
    "1e2e-sandbox",
    "E2e-sandbox",
    "e2e.sandbox",
    "e2e_sandbox",
  ])("enforces the OpenShell 0.0.99 sandbox identity boundary [%s] (#8497)", (invalidName) => {
    expect(() => validateSandboxName("a234567890123456789")).not.toThrow();

    expect(() => validateSandboxName(invalidName), invalidName).toThrow(
      /sandbox name is invalid for fixture client/,
    );
  });

  it.each([
    { stdin: undefined, expectedTimeout: false, expectedOutput: "EOF" },
    { stdin: "open-pipe" as const, expectedTimeout: true, expectedOutput: "" },
    { stdin: { text: "" }, expectedTimeout: false, expectedOutput: "EOF" },
    { stdin: { text: "PRIVATE_INPUT" }, expectedTimeout: false, expectedOutput: "[REDACTED]EOF" },
  ])(
    "keeps the configured host command's input open only when requested ($stdin)",
    async ({ stdin, expectedTimeout, expectedOutput }) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-host-stdin-"));
      const progress = startTestProgress("host stdin", ["run configured command", "verify input"], {
        logLine: () => undefined,
      });
      try {
        const probe = new ShellProbe({
          artifacts: new ArtifactSink(tmp),
          progress,
          redact: (text) => text,
          signal: new AbortController().signal,
        });
        const host = new HostCliClient(probe, { cliPath: process.execPath });
        progress.phase("run configured command");
        const result = await host.nemoclaw(
          [
            "-e",
            "process.stdin.on('data', data => process.stdout.write(data)); process.stdin.on('end', () => console.log('EOF'));",
          ],
          { stdin, timeoutMs: 2_000, persistArtifacts: false, redactionValues: ["PRIVATE_INPUT"] },
        );
        progress.phase("verify input");
        expect(result.timedOut).toBe(expectedTimeout);
        expect(result.stdout.trim()).toBe(expectedOutput);
      } finally {
        progress.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("host client runs the configured NemoClaw CLI", async () => {
    const runner = new FakeRunner();
    runner.stdout = "nemoclaw 0.1.0\n";
    const host = new HostCliClient(runner, { cliPath: "./bin/nemoclaw.js" });

    await host.expectNemoclawAvailable();

    expect(runner.calls).toEqual([
      {
        command: "./bin/nemoclaw.js",
        args: ["--version"],
        options: {
          artifactName: "nemoclaw-version",
          env: expect.objectContaining({
            PATH: expect.any(String),
          }),
        },
      },
    ]);
  });

  it("does not require a stock-image receipt for onboarding help", async () => {
    const runner = new FakeRunner();
    const host = new HostCliClient(runner);

    await expect(
      host.command("node", ["/workspace/bin/nemoclaw.js", "onboard", "--help"], {
        env: { E2E_MANAGED_IMAGE_REVISION: "a".repeat(40) },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it.each([
    { exitCode: 0, expected: true, label: "available" },
    { exitCode: 1, expected: false, label: "missing" },
  ])("host client reports a command as $label", async ({ exitCode, expected }) => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });
    const options = {
      artifactName: "cleanup-command-probe",
      env: { PATH: "/test/bin" },
      redactionValues: ["cleanup-secret"],
      timeoutMs: 123_000,
    };

    await expect(host.isCommandAvailable("openshell", options)).resolves.toBe(expected);
    expect(runner.calls).toEqual([
      {
        command: "bash",
        args: ["-lc", 'command -v "$1" >/dev/null 2>&1', "command-availability-probe", "openshell"],
        options,
      },
    ]);
  });

  it("host client surfaces an unexpected command availability failure", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 2, stderr: "shell probe failed" });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(host.isCommandAvailable("openshell")).rejects.toThrow(
      "probe command availability for openshell failed: shell probe failed",
    );
  });

  it("host client resolves the configured OpenShell command through the fixture child environment", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ stdout: "/home/runner/.local/bin/openshell\n" });
    const host = new HostCliClient(runner);

    await expect(host.resolveOpenShellCommandPath()).resolves.toBe(
      "/home/runner/.local/bin/openshell",
    );

    expect(host.openshellCommandPath).toBe("/home/runner/.local/bin/openshell");
    expect(runner.calls).toEqual([
      {
        command: "bash",
        args: ["-lc", 'command -v -- "$1"', "resolve-openshell-command", "openshell"],
        options: {
          artifactName: "resolve-openshell-command",
          env: expect.objectContaining({ PATH: expect.any(String) }),
          timeoutMs: 30_000,
        },
      },
    ]);
  });

  it.each([
    { label: "empty output", stdout: "" },
    { label: "a relative path", stdout: "openshell\n" },
    {
      label: "multiple absolute paths",
      stdout: "/home/runner/.local/bin/openshell\n/usr/bin/openshell\n",
    },
  ])("host client keeps its configured OpenShell command for $label", async ({ stdout }) => {
    const runner = new FakeRunner();
    runner.enqueue({ stdout });
    const host = new HostCliClient(runner);

    await expect(host.resolveOpenShellCommandPath()).rejects.toThrow(
      "resolve OpenShell command path failed: expected exactly one non-empty absolute path",
    );
    expect(host.openshellCommandPath).toBe("openshell");
  });

  it.each([
    { actualExecutable: "/opt/openshell", expected: true },
    { actualExecutable: "/usr/bin/python3", expected: false },
  ])(
    "host client verifies an exact ForwardTcp listener executable [expected=$expected]",
    async ({ actualExecutable, expected }) => {
      const runner = new FakeRunner();
      runner.enqueue({ stdout: "4321\n" });
      runner.enqueue({ stdout: "/usr/local/bin/openshell\n" });
      runner.enqueue({ stdout: `${actualExecutable}\n` });
      runner.enqueue({ stdout: "/opt/openshell\n" });
      runner.enqueue({
        stdout:
          "/usr/local/bin/openshell --gateway nemoclaw --gateway-endpoint https://127.0.0.1:8080 --workspace default forward service alpha --target-port 18789 --target-host 127.0.0.1 --local 127.0.0.1:18789\n",
      });
      runner.enqueue({ stdout: "4321\n" });
      const host = new HostCliClient(runner);

      await expect(host.inspectOpenShellForwardListener("18789", "alpha")).resolves.toMatchObject({
        valid: expected,
        ...(expected ? { pid: 4321 } : {}),
      });
    },
  );

  it("rejects a wrapper as the owner of a canonical OpenShell listener", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ stdout: "4321\n" });
    runner.enqueue({ stdout: "/tmp/openshell-wrapper\n" });
    runner.enqueue({ stdout: "/opt/openshell\n" });
    runner.enqueue({ stdout: "/tmp/openshell-wrapper\n" });
    runner.enqueue({
      stdout:
        "/tmp/openshell-wrapper --gateway nemoclaw --gateway-endpoint https://127.0.0.1:8080 --workspace default forward service alpha --target-port 18789 --target-host 127.0.0.1 --local 127.0.0.1:18789\n",
    });
    runner.enqueue({ stdout: "4321\n" });

    await expect(
      new HostCliClient(runner).inspectOpenShellForwardListener("18789", "alpha"),
    ).resolves.toMatchObject({ valid: false });
  });

  it("matches a forward listener against the caller's gateway and workspace", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ stdout: "4321\n" });
    runner.enqueue({ stdout: "/usr/local/bin/openshell\n" });
    runner.enqueue({ stdout: "/opt/openshell\n" });
    runner.enqueue({ stdout: "/opt/openshell\n" });
    runner.enqueue({
      stdout:
        "/usr/local/bin/openshell --gateway nemoclaw-19080 --gateway-endpoint https://127.0.0.1:19080 --workspace review forward service alpha --target-port 18789 --target-host 127.0.0.1 --local 127.0.0.1:18789\n",
    });
    runner.enqueue({ stdout: "4321\n" });

    await expect(
      new HostCliClient(runner).inspectOpenShellForwardListener("18789", "alpha", {
        env: {
          NEMOCLAW_GATEWAY_PORT: "19080",
          OPENSHELL_GATEWAY: "nemoclaw-19080",
          OPENSHELL_WORKSPACE: "review",
        },
      }),
    ).resolves.toMatchObject({ valid: true, pid: 4321 });
  });

  it("composes installation, OpenShell resolution, and launch in authority order", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ stdout: "installation complete\n" });
    runner.enqueue({ stdout: "/home/runner/.local/bin/openshell\n" });
    runner.enqueue({});
    const host = new HostCliClient(runner);
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    try {
      const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
        artifactName: "phase-1-install-sh",
      });
      expect(install.exitCode).toBe(0);
      await host.resolveOpenShellCommandPath();
      await runOpenClawLaunchSession({
        artifactName: "phase-4-openclaw-launch-turn",
        cliCommand: "nemoclaw",
        env: {},
        host,
        redactionValues: [],
        sandboxName: "alpha",
      });

      expect(runner.calls.map(({ args }) => args)).toEqual([
        ["install.sh", "--non-interactive", "--fresh"],
        ["-lc", 'command -v -- "$1"', "resolve-openshell-command", "openshell"],
        ["-lc", LAUNCH_TURN_SCRIPT],
      ]);
      expect(runner.calls[2]?.options?.env?.NEMOCLAW_OPENSHELL_COMMAND).toBe(
        "/home/runner/.local/bin/openshell",
      );
    } finally {
      platform.mockRestore();
    }
  });

  it("host client validates list/status and cleans up sandbox destroys", async () => {
    const runner = new FakeRunner();
    runner.stdout = "NAME\nassistant\n";
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await host.expectListed("assistant");
    await host.expectStatus("assistant");
    await host.cleanupSandbox("assistant");

    expect(runner.calls.map((call) => ({ command: call.command, args: call.args }))).toEqual([
      { command: "nemoclaw", args: ["list"] },
      { command: "nemoclaw", args: ["assistant", "status"] },
      { command: "nemoclaw", args: ["assistant", "destroy", "--yes"] },
    ]);
  });

  it.each(["Error: sandbox assistant not found", "no such sandbox: assistant"])(
    "host client accepts canonical already-absent cleanup output: %s",
    async (stderr) => {
      const runner = new FakeRunner();
      runner.exitCode = 1;
      runner.stderr = stderr;
      const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

      await expect(host.cleanupSandbox("assistant")).resolves.toBeUndefined();
    },
  );

  it.each([0, 23])(
    "preserves destroy exit %i and its artifacts after successful final cleanup",
    async (destroyExitCode) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-evidence-"));
      const progress = startTestProgress("cleanup", ["destroy sandbox", "inspect evidence"], {
        logLine: () => undefined,
      });
      try {
        const artifacts = new ArtifactSink(tmp);
        const probe = new ShellProbe({
          artifacts,
          progress,
          redact: (text) => text,
          signal: new AbortController().signal,
        });
        let attempt = 0;
        const host = new HostCliClient({
          run: (_command, options) =>
            probe.run(
              trustedShellCommand({
                command: process.execPath,
                args: [
                  "-e",
                  "const code = Number(process.argv[1]); code && process.stderr.write('destroy permission denied'); process.exitCode = code;",
                  String(attempt++ === 1 ? destroyExitCode : 0),
                ],
                reason: "exercise cleanup command results",
              }),
              options,
            ),
        });
        const cleanup = new CleanupRegistry();
        cleanup.trackSandbox(host, "assistant", { artifactName: "cleanup-nemoclaw-destroy" });
        progress.phase("destroy sandbox");
        await host.cleanupSandbox("assistant", { artifactName: "pre-cleanup-nemoclaw-destroy" });
        const outcome = await (async () => {
          try {
            await host.cleanupSandbox("assistant", {
              artifactName: "verify-cleanup-nemoclaw-destroy",
            });
          } finally {
            assertCleanupPassed(await cleanup.runAll());
          }
        })().catch((error: Error) => error.message);
        expect(outcome).toBe(
          destroyExitCode === 0
            ? undefined
            : "cleanup destroy sandbox assistant failed: destroy permission denied",
        );
        progress.phase("inspect evidence");
        const readResult = (prefix: string) =>
          JSON.parse(
            fs.readFileSync(
              artifacts.pathFor(`shell/${prefix}-nemoclaw-destroy.result.json`),
              "utf8",
            ),
          );
        expect(readResult("pre-cleanup")).toMatchObject({ exitCode: 0 });
        expect(readResult("verify-cleanup")).toMatchObject({
          exitCode: destroyExitCode,
          stderr: destroyExitCode === 0 ? "" : "destroy permission denied",
        });
        expect(readResult("cleanup")).toMatchObject({ exitCode: 0 });
      } finally {
        progress.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("host client removes a current OpenShell gateway with the caller environment", async () => {
    const runner = new FakeRunner();
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await host.cleanupGatewayRegistration("nemoclaw", {
      env: { HOME: "/tmp/cloud-onboard-home" },
    });

    expect(runner.calls.map((call) => call.args)).toEqual([["gateway", "remove", "nemoclaw"]]);
    expect(runner.calls[0]?.options?.env).toEqual({ HOME: "/tmp/cloud-onboard-home" });
  });

  it("host client falls back to the legacy gateway destroy verb", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 2, stderr: "unrecognized subcommand 'remove'" });
    runner.enqueue({ exitCode: 0 });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await host.cleanupGatewayRegistration("nemoclaw");

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["gateway", "remove", "nemoclaw"],
      ["gateway", "destroy", "-g", "nemoclaw"],
    ]);
  });

  it("host client accepts an already-absent gateway without a legacy fallback", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr: "No gateway metadata found" });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await host.cleanupGatewayRegistration("nemoclaw");

    expect(runner.calls.map((call) => call.args)).toEqual([["gateway", "remove", "nemoclaw"]]);
  });

  it("host client accepts an already-absent legacy gateway registration", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 2, stderr: "unrecognized subcommand 'remove'" });
    runner.enqueue({ exitCode: 1, stderr: "No gateway metadata found" });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await host.cleanupGatewayRegistration("nemoclaw");

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["gateway", "remove", "nemoclaw"],
      ["gateway", "destroy", "-g", "nemoclaw"],
    ]);
  });

  it.each(["No active forward", "forward 18789 not found", "forward stop failed: not running"])(
    "host client accepts canonical already-absent forward output: %s",
    async (stderr) => {
      const runner = new FakeRunner();
      runner.enqueue({ exitCode: 1, stderr });
      const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

      await host.cleanupForward(18789);

      expect(runner.calls.map((call) => call.args)).toEqual([["forward", "stop", "18789"]]);
    },
  );

  it("scopes forward cleanup to its sandbox and gateway", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 0 });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await host.cleanupForward(18789, {
      gatewayName: "nemoclaw",
      sandboxName: "e2e-double-a",
    });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["forward", "stop", "18789", "e2e-double-a", "--gateway", "nemoclaw"],
    ]);
  });

  it("rejects incomplete forward cleanup ownership", async () => {
    const runner = new FakeRunner();
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(host.cleanupForward(18789, { sandboxName: "e2e-double-a" })).rejects.toThrow(
      "Scoped forward cleanup requires a gateway name and sandbox name.",
    );
    expect(runner.calls).toEqual([]);
  });

  it("accepts an absent scoped forward", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr: "forward 18789 not found" });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(
      host.cleanupForward(18789, {
        gatewayName: "nemoclaw",
        sandboxName: "e2e-double-a",
      }),
    ).resolves.toBeUndefined();
  });

  it("surfaces a foreign scoped forward without retrying an unscoped stop", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr: "forward belongs to another sandbox" });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(
      host.cleanupForward(18789, {
        gatewayName: "nemoclaw",
        sandboxName: "e2e-double-a",
      }),
    ).rejects.toThrow("cleanup forward 18789 failed: forward belongs to another sandbox");
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["forward", "stop", "18789", "e2e-double-a", "--gateway", "nemoclaw"],
    ]);
  });

  it.each(["permission denied", "daemon not running", "some unrelated error: not running"])(
    "host client surfaces unexpected forward cleanup failure: %s",
    async (stderr) => {
      const runner = new FakeRunner();
      runner.enqueue({ exitCode: 1, stderr });
      const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

      await expect(host.cleanupForward(18789)).rejects.toThrow(
        `cleanup forward 18789 failed: ${stderr}`,
      );
    },
  );

  it("host client does not hide a current gateway remove failure behind the legacy verb", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr: "permission denied" });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(host.cleanupGatewayRegistration("nemoclaw")).rejects.toThrow(
      "cleanup gateway registration nemoclaw failed: permission denied",
    );
    expect(runner.calls.map((call) => call.args)).toEqual([["gateway", "remove", "nemoclaw"]]);
  });

  it("host client surfaces an unexpected legacy gateway cleanup failure", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 2, stderr: "unrecognized subcommand 'remove'" });
    runner.enqueue({ exitCode: 1, stderr: "permission denied" });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(host.cleanupGatewayRegistration("nemoclaw")).rejects.toThrow(
      "cleanup gateway registration nemoclaw failed: permission denied",
    );
  });

  it("host cleanup resources preserve caller probe options and gateway artifact suffixes", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 0 });
    runner.enqueue({ exitCode: 2, stderr: "unrecognized subcommand 'remove'" });
    runner.enqueue({ exitCode: 0 });
    runner.enqueue({ exitCode: 0 });
    const host = new HostCliClient(runner, {
      cliPath: "nemoclaw",
      openshellPath: "/opt/openshell/bin/openshell",
    });
    const options = {
      artifactName: "resource-cleanup",
      env: { OPENSHELL_GATEWAY: "nemoclaw-18080" },
      redactionValues: ["cleanup-secret"],
      timeoutMs: 123_000,
    };

    await host.cleanupSandbox("assistant", options);
    await host.cleanupGatewayRegistration("nemoclaw-18080", options);
    await host.cleanupForward(18789, options);

    expect(runner.calls).toEqual([
      {
        command: "nemoclaw",
        args: ["assistant", "destroy", "--yes"],
        options,
      },
      {
        command: "/opt/openshell/bin/openshell",
        args: ["gateway", "remove", "nemoclaw-18080"],
        options: { ...options, artifactName: "resource-cleanup-remove" },
      },
      {
        command: "/opt/openshell/bin/openshell",
        args: ["gateway", "destroy", "-g", "nemoclaw-18080"],
        options: { ...options, artifactName: "resource-cleanup-legacy-destroy" },
      },
      {
        command: "/opt/openshell/bin/openshell",
        args: ["forward", "stop", "18789"],
        options,
      },
    ]);
  });

  it("host client propagates cwd, env, and timeout options", async () => {
    const runner = new FakeRunner();
    const host = new HostCliClient(runner, {
      cliPath: "nemoclaw",
      cwd: "/tmp/project",
    });

    await host.nemoclaw(["status"], {
      env: { NEMOCLAW_TEST_VALUE: "1" },
      timeoutMs: 123,
    });

    expect(runner.calls[0]).toEqual({
      command: "nemoclaw",
      args: ["status"],
      options: {
        artifactName: "nemoclaw-status",
        cwd: "/tmp/project",
        env: { NEMOCLAW_TEST_VALUE: "1" },
        timeoutMs: 123,
      },
    });
  });

  it("gateway client delegates through NemoClaw gateway status", async () => {
    const runner = new FakeRunner();
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });
    const sandbox = new SandboxClient(runner);
    const gateway = new GatewayClient(host, sandbox);

    await gateway.expectHealthy();

    expect(runner.calls[0]).toEqual({
      command: "nemoclaw",
      args: ["gateway", "status"],
      options: { artifactName: "gateway-status" },
    });
  });

  it("gateway client preserves caller-provided probe options", async () => {
    const runner = new FakeRunner();
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });
    const sandbox = new SandboxClient(runner);
    const gateway = new GatewayClient(host, sandbox);

    await gateway.status({
      artifactName: "custom-gateway-status",
      env: { NEMOCLAW_TEST_VALUE: "1" },
      timeoutMs: 123,
    });

    expect(runner.calls[0]).toEqual({
      command: "nemoclaw",
      args: ["gateway", "status"],
      options: {
        artifactName: "custom-gateway-status",
        env: { NEMOCLAW_TEST_VALUE: "1" },
        timeoutMs: 123,
      },
    });
  });

  it("gateway client resolves host runtime and validates OpenShell status", async () => {
    const pidRunner = new FakeRunner();
    pidRunner.stdout = "12345\n";
    const pidHost = new HostCliClient(pidRunner, { cliPath: "nemoclaw" });
    await expect(
      new GatewayClient(pidHost, new SandboxClient(pidRunner)).resolveHostRuntime(),
    ).resolves.toEqual({
      kind: "pid",
      id: "12345",
    });

    const containerRunner = new FakeRunner();
    containerRunner.exitCode = 1;
    const containerHost = new HostCliClient(containerRunner, {
      cliPath: "nemoclaw",
    });
    const containerGateway = new GatewayClient(containerHost, new SandboxClient(containerRunner));
    const runtime = containerGateway.resolveHostRuntime();
    containerRunner.exitCode = 0;
    containerRunner.stdout = "abc123\topenshell-cluster-nemoclaw\n";
    await expect(runtime).resolves.toEqual({ kind: "container", id: "abc123" });

    const statusRunner = new FakeRunner();
    statusRunner.stdout = "Connected to nemoclaw\n";
    const statusHost = new HostCliClient(statusRunner, { cliPath: "nemoclaw" });
    await new GatewayClient(
      statusHost,
      new SandboxClient(statusRunner),
    ).expectOpenshellStatusConnected();
  });

  it("gateway client proves registration, listener, and host runtime are removed", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr: "No active gateway" });
    runner.enqueue({ exitCode: 1 });
    runner.enqueue({ exitCode: 1 });
    runner.enqueue({ exitCode: 0 });
    const gateway = new GatewayClient(
      new HostCliClient(runner, { cliPath: "nemoclaw" }),
      new SandboxClient(runner),
    );

    await gateway.expectRemoved("nemoclaw", {
      artifactName: "final-gateway",
      gatewayPort: 18_080,
    });

    expect(runner.calls.map(({ command, args }) => [command, args])).toEqual([
      ["openshell", ["status"]],
      ["lsof", ["-ti", ":18080", "-sTCP:LISTEN"]],
      ["sh", expect.any(Array)],
      ["docker", ["container", "ps", "--format", "{{.ID}}\t{{.Names}}"]],
      ["true", []],
    ]);
    expect(runner.calls[0].options).toMatchObject({
      artifactName: "final-gateway-status",
      env: { OPENSHELL_GATEWAY: "nemoclaw" },
    });
    expect(runner.calls[1].options).toMatchObject({
      artifactName: "final-gateway-listener",
    });
  });

  it("gateway client rejects an inconclusive listener absence probe", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr: "Status: Disconnected\nGateway: nemoclaw" });
    runner.enqueue({ exitCode: 1, stderr: "lsof: command unavailable" });
    const gateway = new GatewayClient(
      new HostCliClient(runner, { cliPath: "nemoclaw" }),
      new SandboxClient(runner),
    );

    await expect(gateway.expectRemoved("nemoclaw", { gatewayPort: 8_080 })).rejects.toThrow(
      "gateway listener still exists or could not be disproved on port 8080",
    );
  });

  it("gateway client rejects a gateway that still accepts status connections", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 0, stdout: "Status: Connected\nGateway: nemoclaw" });
    const gateway = new GatewayClient(
      new HostCliClient(runner, { cliPath: "nemoclaw" }),
      new SandboxClient(runner),
    );

    await expect(gateway.expectRemoved("nemoclaw", { gatewayPort: 8_080 })).rejects.toThrow(
      "openshell status did not prove gateway 'nemoclaw' disconnected",
    );
  });

  it("initial cleanup verifies the requested gateway before deleting a sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ stdout: JSON.stringify({ gateway: "nemoclaw", status: "healthy" }) });
    const sandbox = new SandboxClient(runner);
    const options = { env: { OPENSHELL_GATEWAY: "nemoclaw" }, timeoutMs: 60000 };
    await sandbox.cleanupSandboxBeforeOnboard("assistant", options);
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["gateway", "info", "-g", "nemoclaw", "-o", "json"],
      ["sandbox", "delete", "assistant"],
    ]);
    expect(runner.calls[0].options).toMatchObject(options);
  });

  it("initial cleanup accepts only the requested absent gateway", async () => {
    const runner = new FakeRunner();
    runner.enqueue({
      exitCode: 1,
      stderr:
        "Error:   × Unknown gateway 'nemoclaw'.\n  │ Register it first: openshell gateway add <endpoint> --name nemoclaw\n  │ Or list available gateways: openshell gateway select",
    });
    const sandbox = new SandboxClient(runner);
    await expect(sandbox.cleanupSandboxBeforeOnboard("assistant")).resolves.toBeUndefined();
    expect(runner.calls).toHaveLength(1);
  });

  it("initial cleanup accepts the pinned gateway-info no-configuration result", async () => {
    const runner = new FakeRunner();
    runner.enqueue({
      exitCode: 1,
      stderr:
        "Error:   × No gateway configured.\n  │ Register a gateway with: openshell gateway add <endpoint>",
    });
    const sandbox = new SandboxClient(runner);
    await expect(sandbox.cleanupSandboxBeforeOnboard("assistant")).resolves.toBeUndefined();
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["gateway", "info", "-g", "nemoclaw", "-o", "json"],
    ]);
  });

  it.each([
    { exitCode: 1, stderr: "permission denied" },
    { exitCode: 1, stderr: "connection refused" },
    { exitCode: 1, stderr: "No active gateway." },
    { exitCode: 1, stderr: "No gateway configured.\npermission denied" },
    { exitCode: 1, stderr: "No gateway configured.", timedOut: true },
    { exitCode: 1, stderr: "No gateway configured.", stdout: "unexpected output" },
    { exitCode: 1, stderr: "Unknown gateway 'other'." },
    { exitCode: 1, stderr: "Unknown gateway 'nemoclaw'.\npermission denied" },
    { exitCode: 1, stderr: "Unknown gateway 'nemoclaw'.", stdout: "unexpected output" },
    { exitCode: 1, stderr: "Unknown gateway 'nemoclaw'.", timedOut: true },
    { exitCode: null, stderr: "Unknown gateway 'nemoclaw'.", signal: "SIGTERM" as const },
    { exitCode: 0, stdout: '{"gateway":"other"}' },
    { exitCode: 0, stdout: '[{"gateway":"nemoclaw"}]' },
    { exitCode: 0, stdout: '{"gateway":"nemoclaw","error":"connection refused"}' },
    { exitCode: 0, stdout: '{"gateway":"nemoclaw"}', stderr: "permission denied" },
    { exitCode: 0, stdout: '{"gateway":"nemoclaw"}', timedOut: true },
    { exitCode: 0, stdout: '{"gateway":"nemoclaw"}', signal: "SIGTERM" as const },
    { exitCode: 0, stdout: "null" },
    { exitCode: 0, stdout: "{}" },
    { exitCode: 0, stdout: "Gateway: nemoclaw" },
    { exitCode: 0, stdout: "" },
  ])("initial cleanup rejects an unverified gateway observation: %j", async (response) => {
    const runner = new FakeRunner();
    runner.enqueue(response);
    const sandbox = new SandboxClient(runner);
    await expect(sandbox.hasGatewayForInitialCleanup("nemoclaw")).rejects.toThrow();
    expect(runner.calls).toHaveLength(1);
  });

  it.each([
    "No gateway configured.",
    "No gateway configured.\n  ",
    "No gateway configured.\n│ Register a gateway with: openshell gateway add <endpoint>\n│ Register a gateway with: openshell gateway add <endpoint>",
    "Unknown gateway 'nemoclaw'.",
    "Unknown gateway 'nemoclaw'.\n│ Register it first: openshell gateway add <endpoint> --name nemoclaw",
    "Unknown gateway 'nemoclaw'.\n│ Or list available gateways: openshell gateway select",
    "Unknown gateway 'nemoclaw'.\n│ Or list available gateways: openshell gateway select\n│ Register it first: openshell gateway add <endpoint> --name nemoclaw",
    "Unknown gateway 'nemoclaw'.\n│ Register it first: openshell gateway add <endpoint> --name nemoclaw\n│ Register it first: openshell gateway add <endpoint> --name nemoclaw",
  ])("initial cleanup rejects incomplete or repeated registration guidance: %s", async (stderr) => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr });
    const sandbox = new SandboxClient(runner);
    await expect(sandbox.cleanupSandboxBeforeOnboard("assistant")).rejects.toThrow();
    expect(runner.calls).toHaveLength(1);
  });

  it("initial cleanup retains deletion failures for a verified gateway", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ stdout: '{"gateway":"nemoclaw"}' });
    runner.enqueue({ exitCode: 1, stderr: "permission denied" });
    const sandbox = new SandboxClient(runner);
    await expect(sandbox.cleanupSandboxBeforeOnboard("assistant")).rejects.toThrow(
      "permission denied",
    );
    expect(runner.calls).toHaveLength(2);
  });

  it("terminal cleanup rejects an absent gateway", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr: "Unknown gateway 'nemoclaw'." });
    const sandbox = new SandboxClient(runner);
    await expect(sandbox.cleanupSandbox("assistant")).rejects.toThrow("Unknown gateway");
  });

  it("sandbox client removes an OpenShell sandbox with caller cleanup options", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner);
    const options = {
      artifactName: "cleanup-partial-sandbox",
      env: { OPENSHELL_GATEWAY: "nemoclaw-18080" },
      redactionValues: ["secret-cleanup-value"],
      timeoutMs: 60_000,
    };

    await sandbox.cleanupSandbox("assistant", options);

    expect(runner.calls).toEqual([
      {
        command: "openshell",
        args: ["sandbox", "delete", "assistant"],
        options,
      },
    ]);
  });

  it.each([
    "NotFound: sandbox assistant",
    "sandbox assistant not present",
    "no such sandbox: assistant",
  ])("sandbox client accepts canonical already-absent cleanup output: %s", async (stderr) => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr });
    const sandbox = new SandboxClient(runner);

    await expect(sandbox.cleanupSandbox("assistant")).resolves.toBeUndefined();
  });

  it.each([
    "permission denied",
    "Error:   × Unknown gateway 'nemoclaw'.",
    "Error:   × No active gateway.",
  ])("sandbox client surfaces cleanup failures that do not prove absence: %s", async (stderr) => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr });
    const sandbox = new SandboxClient(runner);

    await expect(sandbox.cleanupSandbox("assistant")).rejects.toThrow(stderr);
  });

  it("sandbox client validates list output using the OpenShell gateway env", async () => {
    const runner = new FakeRunner();
    runner.stdout = "NAME\nassistant\n";
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await sandbox.expectListed("assistant");

    expect(runner.calls[0]).toMatchObject({
      command: "openshell",
      args: ["sandbox", "list"],
      options: {
        artifactName: "sandbox-list",
        env: expect.objectContaining({ OPENSHELL_GATEWAY: "nemoclaw" }),
      },
    });
  });

  it("sandbox client proves exact-name absence from OpenShell list output", async () => {
    const runner = new FakeRunner();
    runner.stdout = "NAME\nassistant-copy\n";
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await expect(sandbox.expectAbsent("assistant")).resolves.toMatchObject({ exitCode: 0 });

    runner.stdout = "NAME\nassistant\n";
    await expect(sandbox.expectAbsent("assistant")).rejects.toThrow(
      "openshell sandbox list still included 'assistant'",
    );
  });

  it("sandbox client rejects an inconclusive OpenShell absence probe", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr: "gateway unavailable" });
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await expect(sandbox.expectAbsent("assistant")).rejects.toThrow(
      "openshell sandbox list failed: gateway unavailable",
    );
  });

  it("sandbox client preserves caller-provided probe options", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await sandbox.status("assistant", {
      artifactName: "custom-sandbox-status",
      env: { NEMOCLAW_TEST_VALUE: "1" },
      timeoutMs: 123,
    });

    expect(runner.calls[0]).toEqual({
      command: "openshell",
      args: ["sandbox", "status", "--name", "assistant"],
      options: {
        artifactName: "custom-sandbox-status",
        env: { NEMOCLAW_TEST_VALUE: "1" },
        timeoutMs: 123,
      },
    });
  });

  it("sandbox client rejects flag-shaped sandbox names before command construction", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await expect(() => sandbox.status("--bad")).toThrow(/sandbox name is invalid/);
    expect(runner.calls).toEqual([]);
  });

  it("sandbox client preserves shell-looking payloads as argv after --", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await sandbox.exec("assistant", ["sh", "-c", "echo '$TOKEN' && rm -rf /tmp/not-real"]);

    expect(runner.calls[0]?.args).toEqual([
      "sandbox",
      "exec",
      "-n",
      "assistant",
      "--",
      "sh",
      "-c",
      "echo '$TOKEN' && rm -rf /tmp/not-real",
    ]);
  });

  it("sandbox client passes trusted shell scripts through the named sandbox exec form", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });
    const script = trustedSandboxShellScript("echo ready");

    expectTypeOf<
      Parameters<SandboxClient["execShell"]>[1]
    >().toEqualTypeOf<TrustedSandboxShellScript>();

    await sandbox.execShell("assistant", script, {
      artifactName: "custom-exec-shell",
      timeoutMs: 123,
    });

    expect(runner.calls[0]).toEqual({
      command: "openshell",
      args: ["sandbox", "exec", "-n", "assistant", "--", "sh", "-lc", script],
      options: {
        artifactName: "custom-exec-shell",
        timeoutMs: 123,
      },
    });
  });

  it("sandbox client preserves multiline shell bytes in one OpenShell argv element", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });
    const script = trustedSandboxShellScript("set -eu\nprintf '%s\\n' ready\r\n");

    await sandbox.execShell("assistant", script);

    const payload = runner.calls[0]?.args.at(-1) ?? "";
    expect(payload).toBe(script);
    expect(payload).toContain("\n");
    expect(payload).toContain("\r\n");
  });

  it("sandbox client does not add an eval or decoder transport", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    const script = trustedSandboxShellScript("echo should-run-directly");
    await sandbox.execShell("assistant", script);

    const payload = runner.calls[0]?.args.at(-1) ?? "";
    expect(payload).toBe(script);
    expect(payload).not.toContain("base64");
    expect(payload).not.toContain("eval");
  });

  it("phase-six shell helpers preserve multiline source and positional arguments", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });
    const script = "set -eu\nprintf '%s\\n' \"$1\"";
    const argument = "line one\r\nline two";

    await sandboxShWithArgs(sandbox, "assistant", script, [argument], {
      artifactName: "phase-six-native-argv",
      redactionValues: ["sensitive-marker"],
      timeoutMs: 321,
    });

    expect(runner.calls[0]?.args).toEqual([
      "sandbox",
      "exec",
      "-n",
      "assistant",
      "--",
      "sh",
      "-c",
      script,
      "nemoclaw-e2e-script",
      argument,
    ]);
    expect(runner.calls[0]?.options).toMatchObject({
      artifactName: "phase-six-native-argv",
      redactionValues: ["sensitive-marker"],
      timeoutMs: 321,
    });
  });

  it("sandbox client requires trusted non-empty shell scripts", () => {
    expect(() => trustedSandboxShellScript("")).toThrow(/must not be empty/);
    expect(() => trustedSandboxShellScript("echo ready\0ignored")).toThrow(/no NUL bytes/);
    expectTypeOf<Parameters<SandboxClient["execShell"]>[1]>().not.toEqualTypeOf<string>();
  });

  it("sandbox client uploads host files into a sandbox", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await sandbox.upload("assistant", "/tmp/local.js", "/tmp/remote.js", {
      timeoutMs: 123,
    });

    expect(runner.calls[0]).toEqual({
      command: "openshell",
      args: ["sandbox", "upload", "assistant", "/tmp/local.js", "/tmp/remote.js"],
      options: {
        artifactName: "sandbox-upload-assistant",
        timeoutMs: 123,
      },
    });
  });

  it("sandbox client rejects flag-shaped upload paths before command construction", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    expect(() => sandbox.upload("assistant", "--local", "/tmp/remote.js")).toThrow(
      /sandbox upload local path is invalid/,
    );
    expect(() => sandbox.upload("assistant", "/tmp/local.js", "--remote")).toThrow(
      /sandbox upload remote path is invalid/,
    );
    expect(runner.calls).toEqual([]);
  });

  it("provider client parses JSON from curl output", async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true });
    const provider = new ProviderClient(runner);

    await expect(
      provider.getJson(trustedProviderEndpoint("http://127.0.0.1:8080/health")),
    ).resolves.toEqual({ ok: true });
    expect(runner.calls[0]).toEqual({
      command: "curl",
      args: ["-fsS", "http://127.0.0.1:8080/health"],
      options: {
        artifactName: "curl-http-127.0.0.1-8080-health",
        redactionValues: [],
      },
    });
  });

  it("provider client posts JSON bodies with --data-raw", async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true });
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint("https://api.example.test/v1/chat/completions", {
      allowedHosts: ["api.example.test"],
    });

    await expect(
      provider.requestJson(endpoint, {
        body: '{"messages":[]}',
        curlMaxTimeSeconds: 5,
        headers: ["Content-Type: application/json"],
      }),
    ).resolves.toMatchObject({ json: { ok: true } });

    expect(runner.calls[0]?.args).toEqual([
      "-fsS",
      "--max-time",
      "5",
      "-H",
      "Content-Type: application/json",
      "--data-raw",
      '{"messages":[]}',
      "https://api.example.test/v1/chat/completions",
    ]);
  });

  it.each([
    { body: "@/etc/passwd" },
    { headers: ["@/tmp/headers"] },
    { headers: ["Authorization: Bearer token\nX-Leak: value"] },
    { curlMaxTimeSeconds: 0 },
    { curlMaxTimeSeconds: -1 },
    { curlMaxTimeSeconds: Number.NaN },
    { curlMaxTimeSeconds: Number.POSITIVE_INFINITY },
  ])(
    "provider client rejects curl-sensitive request options before command construction [case %#]",
    async (options) => {
      const endpoint = trustedProviderEndpoint("https://api.example.test/v1/models", {
        allowedHosts: ["api.example.test"],
      });

      const runner = new FakeRunner();
      const provider = new ProviderClient(runner);

      await expect(provider.requestJson(endpoint, options)).rejects.toThrow(
        /@file|CR or LF|finite positive/,
      );
      expect(runner.calls).toEqual([]);
    },
  );

  it("provider client does not follow redirects after endpoint validation", async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true });
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint("https://api.example.test/v1/models", {
      allowedHosts: ["api.example.test"],
    });

    await provider.getJson(endpoint);

    expect(runner.calls[0]?.args).toEqual(["-fsS", "https://api.example.test/v1/models"]);
    expect(runner.calls[0]?.args).not.toContain("-L");
  });

  it("provider endpoint rejects unsafe schemes, hosts, and userinfo", () => {
    expect(() => trustedProviderEndpoint("file:///etc/passwd")).toThrow(/protocol/);
    expect(() => trustedProviderEndpoint("http://example.com/health")).toThrow(/loopback/);
    expect(() => trustedProviderEndpoint("https://api.example.test/models")).toThrow(
      /allowedHosts/,
    );
    expect(() => trustedProviderEndpoint("http://169.254.169.254/latest/meta-data")).toThrow(
      /blocked/,
    );
    expect(() => trustedProviderEndpoint("https://token@example.com/models")).toThrow(
      /credentials/,
    );
    expect(() =>
      trustedProviderEndpoint("https://api.example.test/models", {
        allowedHosts: ["api.other.test"],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      trustedProviderEndpoint("https://10.0.0.1/models", {
        allowedHosts: ["10.0.0.1"],
      }),
    ).toThrow(/private or link-local/);
    expect(() =>
      trustedProviderEndpoint("https://[fd00::1]/models", {
        allowedHosts: ["fd00::1"],
      }),
    ).toThrow(/private or link-local/);
  });

  it("provider endpoint allows loopback HTTP, including IPv6 loopback", () => {
    expect(trustedProviderEndpoint("http://127.0.0.1:8080/health").url).toBe(
      "http://127.0.0.1:8080/health",
    );
    expect(trustedProviderEndpoint("http://[::1]:8080/health").url).toBe(
      "http://[::1]:8080/health",
    );
  });

  it("provider client sanitizes labels and redacts credential-bearing query values", async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true });
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint(
      "https://api.example.test/v1/models?api_key=query-token-value",
      { allowedHosts: ["api.example.test"] },
    );

    await expect(provider.getJson(endpoint)).resolves.toEqual({ ok: true });

    expect(runner.calls[0]?.options?.artifactName).toBe("curl-https-api.example.test-v1-models");
    expect(runner.calls[0]?.options?.redactionValues).toEqual(
      expect.arrayContaining(["api_key=query-token-value", "query-token-value"]),
    );
  });

  it("provider client builds reachability probes from trusted endpoints", async () => {
    const runner = new FakeRunner();
    runner.stdout = "204";
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint("https://inference-api.nvidia.com/v1", {
      allowedHosts: ["inference-api.nvidia.com"],
    });

    await expect(provider.probeReachability(endpoint)).resolves.toMatchObject({ stdout: "204" });

    expect(runner.calls.at(-1)).toMatchObject({
      command: "curl",
      args: [
        "-sS",
        "--connect-timeout",
        "10",
        "--max-time",
        "20",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "https://inference-api.nvidia.com/v1",
      ],
    });
  });

  it("provider endpoint validation rejects metadata SSRF targets before reachability probes", () => {
    expect(() => trustedProviderEndpoint("http://169.254.169.254/latest/meta-data")).toThrow(
      /private or link-local|blocked/,
    );
    expect(() =>
      trustedProviderEndpoint("https://metadata.google.internal/computeMetadata/v1"),
    ).toThrow(/blocked/);
  });

  it("provider client reports invalid JSON without echoing response body", async () => {
    const runner = new FakeRunner();
    runner.stdout = "not-json with query-token-value";
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint(
      "https://api.example.test/v1/models?api_key=query-token-value",
      { allowedHosts: ["api.example.test"] },
    );

    await expect(provider.getJson(endpoint)).rejects.toThrow(/provider response was not JSON/);
    await expect(provider.getJson(endpoint)).rejects.not.toThrow(/query-token-value|not-json/);
  });

  it("provider client failure labels omit query strings", async () => {
    const runner = new FakeRunner();
    runner.exitCode = 22;
    const provider = new ProviderClient(runner);
    const endpoint = trustedProviderEndpoint(
      "https://api.example.test/v1/models?api_key=query-token-value",
      {
        allowedHosts: ["api.example.test"],
      },
    );

    await expect(provider.getJson(endpoint)).rejects.toThrow(
      "curl https://api.example.test/v1/models failed: exit=22",
    );
    await expect(provider.getJson(endpoint)).rejects.not.toThrow(/query-token-value|api_key/);
  });

  it("shared command helpers match complete sandbox names", async () => {
    const { outputContainsSandbox, resultText } = await import("../fixtures/clients/index.ts");
    const result = {
      stdout: "NAME\nassistant-old\nassistant\n",
      stderr: "",
    };

    expect(resultText(result)).toContain("assistant");
    expect(outputContainsSandbox(result, "assistant")).toBe(true);
    expect(outputContainsSandbox(result, "assist")).toBe(false);
  });

  it("precleans shared live fixtures through OpenShell only", async () => {
    const command = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }));
    const host = {
      command,
      openshellCommandPath: "openshell",
    } as unknown as HostCliClient;

    await precleanSandbox(host, "e2e-cleanup", {}, [], "shared-preclean");

    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "delete", "e2e-cleanup"],
      expect.objectContaining({
        artifactName: "shared-preclean-openshell-sandbox-delete",
      }),
    );
  });

  it("exit assertions report unexpected and signaled command results", () => {
    const result: ShellProbeResult = {
      command: ["cmd"],
      exitCode: 7,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      artifacts: { stdout: "", stderr: "", result: "" },
    };

    expect(() => assertExitZero(result, "cmd")).toThrow("cmd failed: exit=7");
    expect(() => assertExitZero({ ...result, exitCode: null, signal: "SIGTERM" }, "cmd")).toThrow(
      "cmd failed: signal=SIGTERM",
    );
    expect(() => assertExitCode(result, 7, "cmd")).not.toThrow();
    expect(() => assertExitCode(result, 1, "cmd")).toThrow("cmd expected exit=1, got exit=7");
  });

  it("assertExitZero accepts lightweight command results and retains both output streams", () => {
    const result = {
      exitCode: 2,
      stdout: "standard output",
      stderr: "standard error",
    };

    expect(() => assertExitZero(result, "lightweight command")).toThrow(
      "lightweight command failed: standard output\nstandard error",
    );
  });

  it("exports the shared shell quoting helper", () => {
    expect(shellQuote("can't run; rm -rf /")).toBe("'can'\\''t run; rm -rf /'");
  });

  it("state client reads text and JSON files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-state-"));
    try {
      const file = path.join(tmp, "state.json");
      fs.writeFileSync(file, JSON.stringify({ sandbox: "assistant" }), "utf8");
      const state = new StateClient();

      await expect(state.exists(file)).resolves.toBe(true);
      await expect(state.exists(path.join(tmp, "missing.json"))).resolves.toBe(false);
      await expect(state.readJson(file)).resolves.toEqual({
        sandbox: "assistant",
      });
      await expect(state.exists(`bad${"\0"}path`)).rejects.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
