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

  it("returns typed unavailable and invalid-request failures without invoking a child", async () => {
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>();
    const unavailable = createCliOpenShellSandboxLogs({
      resolveBinary: () => null,
      runBuffered,
      environment: {},
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
    const timeoutLogs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered: async () => ({
        status: null,
        stdout: "partial",
        stderr: "detail",
        timedOut: true,
      }),
      environment: {},
    });
    await expect(timeoutLogs.read(gatewayRequest)).resolves.toMatchObject({
      content: "partial",
      diagnostic: "detail",
      outcome: { kind: "failed", error: { kind: "timeout" } },
    });

    const rejectedLogs = createCliOpenShellSandboxLogs({
      resolveBinary: () => "/usr/bin/openshell",
      runBuffered: async () => {
        throw new Error("runner rejected");
      },
      environment: {},
    });
    await expect(rejectedLogs.read(gatewayRequest)).resolves.toMatchObject({
      outcome: {
        kind: "failed",
        error: { kind: "invocation", message: "runner rejected" },
      },
    });
  });

  it("supervises followed output and cancellation behind the typed session", async () => {
    const output = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
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
    session.output?.onChunk((chunk) => chunks.push(chunk));
    output.write("gateway line\n");
    session.cancel("terminate");
    (child as unknown as EventEmitter).emit("exit", null, "SIGTERM");

    await expect(session.completion).resolves.toEqual({
      outcome: { kind: "completed", exitCode: 143, termination: "terminated" },
    });
    expect(chunks).toEqual(["gateway line\n"]);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnChild).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "exec", "-n", "alpha", "--", "tail", "-n", "50", "-f", "/tmp/gateway.log"],
      { cwd: "/repo", env: environment, stdio: ["inherit", "pipe", "inherit"] },
    );
  });
});
