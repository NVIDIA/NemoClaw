// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { BlockList } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  preparePortableExperimentalHost,
  type PortableHostPreparationDeps,
} from "./portable-host-preparation";
import {
  PORTABLE_DOCKER_NETWORK_SUBNET,
  PORTABLE_HOST_GATEWAY_IP,
  PORTABLE_REGISTRY_IP,
} from "./portable-profile";

type SpawnResult = ReturnType<typeof spawnSync>;
type HostCommandMock = ReturnType<
  typeof vi.fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>
>;
type SocketAuthorityMock = ReturnType<
  typeof vi.fn<NonNullable<PortableHostPreparationDeps["assertSocketAuthority"]>>
>;

const RETIRED_SUBNET = "169.254.1.0/24";
const RETIRED_REGISTRY_IP = "169.254.1.3";
const NETWORK_ID = "a".repeat(64);
const REGISTRY_ID = "b".repeat(64);
const OTHER_ID = "c".repeat(64);
const SOCKET = "unix:///run/user/1001/podman/podman.sock";
const OWNER_LABEL = "com.nvidia.nemoclaw.portable";
const NO_RETIRED_GATEWAY_EVIDENCE = JSON.stringify([
  { ifname: "lo", addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8 }] },
]);

type RecoveryScenario = {
  readonly networkInspection?: SpawnResult;
  readonly attachmentInspection?: SpawnResult;
  readonly registryInspection?: SpawnResult;
  readonly socketFailureAt?: number;
};

function result(status: number | null = 0, stdout = "", error?: Error): SpawnResult {
  return {
    status,
    stdout,
    stderr: "",
    ...(error ? { error } : {}),
  } as SpawnResult;
}

function networkRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "openshell-docker",
    id: NETWORK_ID,
    driver: "bridge",
    internal: false,
    ipv6_enabled: false,
    dns_enabled: true,
    network_interface: "podman1",
    subnets: [{ subnet: RETIRED_SUBNET, gateway: "169.254.1.1" }],
    ipam_options: { driver: "host-local" },
    labels: {},
    options: {},
    routes: [],
    ...overrides,
  };
}

function networkSnapshot(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([networkRecord(overrides)]);
}

function registryRecord(
  overrides: {
    readonly id?: string;
    readonly name?: string;
    readonly labels?: Record<string, string>;
    readonly running?: unknown;
    readonly networks?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    Id: overrides.id ?? REGISTRY_ID,
    Name: overrides.name ?? "nemoclaw-portable-registry",
    Config: { Labels: overrides.labels ?? { [OWNER_LABEL]: "1" } },
    State: { Running: overrides.running ?? true },
    NetworkSettings: {
      Networks: overrides.networks ?? {
        "openshell-docker": {
          IPAddress: RETIRED_REGISTRY_IP,
          NetworkID: NETWORK_ID,
        },
      },
    },
  };
}

function registrySnapshot(overrides: Parameters<typeof registryRecord>[0] = {}): string {
  return JSON.stringify([registryRecord(overrides)]);
}

function recoveryPodman(scenario: RecoveryScenario, events: string[] = []) {
  return vi.fn((args: readonly string[], _env: NodeJS.ProcessEnv): SpawnResult => {
    expect(args.slice(0, 2)).toEqual(["--url", SOCKET]);
    const command = args.slice(2);
    events.push(`podman:${command.join(" ")}`);
    switch (`${command[0]}:${command[1]}`) {
      case "network:inspect":
        return scenario.networkInspection ?? result(0, networkSnapshot());
      case "ps:--all":
        expect(command).toContain(`network=${NETWORK_ID}`);
        return scenario.attachmentInspection ?? result();
      case "container:inspect":
        return scenario.registryInspection ?? result(0, registrySnapshot());
      default:
        throw new Error(`unexpected Podman command: ${command.join(" ")}`);
    }
  });
}

