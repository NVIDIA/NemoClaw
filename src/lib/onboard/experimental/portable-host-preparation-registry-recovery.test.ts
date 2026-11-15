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
type ProbeCall = { command: string; dockerHost: string | undefined; timeoutMs: number | undefined };
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
      docker: (args, env, timeoutMs) =>
        args[0] === "network" && args[1] === "inspect"
          ? result(0, JSON.stringify([{ Subnet: PORTABLE_DOCKER_NETWORK_SUBNET }]))
          : docker(args, env, timeoutMs),
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

    // The probe must reach the verified socket and stay on the short host timeout.
    const expectBoundedProbe = (probes: ProbeCall[]): void => {
      const holderProbes = probes.filter(({ command }) => command === "holder");
      expect(holderProbes).toEqual([
        {
          command: "holder",
          dockerHost: "unix:///run/user/1001/podman/podman.sock",
          timeoutMs: 30_000,
        },
      ]);
    };

    // Commands shown to the user must reach the verified socket, not their ambient Docker.
    const podmanCommand = "podman --url 'unix:///run/user/1001/podman/podman.sock'";

    const noSuchObject = (): SpawnResult =>
      ({ status: 1, stdout: "", stderr: `Error: No such object: ${staleId}` }) as SpawnResult;

    function startRegistry(
      holder: SpawnResult,
      refusal: SpawnResult = ipamRefusal(),
      registry: SpawnResult = result(1),
      socketChangesDuringProbe = false,
    ): { message: string; commands: string[][]; probes: ProbeCall[] } {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
      tempDirs.push(home);
      const commands: string[][] = [];
      const probes: ProbeCall[] = [];
      let socketChanged = false;
      const docker = vi.fn(
        (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => {
          commands.push([...args]);
          const command = args[0] === "inspect" && args.includes(staleId) ? "holder" : args[0]!;
          probes.push({ command, dockerHost: env.DOCKER_HOST, timeoutMs });
          socketChanged = socketChanged || (command === "holder" && socketChangesDuringProbe);
          const responses: Record<string, SpawnResult> = {
            run: refusal,
            // A registry that is connected to no address yet needs `network connect`.
            network: refusal,
            holder,
            inspect: registry,
          };
          return responses[command] ?? result();
        },
      );
      try {
        // Fails once the probe has run against a replaced socket.
        prepare(home, docker, () => expect(socketChanged).toBe(false));
      } catch (error) {
        return { message: (error as Error).message, commands, probes };
      }
      throw new Error("expected the registry start to fail");
    }

    it("names the orphaned record and points to a reboot, not a file deletion", () => {
      const { message, commands, probes } = startRegistry(noSuchObject());

      expectBoundedProbe(probes);
      expect(message).toContain("Starting the managed portable registry failed");
      expect(message).toContain(
        `requested ip address ${PORTABLE_REGISTRY_IP} is already allocated`,
      );
      expect(message).toContain(`${staleId}, but that container no longer exists`);
      expect(message).toContain("Reboot the host to clear it");
      expect(message).toContain("nemoclaw onboard --experimental-profile portable");
      expect(message).not.toContain("ipam.db");
      expect(message).not.toMatch(/`(?:podman[^`]*)? ?rm /u);
      expect(commands.filter(([command]) => command === "run")).toHaveLength(1);
      expect(commands.some(([command]) => ["ps", "rm", "network"].includes(command))).toBe(false);
    });

    it("points at the live container when one still holds the address", () => {
      const { message, probes } = startRegistry(result(0, staleId));

      expectBoundedProbe(probes);
      expect(message).toContain(`held by container ${staleId}, which still exists`);
      expect(message).toContain(`\`${podmanCommand} inspect ${staleId}\``);
      expect(message).toContain(`\`${podmanCommand} rm -f ${staleId}\``);
      expect(message).not.toContain("`docker ");
      expect(message).not.toContain("ipam.db");
    });

    it("reports a changed Podman socket and gives no recovery commands", () => {
      const { message, probes } = startRegistry(noSuchObject(), ipamRefusal(), result(1), true);

      expectBoundedProbe(probes);
      expect(message).toMatch(/^Starting the managed portable registry failed: docker: /u);
      expect(message).toContain("The verified Podman socket changed");
      expect(message).toContain("Make sure the Podman runtime is stable, then rerun");
      expect(message).toContain("nemoclaw onboard --experimental-profile portable");
      expect(message).not.toContain("Reboot the host");
      expect(message).not.toContain("`podman ");
    });

    it("keeps the raw error when the holder probe times out", () => {
      const timedOut = {
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }),
      } as unknown as SpawnResult;
      const { message, probes } = startRegistry(timedOut);

      expectBoundedProbe(probes);
      expect(message).toMatch(/^Starting the managed portable registry failed: docker: /u);
      expect(message).not.toContain("\n");
    });

    it.each([
      ["a different address", ipamRefusal("10.87.0.9"), noSuchObject()],
      ["an inspection that cannot show the container is gone", ipamRefusal(), result(125)],
    ])("keeps the raw error for %s", (_case, refusal, holder) => {
      const { message } = startRegistry(holder as SpawnResult, refusal);

      expect(message).toMatch(/^Starting the managed portable registry failed: docker: /u);
      expect(message).not.toContain("\n");
    });

    describe("when the running managed registry must join the network", () => {
      const connectedToNothing = result(0, "1|true|");

      it("explains the stale address from the network connect refusal", () => {
        const { message, commands } = startRegistry(
          noSuchObject(),
          ipamRefusal(),
          connectedToNothing,
        );

        expect(message).toContain(
          "Connecting the managed portable registry to the sandbox network failed",
        );
        expect(message).toContain(`${staleId}, but that container no longer exists`);
        expect(message).toContain("Reboot the host to clear it");
        expect(message).not.toContain("ipam.db");
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

      it("keeps the raw error when the holder cannot be inspected", () => {
        const { message } = startRegistry(result(125), ipamRefusal(), connectedToNothing);

        expect(message).toMatch(
          /^Connecting the managed portable registry to the sandbox network failed: docker: /u,
        );
      });
    });
  });
});
