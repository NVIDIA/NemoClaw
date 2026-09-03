// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  PodmanExecutableAuthorityDeps,
  PodmanExecutableStat,
  PodmanSocketAuthority,
} from "../../adapters/podman";
import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { createPortableOnboardEnvironmentScope } from "../session-bootstrap";
import {
  captureHermesPortablePodmanExecutableAuthority,
  captureHermesPortablePodmanExecutableFileAuthority,
  createHermesPortablePodmanCommandAuthority,
  createHermesPortablePodmanInferenceInspectionAuthority,
  createHermesPortablePodmanOperationEngines,
  type HermesPortablePodmanAuthorityDeps,
} from "./hermes-portable-podman-authority";

const PODMAN_PATH = "/usr/bin/podman";
const PODMAN_BYTES = Buffer.from("hermes-portable-podman-5.7.0", "utf8");

function runtimeAuthority(): CheckpointPortableRuntimeAuthority {
  const uid = process.getuid!();
  return {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid,
    homeDir: "/home/test",
    configHome: "/home/test/.config",
    runtimeDir: `/run/user/${String(uid)}`,
    socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
  };
}

function socketAuthority(): PodmanSocketAuthority {
  const runtime = runtimeAuthority();
  return {
    device: "1",
    inode: "2",
    mode: String(0o140600),
    ownerUid: String(runtime.uid),
    socketPath: runtime.socketPath,
    directoryChain: [],
  };
}

function executableDeps(generation: {
  executableInode: bigint;
  parentInode: bigint;
}): PodmanExecutableAuthorityDeps {
  const executable = (): PodmanExecutableStat => ({
    dev: 1n,
    ino: generation.executableInode,
    mode: 0o100755n,
    uid: 0n,
    size: BigInt(PODMAN_BYTES.byteLength),
    mtimeNs: 10n,
    ctimeNs: 11n,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const directory = (filePath: string): PodmanExecutableStat => ({
    ...executable(),
    ino: filePath === "/usr/bin" ? generation.parentInode : 100n,
    mode: 0o40755n,
    size: 0n,
    isDirectory: () => true,
    isFile: () => false,
  });
  return {
    uid: process.getuid!(),
    lstat: (filePath) => (filePath === PODMAN_PATH ? executable() : directory(filePath)),
    readFile: () => PODMAN_BYTES,
    realpath: (filePath) => filePath,
  };
}

function podmanInfo(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    host: {
      arch: "amd64",
      os: "linux",
      cgroupVersion: "v2",
      networkBackend: "netavark",
      security: { rootless: true },
      idMappings: {
        uidmap: [
          { container_id: 0, host_id: 1000, size: 1 },
          { container_id: 1, host_id: 100000, size: 65536 },
        ],
        gidmap: [
          { container_id: 0, host_id: 1000, size: 1 },
          { container_id: 1, host_id: 100000, size: 65536 },
        ],
      },
      ...overrides,
    },
  });
}

function authorityDeps(
  capture: ContainerEngineCommandCapture,
  executableAuthorityDeps: PodmanExecutableAuthorityDeps,
  resolveExecutablePath: (env: NodeJS.ProcessEnv) => string = () => PODMAN_PATH,
): HermesPortablePodmanAuthorityDeps {
  return {
    capture,
    executableAuthorityDeps,
    assertSocketAuthority: vi.fn(),
    resolveExecutablePath,
    platform: "linux",
    architecture: "x64",
    uid: process.getuid!(),
  };
}

function successfulCapture(
  options: { client?: string; server?: string; info?: string; failInfo?: boolean } = {},
): ReturnType<typeof vi.fn<ContainerEngineCommandCapture>> {
  return vi.fn<ContainerEngineCommandCapture>((_executable, args, _timeout, _input, env) => {
    expect(env).toEqual({
      HOME: "/home/test",
      XDG_CONFIG_HOME: "/home/test/.config",
      XDG_RUNTIME_DIR: `/run/user/${String(process.getuid!())}`,
    });
    const operation = args.includes("version")
      ? "version"
      : args.includes("info")
        ? "info"
        : "business";
    const responses = {
      version: () => ({
        status: 0,
        stdout: JSON.stringify({
          Client: { Version: options.client ?? "5.7.0" },
          Server: { Version: options.server ?? "5.7.0" },
        }),
        stderr: "",
      }),
      info: () =>
        options.failInfo
          ? { status: 125, stdout: "", stderr: "API unavailable" }
          : { status: 0, stdout: options.info ?? podmanInfo(), stderr: "" },
      business: () => ({ status: 0, stdout: "business command", stderr: "" }),
    } as const;
    return responses[operation]();
  });
}

