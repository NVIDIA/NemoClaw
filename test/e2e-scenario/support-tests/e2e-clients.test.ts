// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { assertExitZero, type CommandRunner } from "../fixtures/clients/index.ts";
import {
  GatewayClient,
  HostCliClient,
  ProviderClient,
  SandboxClient,
  StateClient,
  trustedSandboxShellScript,
  trustedProviderEndpoint,
  type TrustedSandboxShellScript,
} from "../fixtures/clients/index.ts";
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

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  stdout = "";
  stderr = "";
  exitCode: number | null = 0;
  signal: NodeJS.Signals | null = null;

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    return {
      command: [command.command, ...command.args],
      exitCode: this.exitCode,
      signal: this.signal,
      timedOut: false,
      stdout: this.stdout,
      stderr: this.stderr,
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

  it("host client propagates cwd, env, and timeout options", async () => {
    const runner = new FakeRunner();
    const host = new HostCliClient(runner, { cliPath: "nemoclaw", cwd: "/tmp/project" });

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
    const gateway = new GatewayClient(host);

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
    const gateway = new GatewayClient(host);

    await gateway.status({
      artifactName: "custom-gateway-status",
      env: { NEMOCLAW_TEST_VALUE: "1" },
      inheritEnv: true,
      timeoutMs: 123,
    });

    expect(runner.calls[0]).toEqual({
      command: "nemoclaw",
      args: ["gateway", "status"],
      options: {
        artifactName: "custom-gateway-status",
        env: { NEMOCLAW_TEST_VALUE: "1" },
        inheritEnv: true,
        timeoutMs: 123,
      },
    });
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

  it("sandbox client preserves caller-provided probe options", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await sandbox.status("assistant", {
      artifactName: "custom-sandbox-status",
      env: { NEMOCLAW_TEST_VALUE: "1" },
      inheritEnv: true,
      timeoutMs: 123,
    });

    expect(runner.calls[0]).toEqual({
      command: "openshell",
      args: ["sandbox", "status", "assistant"],
      options: {
        artifactName: "custom-sandbox-status",
        env: { NEMOCLAW_TEST_VALUE: "1" },
        inheritEnv: true,
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

  it("sandbox client wraps shell scripts with the named sandbox exec form", async () => {
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
      args: ["sandbox", "exec", "-n", "assistant", "--", "sh", "-lc", "echo ready"],
      options: {
        artifactName: "custom-exec-shell",
        timeoutMs: 123,
      },
    });
  });

  it("sandbox client requires trusted non-empty shell scripts", () => {
    expect(() => trustedSandboxShellScript("")).toThrow(/must not be empty/);
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
      trustedProviderEndpoint("https://10.0.0.1/models", { allowedHosts: ["10.0.0.1"] }),
    ).toThrow(/private or link-local/);
    expect(() =>
      trustedProviderEndpoint("https://[fd00::1]/models", { allowedHosts: ["fd00::1"] }),
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

  it("state client reads text and JSON files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-state-"));
    try {
      const file = path.join(tmp, "state.json");
      fs.writeFileSync(file, JSON.stringify({ sandbox: "assistant" }), "utf8");
      const state = new StateClient();

      await expect(state.exists(file)).resolves.toBe(true);
      await expect(state.exists(path.join(tmp, "missing.json"))).resolves.toBe(false);
      await expect(state.readJson(file)).resolves.toEqual({ sandbox: "assistant" });
      await expect(state.exists(`bad${"\0"}path`)).rejects.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