function preparationDeps(
  home: string,
  podman: ReturnType<typeof recoveryPodman>,
  docker: HostCommandMock,
  sudo: HostCommandMock,
  assertSocketAuthority: SocketAuthorityMock,
) {
  return {
    platform: "linux" as const,
    home,
    uid: 1001,
    systemctl: () => result(),
    podman,
    docker,
    hardenSocketDirectory: vi.fn(),
    validateConfigAuthority: vi.fn(),
    sudo,
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
      assertSocketAuthority,
      podmanCapture: () => ({
        status: 0,
        stdout: JSON.stringify({ Server: { Version: "5.7.0" } }),
        stderr: "",
      }),
    },
  };
}

const tempDirs: string[] = [];

function runRecovery(scenario: RecoveryScenario = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
  tempDirs.push(home);
  const events: string[] = [];
  let recoveryStarted = false;
  let recoveryAssertionCount = 0;
  const podman = recoveryPodman(scenario, events);
  const docker = vi.fn((args: readonly string[], _env: NodeJS.ProcessEnv): SpawnResult => {
    const isVersionProbe = args[0] === "--version";
    recoveryStarted ||= !isVersionProbe;
    return isVersionProbe ? result() : result(0, JSON.stringify([{ Subnet: RETIRED_SUBNET }]));
  });
  const sudo = vi.fn((_args: readonly string[], _env: NodeJS.ProcessEnv) => result());
  const assertSocketAuthority = vi.fn<
    NonNullable<PortableHostPreparationDeps["assertSocketAuthority"]>
  >(() => {
    events.push("assert");
    recoveryAssertionCount += Number(recoveryStarted);
    return recoveryStarted && scenario.socketFailureAt === recoveryAssertionCount
      ? (() => {
          throw new Error("socket authority changed");
        })()
      : undefined;
  });
  let message = "";
  try {
    preparePortableExperimentalHost(
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      preparationDeps(home, podman, docker, sudo, assertSocketAuthority),
    );
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).not.toBe("");

  const issuedDocker = docker.mock.calls.map(([args]) => args.join(" "));
  const issuedPodman = podman.mock.calls.map(([args]) => args.slice(2).join(" "));
  expect(
    issuedDocker.some((command) => /\b(?:rm|stop)\b|--force|network create/u.test(command)),
  ).toBe(false);
  expect(issuedPodman.some((command) => /\b(?:rm|stop)\b|--force/u.test(command))).toBe(false);
  expect(sudo).not.toHaveBeenCalled();
  for (const [args, env] of podman.mock.calls) {
    expect(args.slice(0, 2)).toEqual(["--url", SOCKET]);
    expect(env.DOCKER_HOST).toBe(SOCKET);
  }
  for (const [index] of [...events.entries()].filter(([, event]) => event.startsWith("podman:"))) {
    expect(events[index - 1]).toBe("assert");
    expect(events[index + 1]).toBe("assert");
  }

  return { message, podman };
}

function ownedRegistryScenario(overrides: RecoveryScenario = {}): RecoveryScenario {
  return {
    attachmentInspection: result(0, REGISTRY_ID),
    registryInspection: result(0, registrySnapshot()),
    ...overrides,
  };
}

function expectNoRemovalGuidance(scenario: RecoveryScenario): void {
  const { message } = runRecovery(scenario);
  expect(message).toContain("No removal commands were produced");
  expect(message).not.toContain("podman --url");
  expect(message).not.toContain("network rm");
  expect(message).not.toContain("container rm");
  expect(message).not.toContain("container stop");
}