describe("Hermes portable Podman executable and endpoint authority", () => {
  it("omits exact scope-owned selectors before the Podman child", () => {
    const runtime = runtimeAuthority();
    const containersConf = "/home/test/.config/nemoclaw/portable/containers.conf";
    const env: NodeJS.ProcessEnv = { HOME: runtime.homeDir, PATH: "/usr/bin" };
    const scope = createPortableOnboardEnvironmentScope(env, null);
    scope.installRuntime({ containersConf, socketPath: runtime.socketPath });
    const capture = successfulCapture();

    expect(() =>
      captureHermesPortablePodmanExecutableAuthority(
        socketAuthority(),
        runtime,
        scope.createHermesPortablePodmanSourceEnvironment(runtime),
        authorityDeps(capture, executableDeps({ executableInode: 10n, parentInode: 20n })),
      ),
    ).not.toThrow();
    expect(env).toMatchObject({
      DOCKER_HOST: `unix://${runtime.socketPath}`,
      CONTAINERS_CONF: containersConf,
    });
    expect(capture).toHaveBeenCalled();
  });

  it("captures and reuses only the exact 5.7.0 rootless amd64 netavark authority", () => {
    const generation = { executableInode: 10n, parentInode: 20n };
    const capture = successfulCapture();
    const deps = authorityDeps(capture, executableDeps(generation));
    const authority = captureHermesPortablePodmanExecutableAuthority(
      socketAuthority(),
      runtimeAuthority(),
      { PATH: "/usr/bin", HOME: "/home/test" },
      deps,
    );
    const command = createHermesPortablePodmanCommandAuthority(
      authority,
      socketAuthority(),
      runtimeAuthority(),
      { PATH: "/usr/bin", HOME: "/home/test" },
      deps,
    );

    command.assertCurrent();
    expect(command.engine.capture(["container", "inspect", "a".repeat(64)]).status).toBe(0);
    expect(authority).toMatchObject({
      version: "5.7.0",
      executable: { executablePath: PODMAN_PATH, inode: "10" },
    });
    expect(capture).toHaveBeenCalledWith(
      PODMAN_PATH,
      ["--url", `unix://${runtimeAuthority().socketPath}`, "container", "inspect", "a".repeat(64)],
      15_000,
      undefined,
      expect.any(Object),
    );
  });

  it("recaptures exact executable identity without querying Podman for read-only proof", () => {
    const generation = { executableInode: 10n, parentInode: 20n };
    const capture = successfulCapture();
    const executableAuthorityDeps = executableDeps(generation);
    const readFile = vi.spyOn(executableAuthorityDeps, "readFile");
    const deps = authorityDeps(capture, executableAuthorityDeps);
    const runtime = runtimeAuthority();
    const sourceEnv = { PATH: "/usr/bin", HOME: "/home/test" };
    const recorded = captureHermesPortablePodmanExecutableAuthority(
      socketAuthority(),
      runtime,
      sourceEnv,
      deps,
    );
    capture.mockClear();
    readFile.mockClear();

    expect(
      captureHermesPortablePodmanExecutableFileAuthority(
        socketAuthority(),
        { runtimeAuthority: runtime, podmanExecutableAuthority: recorded },
        sourceEnv,
        deps,
      ),
    ).toEqual(recorded);
    expect(capture).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects retained file proof when Podman executable metadata drifts", () => {
    const generation = { executableInode: 10n, parentInode: 20n };
    const capture = successfulCapture();
    const deps = authorityDeps(capture, executableDeps(generation));
    const runtime = runtimeAuthority();
    const sourceEnv = { PATH: "/usr/bin", HOME: "/home/test" };
    const recorded = captureHermesPortablePodmanExecutableAuthority(
      socketAuthority(),
      runtime,
      sourceEnv,
      deps,
    );
    capture.mockClear();
    generation.executableInode = 11n;

    expect(() =>
      captureHermesPortablePodmanExecutableFileAuthority(
        socketAuthority(),
        { runtimeAuthority: runtime, podmanExecutableAuthority: recorded },
        sourceEnv,
        deps,
      ),
    ).toThrow("changed after it was qualified");
    expect(capture).not.toHaveBeenCalled();
  });

  it("binds one inference inspection without repeating Podman version or info", () => {
    const generation = { executableInode: 10n, parentInode: 20n };
    const capture = successfulCapture();
    const deps = authorityDeps(capture, executableDeps(generation));
    const runtime = runtimeAuthority();
    const sourceEnv = { PATH: "/usr/bin", HOME: "/home/test" };
    const recorded = captureHermesPortablePodmanExecutableAuthority(
      socketAuthority(),
      runtime,
      sourceEnv,
      deps,
    );
    capture.mockClear();

    const inspection = createHermesPortablePodmanInferenceInspectionAuthority(
      recorded,
      socketAuthority(),
      runtime,
      sourceEnv,
      deps,
    );
    inspection.assertTransactionCurrent();
    expect(capture).not.toHaveBeenCalled();

    expect(inspection.engine.capture(["container", "inspect", "a".repeat(64)]).status).toBe(0);
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[1]).toEqual([
      "--url",
      `unix://${runtime.socketPath}`,
      "container",
      "inspect",
      "a".repeat(64),
    ]);
  });

  it("performs one full executable assertion at each adjacent authority boundary", () => {
    const generation = { executableInode: 10n, parentInode: 20n };
    const capture = successfulCapture();
    const executableAuthorityDeps = executableDeps(generation);
    const readFile = vi.fn(executableAuthorityDeps.readFile!);
    const deps = authorityDeps(capture, { ...executableAuthorityDeps, readFile });
    const runtime = runtimeAuthority();
    const socket = socketAuthority();
    const sourceEnv = { PATH: "/usr/bin", HOME: "/home/test" };
    const authority = captureHermesPortablePodmanExecutableAuthority(
      socket,
      runtime,
      sourceEnv,
      deps,
    );
    readFile.mockClear();

    const command = createHermesPortablePodmanCommandAuthority(
      authority,
      socket,
      runtime,
      sourceEnv,
      deps,
    );
    expect(readFile).toHaveBeenCalledTimes(1);
    readFile.mockClear();

    command.assertTransactionCurrent();

    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("latches wrapper assertion failure across operation engines", () => {
    const generation = { executableInode: 10n, parentInode: 20n };
    const capture = successfulCapture();
    const deps = authorityDeps(capture, executableDeps(generation));
    const runtime = runtimeAuthority();
    const socket = socketAuthority();
    const sourceEnv = { PATH: "/usr/bin", HOME: "/home/test" };
    const authority = captureHermesPortablePodmanExecutableAuthority(
      socket,
      runtime,
      sourceEnv,
      deps,
    );
    const engines = createHermesPortablePodmanOperationEngines(
      authority,
      socket,
      runtime,
      sourceEnv,
      deps,
    );
    capture.mockClear();
    generation.executableInode = 11n;

    expect(() => engines.assertTransactionCurrent()).toThrow("changed after it was qualified");
    generation.executableInode = 10n;
    expect(() => engines.sandboxLifecycle.capture(["info"])).toThrow(
      "changed after it was qualified",
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["client", { client: "5.6.2" }],
    ["server", { server: "5.8.0" }],
    ["API", { failInfo: true }],
  ])("rejects an exact %s qualification failure", (_label, options) => {
    const generation = { executableInode: 10n, parentInode: 20n };
    expect(() =>
      captureHermesPortablePodmanExecutableAuthority(
        socketAuthority(),
        runtimeAuthority(),
        { PATH: "/usr/bin", HOME: "/home/test" },
        authorityDeps(successfulCapture(options), executableDeps(generation)),
      ),
    ).toThrow();
  });

  it("rejects binary, parent, and PATH replacement before another child", () => {
    const generation = { executableInode: 10n, parentInode: 20n };
    let resolved = PODMAN_PATH;
    const capture = successfulCapture();
    const deps = authorityDeps(capture, executableDeps(generation), () => resolved);
    const authority = captureHermesPortablePodmanExecutableAuthority(
      socketAuthority(),
      runtimeAuthority(),
      { PATH: "/usr/bin", HOME: "/home/test" },
      deps,
    );
    const command = createHermesPortablePodmanCommandAuthority(
      authority,
      socketAuthority(),
      runtimeAuthority(),
      { PATH: "/usr/bin", HOME: "/home/test" },
      deps,
    );

    generation.executableInode = 11n;
    expect(() => command.assertCurrent()).toThrow("changed after it was qualified");
    generation.executableInode = 10n;
    generation.parentInode = 21n;
    expect(() => command.assertCurrent()).toThrow("changed after it was qualified");
    generation.parentInode = 20n;
    resolved = "/opt/replacement/podman";
    expect(() => command.assertCurrent()).toThrow("PATH resolves another Podman executable");
  });

  it("rejects selectors and socket/runtime disagreement before a Podman child", () => {
    const capture = successfulCapture();
    const deps = authorityDeps(capture, executableDeps({ executableInode: 10n, parentInode: 20n }));
    expect(() =>
      captureHermesPortablePodmanExecutableAuthority(
        socketAuthority(),
        runtimeAuthority(),
        { PATH: "/usr/bin", HOME: "/home/test", DOCKER_HOST: "tcp://attacker.test" },
        deps,
      ),
    ).toThrow("connection selector is not allowed");

    const wrongSocket = { ...socketAuthority(), socketPath: "/run/user/1/podman.sock" };
    expect(() =>
      captureHermesPortablePodmanExecutableAuthority(
        wrongSocket,
        runtimeAuthority(),
        { PATH: "/usr/bin", HOME: "/home/test" },
        deps,
      ),
    ).toThrow("runtime or socket identity disagrees");
    expect(capture).not.toHaveBeenCalled();
  });
});
