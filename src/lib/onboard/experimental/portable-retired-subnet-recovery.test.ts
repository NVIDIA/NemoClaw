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

  const NETWORK_ID = "3f2a1c9d8e7b6a5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c";
  const REGISTRY_ID = "aa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899";

  function runRetiredSubnetRecovery(
    dockerImpl: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult,
  ) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockImplementation(dockerImpl);
    const run = () =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        preparationDeps(home, docker),
      );
    return { docker, run };
  }

  // Answers the fixed call sequence: --version, network inspect (IPAM),
  // network inspect (id), ps -a, container inspect.
  function dockerStub(over: {
    connected?: SpawnResult;
    registry?: SpawnResult;
    networkId?: SpawnResult;
  }) {
    return (args: readonly string[]): SpawnResult => {
      const command = args.join(" ");
      const routes: Array<readonly [boolean, SpawnResult]> = [
        [
          command.startsWith("network inspect") && command.includes("{{.Id}}"),
          over.networkId ?? result(0, `${NETWORK_ID}\n`),
        ],
        [
          command.startsWith("network inspect"),
          result(0, JSON.stringify([{ Subnet: RETIRED_SUBNET }])),
        ],
        [command.startsWith("ps -a"), over.connected ?? result(0, "")],
        [command.startsWith("inspect"), over.registry ?? result(1)],
      ];
      return routes.find(([matched]) => matched)?.[1] ?? result();
    };
  }

  function issuedCommands(docker: { mock: { calls: Array<[readonly string[], ...unknown[]]> } }) {
    return docker.mock.calls.map(([args]) => args.join(" "));
  }

  // A refusal must neither mutate the host nor print a command the operator
  // could paste. Assert both the issued commands and the message text.
  function expectNoRemovalGuidance(
    docker: { mock: { calls: Array<[readonly string[], ...unknown[]]> } },
    run: () => unknown,
  ) {
    expect(issuedCommands(docker).filter((c) => /\brm\b|--force/u.test(c))).toEqual([]);
    const message = (() => {
      try {
        run();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    })();
    expect(message).not.toMatch(/podman (network )?rm/u);
    expect(message).not.toContain(NETWORK_ID);
  }

  it("names only the network when nothing is connected", () => {
    const { docker, run } = runRetiredSubnetRecovery(dockerStub({ connected: result(0, "") }));

    expect(run).toThrow(
      `Network 'openshell-docker' still uses the retired portable subnet ${RETIRED_SUBNET}. ` +
        "No container is connected to it. Remove it without `--force`: " +
        `\`podman network rm ${NETWORK_ID}\`, then rerun ` +
        "`nemoclaw onboard --experimental-profile portable`.",
    );
    expect(issuedCommands(docker).filter((c) => /\brm\b|--force/u.test(c))).toEqual([]);
  });

  it("names the verified registry and the network by full ID when the registry is the sole container", () => {
    const { docker, run } = runRetiredSubnetRecovery(
      dockerStub({
        connected: result(0, `${REGISTRY_ID}|nemoclaw-portable-registry\n`),
        registry: result(0, "1|true|169.254.1.3"),
      }),
    );

    expect(run).toThrow(
      `Network 'openshell-docker' still uses the retired portable subnet ${RETIRED_SUBNET}. ` +
        "The verified NemoClaw registry is its only connected container. Stop and remove the registry, " +
        "then remove the network. No step uses `--force`: " +
        `\`podman stop ${REGISTRY_ID}\`, \`podman rm ${REGISTRY_ID}\`, ` +
        `then \`podman network rm ${NETWORK_ID}\`, then rerun ` +
        "`nemoclaw onboard --experimental-profile portable`.",
    );
    expect(issuedCommands(docker).filter((c) => /\brm\b|--force/u.test(c))).toEqual([]);
  });

  it.each<[string, Parameters<typeof dockerStub>[0]]>([
    [
      "another container is connected",
      { connected: result(0, `${REGISTRY_ID}|some-other-container\n`) },
    ],
    [
      "the registry shares the network with another container",
      {
        connected: result(
          0,
          `${REGISTRY_ID}|nemoclaw-portable-registry\nbbbb|some-other-container\n`,
        ),
        registry: result(0, "1|true|169.254.1.3"),
      },
    ],
    [
      "a same-name container does not carry the ownership label",
      {
        connected: result(0, `${REGISTRY_ID}|nemoclaw-portable-registry\n`),
        registry: result(0, "<no value>|true|169.254.1.3"),
      },
    ],
  ])("shows no removal command when %s", (_label, over) => {
    const { docker, run } = runRetiredSubnetRecovery(dockerStub(over));

    expect(run).toThrow(
      "A container NemoClaw does not own is connected to it, so NemoClaw will not name that network " +
        "or any container for removal.",
    );
    expectNoRemovalGuidance(docker, run);
  });

  it.each<[string, Parameters<typeof dockerStub>[0]]>([
    ["the connected-container probe fails", { connected: result(125) }],
    ["the network identity probe fails", { networkId: result(125) }],
    ["the network identity probe returns nothing", { networkId: result(0, "  \n") }],
    [
      "the ownership probe fails for the sole connected registry",
      {
        connected: result(0, `${REGISTRY_ID}|nemoclaw-portable-registry\n`),
        registry: result(125),
      },
    ],
  ])("refuses without removal guidance when %s", (_label, over) => {
    const { docker, run } = runRetiredSubnetRecovery(dockerStub(over));

    expect(run).toThrow(/failed|returned no network ID/u);
    expectNoRemovalGuidance(docker, run);
  });
});
