// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  OpenShellBufferedCommandRunner,
  OpenShellBufferedCommandRunResult,
} from "./sandbox-command-cli";
import {
  createCliOpenShellSandboxSshExecutor,
  createCliOpenShellSandboxSshCommandExecutor,
} from "./sandbox-ssh-cli";
import { namedOpenShellGateway } from "./sandbox-observer";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

const request = {
  sandboxName: "alpha",
  target: namedOpenShellGateway("nemoclaw-18080"),
  command: "hermes --version",
};
const config =
  "Host openshell-alpha.default\n  HostName 127.0.0.1\n  IdentityFile /private/ssh-key\n";
const success = { status: 0, stdout: "", stderr: "" };

function fixture(result: OpenShellBufferedCommandRunResult = success) {
  const run = vi
    .fn<OpenShellBufferedCommandRunner>()
    .mockResolvedValueOnce(success)
    .mockResolvedValueOnce({ ...success, stdout: config })
    .mockResolvedValueOnce(result);
  return {
    run,
    executor: createCliOpenShellSandboxSshExecutor({
      resolveBinary: () => "/bin/openshell",
      runBuffered: run,
    }),
  };
}

describe("CLI sandbox SSH execution", () => {
  it("pins both config reads to the gateway and preserves the version SSH options", async () => {
    const { run, executor } = fixture();
    run.mockReset();
    run
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({ ...success, stdout: config })
      .mockImplementationOnce(async (_binary, args) => {
        expect(readFileSync(args[1], "utf8")).toBe(config);
        expect(statSync(args[1]).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(args[1])).mode & 0o777).toBe(0o700);
        return { status: 0, stdout: "hermes 1.2.3\n", stderr: "notice\n" };
      });
    const environment = { PATH: "/bin" };
    expect(await executor.run({ ...request, environment, timeoutMilliseconds: 1234 })).toEqual({
      kind: "completed",
      exitCode: 0,
      stdout: "hermes 1.2.3\n",
      stderr: "notice\n",
    });
    expect(run.mock.calls.slice(0, 2)).toEqual([
      [
        "/bin/openshell",
        ["sandbox", "get", "-g", "nemoclaw-18080", "alpha"],
        { environment, timeoutMilliseconds: OPENSHELL_PROBE_TIMEOUT_MS },
      ],
      [
        "/bin/openshell",
        ["sandbox", "ssh-config", "-g", "nemoclaw-18080", "alpha"],
        { environment, timeoutMilliseconds: OPENSHELL_PROBE_TIMEOUT_MS },
      ],
    ]);
    const file = run.mock.calls[2][1][1];
    expect(run.mock.calls[2]).toEqual([
      "ssh",
      [
        "-F",
        file,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "LogLevel=ERROR",
        "openshell-alpha.default",
        "hermes --version",
      ],
      { environment, timeoutMilliseconds: 1234 },
    ]);
    expect(existsSync(dirname(file))).toBe(false);
  });

  it("uses the legacy host selected from the OpenShell SSH configuration", async () => {
    const { run, executor } = fixture();
    run
      .mockReset()
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({ ...success, stdout: "Host openshell-alpha\n" })
      .mockResolvedValueOnce(success);
    await executor.run(request);
    expect(run.mock.calls[2][1].slice(-2)).toEqual(["openshell-alpha", "hermes --version"]);
  });

  it.each([
    [
      { status: 17, stdout: "out", stderr: "err" },
      { kind: "completed", exitCode: 17, stdout: "out", stderr: "err" },
    ],
    [
      { ...success, status: 255 },
      { kind: "failed", reason: "transport" },
    ],
    [
      { ...success, status: null, timedOut: true },
      { kind: "failed", reason: "timeout" },
    ],
    [
      { ...success, error: Object.assign(new Error("private command"), { code: "ENOENT" }) },
      { kind: "failed", reason: "unavailable" },
    ],
    [
      {
        ...success,
        error: Object.assign(new Error("private command"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        }),
      },
      { kind: "failed", reason: "capture" },
    ],
    [
      { ...success, error: new Error("private command") },
      { kind: "failed", reason: "transport" },
    ],
    [
      { ...success, status: null, signal: "SIGTERM" },
      { kind: "failed", reason: "cancelled", signal: "SIGTERM" },
    ],
  ] as const)(
    "classifies SSH result %j and removes its private config",
    async (result, expected) => {
      const { run, executor } = fixture(result);
      expect(await executor.run(request)).toEqual(expected);
      expect(run).toHaveBeenCalledTimes(3);
      expect(existsSync(dirname(run.mock.calls[2][1][1]))).toBe(false);
    },
  );

  it.each(["", "Host unrelated\n", "Host *\n"])(
    "rejects configuration %j before opening SSH",
    async (stdout) => {
      const { run, executor } = fixture();
      run
        .mockReset()
        .mockResolvedValueOnce(success)
        .mockResolvedValueOnce({ ...success, stdout });
      expect(await executor.run(request)).toEqual({ kind: "failed", reason: "configuration" });
      expect(run).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { first: { ...success, timedOut: true }, calls: 1 },
    { first: success, calls: 2 },
  ])("stops after $calls configuration reads when a lookup times out", async ({ first, calls }) => {
    const { run, executor } = fixture();
    run
      .mockReset()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ...success, timedOut: true });
    expect(await executor.run(request)).toEqual({ kind: "failed", reason: "timeout" });
    expect(run).toHaveBeenCalledTimes(calls);
  });

  it("keeps the private configuration until the SSH operation settles", async () => {
    const { run, executor } = fixture();
    let complete!: (result: OpenShellBufferedCommandRunResult) => void;
    const pending = new Promise<OpenShellBufferedCommandRunResult>((resolve) => {
      complete = resolve;
    });
    run
      .mockReset()
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({ ...success, stdout: config })
      .mockReturnValueOnce(pending);
    const operation = executor.run(request);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    const file = run.mock.calls[2][1][1];
    expect(existsSync(file)).toBe(true);
    complete(success);
    await operation;
    expect(existsSync(dirname(file))).toBe(false);
  });

  it("removes the configuration if the SSH runner throws", async () => {
    const { run, executor } = fixture();
    run
      .mockReset()
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({ ...success, stdout: config })
      .mockRejectedValueOnce(new Error("private diagnostic"));
    expect(await executor.run(request)).toEqual({ kind: "failed", reason: "transport" });
    expect(existsSync(dirname(run.mock.calls[2][1][1]))).toBe(false);
  });

  it("uses the runner's filtered environment when no override is supplied", async () => {
    const { run, executor } = fixture();
    await executor.run(request);
    expect(run.mock.calls[2][2]?.environment).toBeUndefined();
  });

  it("returns a configuration failure without spawning for an endpoint override", async () => {
    const { run, executor } = fixture();
    expect(
      await executor.run({
        ...request,
        environment: { OPENSHELL_GATEWAY_ENDPOINT: "https://ambient.invalid" },
      }),
    ).toEqual({ kind: "failed", reason: "configuration" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { status: 255, reason: "transport", timedOut: false },
    { status: null, reason: "timeout", timedOut: true },
  ])(
    "retains command diagnostics after $reason failure without retrying",
    async ({ status, reason, timedOut }) => {
      const { run } = fixture({ status, timedOut, stdout: "partial output", stderr: "diagnostic" });
      const executor = createCliOpenShellSandboxSshCommandExecutor({
        resolveBinary: () => "/bin/openshell",
        runBuffered: run,
      });
      expect(await executor.run(request)).toEqual({
        kind: "failed",
        reason,
        command: { exitCode: status ?? 1, stdout: "partial output", stderr: "diagnostic" },
      });
      expect(run).toHaveBeenCalledTimes(3);
      expect(existsSync(dirname(run.mock.calls[2][1][1]))).toBe(false);
    },
  );

  it("does not spawn when the executable is unavailable", async () => {
    const run = vi.fn<OpenShellBufferedCommandRunner>();
    const executor = createCliOpenShellSandboxSshExecutor({
      resolveBinary: () => null,
      runBuffered: run,
    });
    expect(await executor.run(request)).toEqual({ kind: "failed", reason: "unavailable" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([{ sandboxName: "--help" }, { command: "bad\0command" }])(
    "rejects invalid identity or command %j without spawning",
    async (invalid) => {
      const { run, executor } = fixture();
      expect(await executor.run({ ...request, ...invalid })).toEqual({
        kind: "failed",
        reason: "configuration",
      });
      expect(run).not.toHaveBeenCalled();
    },
  );
});
