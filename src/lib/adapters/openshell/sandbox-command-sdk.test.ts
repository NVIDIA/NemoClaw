// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureManagedGatewayStateRoot,
  MANAGED_GATEWAY_STATE_ROOT_MARKER,
} from "../../onboard/gateway/state-dir";

import {
  connectManagedOpenShellSdk,
  createSdkOpenShellSandboxCommandExecutor,
} from "./sandbox-command-sdk";

const roots: string[] = [];

function writeTlsFiles(stateDir: string): void {
  fs.mkdirSync(path.join(stateDir, "tls", "client"), { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(stateDir, "tls", "ca.crt"), "ca");
  fs.writeFileSync(path.join(stateDir, "tls", "client", "tls.crt"), "cert");
  fs.writeFileSync(path.join(stateDir, "tls", "client", "tls.key"), "key");
}

function writeTlsBundle(gatewayName = "nemoclaw-9443", gatewayPort = 9443): string {
  const stateDir = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-sdk-test-"));
  roots.push(stateDir);
  ensureManagedGatewayStateRoot({ gatewayName, gatewayPort, stateDir });
  writeTlsFiles(stateDir);
  return stateDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

async function expectStateDirectoryRejected(stateDir: string): Promise<void> {
  const loadSdk = vi.fn();
  await expect(
    connectManagedOpenShellSdk(
      { kind: "named", gatewayName: "nemoclaw-9443" },
      {
        env: { NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir },
        homeDir: "/unused",
        loadSdk,
      },
    ),
  ).rejects.toThrow("Unsafe OpenShell gateway state directory");
  expect(loadSdk).not.toHaveBeenCalled();
}

describe("OpenShell SDK sandbox command executor", () => {
  it("connects to the named managed gateway with its local mTLS identity", async () => {
    const stateDir = writeTlsBundle();
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

  it("accepts the private port-derived default root without a legacy marker", async () => {
    const homeDir = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-sdk-home-test-"));
    roots.push(homeDir);
    const stateDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    writeTlsFiles(stateDir);
    const connect = vi.fn().mockResolvedValue({ sandbox: {} });

    await connectManagedOpenShellSdk(
      { kind: "named", gatewayName: "nemoclaw" },
      {
        env: {},
        homeDir,
        loadSdk: async () => ({ OpenShellClient: { connect } }),
      },
    );

    expect(connect).toHaveBeenCalledOnce();
  });

  it("rejects a missing ownership marker before loading the SDK", async () => {
    const stateDir = writeTlsBundle();
    fs.rmSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER));
    await expectStateDirectoryRejected(stateDir);
  });

  it("rejects a marker for another gateway before loading the SDK", async () => {
    const stateDir = writeTlsBundle("nemoclaw-9444", 9444);
    await expectStateDirectoryRejected(stateDir);
  });

  it("streams native stdout and stderr and preserves the SDK exit code", async () => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const executor = createSdkOpenShellSandboxCommandExecutor({
      connect: async () => ({
        sandbox: {
          exec: vi.fn(),
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

    const completion = await executor.runStreaming({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw" },
      command: ["/usr/local/bin/openclaw", "skills", "list"],
      timeoutSeconds: 120,
    });
    completion.release();

    expect(completion.outcome).toEqual({ kind: "completed", exitCode: 7 });
    expect(Buffer.concat(stdout).toString()).toBe("native out\n");
    expect(Buffer.concat(stderr).toString()).toBe("native err\n");
  });

  it("uses the SDK for directory probes", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1 });
    const executor = createSdkOpenShellSandboxCommandExecutor({
      connect: async () => ({ sandbox: { exec, execStream: vi.fn() } }),
    });

    await expect(
      executor.probeDirectory({
        sandboxName: "alpha",
        target: { kind: "named", gatewayName: "nemoclaw" },
        path: "/sandbox/missing",
      }),
    ).resolves.toEqual({ state: "missing" });
    expect(exec).toHaveBeenCalledWith("alpha", ["test", "-d", "/sandbox/missing"], {
      noLoginShell: true,
      timeoutSecs: 30,
    });
  });

  it("reconnects after a transient connection failure", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0 });
    const client = { sandbox: { exec, execStream: vi.fn() } };
    const connect = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(client);
    const executor = createSdkOpenShellSandboxCommandExecutor({ connect });
    const request = {
      sandboxName: "alpha",
      target: { kind: "named" as const, gatewayName: "nemoclaw" },
      path: "/sandbox",
    };

    await expect(executor.probeDirectory(request)).resolves.toMatchObject({
      state: "unobservable",
    });
    await expect(executor.probeDirectory(request)).resolves.toEqual({ state: "present" });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("classifies a missing optional SDK package as unavailable", async () => {
    const executor = createSdkOpenShellSandboxCommandExecutor({
      connect: vi
        .fn()
        .mockRejectedValue(
          new Error("Cannot find package '@nvidia/openshell-sdk' imported from /app/skill.js"),
        ),
    });

    const completion = await executor.runStreaming({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw" },
      command: ["true"],
    });
    completion.release();

    expect(completion.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "unavailable" },
    });
  });

  it("settles with the signal exit code when connection is interrupted", async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const add = vi.fn((signal: NodeJS.Signals, listener: () => void) =>
      listeners.set(signal, listener),
    );
    const remove = vi.fn((signal: NodeJS.Signals) => listeners.delete(signal));
    const execStream = vi.fn(async function* () {});
    let resolveConnection = () => {};
    const executor = createSdkOpenShellSandboxCommandExecutor({
      connect: () =>
        new Promise((resolve) => {
          resolveConnection = () =>
            resolve({ sandbox: { exec: vi.fn().mockResolvedValue({ exitCode: 0 }), execStream } });
        }),
      signalSource: { add, remove },
    });
    const pending = executor.runStreaming({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw" },
      command: ["true"],
    });
    await Promise.resolve();

    listeners.get("SIGTERM")?.();
    const completion = await pending;

    expect(completion.outcome).toEqual({
      kind: "completed",
      exitCode: 143,
      signal: "SIGTERM",
    });
    resolveConnection();
    await Promise.resolve();
    expect(execStream).not.toHaveBeenCalled();
    completion.release();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("bounds connection setup and starts a fresh connection after timeout", async () => {
    vi.useFakeTimers();
    try {
      const execStream = vi.fn(async function* () {
        yield { type: "exit" as const, exitCode: 0 };
      });
      const connect = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ sandbox: { exec: vi.fn(), execStream } });
      const executor = createSdkOpenShellSandboxCommandExecutor({ connect });
      const request = {
        sandboxName: "alpha",
        target: { kind: "named" as const, gatewayName: "nemoclaw" },
        command: ["true"],
        timeoutSeconds: 1,
      };

      const pending = executor.runStreaming(request);
      await vi.advanceTimersByTimeAsync(1000);
      const timedOut = await pending;
      timedOut.release();

      expect(timedOut.outcome).toMatchObject({
        kind: "failed",
        error: { kind: "timeout" },
      });
      const retry = await executor.runStreaming(request);
      retry.release();
      expect(retry.outcome).toEqual({ kind: "completed", exitCode: 0 });
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires an explicit managed gateway", async () => {
    const executor = createSdkOpenShellSandboxCommandExecutor({
      connect: vi.fn(),
    });

    await expect(
      executor.runStreaming({
        sandboxName: "alpha",
        target: { kind: "selected" },
        command: ["true"],
      }),
    ).rejects.toThrow("explicit gateway target");
  });
});
