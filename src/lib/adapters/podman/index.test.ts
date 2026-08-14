// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createPodmanContainerEngine,
  localPodmanEnvironment,
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

describe("Podman container engine command adapter", () => {
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
});
