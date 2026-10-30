// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { openInstalledRuntimeSession } from "../../packaging/windows/runtime/installed-runtime-provider.mts";
import { NativeGatewaySession } from "../../packaging/windows/runtime/native-gateway-session.mts";
import { run } from "../../packaging/windows/runtime/native-command.mts";
import {
  requestNativeUiSandboxDeletion,
  confirmNativeUiRegistryEmpty,
  waitForNativeMxcCompletion,
} from "../../packaging/windows/runtime/native-ui-lifecycle.mts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../packaging/windows/runtime/native-command.mts", () => ({
  requiredFile: (file: string) => file,
  allowlistedWindowsEnvironment: (environment: NodeJS.ProcessEnv) => environment,
  run: vi.fn(),
}));
vi.mock("../../packaging/windows/runtime/native-ui-lifecycle.mts", () => ({
  requestNativeUiSandboxDeletion: vi.fn(),
  confirmNativeUiRegistryEmpty: vi.fn(),
  waitForNativeMxcCompletion: vi.fn(),
  watchNativeUiSandbox: vi.fn(),
}));
vi.mock("../../packaging/windows/runtime/native-gateway-session.mts", () => ({
  NativeGatewaySession: vi.fn(
    class {
      root = "private";
      environment = { XDG_CONFIG_HOME: "private-config", OPENSHELL_LOCAL_TLS_DIR: "private-tls" };
      gatewayProcessId = 42;
      ownCommandProcess = vi.fn();
      spawnGateway = vi.fn();
      prepare = vi.fn();
      configuration = vi.fn();
      preflightConfiguration = vi.fn();
      stopGateway = vi.fn();
      dispose = vi.fn();
    },
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function fixture() {
  const session = openInstalledRuntimeSession("installation", "run");
  const owner = vi.mocked(NativeGatewaySession).mock.results[0].value as NativeGatewaySession;
  return { session, owner, environment: { XDG_CONFIG_HOME: "private-config" } };
}

describe("installed Windows provider operations", () => {
  it.each([
    { agent: "openclaw", terminal: false, ports: undefined },
    { agent: "openclaw", terminal: true, ports: [1234, 2345] },
    { agent: "hermes", terminal: false, ports: [1234, 2345, 3456] },
    { agent: "hermes", terminal: true, ports: [1234, 2345] },
  ])("preserves the $agent workload with terminal=$terminal", ({ agent, terminal, ports }) => {
    const { session, owner, environment } = fixture();
    const child = new EventEmitter() as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const workload = {
      name: "owned-sandbox",
      policy: "owned-policy",
      command: ["sealed-worker", agent],
      directory: "owned-writable-state",
      ports,
      terminal,
      environment: { HOME: "owned-home" },
    };
    expect(session.startWorkload(workload, environment, ["ignore", "pipe", "pipe"])).toBe(child);
    expect(owner.ownCommandProcess).toHaveBeenCalledExactlyOnceWith(child);
    const [file, argv, options] = vi.mocked(spawn).mock.calls[0];
    expect(file).toBe(path.join("installation", "bin", "openshell.exe"));
    expect(argv).toEqual([
      "sandbox",
      "create",
      "--name",
      workload.name,
      "--policy",
      workload.policy,
      "--driver-config-json",
      JSON.stringify({
        mxc: {
          command: workload.command,
          cwd: workload.directory,
          ...(ports === undefined ? {} : { loopback_pipe_ports: ports }),
        },
      }),
      terminal ? "--tty" : "--no-tty",
      "--env",
      "HOME=owned-home",
      "--detach",
      "--",
      ...workload.command,
    ]);
    expect(options).toEqual({
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  });

  it("keeps authentication, private state, and Hermes desktop settings on gateway startup", () => {
    const { session, owner } = fixture();
    const environment = session.gatewayEnvironment("gateway.toml", {
      OPENSHELL_DRIVERS: "foreign",
      XDG_CONFIG_HOME: "foreign",
      NEMOCLAW_HERMES_PRIVATE_DESKTOP: "1",
      NEMOCLAW_MSYS_TOKEN_INSPECTION: "hermes-query",
    });
    expect(environment).toMatchObject({
      OPENSHELL_DRIVERS: "mxc",
      OPENSHELL_GATEWAY_CONFIG: "gateway.toml",
      XDG_CONFIG_HOME: "private-config",
      OPENSHELL_LOCAL_TLS_DIR: "private-tls",
      NEMOCLAW_HERMES_PRIVATE_DESKTOP: "1",
      NEMOCLAW_MSYS_TOKEN_INSPECTION: "hermes-query",
    });
    session.startGateway({
      port: 1234,
      environment,
      stdio: "inherit",
      windowsHide: false,
      logLevel: "warn",
    });
    expect(owner.spawnGateway).toHaveBeenCalledExactlyOnceWith(
      path.join("installation", "bin", "openshell-gateway.exe"),
      [
        "--port",
        "1234",
        "--enable-mtls-auth",
        "true",
        "--db-url",
        "sqlite::memory:",
        "--log-level",
        "warn",
      ],
      { env: environment, stdio: "inherit", windowsHide: false },
    );
  });

  it("passes the same command owner to gateway registration, creation, and deletion", async () => {
    const { session, owner, environment } = fixture();
    await session.registerGateway(1234, "owned-gateway", environment, ["add", "select"]);
    await session.createWorkload(
      {
        name: "owned-sandbox",
        policy: "policy",
        command: ["worker"],
        directory: "home",
        environment: {},
      },
      environment,
      "create",
    );
    await session.deleteWorkload("owned-sandbox", environment, "delete", 30_000);
    expect(vi.mocked(run).mock.calls.map((call) => [call[1], call[2], call[4], call[6]])).toEqual([
      [
        ["gateway", "add", "https://127.0.0.1:1234", "--local", "--name", "owned-gateway"],
        environment,
        undefined,
        owner.ownCommandProcess,
      ],
      [["gateway", "select", "owned-gateway"], environment, undefined, owner.ownCommandProcess],
      [
        expect.arrayContaining(["sandbox", "create", "--policy", "policy", "--no-tty", "--detach"]),
        environment,
        undefined,
        owner.ownCommandProcess,
      ],
      [["sandbox", "delete", "owned-sandbox"], environment, 30_000, owner.ownCommandProcess],
    ]);
  });

  it("preserves deletion authority, completion observation, and cleanup failures", async () => {
    const { session, owner, environment } = fixture();
    const gateway = { exitCode: null, signalCode: null };
    const stateSession = { assertHeld: vi.fn() };
    const ownership = {
      sandboxName: "owned-sandbox",
      gateway,
      stateSession,
      creationRejected: true,
    };
    await session.requestWorkloadDeletion(environment, ownership);
    await session.confirmRegistryEmpty(environment, ownership);
    await session.waitForCompletion(
      environment,
      ownership.sandboxName,
      gateway,
      stateSession,
      12_000,
    );
    expect(requestNativeUiSandboxDeletion).toHaveBeenCalledExactlyOnceWith(
      path.join("installation", "bin", "openshell.exe"),
      environment,
      ownership,
      owner.ownCommandProcess,
    );
    expect(confirmNativeUiRegistryEmpty).toHaveBeenCalledExactlyOnceWith(
      path.join("installation", "bin", "openshell.exe"),
      environment,
      ownership,
      owner.ownCommandProcess,
    );
    expect(waitForNativeMxcCompletion).toHaveBeenCalledExactlyOnceWith(
      path.join("installation", "bin", "openshell.exe"),
      environment,
      "owned-sandbox",
      gateway,
      stateSession,
      12_000,
      owner.ownCommandProcess,
      undefined,
    );
    vi.mocked(owner.stopGateway).mockResolvedValue(false);
    vi.mocked(owner.dispose).mockRejectedValue(new Error("owned process remains"));
    expect(await session.stopGateway()).toBe(false);
    await expect(session.dispose()).rejects.toThrow("owned process remains");
  });
});
