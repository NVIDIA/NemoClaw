// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanSocketAuthority } from "../../adapters/podman";
import { preparePortableExperimentalHost } from "./portable-host-preparation";
import {
  PORTABLE_DOCKER_NETWORK_NAME,
  PORTABLE_DOCKER_NETWORK_SUBNET,
  PORTABLE_HOST_GATEWAY_IP,
  PORTABLE_REGISTRY_IP,
} from "./portable-profile";

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
      architecture: "x64",
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

  describe("when Podman still reserves the registry address (#11409)", () => {
    const staleId = "49f6af196bc7cf81b292b3275984727db24c35c2ed53adf35851f680d19c18d8";
    const ipamRefusal = (ip = PORTABLE_REGISTRY_IP): SpawnResult =>
      ({
        status: 125,
        stdout: "",
        stderr: `docker: Error response from daemon: IPAM error: requested ip address ${ip} is already allocated to container ID ${staleId}`,
      }) as SpawnResult;

    function startRegistry(
      holder: SpawnResult,
      attached: SpawnResult = result(0, ""),
      refusal: SpawnResult = ipamRefusal(),
    ): { message: string; commands: string[][] } {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
      tempDirs.push(home);
      const commands: string[][] = [];
      const docker = vi.fn((args: readonly string[]): SpawnResult => {
        commands.push([...args]);
        const command = args[0] === "inspect" && args.includes(staleId) ? "holder" : args[0]!;
        const responses: Record<string, SpawnResult> = {
          run: refusal,
          holder,
          inspect: result(1),
          ps: attached,
        };
        return responses[command] ?? result();
      });
      try {
        prepare(home, docker);
      } catch (error) {
        return { message: (error as Error).message, commands };
      }
      throw new Error("expected the registry start to fail");
    }

    const noSuchObject = (): SpawnResult =>
      ({ status: 1, stdout: "", stderr: `Error: No such object: ${staleId}` }) as SpawnResult;

    it("names the orphaned record and the file that holds it", () => {
      const { message, commands } = startRegistry(noSuchObject());

      expect(message).toContain("Starting the managed portable registry failed");
      expect(message).toContain(
        `requested ip address ${PORTABLE_REGISTRY_IP} is already allocated`,
      );
      expect(message).toContain(`${staleId}, but that container no longer exists`);
      expect(message).toContain("rm '/run/user/1001/containers/networks/ipam.db'");
      expect(message).not.toContain("Stop or remove them first");
      expect(message).toContain("nemoclaw onboard --experimental-profile portable");
      expect(commands.find(([command]) => command === "ps")).toEqual([
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `network=${PORTABLE_DOCKER_NETWORK_NAME}`,
        "--format",
        "{{.ID}}",
      ]);
      expect(commands.filter(([command]) => command === "run")).toHaveLength(1);
      expect(commands.some(([command]) => command === "rm" || command === "network")).toBe(false);
    });

    it("tells the user to stop other containers on the network first", () => {
      const { message } = startRegistry(noSuchObject(), result(0, `${"a".repeat(64)}\n`));

      expect(message).toContain(
        `Other containers may still use network '${PORTABLE_DOCKER_NETWORK_NAME}'`,
      );
      expect(message).toContain("rm '/run/user/1001/containers/networks/ipam.db'");
    });

    it("does not offer a file removal when it cannot list the network's containers", () => {
      const { message } = startRegistry(noSuchObject(), result(125));

      expect(message).toContain("Stop or remove them first");
    });

    it("points at the live container when one still holds the address", () => {
      const { message } = startRegistry(result(0, staleId));

      expect(message).toContain(`held by container ${staleId}, which still exists`);
      expect(message).toContain(`docker rm -f ${staleId}`);
      expect(message).not.toContain("ipam.db");
    });

    it.each([
      ["a different address", ipamRefusal("10.87.0.9"), noSuchObject()],
      ["an inspection that cannot show the container is gone", ipamRefusal(), result(125)],
    ])("keeps the raw error for %s", (_case, refusal, holder) => {
      const { message } = startRegistry(holder as SpawnResult, result(0, ""), refusal);

      expect(message).toMatch(/^Starting the managed portable registry failed: docker: /u);
      expect(message).not.toContain("ipam.db");
      expect(message).not.toContain("\n");
    });
  });
});
