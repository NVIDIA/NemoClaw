// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureManagedGatewayStateRoot } from "../../onboard/gateway/state-dir";
import {
  connectManagedOpenShellSdk,
  createSdkOpenShellSandboxCommandExecutor,
} from "./sandbox-command-sdk";

const roots: string[] = [];
const request = (timeoutSeconds = 120) =>
  ({
    sandboxName: "alpha",
    target: { kind: "named" as const, gatewayName: "nemoclaw" },
    command: ["/usr/local/bin/openclaw", "skills", "list"],
    timeoutSeconds,
  }) as const;

function tlsBundle(): string {
  const stateDir = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-sdk-test-"));
  roots.push(stateDir);
  ensureManagedGatewayStateRoot({
    gatewayName: "nemoclaw-9443",
    gatewayPort: 9443,
    stateDir,
  });
  fs.mkdirSync(path.join(stateDir, "tls", "client"), { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(stateDir, "tls", "ca.crt"), "ca");
  fs.writeFileSync(path.join(stateDir, "tls", "client", "tls.crt"), "cert");
  fs.writeFileSync(path.join(stateDir, "tls", "client", "tls.key"), "key");
  return stateDir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("OpenShell SDK sandbox command executor", () => {
  it("connects to a marked managed gateway with its local mTLS identity", async () => {
    const stateDir = tlsBundle();
    const connect = vi.fn().mockResolvedValue({ sandbox: {} });

    await connectManagedOpenShellSdk(
      { kind: "named", gatewayName: "nemoclaw-9443" },
      {
        env: { NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir },
        homeDir: "/unused",
        loadSdk: async () => ({ OpenShellClient: { connect } }),
      },
    );

    expect(connect).toHaveBeenCalledWith({
      gateway: "https://127.0.0.1:9443",
      caCert: Buffer.from("ca"),
      clientCert: Buffer.from("cert"),
      clientKey: Buffer.from("key"),
    });
  });

  it("streams native output and preserves the exit status", async () => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const executor = createSdkOpenShellSandboxCommandExecutor({
      connect: async () => ({
        sandbox: {
          execStream: async function* () {
            yield { stream: "stdout" as const, data: Buffer.from("native out\n") };
            yield { stream: "stderr" as const, data: Buffer.from("native err\n") };
            yield { type: "exit" as const, exitCode: 7 };
          },
        },
      }),
      stdout: (data) => stdout.push(data),
      stderr: (data) => stderr.push(data),
    });

    const completion = await executor.runStreaming(request());
    expect(completion.outcome).toEqual({ kind: "completed", exitCode: 7 });
    expect(Buffer.concat(stdout).toString()).toBe("native out\n");
    expect(Buffer.concat(stderr).toString()).toBe("native err\n");
    completion.release();
  });

  it("reports the optional SDK package as unavailable", async () => {
    const executor = createSdkOpenShellSandboxCommandExecutor({
      connect: vi
        .fn()
        .mockRejectedValue(
          new Error("Cannot find package '@nvidia/openshell-sdk' imported from /app/skill.js"),
        ),
    });

    const completion = await executor.runStreaming(request());
    expect(completion.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "unavailable" },
    });
    completion.release();
  });

  it("bounds connection and streaming even when the SDK ignores abort", async () => {
    vi.useFakeTimers();
    const connect = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({
        sandbox: {
          execStream: async function* () {
            await new Promise(() => {});
          },
        },
      })
      .mockResolvedValueOnce({
        sandbox: {
          execStream: async function* () {
            yield { type: "exit" as const, exitCode: 0 };
          },
        },
      });
    const executor = createSdkOpenShellSandboxCommandExecutor({ connect });

    const pendingConnection = executor.runStreaming(request(1));
    await vi.advanceTimersByTimeAsync(1000);
    const connectionTimeout = await pendingConnection;
    expect(connectionTimeout.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "timeout" },
    });
    connectionTimeout.release();

    const pendingStream = executor.runStreaming(request(1));
    await vi.advanceTimersByTimeAsync(1000);
    const streamTimeout = await pendingStream;
    expect(streamTimeout.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "timeout" },
    });
    streamTimeout.release();
    const success = await executor.runStreaming(request(1));
    expect(success.outcome).toEqual({ kind: "completed", exitCode: 0 });
    success.release();
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
