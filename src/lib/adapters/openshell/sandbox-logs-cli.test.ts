// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { OpenShellBufferedCommandRunner } from "./sandbox-command-cli";
import {
  buildCliOpenShellSandboxLogArgs,
  createCliOpenShellSandboxLogs,
  type OpenShellLogChild,
  type OpenShellLogSpawner,
} from "./sandbox-logs-cli";
import type { OpenShellSandboxLogRequest } from "./sandbox-logs";

const gatewayRequest: OpenShellSandboxLogRequest = {
  target: { kind: "selected" },
  sandboxName: "alpha",
  source: "gateway",
  lines: "50",
  since: null,
  timeoutMs: 5000,
};

describe("CLI OpenShell sandbox logs adapter", () => {
  it("owns the exact gateway and OpenShell argv shapes", () => {
    expect(buildCliOpenShellSandboxLogArgs(gatewayRequest, false)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "tail",
      "-n",
      "50",
      "/tmp/gateway.log",
    ]);
    expect(
      buildCliOpenShellSandboxLogArgs(
        {
          ...gatewayRequest,
          target: { kind: "named", gatewayName: "managed" },
          source: "openshell",
          lines: "200",
          since: "5m",
        },
        true,
      ),
    ).toEqual([
      "logs",
      "-g",
      "managed",
      "alpha",
      "-n",
      "200",
      "--source",
      "all",
      "--since",
      "5m",
      "--tail",
    ]);
  });

  it("captures a bounded read through the selected binary and environment", async () => {
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>(async () => ({
      status: 0,
      stdout: "line\n",
      stderr: "",
    }));
    const environment = { HOME: "/tmp/home", PATH: "/bin" };
    const logs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered,
      environment,
      hostCwd: "/repo",
    });

    await expect(logs.read(gatewayRequest)).resolves.toEqual({
      content: "line\n",
      diagnostic: "",
      outcome: { kind: "completed", exitCode: 0 },
    });
    expect(runBuffered).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "exec", "-n", "alpha", "--", "tail", "-n", "50", "/tmp/gateway.log"],
      {
        environment,
        hostCwd: "/repo",
        outputLimitBytes: 1024 * 1024,
        timeoutKillSignal: "SIGKILL",
        timeoutMilliseconds: 5000,
      },
    );
  });

  it("preserves a completed nonzero buffered exit", async () => {
    const logs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered: async () => ({ status: 23, stdout: "partial\n", stderr: "diagnostic\n" }),
      environment: {},
    });

    await expect(logs.read(gatewayRequest)).resolves.toEqual({
      content: "partial\n",
      diagnostic: "diagnostic\n",
      outcome: { kind: "completed", exitCode: 23 },
    });
  });

  it("retains selected OpenShell routing without forwarding ambient credentials", async () => {
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>(async () => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const logs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered,
      environment: {
        HOME: "/tmp/home",
        PATH: "/bin",
        OPENSHELL_GATEWAY: "nemoclaw-8090",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/tmp/openshell-tls",
        OPENSHELL_GATEWAY_AUTH_TOKEN: "must-not-cross-child-boundary",
        AWS_SECRET_ACCESS_KEY: "must-not-cross-child-boundary",
      },
    });

    await logs.read(gatewayRequest);

    expect(runBuffered).toHaveBeenCalledOnce();
    const childEnvironment = runBuffered.mock.calls[0]?.[2].environment;
    expect(childEnvironment).toMatchObject({
      HOME: "/tmp/home",
      PATH: "/bin",
      OPENSHELL_GATEWAY: "nemoclaw-8090",
      OPENSHELL_WORKSPACE: "default",
      OPENSHELL_LOCAL_TLS_DIR: "/tmp/openshell-tls",
    });
    expect(childEnvironment).not.toHaveProperty("OPENSHELL_GATEWAY_AUTH_TOKEN");
    expect(childEnvironment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("rejects an ambient gateway endpoint override before invoking OpenShell", async () => {
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>();
    const logs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered,
      environment: {
        OPENSHELL_GATEWAY_ENDPOINT: "https://untrusted.invalid",
      },
    });

    await expect(logs.read(gatewayRequest)).resolves.toMatchObject({
      outcome: {
        kind: "failed",
        error: { kind: "configuration", message: expect.stringContaining("Unset") },
      },
    });
    expect(runBuffered).not.toHaveBeenCalled();
  });

  it("returns typed unavailable and invalid-request failures without invoking a child", async () => {
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>();
    const unavailable = createCliOpenShellSandboxLogs({
      resolveBinary: () => null,
      runBuffered,
      environment: {},
    });
    expect(unavailable.checkAvailability()).toEqual({
      kind: "unavailable",
      message: "OpenShell binary not found",
    });
    await expect(unavailable.read(gatewayRequest)).resolves.toMatchObject({
      outcome: { kind: "failed", error: { kind: "unavailable" } },
    });

    const invalid = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered,
      environment: {},
    });
    await expect(
      invalid.read({ ...gatewayRequest, source: "gateway", since: "5m" }),
    ).resolves.toMatchObject({
      outcome: { kind: "failed", error: { kind: "configuration" } },
    });
    expect(runBuffered).not.toHaveBeenCalled();
  });

  it("maps timeout and rejected runner failures without leaking transport exceptions", async () => {
    const secret = ["transport", "secret"].join("-");
    const timeoutRunner = vi.fn<OpenShellBufferedCommandRunner>(async () => ({
      status: null,
      stdout: "partial",
      stderr: `Authorization: Bearer ${secret}`,
      timedOut: true,
    }));
    const timeoutLogs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered: timeoutRunner,
      environment: {},
    });
    const openshellRequest = {
      ...gatewayRequest,
      source: "openshell" as const,
      since: "5m",
    };
    await expect(timeoutLogs.read(openshellRequest)).resolves.toMatchObject({
      content: "partial",
      diagnostic: "Authorization: <REDACTED> <REDACTED>",
      outcome: { kind: "failed", error: { kind: "timeout" } },
    });
    expect(timeoutRunner.mock.calls[0]?.[2].timeoutMilliseconds).toBe(5000);

    const rejectedLogs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered: async () => {
        throw new Error(`runner rejected Bearer ${secret}`);
      },
      environment: {},
    });
    await expect(rejectedLogs.read(gatewayRequest)).resolves.toMatchObject({
      outcome: {
        kind: "failed",
        error: { kind: "invocation", message: "runner rejected Bearer <REDACTED>" },
      },
    });
  });

  it("classifies capture overflow without exposing credentials", async () => {
    const secret = ["capture", "secret"].join("-");
    const captureError = Object.assign(new Error(`max buffer Bearer ${secret}`), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });
    const logs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered: async () => ({
        status: null,
        stdout: "partial",
        stderr: `Authorization: Bearer ${secret}`,
        error: captureError,
      }),
      environment: {},
    });

    await expect(logs.read(gatewayRequest)).resolves.toEqual({
      content: "partial",
      diagnostic: "Authorization: <REDACTED> <REDACTED>",
      outcome: {
        kind: "failed",
        error: { kind: "capture", message: "max buffer Bearer <REDACTED>" },
        exitCode: 1,
      },
    });
  });

  it("supervises followed output and cancellation behind the typed session", async () => {
    const output = new PassThrough();
    const diagnostic = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stderr: diagnostic,
      stdout: output,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn(() => true),
    }) as unknown as OpenShellLogChild;
    const spawnChild = vi.fn<OpenShellLogSpawner>(() => child);
    const environment = { HOME: "/tmp/home", PATH: "/bin" };
    const logs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      spawnChild,
      environment,
      hostCwd: "/repo",
    });

    const session = logs.follow(gatewayRequest);
    const chunks: string[] = [];
    const diagnostics: string[] = [];
    session.output?.onChunk((chunk) => chunks.push(chunk));
    session.diagnostic?.onChunk((chunk) => diagnostics.push(chunk));
    output.write("gateway line\n");
    const secret = ["follow", "secret"].join("-");
    diagnostic.write("Authorization: Bearer follow-");
    diagnostic.write("secret\n");
    diagnostic.write("x".repeat(64 * 1024 + 1));
    diagnostic.write("\nvisible diagnostic\n");
    session.cancel("terminate");
    (child as unknown as EventEmitter).emit("exit", null, "SIGTERM");

    await expect(session.completion).resolves.toEqual({
      outcome: { kind: "completed", exitCode: 143, termination: "terminated" },
    });
    expect(chunks).toEqual(["gateway line\n"]);
    expect(diagnostics).toEqual([
      "Authorization: <REDACTED> <REDACTED>\n",
      "OpenShell diagnostic omitted: line exceeded safe display limit.\n",
      "visible diagnostic\n",
    ]);
    expect(diagnostics.join("")).not.toContain(secret);
    expect(diagnostics.join("")).not.toContain("x".repeat(64));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnChild).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "exec", "-n", "alpha", "--", "tail", "-n", "50", "-f", "/tmp/gateway.log"],
      { cwd: "/repo", env: environment, stdio: ["inherit", "pipe", "pipe"] },
    );
  });

  it("spawns an OpenShell follow request with its source and time filter", async () => {
    const diagnostic = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stderr: diagnostic,
      stdout: null,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn(() => true),
    }) as unknown as OpenShellLogChild;
    const spawnChild = vi.fn<OpenShellLogSpawner>(() => child);
    const environment = { HOME: "/tmp/home", PATH: "/bin" };
    const logs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      spawnChild,
      environment,
      hostCwd: "/repo",
    });

    const session = logs.follow({
      ...gatewayRequest,
      source: "openshell",
      since: "5m",
    });
    expect(session.output).toBeNull();
    expect(session.diagnostic).not.toBeNull();
    expect(spawnChild).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["logs", "alpha", "-n", "50", "--source", "all", "--since", "5m", "--tail"],
      { cwd: "/repo", env: environment, stdio: ["inherit", "inherit", "pipe"] },
    );

    (child as unknown as EventEmitter).emit("exit", 0, null);
    await expect(session.completion).resolves.toEqual({
      outcome: { kind: "completed", exitCode: 0 },
    });
  });
});
