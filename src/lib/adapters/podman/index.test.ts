// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ContainerEngineCommandCapture } from "../container-engine";
import {
  createPodmanContainerEngine,
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
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(() => engine.captureHost(["info"])).toThrow("forbids ambient host command capture");
    expect(capture).toHaveBeenCalledTimes(1);
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

  it("requires an explicit canonical absolute executable for host-local inference", () => {
    expect(() =>
      createPodmanContainerEngine({
        operation: "host-local-inference",
        socketAuthority: AUTHORITY,
        assertAuthority: vi.fn(),
        capture: vi.fn(),
      }),
    ).toThrow("canonical absolute path");
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

  it("rejects executable content rotation observed after a successful command", () => {
    const changedBytes = Buffer.from("changed--podman-binary!", "utf8");
    expect(changedBytes.byteLength).toBe(PODMAN_BYTES.byteLength);
    const readFile = vi
      .fn<() => Uint8Array>()
      .mockReturnValueOnce(PODMAN_BYTES)
      .mockReturnValueOnce(PODMAN_BYTES)
      .mockReturnValueOnce(changedBytes);
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { readFile }),
      assertAuthority: vi.fn(),
      capture,
    });

    expect(() => engine.capture(["info"])).toThrow("changed after it was qualified");
    expect(capture).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledTimes(3);
  });

  it("rejects executable content rotation before command dispatch", () => {
    const changedBytes = Buffer.from("changed--podman-binary!", "utf8");
    const readFile = vi
      .fn<() => Uint8Array>()
      .mockReturnValueOnce(PODMAN_BYTES)
      .mockReturnValueOnce(changedBytes);
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { readFile }),
      assertAuthority: vi.fn(),
      capture,
    });

    expect(() => engine.capture(["info"])).toThrow("changed after it was qualified");
    expect(capture).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledTimes(2);
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
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createPodmanContainerEngine({
      operation: "host-local-inference",
      socketAuthority: AUTHORITY,
      executable: "/usr/bin/podman",
      executableAuthorityDeps: executableAuthorityDeps(PODMAN_BYTES, { readFile }),
      assertAuthority,
      capture,
    });

    expect(() => engine.capture(["info"])).toThrow(socketChanged);
    expect(capture).toHaveBeenCalledOnce();
    expect(assertAuthority).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(3);
  });
});