describe("portable retired-subnet recovery (#9707)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the sandbox subnet outside the link-local block netavark refuses", () => {
    const linkLocal = new BlockList();
    linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
    const [networkAddress] = PORTABLE_DOCKER_NETWORK_SUBNET.split("/");

    expect(linkLocal.check(networkAddress!, "ipv4")).toBe(false);
    expect(linkLocal.check(PORTABLE_REGISTRY_IP, "ipv4")).toBe(false);
  });

  it("prints only the socket-bound immutable network command when the retired network is empty", () => {
    const { message, podman } = runRecovery();
    const networkCommand = `podman --url '${SOCKET}' network rm ${NETWORK_ID}`;

    expect(podman).toHaveBeenCalledTimes(2);
    expect(podman.mock.calls[0]?.[0]).toEqual([
      "--url",
      SOCKET,
      "network",
      "inspect",
      "openshell-docker",
    ]);
    expect(podman.mock.calls[1]?.[0]).toEqual([
      "--url",
      SOCKET,
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `network=${NETWORK_ID}`,
      "--format",
      "{{.ID}}",
    ]);
    expect(message).toContain(networkCommand);
    expect(message).not.toContain("container rm");
    expect(message).not.toContain("--force");
  });

  it("prints ordered force-free immutable commands for the sole owned running registry", () => {
    const { message, podman } = runRecovery(ownedRegistryScenario());
    const stopCommand = `podman --url '${SOCKET}' container stop ${REGISTRY_ID}`;
    const registryCommand = `podman --url '${SOCKET}' container rm ${REGISTRY_ID}`;
    const networkCommand = `podman --url '${SOCKET}' network rm ${NETWORK_ID}`;

    expect(podman).toHaveBeenCalledTimes(3);
    expect(podman.mock.calls[2]?.[0]).toEqual([
      "--url",
      SOCKET,
      "container",
      "inspect",
      REGISTRY_ID,
    ]);
    expect(message).toContain(stopCommand);
    expect(message).toContain(registryCommand);
    expect(message).toContain(networkCommand);
    expect(message.indexOf(stopCommand)).toBeLessThan(message.indexOf(registryCommand));
    expect(message.indexOf(registryCommand)).toBeLessThan(message.indexOf(networkCommand));
    expect(message).not.toContain("--force");
  });

  it("omits the stop command for the sole owned stopped registry", () => {
    const { message } = runRecovery(
      ownedRegistryScenario({
        registryInspection: result(0, registrySnapshot({ running: false })),
      }),
    );

    expect(message).not.toContain("container stop");
    expect(message).toContain(`podman --url '${SOCKET}' container rm ${REGISTRY_ID}`);
    expect(message).toContain(`podman --url '${SOCKET}' network rm ${NETWORK_ID}`);
    expect(message).not.toContain("--force");
  });

  it.each<[string, RecoveryScenario]>([
    [
      "the network inspection process fails",
      { networkInspection: result(null, "", new Error("spawn failed")) },
    ],
    ["the network inspection status fails", { networkInspection: result(125) }],
    ["the network JSON is malformed", { networkInspection: result(0, "{") }],
    ["no network record is returned", { networkInspection: result(0, "[]") }],
    [
      "more than one network record is returned",
      { networkInspection: result(0, JSON.stringify([networkRecord(), networkRecord()])) },
    ],
    [
      "the network ID is truncated",
      { networkInspection: result(0, networkSnapshot({ id: "abc" })) },
    ],
    [
      "the network ID uses uppercase",
      { networkInspection: result(0, networkSnapshot({ id: "A".repeat(64) })) },
    ],
    [
      "the network name differs",
      { networkInspection: result(0, networkSnapshot({ name: "other" })) },
    ],
    [
      "the network driver differs",
      { networkInspection: result(0, networkSnapshot({ driver: "macvlan" })) },
    ],
    [
      "the network is internal",
      { networkInspection: result(0, networkSnapshot({ internal: true })) },
    ],
    [
      "the network enables IPv6",
      { networkInspection: result(0, networkSnapshot({ ipv6_enabled: true })) },
    ],
    [
      "the network DNS mode is missing",
      { networkInspection: result(0, networkSnapshot({ dns_enabled: undefined })) },
    ],
    [
      "the network DNS mode is malformed",
      { networkInspection: result(0, networkSnapshot({ dns_enabled: "true" })) },
    ],
    [
      "the network disables DNS",
      { networkInspection: result(0, networkSnapshot({ dns_enabled: false })) },
    ],
    [
      "the network bridge interface is missing",
      { networkInspection: result(0, networkSnapshot({ network_interface: undefined })) },
    ],
    [
      "the network bridge interface is malformed",
      { networkInspection: result(0, networkSnapshot({ network_interface: 1 })) },
    ],
    [
      "the network uses a custom bridge interface",
      { networkInspection: result(0, networkSnapshot({ network_interface: "portable0" })) },
    ],
    [
      "the network has custom DNS servers",
      {
        networkInspection: result(0, networkSnapshot({ network_dns_servers: ["192.0.2.53"] })),
      },
    ],
    [
      "the network DNS server evidence is malformed",
      { networkInspection: result(0, networkSnapshot({ network_dns_servers: "192.0.2.53" })) },
    ],
    [
      "the network DNS server evidence is ambiguous",
      { networkInspection: result(0, networkSnapshot({ network_dns_servers: null })) },
    ],
    [
      "the subnet record is missing",
      { networkInspection: result(0, networkSnapshot({ subnets: [] })) },
    ],
    [
      "the network has another subnet",
      {
        networkInspection: result(
          0,
          networkSnapshot({ subnets: [{ subnet: "10.0.0.0/24", gateway: "10.0.0.1" }] }),
        ),
      },
    ],
    [
      "the network has more than one subnet",
      {
        networkInspection: result(
          0,
          networkSnapshot({
            subnets: [
              { subnet: RETIRED_SUBNET, gateway: "169.254.1.1" },
              { subnet: "fd00::/64", gateway: "fd00::1" },
            ],
          }),
        ),
      },
    ],
    [
      "the network gateway differs",
      {
        networkInspection: result(
          0,
          networkSnapshot({ subnets: [{ subnet: RETIRED_SUBNET, gateway: "169.254.1.254" }] }),
        ),
      },
    ],
    [
      "the subnet has a custom lease range",
      {
        networkInspection: result(
          0,
          networkSnapshot({
            subnets: [
              {
                subnet: RETIRED_SUBNET,
                gateway: "169.254.1.1",
                lease_range: { start_ip: "169.254.1.20", end_ip: "169.254.1.30" },
              },
            ],
          }),
        ),
      },
    ],
    [
      "the subnet lease range is malformed",
      {
        networkInspection: result(
          0,
          networkSnapshot({
            subnets: [
              {
                subnet: RETIRED_SUBNET,
                gateway: "169.254.1.1",
                lease_range: "169.254.1.20-169.254.1.30",
              },
            ],
          }),
        ),
      },
    ],
    [
      "the subnet lease range evidence is ambiguous",
      {
        networkInspection: result(
          0,
          networkSnapshot({
            subnets: [{ subnet: RETIRED_SUBNET, gateway: "169.254.1.1", lease_range: null }],
          }),
        ),
      },
    ],
    [
      "the network IPAM driver is missing",
      { networkInspection: result(0, networkSnapshot({ ipam_options: {} })) },
    ],
    [
      "the network IPAM driver differs",
      { networkInspection: result(0, networkSnapshot({ ipam_options: { driver: "dhcp" } })) },
    ],
    [
      "the network has an ownership label",
      { networkInspection: result(0, networkSnapshot({ labels: { owner: "user" } })) },
    ],
    [
      "the network has a custom option",
      { networkInspection: result(0, networkSnapshot({ options: { mtu: "1400" } })) },
    ],
    [
      "the network has a custom route",
      {
        networkInspection: result(0, networkSnapshot({ routes: [{ destination: "10.0.0.0/8" }] })),
      },
    ],
    [
      "the attachment query process fails",
      { attachmentInspection: result(null, "", new Error("spawn failed")) },
    ],
    ["the attachment query status fails", { attachmentInspection: result(125) }],
    ["an attachment ID is truncated", { attachmentInspection: result(0, "abc") }],
    ["an attachment ID uses uppercase", { attachmentInspection: result(0, "C".repeat(64)) }],
    ["an attachment ID has whitespace", { attachmentInspection: result(0, ` ${OTHER_ID}`) }],
    ["the attachment list has a blank row", { attachmentInspection: result(0, `${OTHER_ID}\n\n`) }],
    [
      "an attachment row has an extra field",
      { attachmentInspection: result(0, `${OTHER_ID}|foreign`) },
    ],
    [
      "an attachment row contains shell text",
      { attachmentInspection: result(0, `${OTHER_ID};exit`) },
    ],
    [
      "an attachment ID is duplicated",
      { attachmentInspection: result(0, `${OTHER_ID}\n${OTHER_ID}`) },
    ],
    [
      "more than one container is attached",
      { attachmentInspection: result(0, `${REGISTRY_ID}\n${OTHER_ID}`) },
    ],
    ["the sole attachment is foreign", { attachmentInspection: result(0, OTHER_ID) }],
    [
      "the registry inspection process fails",
      ownedRegistryScenario({ registryInspection: result(null, "", new Error("spawn failed")) }),
    ],
    [
      "the registry inspection status fails",
      ownedRegistryScenario({ registryInspection: result(125) }),
    ],
    [
      "the registry JSON is malformed",
      ownedRegistryScenario({ registryInspection: result(0, "{") }),
    ],
    [
      "no registry record is returned",
      ownedRegistryScenario({ registryInspection: result(0, "[]") }),
    ],
    [
      "more than one registry record is returned",
      ownedRegistryScenario({
        registryInspection: result(0, JSON.stringify([registryRecord(), registryRecord()])),
      }),
    ],
    [
      "the registry ID differs from the holder inventory",
      ownedRegistryScenario({ registryInspection: result(0, registrySnapshot({ id: OTHER_ID })) }),
    ],
    [
      "the registry name differs",
      ownedRegistryScenario({
        registryInspection: result(0, registrySnapshot({ name: "replacement" })),
      }),
    ],
    [
      "the registry ownership label is missing",
      ownedRegistryScenario({ registryInspection: result(0, registrySnapshot({ labels: {} })) }),
    ],
    [
      "the registry ownership label differs",
      ownedRegistryScenario({
        registryInspection: result(0, registrySnapshot({ labels: { [OWNER_LABEL]: "0" } })),
      }),
    ],
    [
      "the registry running state is malformed",
      ownedRegistryScenario({
        registryInspection: result(0, registrySnapshot({ running: "true" })),
      }),
    ],
    [
      "the registry uses another retired-network IP",
      ownedRegistryScenario({
        registryInspection: result(
          0,
          registrySnapshot({
            networks: {
              "openshell-docker": { IPAddress: "169.254.1.4", NetworkID: NETWORK_ID },
            },
          }),
        ),
      }),
    ],
    [
      "the registry NetworkID differs",
      ownedRegistryScenario({
        registryInspection: result(
          0,
          registrySnapshot({
            networks: {
              "openshell-docker": { IPAddress: RETIRED_REGISTRY_IP, NetworkID: OTHER_ID },
            },
          }),
        ),
      }),
    ],
    [
      "the registry NetworkID is missing",
      ownedRegistryScenario({
        registryInspection: result(
          0,
          registrySnapshot({
            networks: {
              "openshell-docker": { IPAddress: RETIRED_REGISTRY_IP },
            },
          }),
        ),
      }),
    ],
    [
      "the registry is attached to another network",
      ownedRegistryScenario({
        registryInspection: result(
          0,
          registrySnapshot({
            networks: {
              "openshell-docker": { IPAddress: RETIRED_REGISTRY_IP, NetworkID: NETWORK_ID },
              other: { IPAddress: "10.0.0.2", NetworkID: OTHER_ID },
            },
          }),
        ),
      }),
    ],
    [
      "the registry is attached only to another network",
      ownedRegistryScenario({
        registryInspection: result(
          0,
          registrySnapshot({
            networks: {
              other: { IPAddress: "10.0.0.2", NetworkID: OTHER_ID },
            },
          }),
        ),
      }),
    ],
  ])("stops without deletion guidance when %s", (_label, scenario) => {
    expectNoRemovalGuidance(scenario);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "stops without deletion guidance when socket authority assertion %i fails",
    (socketFailureAt) => {
      expectNoRemovalGuidance(ownedRegistryScenario({ socketFailureAt }));
    },
  );
});
