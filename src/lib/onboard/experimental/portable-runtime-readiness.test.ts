// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import type { PodmanSocketAuthority } from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import {
  DEFAULT_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS,
  inspectPortablePodmanReadiness,
  PORTABLE_PODMAN_STARTUP_TIMEOUT_ENV,
  portablePodmanReadinessError,
  resolvePortablePodmanStartupTimeout,
} from "./portable-runtime-readiness";

const AUTHORITY: CheckpointPortableRuntimeAuthority = {
  schemaVersion: 1,
  kind: "podman",
  ownership: "current-user",
  uid: 1001,
  homeDir: "/home/tester",
  configHome: "/home/tester/.config",
  runtimeDir: "/run/user/1001",
  socketPath: "/run/user/1001/podman/podman.sock",
};

const SOCKET_AUTHORITY: PodmanSocketAuthority = {
  directoryChain: [],
  device: "1",
  inode: "2",
  mode: String(0o140600),
  ownerUid: "1001",
  socketPath: AUTHORITY.socketPath,
};

const ROTATED_SOCKET_AUTHORITY: PodmanSocketAuthority = {
  ...SOCKET_AUTHORITY,
  inode: "3",
};

function capture(status: number, stdout = ""): ReturnType<ContainerEngineCommandCapture> {
  return { status, stdout, stderr: "" };
}

