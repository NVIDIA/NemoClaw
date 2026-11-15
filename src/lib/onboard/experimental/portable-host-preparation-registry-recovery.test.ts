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

function prepare(
  home: string,
  docker: NonNullable<PreparationDeps["docker"]>,
  assertSocketAuthority: () => void = vi.fn(),
): void {
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
        assertSocketAuthority,
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

    // Commands shown to the user must reach the verified socket, not their ambient Docker.
    const podmanCommand = "podman --url 'unix:///run/user/1001/podman/podman.sock'";

    const noSuchObject = (): SpawnResult =>
      ({ status: 1, stdout: "", stderr: `Error: No such object: ${staleId}` }) as SpawnResult;

    function startRegistry(
      holder: SpawnResult,
      containers: SpawnResult = result(0, ""),
      refusal: SpawnResult = ipamRefusal(),
      registry: SpawnResult = result(1),
      driftAt = "",
    ): { message: string; commands: string[][] } {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
      tempDirs.push(home);
      const commands: string[][] = [];
      let socketChanged = false;
      const docker = vi.fn((args: readonly string[]): SpawnResult => {
        commands.push([...args]);
        const command = args[0] === "inspect" && args.includes(staleId) ? "holder" : args[0]!;
        socketChanged = socketChanged || command === driftAt;
        const responses: Record<string, SpawnResult> = {
          run: refusal,
          // A registry that is connected to no address yet needs `network connect`.
          network: refusal,
          holder,
          inspect: registry,
          ps: containers,
        };
        return responses[command] ?? result();
      });
      try {
        // Fails once a probe has run against a replaced socket.
        prepare(home, docker, () => expect(socketChanged).toBe(false));
      } catch (error) {
        return { message: (error as Error).message, commands };
      }
      throw new Error("expected the registry start to fail");
    }

    const names = (...containerNames: string[]): SpawnResult =>
      result(0, containerNames.map((name) => `${name}\n`).join(""));

    it("names the orphaned record and the file that holds it", () => {
      const { message, commands } = startRegistry(noSuchObject());

      expect(message).toContain("Starting the managed portable registry failed");
      expect(message).toContain(
        `requested ip address ${PORTABLE_REGISTRY_IP} is already allocated`,
      );
      expect(message).toContain(`${staleId}, but that container no longer exists`);
      expect(message).toContain("rm '/run/user/1001/containers/networks/ipam.db'");
      expect(message).toContain("none other exists now");
      expect(message).toContain("nemoclaw onboard --experimental-profile portable");
      expect(commands.find(([command]) => command === "ps")).toEqual([
        "ps",
        "--all",
        "--format",
        "{{.Names}}",
      ]);
      expect(commands.filter(([command]) => command === "run")).toHaveLength(1);
      expect(commands.some(([command]) => command === "rm" || command === "network")).toBe(false);
    });

    it("offers the file removal when only the managed registry exists", () => {
      const { message } = startRegistry(noSuchObject(), names("nemoclaw-portable-registry"));

      expect(message).toContain("rm '/run/user/1001/containers/networks/ipam.db'");
    });

    it("does not offer the file removal while a container on another network exists", () => {
      const { message, commands } = startRegistry(noSuchObject(), names("unrelated-service"));

      expect(commands.find(([command]) => command === "ps")).not.toContain("--filter");
      expect(message).toContain("Stop or remove all of them");
      expect(message).toContain(`\`${podmanCommand} ps --all\``);
      expect(message).not.toContain("`docker ");
      expect(message).toContain("shared by every container of this user's Podman runtime");
      expect(message).not.toContain("ipam.db");
    });

    it("does not offer the file removal when it cannot list the runtime's containers", () => {
      const { message } = startRegistry(noSuchObject(), result(125));

      expect(message).toContain("Stop or remove all of them");
      expect(message).not.toContain("ipam.db");
    });

    it("points at the live container when one still holds the address", () => {
      const { message } = startRegistry(result(0, staleId));

      expect(message).toContain(`held by container ${staleId}, which still exists`);
      expect(message).toContain(`\`${podmanCommand} inspect ${staleId}\``);
      expect(message).toContain(`\`${podmanCommand} rm -f ${staleId}\``);
      expect(message).not.toContain("`docker ");
      expect(message).not.toContain("ipam.db");
    });

    it.each([
      ["inspecting the holder", "holder"],
      ["listing the runtime's containers", "ps"],
    ])("keeps the raw error when the Podman socket changes while %s", (_case, driftAt) => {
      const { message, commands } = startRegistry(
        noSuchObject(),
        result(0, ""),
        ipamRefusal(),
        result(1),
        driftAt,
      );

      expect(message).toMatch(/^Starting the managed portable registry failed: docker: /u);
      expect(message).not.toContain("ipam.db");
      expect(message).not.toContain("\n");
      expect(commands.some(([command]) => command === "ps")).toBe(driftAt === "ps");
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

    describe("when the running managed registry must join the network", () => {
      const connectedToNothing = result(0, "1|true|");

      it("explains the stale address from the network connect refusal", () => {
        const { message, commands } = startRegistry(
          noSuchObject(),
          result(0, ""),
          ipamRefusal(),
          connectedToNothing,
        );

        expect(message).toContain(
          "Connecting the managed portable registry to the sandbox network failed",
        );
        expect(message).toContain(`${staleId}, but that container no longer exists`);
        expect(message).toContain("rm '/run/user/1001/containers/networks/ipam.db'");
        expect(commands.filter(([command]) => command === "network")).toEqual([
          [
            "network",
            "connect",
            "--ip",
            PORTABLE_REGISTRY_IP,
            PORTABLE_DOCKER_NETWORK_NAME,
            "nemoclaw-portable-registry",
          ],
        ]);
        expect(commands.some(([command]) => command === "rm" || command === "run")).toBe(false);
      });

      it("does not offer the file removal while that registry is still running", () => {
        const { message } = startRegistry(
          noSuchObject(),
          names("nemoclaw-portable-registry"),
          ipamRefusal(),
          connectedToNothing,
        );

        expect(message).toContain("Stop or remove all of them");
        expect(message).not.toContain("ipam.db");
      });

      it("keeps the raw error when the holder cannot be inspected", () => {
        const { message } = startRegistry(
          result(125),
          result(0, ""),
          ipamRefusal(),
          connectedToNothing,
        );

        expect(message).toMatch(
          /^Connecting the managed portable registry to the sandbox network failed: docker: /u,
        );
        expect(message).not.toContain("ipam.db");
      });
    });
  });
});
