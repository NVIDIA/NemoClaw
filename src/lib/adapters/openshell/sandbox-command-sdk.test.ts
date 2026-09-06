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

function writeTlsBundle(gatewayName = "nemoclaw-9443", gatewayPort = 9443): string {
  const stateDir = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-sdk-test-"));
  roots.push(stateDir);
  ensureManagedGatewayStateRoot({ gatewayName, gatewayPort, stateDir });
  fs.mkdirSync(path.join(stateDir, "tls", "client"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "tls", "ca.crt"), "ca");
  fs.writeFileSync(path.join(stateDir, "tls", "client", "tls.crt"), "cert");
  fs.writeFileSync(path.join(stateDir, "tls", "client", "tls.key"), "key");
  return stateDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

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

  it.each([
    ["a missing ownership marker", "missing"],
    ["a marker for another gateway", "wrong-gateway"],
  ])("rejects %s before loading the SDK", async (_label, fixture) => {
    const stateDir =
      fixture === "wrong-gateway" ? writeTlsBundle("nemoclaw-9444", 9444) : writeTlsBundle();
    if (fixture === "missing") {
      fs.rmSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER));
    }
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
