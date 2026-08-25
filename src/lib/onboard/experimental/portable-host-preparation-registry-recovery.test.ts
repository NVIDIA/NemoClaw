// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanSocketAuthority } from "../../adapters/podman";
import { preparePortableExperimentalHost } from "./portable-host-preparation";
import { PORTABLE_DOCKER_NETWORK_SUBNET, PORTABLE_HOST_GATEWAY_IP } from "./portable-profile";

type SpawnResult = ReturnType<typeof spawnSync>;
type PreparationDeps = NonNullable<Parameters<typeof preparePortableExperimentalHost>[1]>;

function result(status = 0, stdout = ""): SpawnResult {
  return { status, stdout, stderr: "" } as SpawnResult;
}

function socketAuthority(socketPath: string): PodmanSocketAuthority {
  return {
    directoryChain: [],
    device: "1",
    inode: "2",
    mode: String(0o140660),
    ownerUid: "1001",
    socketPath,
  };
}

function prepare(home: string, docker: NonNullable<PreparationDeps["docker"]>): void {
  const socketPath = "/run/user/1001/podman/podman.sock";
  preparePortableExperimentalHost(
    { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
    {
      platform: "linux",
      home,
      uid: 1001,
      systemctl: () => result(),
      podman: () => result(0, socketPath),
      docker: (args, env) =>
        args[0] === "network" && args[1] === "inspect"
          ? result(0, JSON.stringify([{ Subnet: PORTABLE_DOCKER_NETWORK_SUBNET }]))
          : docker(args, env),
      ip: (args) =>
        args[0] === "-j"
          ? result(
              0,
              JSON.stringify([
                {
                  ifname: "lo",
                  addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8 }],
                },
              ]),
            )
          : result(0, `1: lo    inet ${PORTABLE_HOST_GATEWAY_IP}/32 scope global lo\n`),
      sudo: () => result(),
      cpuDelegationPreflight: () => ({ ok: true, detail: "stubbed in tests" }),
      runtimeReadiness: {
        uid: 1001,
        home,
        hardenSocketDirectory: vi.fn(),
        captureSocketAuthority: () => socketAuthority(socketPath),
        assertSocketAuthority: vi.fn(),
        podmanCapture: () => ({
          status: 0,
          stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
          stderr: "",
        }),
      },
      hardenSocketDirectory: vi.fn(),
      validateConfigAuthority: vi.fn(),
    },
  );
}

describe("Portable managed registry recovery", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("recreates a stopped registry when Podman reports its unavailable address (#10056)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result(0, "1|false|invalid IP"))
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result());

    prepare(home, docker);

    expect(docker.mock.calls.map(([args]) => args[0])).toEqual([
      "--version",
      "inspect",
      "rm",
      "run",
    ]);
    expect(docker.mock.calls[2]?.[0]).toEqual(["rm", "-f", "nemoclaw-portable-registry"]);
  });

  it.each([
    ["running registry without an address", "1|true|invalid IP"],
    ["stopped registry at a different address", "1|false|10.87.0.9"],
  ])("refuses a %s (#10056)", (_case, inspection) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result(0, inspection));

    expect(() => prepare(home, docker)).toThrow(/unexpected network address/u);
    expect(docker).toHaveBeenCalledTimes(2);
  });
});
