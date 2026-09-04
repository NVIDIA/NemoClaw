// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ContainerEngineCommandCapture } from "../container-engine";
import {
  capturePodmanExecutableAuthority,
  createPodmanContainerEngine,
  createPodmanExecutableOperationProof,
  localPodmanEnvironment,
  resolvePodmanExecutablePath,
  type PodmanExecutableAuthorityDeps,
  type PodmanExecutableStat,
  type PodmanSocketAuthority,
} from "./index";

const AUTHORITY = {
  directoryChain: [],
  device: "8",
  inode: "9001",
  mode: "384",
  ownerUid: "1000",
  socketPath: "/run/user/1000/podman/podman.sock",
} as const satisfies PodmanSocketAuthority;
const PODMAN_BYTES = Buffer.from("qualified-podman-binary", "utf8");

function executableAuthorityDeps(
  bytes: Uint8Array = PODMAN_BYTES,
  overrides: Partial<PodmanExecutableAuthorityDeps> = {},
): PodmanExecutableAuthorityDeps {
  const stat: PodmanExecutableStat = {
    dev: 8n,
    ino: 42n,
    mode: 0o100755n,
    uid: 0n,
    size: BigInt(bytes.byteLength),
    mtimeNs: 1000n,
    ctimeNs: 2000n,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const directoryStat: PodmanExecutableStat = {
    ...stat,
    ino: 43n,
    mode: 0o40755n,
    size: 0n,
    isDirectory: () => true,
    isFile: () => false,
  };
  return {
    uid: 1000,
    lstat: (filePath) => (filePath === "/usr/bin/podman" ? stat : directoryStat),
    readFile: () => bytes,
    realpath: (filePath) => filePath,
    ...overrides,
  };
}

describe("Podman container engine command adapter", () => {
  it("resolves and pins the canonical Podman executable for host-local inference", ({
    onTestFinished,
  }) => {
    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync(os.homedir()), ".nemoclaw-podman-executable-"),
    );
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "podman");
    fs.writeFileSync(executable, PODMAN_BYTES, { mode: 0o700 });

    expect(resolvePodmanExecutablePath({ PATH: directory })).toBe(executable);
    const capture = vi.fn<ContainerEngineCommandCapture>(() => ({
      status: 0,
      stdout: "ok",
      stderr: "",
    }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executableSearchEnv: { PATH: directory },
      assertAuthority: vi.fn(),
      capture,
    });

    expect(engine.capture(["inspect", "qualified-id"], 2000).status).toBe(0);
    expect(capture.mock.calls[0]?.[0]).toBe(executable);
  });

  it("removes ambient remote and Docker TLS selectors from local Podman commands (#9035)", () => {
    const source = {
      CONTAINER_HOST: "ssh://attacker.test",
      CONTAINER_CONNECTION: "attacker",
      CONTAINER_SSHKEY: "/tmp/attacker-key",
      DOCKER_TLS: "1",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: "/tmp/attacker-certs",
      KEEP: "value",
    };

    expect(localPodmanEnvironment(source)).toEqual({ KEEP: "value" });
    expect(source.DOCKER_TLS_VERIFY).toBe("1");
  });

  it("pins the exact socket around each operation-scoped command", () => {
    const assertAuthority = vi.fn();
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      assertAuthority,
      capture,
    });

    expect(engine.capture(["start", "a".repeat(64)], 2000)).toMatchObject({
      status: 0,
      stdout: "ok",
    });
    expect(assertAuthority).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/podman",
      ["--url", "unix:///run/user/1000/podman/podman.sock", "start", "a".repeat(64)],
      2000,
    );
    expect(engine).toMatchObject({
      operation: "sandbox-lifecycle",
      engineId: "podman",
      displayName: "Podman",
      authorityId: expect.stringMatching(/^podman-sha256:[0-9a-f]{64}$/u),
    });
  });

  it("gives different socket authorities different opaque identities", () => {
    const first = createPodmanContainerEngine({
      operation: "host-doctor",
      socketAuthority: AUTHORITY,
      assertAuthority: vi.fn(),
      capture: vi.fn(),
    });
    const second = createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority: { ...AUTHORITY, inode: "9002" },
      assertAuthority: vi.fn(),
      capture: vi.fn(),
    });

    expect(first.authorityId).not.toBe(second.authorityId);
  });

  it("creates a host-local-inference engine without changing another operation", () => {
    const assertAuthority = vi.fn();
    const capture = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const readFile = vi.fn(() => PODMAN_BYTES);
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { readFile }),
      assertAuthority,
      capture,
    });

    engine.capture(["info", "--format", "json"]);

    expect(engine.operation).toBe("host-local-inference");
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/podman",
      ["--url", "unix:///run/user/1000/podman/podman.sock", "info", "--format", "json"],
      15_000,
    );
    expect(assertAuthority).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledOnce();
    expect(() => engine.captureHost(["info"])).toThrow("forbids ambient host command capture");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("pins socket and executable authority for sandbox lifecycle retries", () => {
    const assertSocketAuthority = vi.fn();
    const capture = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const readFile = vi.fn(() => PODMAN_BYTES);
    const authorityDeps = executableAuthorityDeps(PODMAN_BYTES, { readFile });
    const engine = createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthority: capturePodmanExecutableAuthority("/usr/bin/podman", authorityDeps),
      executableAuthorityDeps: authorityDeps,
      assertAuthority: assertSocketAuthority,
      capture,
    });

    engine.assertAuthority();
    engine.capture(["container", "inspect", "a".repeat(64)]);

    expect(engine.operation).toBe("sandbox-lifecycle");
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(assertSocketAuthority).toHaveBeenCalledTimes(3);
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/podman",
      ["--url", "unix:///run/user/1000/podman/podman.sock", "container", "inspect", "a".repeat(64)],
      15_000,
    );
    expect(() => engine.captureHost(["info"])).toThrow(
      "Podman sandbox-lifecycle forbids ambient host command capture",
    );
  });

  it("prepares one exact managed-bootstrap workspace root through Podman's user namespace", ({
    onTestFinished,
  }) => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-workspace-")),
    );
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const capture = vi.fn<ContainerEngineCommandCapture>((_executable, args) => {
      const payload = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>;
      return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
    });
    const engine = createPodmanContainerEngine({
      operation: "managed-bootstrap",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(),
      assertAuthority: vi.fn(),
      commandEnvironment: {
        HOME: "/home/podman",
        XDG_RUNTIME_DIR: "/run/user/1000",
        CONTAINERS_CONF: "/tmp/native-podman-containers.conf",
        CONTAINERS_STORAGE_CONF: "/tmp/native-podman-storage.conf",
      },
      capture,
    });

    expect(
      engine.prepareManagedWorkspaceRoot?.({ path: directory, uid: 0, gid: 999, mode: 0o1775 }),
    ).toMatchObject({
      path: directory,
      uid: 0,
      gid: 999,
      mode: 0o1775,
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[1].slice(0, 2)).toEqual([
      "unshare",
      fs.realpathSync(process.execPath),
    ]);
    expect(JSON.parse(capture.mock.calls[0]?.[1].at(-1) ?? "{}")).toMatchObject({
      path: directory,
      uid: 0,
      gid: 999,
      mode: 0o1775,
    });
    expect(capture.mock.calls[0]?.[4]).toEqual({
      HOME: "/home/podman",
      XDG_RUNTIME_DIR: "/run/user/1000",
      CONTAINERS_CONF: "/tmp/native-podman-containers.conf",
      CONTAINERS_STORAGE_CONF: "/tmp/native-podman-storage.conf",
    });
    expect(() => engine.captureHost(["unshare", "id"])).toThrow(
      "forbids ambient host command capture",
    );
  });

  it("prepares one exact managed-bootstrap volume root without recursive ownership changes", ({
    onTestFinished,
  }) => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-volume-")),
    );
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const capture = vi.fn<ContainerEngineCommandCapture>((_executable, args) => {
      const payload = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>;
      return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
    });
    const engine = createPodmanContainerEngine({
      operation: "managed-bootstrap",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(),
      assertAuthority: vi.fn(),
      capture,
    });

    expect(
      engine.prepareManagedVolumeRoot?.({
        path: directory,
        uid: 1000,
        gid: 1000,
        mode: 0o2770,
      }),
    ).toMatchObject({ path: directory, uid: 1000, gid: 1000, mode: 0o2770 });
    expect(capture).toHaveBeenCalledOnce();
    expect(JSON.parse(capture.mock.calls[0]?.[1].at(-1) ?? "{}")).toMatchObject({
      path: directory,
      uid: 1000,
      gid: 1000,
      mode: 0o2770,
    });
  });

  it("shares only socket authority across real operation-scoped engines", () => {
    const common = {
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      assertAuthority: vi.fn(),
      capture: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    } as const;
    const hostDoctor = createPodmanContainerEngine({
      ...common,
      operation: "host-doctor",
    });
    const sandboxLifecycle = createPodmanContainerEngine({
      ...common,
      operation: "sandbox-lifecycle",
    });
    const hostLocalInference = createPodmanContainerEngine({
      ...common,
      operation: "host-local-inference",
      executableAuthorityDeps: executableAuthorityDeps(),
    });

    expect(hostDoctor.endpointAuthorityId).toBe(sandboxLifecycle.endpointAuthorityId);
    expect(hostLocalInference.endpointAuthorityId).toBe(hostDoctor.endpointAuthorityId);
    expect(hostDoctor.authorityId).toBe(sandboxLifecycle.authorityId);
    expect(hostLocalInference.authorityId).not.toBe(hostDoctor.authorityId);
  });

  it("keeps explicit inference environment on the exact guarded socket command", () => {
    const assertAuthority = vi.fn();
    const capture = vi.fn<ContainerEngineCommandCapture>(() => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(),
      assertAuthority,
      capture,
    });

    engine.captureWithEnvironment?.(
      ["run", "--env", "NIM_NGC_API_KEY"],
      { NIM_NGC_API_KEY: "operation-only-test-value" },
      2000,
    );

    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.slice(0, 3)).toEqual([
      "/usr/bin/podman",
      ["--url", "unix:///run/user/1000/podman/podman.sock", "run", "--env", "NIM_NGC_API_KEY"],
      2000,
    ]);
    expect(capture.mock.calls[0]?.[4]).toMatchObject({
      NIM_NGC_API_KEY: "operation-only-test-value",
    });
    expect(assertAuthority).toHaveBeenCalledTimes(2);
  });

  it("requires a resolvable canonical absolute executable for host-local inference", () => {
    expect(() =>
      createPodmanContainerEngine({
        operation: "host-local-inference",
        socketAuthority: AUTHORITY,
        executableSearchEnv: { PATH: "" },
        assertAuthority: vi.fn(),
        capture: vi.fn(),
      }),
    ).toThrow("could not resolve podman from PATH");
    expect(() =>
      createPodmanContainerEngine({
        operation: "host-local-inference",
        socketAuthority: AUTHORITY,
        executable: "podman",
        assertAuthority: vi.fn(),
        capture: vi.fn(),
      }),
    ).toThrow("canonical absolute path");
  });

  it("binds executable content authority into the opaque Podman authority", () => {
    const firstBytes = Buffer.from("qualified-podman-binary", "utf8");
    const secondBytes = Buffer.from("different-podman-binary", "utf8");
    expect(secondBytes.byteLength).toBe(firstBytes.byteLength);
    const first = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(firstBytes),
      assertAuthority: vi.fn(),
      capture: vi.fn(),
    });
    const second = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(secondBytes),
      assertAuthority: vi.fn(),
      capture: vi.fn(),
    });

    expect(first.authorityId).not.toBe(second.authorityId);
  });

  it("rejects executable metadata rotation observed after a successful command", () => {
    const defaultDeps = executableAuthorityDeps();
    let executableInode = 42n;
    const lstat = vi.fn((filePath: string) => {
      const stat = defaultDeps.lstat?.(filePath) as PodmanExecutableStat;
      return filePath === "/usr/bin/podman" ? { ...stat, ino: executableInode } : stat;
    });
    const readFile = vi.fn(() => PODMAN_BYTES);
    const capture = vi.fn(() => {
      executableInode = 44n;
      return { status: 0, stdout: "ok", stderr: "" };
    });
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { lstat, readFile }),
      assertAuthority: vi.fn(),
      capture,
    });

    expect(() => engine.capture(["info"])).toThrow("changed after it was qualified");
    expect(capture).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("rejects executable metadata rotation before command dispatch", () => {
    const defaultDeps = executableAuthorityDeps();
    let executableInode = 42n;
    const lstat = vi.fn((filePath: string) => {
      const stat = defaultDeps.lstat?.(filePath) as PodmanExecutableStat;
      return filePath === "/usr/bin/podman" ? { ...stat, ino: executableInode } : stat;
    });
    const readFile = vi.fn(() => PODMAN_BYTES);
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { lstat, readFile }),
      assertAuthority: vi.fn(),
      capture,
    });
    executableInode = 44n;

    expect(() => engine.capture(["info"])).toThrow("changed after it was qualified");
    expect(capture).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("revalidates the executable even when the socket also drifts after the command", () => {
    const socketChanged = new Error("socket changed");
    const assertAuthority = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw socketChanged;
      });
    const readFile = vi.fn(() => PODMAN_BYTES);
    const realpath = vi.fn((filePath: string) => filePath);
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { readFile, realpath }),
      assertAuthority,
      capture,
    });

    expect(() => engine.capture(["info"])).toThrow(socketChanged);
    expect(capture).toHaveBeenCalledOnce();
    expect(assertAuthority).toHaveBeenCalledTimes(2);
    expect(realpath).toHaveBeenCalledTimes(6);
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("rehashes executable content before every 64th command", () => {
    const changedBytes = Buffer.from("changed--podman-binary!", "utf8");
    expect(changedBytes.byteLength).toBe(PODMAN_BYTES.byteLength);
    const readFile = vi
      .fn<() => Uint8Array>()
      .mockReturnValueOnce(PODMAN_BYTES)
      .mockReturnValue(changedBytes);
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { readFile }),
      assertAuthority: vi.fn(),
      capture,
    });

    for (let index = 0; index < 63; index += 1) {
      expect(engine.capture(["info"])).toMatchObject({ status: 0 });
    }
    expect(readFile).toHaveBeenCalledOnce();
    expect(() => engine.capture(["info"])).toThrow("changed after it was qualified");
    expect(capture).toHaveBeenCalledTimes(63);
    expect(readFile).toHaveBeenCalledTimes(2);

    readFile.mockReturnValue(PODMAN_BYTES);
    expect(() => engine.capture(["info"])).toThrow("changed after it was qualified");
    expect(capture).toHaveBeenCalledTimes(63);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("keeps content checkpoints pre-dispatch after a failed socket precheck", () => {
    const changedBytes = Buffer.from("changed--podman-binary!", "utf8");
    const readFile = vi
      .fn<() => Uint8Array>()
      .mockReturnValueOnce(PODMAN_BYTES)
      .mockReturnValue(changedBytes);
    const transientSocketFailure = new Error("transient socket precheck failure");
    const assertAuthority = vi
      .fn()
      .mockImplementationOnce(() => {
        throw transientSocketFailure;
      })
      .mockImplementation(() => undefined);
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { readFile }),
      assertAuthority,
      capture,
    });

    expect(() => engine.capture(["info"])).toThrow(transientSocketFailure);
    for (let index = 0; index < 63; index += 1) engine.capture(["info"]);
    expect(capture).toHaveBeenCalledTimes(63);
    expect(readFile).toHaveBeenCalledOnce();

    expect(() => engine.capture(["info"])).toThrow("changed after it was qualified");
    expect(capture).toHaveBeenCalledTimes(63);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("keeps executable rehash counters operation-local", () => {
    const firstReadFile = vi.fn(() => PODMAN_BYTES);
    const secondReadFile = vi.fn(() => PODMAN_BYTES);
    const first = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, {
        readFile: firstReadFile,
      }),
      assertAuthority: vi.fn(),
      capture: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
    });
    const second = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, {
        readFile: secondReadFile,
      }),
      assertAuthority: vi.fn(),
      capture: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
    });

    for (let index = 0; index < 63; index += 1) first.capture(["info"]);
    second.capture(["info"]);
    expect(firstReadFile).toHaveBeenCalledOnce();
    expect(secondReadFile).toHaveBeenCalledOnce();

    first.capture(["info"]);
    expect(firstReadFile).toHaveBeenCalledTimes(2);
    expect(secondReadFile).toHaveBeenCalledOnce();
  });

  it("rejects a caller-forged executable proof", () => {
    const authority = capturePodmanExecutableAuthority(
      "/usr/bin/podman",
      executableAuthorityDeps(),
    );
    const forged = {
      authority,
      executablePath: authority.executablePath,
      assertMetadataAuthority: vi.fn(),
      assertContentAuthority: vi.fn(),
      guardCommand: vi.fn(),
    };

    expect(() =>
      createPodmanContainerEngine({
        operation: "sandbox-lifecycle",
        socketAuthority: AUTHORITY,
        executableProof: forged,
        assertAuthority: vi.fn(),
        capture: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
      }),
    ).toThrow("was not created by this adapter");
  });

  it("shares the periodic rehash interval across engines using one proof", () => {
    const readFile = vi.fn(() => PODMAN_BYTES);
    const deps = executableAuthorityDeps(PODMAN_BYTES, { readFile });
    const authority = capturePodmanExecutableAuthority("/usr/bin/podman", deps);
    const proof = createPodmanExecutableOperationProof(authority, deps);
    const engine = () =>
      createPodmanContainerEngine({
        operation: "host-local-inference",
        socketAuthority: AUTHORITY,
        executableProof: proof,
        executableAuthorityDeps: deps,
        assertAuthority: vi.fn(),
        capture: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
      });
    const first = engine();
    const second = engine();
    readFile.mockClear();

    Array.from({ length: 32 }, () => first.capture(["info"]));
    Array.from({ length: 31 }, () => second.capture(["info"]));
    expect(readFile).not.toHaveBeenCalled();
    second.capture(["info"]);
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("rehashes stable-metadata content at commands 64 and 128 across engines", () => {
    const readFile = vi.fn(() => PODMAN_BYTES);
    const deps = executableAuthorityDeps(PODMAN_BYTES, { readFile });
    const authority = capturePodmanExecutableAuthority("/usr/bin/podman", deps);
    const proof = createPodmanExecutableOperationProof(authority, deps);
    const firstCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const secondCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const first = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: firstCapture,
    });
    const second = createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: secondCapture,
    });
    readFile.mockClear();

    Array.from({ length: 32 }, () => first.capture(["info"]));
    Array.from({ length: 31 }, () => second.capture(["info"]));
    expect(readFile).not.toHaveBeenCalled();
    second.capture(["info"]);
    expect(readFile).toHaveBeenCalledOnce();

    Array.from({ length: 63 }, (_, index) => (index % 2 === 0 ? first : second).capture(["info"]));
    expect(readFile).toHaveBeenCalledOnce();
    first.capture(["info"]);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("rejects stable-metadata changed bytes at command 64 before dispatch and latches across engines", () => {
    const changedBytes = Buffer.from("changed--podman-binary!", "utf8");
    expect(changedBytes).toHaveLength(PODMAN_BYTES.length);
    const readFile = vi.fn(() => PODMAN_BYTES);
    const deps = executableAuthorityDeps(PODMAN_BYTES, { readFile });
    const authority = capturePodmanExecutableAuthority("/usr/bin/podman", deps);
    const proof = createPodmanExecutableOperationProof(authority, deps);
    const firstCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const secondCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const first = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: firstCapture,
    });
    const second = createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: secondCapture,
    });
    readFile.mockClear();

    Array.from({ length: 63 }, (_, index) => (index % 2 === 0 ? first : second).capture(["info"]));
    readFile.mockReturnValue(changedBytes);
    expect(() => second.capture(["info"])).toThrow("changed after it was qualified");
    expect(firstCapture.mock.calls.length + secondCapture.mock.calls.length).toBe(63);
    readFile.mockReturnValue(PODMAN_BYTES);
    expect(() => first.capture(["info"])).toThrow("changed after it was qualified");
    expect(firstCapture.mock.calls.length + secondCapture.mock.calls.length).toBe(63);
  });

  it("does not consume the shared rehash checkpoint after a socket precheck failure", () => {
    const readFile = vi.fn(() => PODMAN_BYTES);
    const deps = executableAuthorityDeps(PODMAN_BYTES, { readFile });
    const authority = capturePodmanExecutableAuthority("/usr/bin/podman", deps);
    const proof = createPodmanExecutableOperationProof(authority, deps);
    const socketFailure = new Error("socket precheck failed");
    const firstSocket = vi.fn().mockImplementationOnce(() => {
      throw socketFailure;
    });
    const firstCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const secondCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const first = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: firstSocket,
      capture: firstCapture,
    });
    const second = createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: secondCapture,
    });
    readFile.mockClear();

    expect(() => first.capture(["info"])).toThrow(socketFailure);
    Array.from({ length: 63 }, () => second.capture(["info"]));
    expect(readFile).not.toHaveBeenCalled();
    second.capture(["info"]);
    expect(readFile).toHaveBeenCalledOnce();
    expect(firstCapture).not.toHaveBeenCalled();
    expect(secondCapture).toHaveBeenCalledTimes(64);
  });

  it("counts a thrown capture after its after-guard toward the shared rehash boundary", () => {
    const readFile = vi.fn(() => PODMAN_BYTES);
    const deps = executableAuthorityDeps(PODMAN_BYTES, { readFile });
    const authority = capturePodmanExecutableAuthority("/usr/bin/podman", deps);
    const proof = createPodmanExecutableOperationProof(authority, deps);
    const thrown = new Error("capture failed");
    const firstCapture = vi.fn(() => {
      throw thrown;
    });
    const secondCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const first = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: firstCapture,
    });
    const second = createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: secondCapture,
    });
    readFile.mockClear();

    expect(() => first.capture(["info"])).toThrow(thrown);
    Array.from({ length: 62 }, () => second.capture(["info"]));
    expect(readFile).not.toHaveBeenCalled();
    second.capture(["info"]);
    expect(readFile).toHaveBeenCalledOnce();
    expect(firstCapture).toHaveBeenCalledOnce();
    expect(secondCapture).toHaveBeenCalledTimes(63);
  });

  it("shares a latched executable failure across engines using one proof", () => {
    const generation = { executableInode: 42n };
    const defaults = executableAuthorityDeps();
    const lstat = vi.fn((filePath: string) => {
      const stat = defaults.lstat?.(filePath) as PodmanExecutableStat;
      return filePath === "/usr/bin/podman" ? { ...stat, ino: generation.executableInode } : stat;
    });
    const deps = executableAuthorityDeps(PODMAN_BYTES, { lstat });
    const authority = capturePodmanExecutableAuthority("/usr/bin/podman", deps);
    const proof = createPodmanExecutableOperationProof(authority, deps);
    const firstCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const secondCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const first = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: firstCapture,
    });
    const second = createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: secondCapture,
    });
    generation.executableInode = 44n;

    expect(() => first.capture(["info"])).toThrow("changed after it was qualified");
    generation.executableInode = 42n;
    expect(() => second.capture(["info"])).toThrow("changed after it was qualified");
    expect(firstCapture).not.toHaveBeenCalled();
    expect(secondCapture).not.toHaveBeenCalled();
  });

  it("latches an explicit assertion failure across engines sharing one proof", () => {
    const generation = { executableInode: 42n };
    const defaults = executableAuthorityDeps();
    const lstat = vi.fn((filePath: string) => {
      const stat = defaults.lstat?.(filePath) as PodmanExecutableStat;
      return filePath === "/usr/bin/podman" ? { ...stat, ino: generation.executableInode } : stat;
    });
    const deps = executableAuthorityDeps(PODMAN_BYTES, { lstat });
    const authority = capturePodmanExecutableAuthority("/usr/bin/podman", deps);
    const proof = createPodmanExecutableOperationProof(authority, deps);
    const first = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
    });
    const secondCapture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const second = createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority: AUTHORITY,
      executableProof: proof,
      assertAuthority: vi.fn(),
      capture: secondCapture,
    });
    generation.executableInode = 44n;

    expect(() => first.assertAuthority()).toThrow("changed after it was qualified");
    generation.executableInode = 42n;
    expect(() => second.capture(["info"])).toThrow("changed after it was qualified");
    expect(secondCapture).not.toHaveBeenCalled();
  });


  it("latches executable authority failure even when socket failure wins the first guard", () => {
    const socketChanged = new Error("socket changed");
    const defaultDeps = executableAuthorityDeps();
    let executableInode = 42n;
    const lstat = vi.fn((filePath: string) => {
      const stat = defaultDeps.lstat?.(filePath) as PodmanExecutableStat;
      return filePath === "/usr/bin/podman" ? { ...stat, ino: executableInode } : stat;
    });
    const assertAuthority = vi.fn((): void => {
      executableInode = 44n;
      throw socketChanged;
    });
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { lstat }),
      assertAuthority,
      capture,
    });

    expect(() => engine.capture(["info"])).toThrow(socketChanged);
    executableInode = 42n;
    assertAuthority.mockImplementation(() => undefined);
    expect(() => engine.capture(["info"])).toThrow("changed after it was qualified");
    expect(capture).not.toHaveBeenCalled();
  });
});
