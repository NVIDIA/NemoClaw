// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assertExitZero,
  type CommandRunner,
  GatewayClient,
  HostCliClient,
  ProviderClient,
  SandboxClient,
  StateClient,
  shellQuote,
  type TrustedSandboxShellScript,
  trustedProviderEndpoint,
  trustedSandboxShellScript,
} from "../fixtures/clients/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";
import { sandboxShWithArgs } from "../live/phase6-messaging-helpers.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

type FakeRunnerResponse = Partial<
  Pick<ShellProbeResult, "exitCode" | "signal" | "stderr" | "stdout">
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
      timedOut: false,
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

  it.each([
    "Error: sandbox assistant not found",
    "no such sandbox: assistant",
  ])("host client accepts canonical already-absent cleanup output: %s", async (stderr) => {
    const runner = new FakeRunner();
    runner.exitCode = 1;
    runner.stderr = stderr;
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(host.cleanupSandbox("assistant")).resolves.toBeUndefined();
  });

  it("host client surfaces unexpected sandbox cleanup failures", async () => {
    const runner = new FakeRunner();
    runner.exitCode = 1;
    runner.stderr = "permission denied";
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(host.cleanupSandbox("assistant")).rejects.toThrow(
      "cleanup destroy sandbox assistant failed: permission denied",
    );
  });

  it("host client removes a current OpenShell gateway registration", async () => {
    const runner = new FakeRunner();
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await host.cleanupGatewayRegistration("nemoclaw");

    expect(runner.calls.map((call) => call.args)).toEqual([["gateway", "remove", "nemoclaw"]]);
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

  it.each([
    "No active forward",
    "forward 18789 not found",
    "forward stop failed: not running",
  ])("host client accepts canonical already-absent forward output: %s", async (stderr) => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await host.cleanupForward(18789);

    expect(runner.calls.map((call) => call.args)).toEqual([["forward", "stop", "18789"]]);
  });

  it.each([
    "permission denied",
    "daemon not running",
    "some unrelated error: not running",
  ])("host client surfaces unexpected forward cleanup failure: %s", async (stderr) => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr });
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(host.cleanupForward(18789)).rejects.toThrow(
      `cleanup forward 18789 failed: ${stderr}`,
    );
  });

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
    containerRunner.stdout = "abc123\n";
    await expect(runtime).resolves.toEqual({ kind: "container", id: "abc123" });

    const statusRunner = new FakeRunner();
    statusRunner.stdout = "Connected to nemoclaw\n";
    const statusHost = new HostCliClient(statusRunner, { cliPath: "nemoclaw" });
    await new GatewayClient(
      statusHost,
      new SandboxClient(statusRunner),
    ).expectOpenshellStatusConnected();
  });

  it("sandbox client builds OpenShell sandbox commands", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await sandbox.exec("assistant", ["echo", "ok"]);

    expect(runner.calls[0]).toEqual({
      command: "openshell",
      args: ["sandbox", "exec", "-n", "assistant", "--", "echo", "ok"],
      options: {
        artifactName: "sandbox-exec-assistant",
      },
    });
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

  it("sandbox client surfaces unexpected cleanup failures", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1, stderr: "permission denied" });
    const sandbox = new SandboxClient(runner);

    await expect(sandbox.cleanupSandbox("assistant")).rejects.toThrow(
      "cleanup OpenShell sandbox assistant failed: permission denied",
    );
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

  it("provider client rejects curl-sensitive request options before command construction", async () => {
    const endpoint = trustedProviderEndpoint("https://api.example.test/v1/models", {
      allowedHosts: ["api.example.test"],
    });

    for (const options of [
      { body: "@/etc/passwd" },
      { headers: ["@/tmp/headers"] },
      { headers: ["Authorization: Bearer token\nX-Leak: value"] },
      { curlMaxTimeSeconds: 0 },
      { curlMaxTimeSeconds: -1 },
      { curlMaxTimeSeconds: Number.NaN },
      { curlMaxTimeSeconds: Number.POSITIVE_INFINITY },
    ]) {
      const runner = new FakeRunner();
      const provider = new ProviderClient(runner);

      await expect(provider.requestJson(endpoint, options)).rejects.toThrow(
        /@file|CR or LF|finite positive/,
      );
      expect(runner.calls).toEqual([]);
    }
  });

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

  it("assertExitZero reports non-zero and signaled commands", () => {
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
