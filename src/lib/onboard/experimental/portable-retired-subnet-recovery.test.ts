// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { BlockList } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePortableExperimentalHost } from "./portable-host-preparation";
import {
  PORTABLE_DOCKER_NETWORK_SUBNET,
  PORTABLE_HOST_GATEWAY_IP,
  PORTABLE_REGISTRY_IP,
} from "./portable-profile";

type SpawnResult = ReturnType<typeof spawnSync>;

const RETIRED_SUBNET = "169.254.1.0/24";
const NO_RETIRED_GATEWAY_EVIDENCE = JSON.stringify([
  { ifname: "lo", addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8 }] },
]);

function result(status = 0, stdout = ""): SpawnResult {
  return { status, stdout, stderr: "" } as SpawnResult;
}

function preparationDeps(
  home: string,
  docker: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult,
) {
  return {
    platform: "linux" as const,
    home,
    uid: 1001,
    systemctl: () => result(),
    podman: () => result(0, "/run/user/1001/podman/podman.sock"),
    docker,
    hardenSocketDirectory: vi.fn(),
    validateConfigAuthority: vi.fn(),
    sudo: () => result(),
    ip: (args: readonly string[]) =>
      args[0] === "-j"
        ? result(0, NO_RETIRED_GATEWAY_EVIDENCE)
        : result(0, `1: lo    inet ${PORTABLE_HOST_GATEWAY_IP}/32 scope global lo\n`),
    cpuDelegationPreflight: () => ({ ok: true as const, detail: "stubbed in tests" }),
    runtimeReadiness: {
      uid: 1001,
      home,
      hardenSocketDirectory: vi.fn(),
      captureSocketAuthority: (socketPath: string) => ({
        directoryChain: [],
        device: "1",
        inode: "2",
        mode: String(0o140660),
        ownerUid: "1001",
        socketPath,
      }),
      assertSocketAuthority: vi.fn(),
      podmanCapture: () => ({
        status: 0,
        stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
        stderr: "",
      }),
    },
  };
}

describe("portable retired-subnet recovery (#9707)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps the sandbox subnet outside the link-local block netavark refuses", () => {
    const linkLocal = new BlockList();
    linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
    const [networkAddress] = PORTABLE_DOCKER_NETWORK_SUBNET.split("/");

    expect(linkLocal.check(networkAddress!, "ipv4")).toBe(false);
    expect(linkLocal.check(PORTABLE_REGISTRY_IP, "ipv4")).toBe(false);
  });

  it.each<[string, SpawnResult, string]>([
    [
      "no registry is attached",
      result(1),
      "Network 'openshell-docker' still uses the retired portable subnet 169.254.1.0/24. " +
        "Remove it with `podman network rm openshell-docker`, then rerun " +
        "`nemoclaw onboard --experimental-profile portable`.",
    ],
    [
      "an owned registry is attached",
      result(0, "1 true 169.254.1.3"),
      "Network 'openshell-docker' still uses the retired portable subnet 169.254.1.0/24. " +
        "Remove the managed registry first, then the network, without `--force`: " +
        "`podman rm -f nemoclaw-portable-registry` and `podman network rm openshell-docker`, " +
        "then rerun `nemoclaw onboard --experimental-profile portable`.",
    ],
    [
      "an unmanaged same-name registry is attached",
      result(0, "<no value> true 169.254.1.3"),
      "Network 'openshell-docker' still uses the retired portable subnet 169.254.1.0/24. " +
        "A container named 'nemoclaw-portable-registry' is attached to it but does not carry the " +
        "NemoClaw ownership label, so NemoClaw will not name it for removal. Resolve that container " +
        "yourself, remove the network with `podman network rm openshell-docker`, then rerun " +
        "`nemoclaw onboard --experimental-profile portable`.",
    ],
  ])("gives ownership-aware recovery when %s", (_label, registryInspection, error) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result(0, JSON.stringify([{ Subnet: RETIRED_SUBNET }])))
      .mockReturnValueOnce(registryInspection);

    expect(() =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        preparationDeps(home, docker),
      ),
    ).toThrow(error);

    // The retired-subnet path reports and stops. It must not remove a
    // container, remove a network, or pass --force on the operator's behalf.
    expect(docker).toHaveBeenCalledTimes(3);
    const issued = docker.mock.calls.map(([args]) => args.join(" "));
    expect(issued.filter((command) => /\brm\b|--force/u.test(command))).toEqual([]);
  });
});