function harness(
  options: {
    active?: boolean;
    captureSocket?: (socketPath: string) => PodmanSocketAuthority;
    hardenSocket?: (socketPath: string, uid: number) => void;
    podmanCapture?: ContainerEngineCommandCapture;
    startStatus?: number;
    assertSocket?: (authority: PodmanSocketAuthority) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  let clock = 0;
  const systemctl = vi.fn((args: readonly string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) =>
    args.includes("is-active")
      ? { status: options.active === false ? 3 : 0 }
      : { status: options.startStatus ?? 0 },
  );
  const podmanCapture =
    options.podmanCapture ??
    vi.fn<ContainerEngineCommandCapture>(() =>
      capture(0, JSON.stringify({ Server: { Version: "5.6.1" } })),
    );
  return {
    systemctl,
    podmanCapture,
    deps: {
      platform: "linux" as const,
      uid: 1001,
      home: AUTHORITY.homeDir,
      env: options.env ?? {},
      now: () => clock,
      sleep: (milliseconds: number) => {
        clock += milliseconds;
      },
      systemctl,
      hardenSocketDirectory: options.hardenSocket ?? vi.fn(),
      captureSocketAuthority: options.captureSocket ?? (() => SOCKET_AUTHORITY),
      assertSocketAuthority: options.assertSocket ?? vi.fn(),
      podmanCapture,
    },
  };
}

describe("portable Podman activation readiness", () => {
  it("activates a cold user socket and waits for a real API response (#9070)", () => {
    const hardenSocket = vi.fn().mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const h = harness({
      active: false,
      hardenSocket,
    });

    const result = inspectPortablePodmanReadiness(AUTHORITY, h.deps);

    expect(result).toMatchObject({
      ok: true,
      serverVersion: "5.6.1",
      timing: { mode: "cold", activationMs: 0, apiMs: 0, totalMs: 0 },
    });
    expect(h.systemctl.mock.calls.map(([args]) => args)).toEqual([
      ["--user", "is-active", "--quiet", "podman.service"],
      ["--user", "start", "podman.socket"],
    ]);
    expect(h.podmanCapture).toHaveBeenCalledWith(
      "podman",
      ["--url", `unix://${AUTHORITY.socketPath}`, "version", "--format", "json"],
      60_000,
    );
    expect(hardenSocket).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after the socket directory is hardened (#9070)", () => {
    const captureSocket = vi
      .fn<() => PodmanSocketAuthority>()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      })
      .mockReturnValue(SOCKET_AUTHORITY);
    const hardenSocket = vi.fn();
    const h = harness({ active: false, captureSocket, hardenSocket });

    const result = inspectPortablePodmanReadiness(AUTHORITY, h.deps);

    expect(result).toMatchObject({
      ok: true,
      serverVersion: "5.6.1",
      timing: { mode: "cold", apiMs: 0, totalMs: 0 },
    });
    expect(hardenSocket).toHaveBeenCalledTimes(1);
    expect(captureSocket).toHaveBeenCalledTimes(2);
  });

  it("requalifies one socket inode rotation during cold API activation (#9070)", () => {
    const hardenSocket = vi.fn().mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const captureSocket = vi
      .fn()
      .mockReturnValueOnce(SOCKET_AUTHORITY)
      .mockReturnValue(ROTATED_SOCKET_AUTHORITY);
    const assertSocket = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("systemd activated the service socket");
      })
      .mockImplementationOnce(() => {
        throw new Error("the initial socket is no longer current");
      });
    const h = harness({ active: false, captureSocket, hardenSocket, assertSocket });

    const result = inspectPortablePodmanReadiness(AUTHORITY, h.deps);

    expect(result).toMatchObject({ ok: true, authority: ROTATED_SOCKET_AUTHORITY });
    expect(captureSocket).toHaveBeenCalledTimes(2);
    expect(h.podmanCapture).toHaveBeenCalledTimes(2);
  });

  it("rejects a cold socket replacement that changes its device identity (#9070)", () => {
    const hardenSocket = vi.fn().mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const captureSocket = vi
      .fn()
      .mockReturnValueOnce(SOCKET_AUTHORITY)
      .mockReturnValue({ ...ROTATED_SOCKET_AUTHORITY, device: "9" });
    const assertSocket = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("socket changed after the API request");
      })
      .mockImplementationOnce(() => {
        throw new Error("the initial socket is no longer current");
      });
    const h = harness({ active: false, captureSocket, hardenSocket, assertSocket });

    expect(inspectPortablePodmanReadiness(AUTHORITY, h.deps)).toMatchObject({
      ok: false,
      stage: "socket authority",
      socketPath: AUTHORITY.socketPath,
    });
    expect(captureSocket).toHaveBeenCalledTimes(2);
    expect(h.podmanCapture).toHaveBeenCalledOnce();
  });

  it("uses the shorter steady-state deadline when the service reports active (#9070)", () => {
    const h = harness({ active: true });

    const result = inspectPortablePodmanReadiness(AUTHORITY, h.deps);

    expect(result).toMatchObject({ ok: true, timing: { mode: "warm" } });
    expect(h.systemctl).toHaveBeenCalledTimes(1);
    expect(h.podmanCapture).toHaveBeenCalledWith("podman", expect.any(Array), 10_000);
  });

  it("uses an already healthy pinned API without starting another user socket (#9070)", () => {
    const h = harness({ active: false });

    const result = inspectPortablePodmanReadiness(AUTHORITY, h.deps);

    expect(result).toMatchObject({ ok: true, timing: { mode: "warm" } });
    expect(h.systemctl).toHaveBeenCalledTimes(1);
    expect(h.podmanCapture).toHaveBeenCalledWith("podman", expect.any(Array), 10_000);
  });

  it("classifies socket activation failure without command output (#9070)", () => {
    const h = harness({
      active: false,
      hardenSocket: () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      startStatus: 1,
    });

    expect(inspectPortablePodmanReadiness(AUTHORITY, h.deps)).toMatchObject({
      ok: false,
      stage: "service activation",
      detail: "The current user's Podman socket service could not be activated.",
      socketPath: AUTHORITY.socketPath,
    });
    expect(h.podmanCapture).not.toHaveBeenCalled();
  });

  it("classifies a startup timeout before the socket appears (#9070)", () => {
    const missing = () => {
      throw Object.assign(new Error("secret-bearing path detail"), { code: "ENOENT" });
    };
    const h = harness({
      active: false,
      hardenSocket: missing,
      env: { [PORTABLE_PODMAN_STARTUP_TIMEOUT_ENV]: "15000" },
    });

    const result = inspectPortablePodmanReadiness(AUTHORITY, h.deps);

    expect(result).toMatchObject({ ok: false, stage: "service activation" });
    expect(result).toMatchObject({ socketPath: AUTHORITY.socketPath });
    expect(result.ok ? "" : result.detail).not.toContain("secret-bearing");
  });

  it("distinguishes cold and warm API health failures (#9070)", () => {
    const unavailable = vi.fn<ContainerEngineCommandCapture>(() => capture(1));
    const cold = harness({ active: false, podmanCapture: unavailable });
    const warm = harness({ active: true, podmanCapture: unavailable });

    expect(inspectPortablePodmanReadiness(AUTHORITY, cold.deps)).toMatchObject({
      ok: false,
      stage: "startup API health",
      socketPath: AUTHORITY.socketPath,
      timing: { mode: "cold" },
    });
    expect(inspectPortablePodmanReadiness(AUTHORITY, warm.deps)).toMatchObject({
      ok: false,
      stage: "steady-state API health",
      socketPath: AUTHORITY.socketPath,
      timing: { mode: "warm" },
    });
  });

  it("rejects unsafe and replaced sockets at the authority stage (#9070)", () => {
    const unsafe = harness({
      captureSocket: () => {
        throw new Error("unsafe");
      },
    });
    const replaced = harness({
      active: false,
      assertSocket: () => {
        throw new Error("replaced");
      },
    });

    expect(inspectPortablePodmanReadiness(AUTHORITY, unsafe.deps)).toMatchObject({
      ok: false,
      stage: "socket authority",
      socketPath: AUTHORITY.socketPath,
    });
    expect(inspectPortablePodmanReadiness(AUTHORITY, replaced.deps)).toMatchObject({
      ok: false,
      stage: "socket authority",
      socketPath: AUTHORITY.socketPath,
    });
    expect(replaced.systemctl).toHaveBeenCalledOnce();
  });

  it("reports only a validated recorded socket path (#9070)", () => {
    const validFailure = inspectPortablePodmanReadiness(AUTHORITY, {
      ...harness({
        active: false,
        hardenSocket: () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        startStatus: 1,
      }).deps,
    });
    const invalidFailure = inspectPortablePodmanReadiness(AUTHORITY, {
      ...harness().deps,
      uid: 2002,
    });

    expect(validFailure).toMatchObject({ ok: false, socketPath: AUTHORITY.socketPath });
    expect(validFailure.ok ? "" : portablePodmanReadinessError(validFailure).message).toContain(
      `Recorded socket: ${AUTHORITY.socketPath}.`,
    );
    expect(invalidFailure).toMatchObject({
      ok: false,
      stage: "socket authority",
      recovery: "current-user-authority",
    });
    expect(invalidFailure).not.toHaveProperty("socketPath");
  });

  it("ignores ambient engine selectors and uses the recorded user authority (#9070)", () => {
    const h = harness({
      env: {
        HOME: "/attacker",
        XDG_RUNTIME_DIR: "/attacker/run",
        CONTAINER_CONNECTION: "attacker",
        CONTAINER_HOST: "tcp://attacker.invalid:9999",
        DOCKER_CONTEXT: "attacker",
        DOCKER_HOST: "tcp://attacker.invalid:2375",
      },
    });

    inspectPortablePodmanReadiness(AUTHORITY, h.deps);

    const childEnv = h.systemctl.mock.calls[0]?.[1] as NodeJS.ProcessEnv;
    expect(childEnv).toMatchObject({
      HOME: AUTHORITY.homeDir,
      XDG_CONFIG_HOME: AUTHORITY.configHome,
      XDG_RUNTIME_DIR: AUTHORITY.runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${AUTHORITY.runtimeDir}/bus`,
    });
    expect(childEnv).not.toHaveProperty("CONTAINER_CONNECTION");
    expect(childEnv).not.toHaveProperty("CONTAINER_HOST");
    expect(childEnv).not.toHaveProperty("DOCKER_CONTEXT");
    expect(childEnv).not.toHaveProperty("DOCKER_HOST");
  });

  it.each(["1", "300001", "1.5", "not-a-number"])(
    "bounds configurable startup timeouts and falls back safely [%s] (#9070)",
    (invalid) => {
      expect(resolvePortablePodmanStartupTimeout({})).toBe(
        DEFAULT_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS,
      );
      expect(
        resolvePortablePodmanStartupTimeout({ [PORTABLE_PODMAN_STARTUP_TIMEOUT_ENV]: "15000" }),
      ).toBe(15_000);
      expect(
        resolvePortablePodmanStartupTimeout({ [PORTABLE_PODMAN_STARTUP_TIMEOUT_ENV]: "300000" }),
      ).toBe(300_000);

      expect(
        resolvePortablePodmanStartupTimeout({
          [PORTABLE_PODMAN_STARTUP_TIMEOUT_ENV]: invalid,
        }),
      ).toBe(DEFAULT_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS);
    },
  );
});
