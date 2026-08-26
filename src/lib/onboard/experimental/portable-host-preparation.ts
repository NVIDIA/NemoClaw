// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  hardenPodmanSocketDirectory,
  type PodmanSocketAuthority,
} from "../../adapters/podman";
import { ensureConfigDir } from "../../state/config-io";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import {
  DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
  isPortableExperimentalProfile,
  parseDockerNetworkIpamEntries,
  PORTABLE_DOCKER_NETWORK_NAME,
  PORTABLE_DOCKER_NETWORK_SUBNET,
  PORTABLE_HOST_GATEWAY_IP,
  PORTABLE_LOCAL_REGISTRY,
  PORTABLE_REGISTRY_IP,
  resolveDockerDriverNetworkName,
} from "../docker-driver-platform";
import {
  inspectPortablePodmanReadiness,
  portablePodmanCommandEnvironment,
  portablePodmanReadinessError,
  type PortablePodmanReadinessDeps,
} from "./portable-runtime-readiness";
import {
  inspectPortableCpuDelegation,
  portableCpuDelegationError,
  type CpuDelegationPreflight,
  type CpuDelegationPreflightDeps,
} from "./portable-cpu-delegation-preflight";

const REGISTRY_CONTAINER = "nemoclaw-portable-registry";
const REGISTRY_LABEL_NAME = "com.nvidia.nemoclaw.portable";
const REGISTRY_LABEL_VALUE = "1";
const REGISTRY_LABEL = `${REGISTRY_LABEL_NAME}=${REGISTRY_LABEL_VALUE}`;
// Portable onboarding assigned this address to loopback before #9587 moved the
// host gateway outside the sandbox subnet. Keep the retired value here so an
// upgraded host cannot silently retain a route that captures sandbox traffic.
const RETIRED_PORTABLE_HOST_GATEWAY_IP = "169.254.1.2";
// Go template fields are joined with an explicit separator because a missing
// label renders as `<no value>`, which contains a space and would corrupt
// whitespace splitting.
const DOCKER_FIELD_SEPARATOR = "|";
// Portable onboarding created the sandbox network on this subnet before #9707
// moved it out of the link-local block that netavark refuses. Name the retired
// value so an upgraded host gets the removal command instead of the generic
// unexpected-subnet refusal.
const RETIRED_PORTABLE_DOCKER_NETWORK_SUBNET = "169.254.1.0/24";
const RETIRED_PORTABLE_DOCKER_NETWORK_GATEWAY = "169.254.1.1";
const RETIRED_PORTABLE_REGISTRY_IP = "169.254.1.3";
const FULL_PODMAN_ID_PATTERN = /^[a-f0-9]{64}$/u;
const AUTO_PODMAN_BRIDGE_INTERFACE_PATTERN = /^podman(?:0|[1-9][0-9]{0,8})$/u;
const REGISTRY_IMAGE =
  "docker.io/library/registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const HOST_COMMAND_TIMEOUT_MS = 30_000;
const REGISTRY_COMMAND_TIMEOUT_MS = 300_000;
const REGISTRY_FRAGMENT = `[[registry]]
location = "${PORTABLE_LOCAL_REGISTRY}"
insecure = true
`;
const PORTABLE_CONTAINERS_CONF = `[network]
default_rootless_network_cmd = "pasta"
firewall_driver = "iptables"

[engine]
env = ["NETAVARK_FW=iptables"]
`;
const PORTABLE_CONFIG_RELATIVE_FILES = [
  "containers/registries.conf.d/99-nemoclaw-portable.conf",
  "containers/containers.conf.d/99-nemoclaw-portable.conf",
  "nemoclaw/portable/containers.conf",
] as const;

type SpawnResult = ReturnType<typeof spawnSync>;

export interface PortableHostPreparationDeps {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  systemctl?: (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => SpawnResult;
  podman?: (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => SpawnResult;
  docker?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  ip?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  sudo?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  hardenSocketDirectory?: (socketPath: string, uid: number) => void;
  captureSocketAuthority?: (socketPath: string, uid: number) => PodmanSocketAuthority;
  assertSocketAuthority?: (authority: PodmanSocketAuthority) => void;
  qualifyPodman?: (authority: PodmanSocketAuthority) => void;
  runtimeReadiness?: PortablePodmanReadinessDeps;
  validateConfigAuthority?: (input: {
    homeDir: string;
    configHome: string;
    runtimeDir: string;
    socketPath: string | null;
    uid: number;
  }) => void;
  cpuDelegationPreflight?: (deps: CpuDelegationPreflightDeps) => CpuDelegationPreflight;
}

export interface PortableHostPreparationResult {
  readonly authority: CheckpointPortableRuntimeAuthority;
  readonly socketAuthority: PodmanSocketAuthority | null;
  readonly containersConf: string;
}

function commandDetail(result: SpawnResult): string {
  if (result.error) return result.error.message;
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  return stderr || stdout || `exit ${String(result.status)}`;
}

function requireCommand(result: SpawnResult, description: string): void {
  if (result.status === 0 && !result.error) return;
  throw new Error(`${description} failed: ${commandDetail(result)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFullPodmanIds(raw: string): readonly string[] {
  if (raw === "") return [];
  const lines = raw.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (
    lines.length === 0 ||
    lines.some(
      (line) => line === "" || line !== line.trim() || !FULL_PODMAN_ID_PATTERN.test(line),
    ) ||
    new Set(lines).size !== lines.length
  ) {
    throw new Error("invalid Podman IDs");
  }
  return lines;
}

function quoteRecoveryArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface RetiredPortableNetworkEvidence {
  readonly networkId: string;
}

function parseRetiredPortableNetwork(
  raw: string,
  expectedName: string,
): RetiredPortableNetworkEvidence {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error("invalid retired network evidence");
  }
  const network = parsed[0];
  const subnets = network.subnets;
  const subnet = Array.isArray(subnets) && subnets.length === 1 ? subnets[0] : null;
  const ipamOptions = network.ipam_options;
  const labels = network.labels;
  const options = network.options;
  const routes = network.routes;
  if (
    typeof network.id !== "string" ||
    !FULL_PODMAN_ID_PATTERN.test(network.id) ||
    expectedName !== PORTABLE_DOCKER_NETWORK_NAME ||
    network.name !== expectedName ||
    network.driver !== "bridge" ||
    network.internal !== false ||
    network.ipv6_enabled !== false ||
    network.dns_enabled !== true ||
    typeof network.network_interface !== "string" ||
    !AUTO_PODMAN_BRIDGE_INTERFACE_PATTERN.test(network.network_interface) ||
    Object.hasOwn(network, "network_dns_servers") ||
    !isRecord(subnet) ||
    subnet.subnet !== RETIRED_PORTABLE_DOCKER_NETWORK_SUBNET ||
    subnet.gateway !== RETIRED_PORTABLE_DOCKER_NETWORK_GATEWAY ||
    Object.hasOwn(subnet, "lease_range") ||
    !isRecord(ipamOptions) ||
    ipamOptions.driver !== "host-local" ||
    (labels !== undefined &&
      labels !== null &&
      (!isRecord(labels) || Object.keys(labels).length)) ||
    (options !== undefined &&
      options !== null &&
      (!isRecord(options) || Object.keys(options).length)) ||
    (routes !== undefined && routes !== null && (!Array.isArray(routes) || routes.length !== 0))
  ) {
    throw new Error("ambiguous retired network evidence");
  }
  return { networkId: network.id };
}

interface RetiredPortableRegistryEvidence {
  readonly containerId: string;
  readonly running: boolean;
}

function parseOwnedRetiredRegistry(
  raw: string,
  expectedContainerId: string,
  networkId: string,
  networkName: string,
): RetiredPortableRegistryEvidence {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error("invalid retired registry evidence");
  }
  const registry = parsed[0];
  const config = isRecord(registry.Config) ? registry.Config : null;
  const labels = config && isRecord(config.Labels) ? config.Labels : null;
  const state = isRecord(registry.State) ? registry.State : null;
  const networkSettings = isRecord(registry.NetworkSettings) ? registry.NetworkSettings : null;
  const networks =
    networkSettings && isRecord(networkSettings.Networks) ? networkSettings.Networks : null;
  const networkNames = networks ? Object.keys(networks) : [];
  const attachment = networks && isRecord(networks[networkName]) ? networks[networkName] : null;
  if (
    typeof registry.Id !== "string" ||
    registry.Id !== expectedContainerId ||
    !FULL_PODMAN_ID_PATTERN.test(registry.Id) ||
    registry.Name !== REGISTRY_CONTAINER ||
    labels?.[REGISTRY_LABEL_NAME] !== REGISTRY_LABEL_VALUE ||
    typeof state?.Running !== "boolean" ||
    networkNames.length !== 1 ||
    networkNames[0] !== networkName ||
    attachment?.NetworkID !== networkId ||
    attachment.IPAddress !== RETIRED_PORTABLE_REGISTRY_IP
  ) {
    throw new Error("ambiguous retired registry evidence");
  }
  return { containerId: registry.Id, running: state.Running };
}

/**
 * The portable profile points DOCKER_HOST at the rootless Podman socket but still
 * drives the managed registry — and the rest of onboarding's runtime preflight —
 * through the `docker` CLI. On a genuinely Podman-only host that CLI is absent,
 * so the first docker spawn fails with a cryptic `spawnSync docker ENOENT`
 * instead of an actionable message (#8453). Detect that up front and tell the
 * user to install the docker-compatible shim the profile expects.
 */
function requireDockerCompatibleCli(
  docker: NonNullable<PortableHostPreparationDeps["docker"]>,
  env: NodeJS.ProcessEnv,
): void {
  const probe = docker(["--version"], env);
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return;
  throw new Error(
    "The portable experimental profile drives Podman through a docker-compatible CLI, but no " +
      "`docker` command was found on PATH. On a Podman-only host, install the podman-docker shim " +
      "(Debian/Ubuntu: `sudo apt install podman-docker`; Fedora: `sudo dnf install podman-docker`), " +
      "then rerun `nemoclaw onboard --experimental-profile portable`.",
  );
}

function portableHostGatewayAliasState(
  output: string,
  gatewayIp = PORTABLE_HOST_GATEWAY_IP,
): "absent" | "configured" {
  const escapedGatewayIp = gatewayIp.replaceAll(".", "\\.");
  const addressPattern = new RegExp(`\\binet\\s+${escapedGatewayIp}/(\\d+)\\b`, "u");
  const assignments = output
    .split("\n")
    .map((line) => ({
      interfaceName: /^\d+:\s+([^ :]+)/u.exec(line)?.[1],
      prefix: addressPattern.exec(line)?.[1],
    }))
    .filter((entry) => entry.prefix !== undefined);
  if (assignments.length === 0) return "absent";
  if (assignments.every((entry) => entry.interfaceName === "lo" && entry.prefix === "32")) {
    return "configured";
  }
  throw new Error(
    `Refusing to configure ${gatewayIp}/32 because the address already has a conflicting host assignment.`,
  );
}

function retiredPortableHostGatewayAliasState(
  output: string,
): "absent" | "configured" | "conflicting" {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("invalid address evidence");
  const assignments: Array<{ interfaceName: string; prefix: number }> = [];
  for (const interfaceEntry of parsed) {
    if (
      !isRecord(interfaceEntry) ||
      typeof interfaceEntry.ifname !== "string" ||
      interfaceEntry.ifname.length === 0 ||
      !Array.isArray(interfaceEntry.addr_info)
    ) {
      throw new Error("invalid address evidence");
    }
    for (const addressEntry of interfaceEntry.addr_info) {
      if (
        !isRecord(addressEntry) ||
        addressEntry.family !== "inet" ||
        typeof addressEntry.local !== "string" ||
        isIP(addressEntry.local) !== 4 ||
        !Number.isInteger(addressEntry.prefixlen) ||
        Number(addressEntry.prefixlen) < 0 ||
        Number(addressEntry.prefixlen) > 32
      ) {
        throw new Error("invalid address evidence");
      }
      if (addressEntry.local === RETIRED_PORTABLE_HOST_GATEWAY_IP) {
        assignments.push({
          interfaceName: interfaceEntry.ifname,
          prefix: Number(addressEntry.prefixlen),
        });
      }
    }
  }
  if (assignments.length === 0) return "absent";
  if (
    assignments.length === 1 &&
    assignments[0]?.interfaceName === "lo" &&
    assignments[0].prefix === 32
  ) {
    return "configured";
  }
  return "conflicting";
}

function rejectRetiredPortableHostGatewayAlias(
  env: NodeJS.ProcessEnv,
  ip: NonNullable<PortableHostPreparationDeps["ip"]>,
): void {
  const result = ip(["-j", "-4", "address", "show"], env);
  requireCommand(result, "Inspecting the retired portable host gateway address");
  let state: "absent" | "configured" | "conflicting";
  try {
    state = retiredPortableHostGatewayAliasState(String(result.stdout ?? ""));
  } catch {
    throw new Error(
      "The retired portable host gateway address inspection returned invalid or ambiguous output. " +
        "Refusing to change Portable networking; investigate the host address assignments, then rerun " +
        "`nemoclaw onboard --experimental-profile portable`.",
    );
  }
  if (state === "absent") return;
  if (state === "conflicting") {
    throw new Error(
      `The retired portable host gateway address ${RETIRED_PORTABLE_HOST_GATEWAY_IP} has a conflicting host assignment. ` +
        "Resolve that assignment, then rerun `nemoclaw onboard --experimental-profile portable`.",
    );
  }
  throw new Error(
    `The retired portable host gateway address ${RETIRED_PORTABLE_HOST_GATEWAY_IP}/32 is still assigned to loopback. ` +
      `Remove it with \`sudo ip address delete ${RETIRED_PORTABLE_HOST_GATEWAY_IP}/32 dev lo\`, then rerun ` +
      "`nemoclaw onboard --experimental-profile portable`.",
  );
}

function ensurePortableHostGatewayAlias(
  env: NodeJS.ProcessEnv,
  ip: NonNullable<PortableHostPreparationDeps["ip"]>,
  sudo: NonNullable<PortableHostPreparationDeps["sudo"]>,
): void {
  const inspect = (): "absent" | "configured" => {
    const result = ip(["-o", "-4", "address", "show"], env);
    requireCommand(result, "Inspecting the portable host gateway address");
    return portableHostGatewayAliasState(String(result.stdout ?? ""));
  };
  if (inspect() === "configured") return;
  requireCommand(
    sudo(["--", "ip", "address", "replace", `${PORTABLE_HOST_GATEWAY_IP}/32`, "dev", "lo"], env),
    "Configuring the portable host gateway address",
  );
  if (inspect() !== "configured") {
    throw new Error(
      `Verifying the portable host gateway address failed: ${PORTABLE_HOST_GATEWAY_IP}/32 is not assigned to loopback.`,
    );
  }
}

function resolvePodmanDockerHost(result: SpawnResult): string {
  requireCommand(result, "Resolving the rootless Podman API socket");
  const socket = String(result.stdout ?? "").trim();
  if (socket.startsWith("unix:///")) return socket;
  if (socket.startsWith("/")) return `unix://${socket}`;
  throw new Error(
    `Resolving the rootless Podman API socket failed: invalid socket path '${socket || "empty"}'`,
  );
}

function assertSocketInsideRuntime(runtimeDir: string, socketPath: string): void {
  const relativeSocket = path.relative(runtimeDir, socketPath);
  if (
    relativeSocket === "" ||
    path.isAbsolute(relativeSocket) ||
    relativeSocket === ".." ||
    relativeSocket.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Portable Podman socket is outside the current user runtime directory.");
  }
}

function writePrivateConfig(filePath: string, value: string): void {
  ensureConfigDir(path.dirname(filePath));
  let file;
  try {
    file = openRegularFileNoFollow(filePath, { writable: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    file = openRegularFileNoFollow(filePath, {
      create: true,
      mode: 0o600,
      writable: true,
    });
  }
  try {
    file.replaceUtf8(value, 0o600);
  } finally {
    file.close();
  }
}

function writePortableRuntimeConfig(configHome: string): string {
  writePrivateConfig(
    path.join(configHome, "containers", "registries.conf.d", "99-nemoclaw-portable.conf"),
    REGISTRY_FRAGMENT,
  );
  // Podman reads `containers.conf.d` drop-ins from its own default search path, so this drop-in
  // keeps `firewall_driver` in effect for a shell that starts without CONTAINERS_CONF. The
  // `systemctl --user set-environment` values below last only until the user manager restarts.
  writePrivateConfig(
    path.join(configHome, "containers", "containers.conf.d", "99-nemoclaw-portable.conf"),
    PORTABLE_CONTAINERS_CONF,
  );
  // The OpenShell gateway service and sandbox prebuild read this file through CONTAINERS_CONF.
  const containersConf = path.join(configHome, "nemoclaw", "portable", "containers.conf");
  writePrivateConfig(containersConf, PORTABLE_CONTAINERS_CONF);
  return containersConf;
}

function canonicalAbsolute(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (resolved !== value || !path.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new Error(`Portable runtime ${label} must be a normalized absolute path.`);
  }
  return resolved;
}

function validateOwnedConfigAuthority(input: {
  homeDir: string;
  configHome: string;
  runtimeDir: string;
  socketPath: string | null;
  uid: number;
}): void {
  const { homeDir, configHome, runtimeDir, socketPath, uid } = input;
  const assertDirectory = (directory: string, owner: number | null): fs.Stats => {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Portable runtime path '${directory}' is not a real directory.`);
    }
    if (owner !== null && stat.uid !== owner) {
      throw new Error(`Portable runtime path '${directory}' is not owned by the current user.`);
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`Portable runtime path '${directory}' has unsafe write permissions.`);
    }
    return stat;
  };
  const assertSystemAncestors = (directory: string): void => {
    for (let current = path.dirname(directory); ; current = path.dirname(current)) {
      assertDirectory(current, null);
      const parent = path.dirname(current);
      if (parent === current) break;
    }
  };
  const assertOwnedRoot = (directory: string): void => {
    assertDirectory(directory, uid);
    assertSystemAncestors(directory);
  };
  const assertOwnedDescendants = (root: string, target: string): void => {
    const relative = path.relative(root, target);
    if (
      relative === "" ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      if (relative === "") return;
      throw new Error(`Portable runtime path '${target}' is outside '${root}'.`);
    }
    let current = root;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      try {
        assertDirectory(current, uid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  };
  const assertConfigRoot = (): void => {
    try {
      assertOwnedRoot(configHome);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let anchor = path.dirname(configHome);
    while (true) {
      try {
        assertOwnedRoot(anchor);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = path.dirname(anchor);
      if (parent === anchor) break;
      anchor = parent;
    }
    throw new Error("Portable runtime config root has no validated owned ancestor.");
  };
  const assertExistingConfigFile = (filePath: string): void => {
    try {
      const stat = fs.lstatSync(filePath);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.uid !== uid ||
        stat.nlink !== 1 ||
        (stat.mode & 0o022) !== 0
      ) {
        throw new Error(`Portable runtime config '${filePath}' is not a safe owned file.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  assertOwnedRoot(homeDir);
  assertOwnedRoot(runtimeDir);
  assertConfigRoot();
  for (const relative of PORTABLE_CONFIG_RELATIVE_FILES) {
    const filePath = path.join(configHome, relative);
    assertOwnedDescendants(configHome, path.dirname(filePath));
    assertExistingConfigFile(filePath);
  }
  if (socketPath) assertOwnedDescendants(runtimeDir, path.dirname(socketPath));
}

function retiredPortableNetworkRecovery(
  env: NodeJS.ProcessEnv,
  podman: NonNullable<PortableHostPreparationDeps["podman"]>,
  podmanUrl: string,
  networkName: string,
  assertSocketAuthority: () => void,
): never {
  const run = (args: readonly string[]): SpawnResult => {
    assertSocketAuthority();
    try {
      return podman(["--url", podmanUrl, ...args], env, HOST_COMMAND_TIMEOUT_MS);
    } finally {
      assertSocketAuthority();
    }
  };
  const blocked = (): never => {
    throw new Error(
      `Network '${networkName}' still uses the retired portable subnet ${RETIRED_PORTABLE_DOCKER_NETWORK_SUBNET}, ` +
        "but NemoClaw could not verify that it is safe to show recovery commands. No removal " +
        "commands were produced. Leave the network and connected containers unchanged. Resolve " +
        "each resource through the lifecycle that created it, then rerun " +
        "`nemoclaw onboard --experimental-profile portable`.",
    );
  };

  let networkId: string;
  let attachmentIds: readonly string[];
  let registry: RetiredPortableRegistryEvidence | null = null;
  try {
    const networkInspection = run(["network", "inspect", networkName]);
    requireCommand(networkInspection, "Inspecting the retired portable sandbox network");
    ({ networkId } = parseRetiredPortableNetwork(
      String(networkInspection.stdout ?? ""),
      networkName,
    ));

    const attachmentInspection = run([
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `network=${networkId}`,
      "--format",
      "{{.ID}}",
    ]);
    requireCommand(attachmentInspection, "Inspecting retired portable network attachments");
    attachmentIds = parseFullPodmanIds(String(attachmentInspection.stdout ?? ""));
    if (attachmentIds.length > 1) return blocked();
    if (attachmentIds.length === 1) {
      const containerId = attachmentIds[0]!;
      const registryInspection = run(["container", "inspect", containerId]);
      requireCommand(registryInspection, "Inspecting the retired portable registry candidate");
      registry = parseOwnedRetiredRegistry(
        String(registryInspection.stdout ?? ""),
        containerId,
        networkId,
        networkName,
      );
    }
  } catch {
    return blocked();
  }

  const commandPrefix = `podman --url ${quoteRecoveryArgument(podmanUrl)}`;
  const networkCommand = `${commandPrefix} network rm ${networkId}`;
  if (attachmentIds.length === 0) {
    throw new Error(
      `Network '${networkName}' still uses the retired portable subnet ${RETIRED_PORTABLE_DOCKER_NETWORK_SUBNET}. ` +
        `Run \`${networkCommand}\`. Continue only after this succeeds. Then rerun ` +
        "`nemoclaw onboard --experimental-profile portable`.",
    );
  }
  if (!registry || attachmentIds[0] !== registry.containerId) return blocked();
  const stopStep = registry.running
    ? `Run \`${commandPrefix} container stop ${registry.containerId}\`. Continue only after this succeeds. `
    : "";
  throw new Error(
    `Network '${networkName}' still uses the retired portable subnet ${RETIRED_PORTABLE_DOCKER_NETWORK_SUBNET}. ` +
      `${stopStep}Run \`${commandPrefix} container rm ${registry.containerId}\`. Continue only after this succeeds. ` +
      `Then run \`${networkCommand}\`. Continue only after this succeeds. Then rerun ` +
      "`nemoclaw onboard --experimental-profile portable`.",
  );
}

function ensurePortableSandboxNetwork(
  env: NodeJS.ProcessEnv,
  docker: NonNullable<PortableHostPreparationDeps["docker"]>,
  podman: NonNullable<PortableHostPreparationDeps["podman"]>,
  podmanUrl: string,
  networkName: string,
  assertSocketAuthority: () => void,
): void {
  const networkInspection = docker(
    ["network", "inspect", "--format", DOCKER_NETWORK_IPAM_INSPECT_FORMAT, networkName],
    env,
  );
  if (networkInspection.error) {
    requireCommand(networkInspection, "Inspecting the portable sandbox network");
  }
  if (networkInspection.status === 0) {
    const subnets = (parseDockerNetworkIpamEntries(String(networkInspection.stdout ?? "")) ?? [])
      .map((entry) => entry.subnet)
      .filter((subnet): subnet is string => Boolean(subnet));
    if (subnets.length === 1 && subnets[0] === RETIRED_PORTABLE_DOCKER_NETWORK_SUBNET) {
      retiredPortableNetworkRecovery(env, podman, podmanUrl, networkName, assertSocketAuthority);
    }
    if (subnets.length !== 1 || subnets[0] !== PORTABLE_DOCKER_NETWORK_SUBNET) {
      throw new Error(
        `Refusing to reuse network '${networkName}' with unexpected subnet '${subnets.join(", ") || "none"}'. Expected ${PORTABLE_DOCKER_NETWORK_SUBNET}.`,
      );
    }
  } else {
    requireCommand(
      docker(["network", "create", "--subnet", PORTABLE_DOCKER_NETWORK_SUBNET, networkName], env),
      "Creating the portable sandbox network",
    );
  }
}

function registryInspectionArgs(networkName: string): readonly string[] {
  return [
    "inspect",
    "--format",
    `{{ index .Config.Labels "com.nvidia.nemoclaw.portable" }}${DOCKER_FIELD_SEPARATOR}{{.State.Running}}${DOCKER_FIELD_SEPARATOR}{{with index .NetworkSettings.Networks ${JSON.stringify(networkName)}}}{{.IPAddress}}{{end}}`,
    REGISTRY_CONTAINER,
  ];
}

function ensureRegistryContainer(
  env: NodeJS.ProcessEnv,
  docker: NonNullable<PortableHostPreparationDeps["docker"]>,
  networkName: string,
): void {
  const inspection = docker(registryInspectionArgs(networkName), env);
  if (inspection.error) {
    requireCommand(inspection, "Inspecting the managed portable registry");
  }
  const exists = inspection.status === 0;
  const [owner, running, networkIp] = String(inspection.stdout ?? "")
    .trim()
    .split(DOCKER_FIELD_SEPARATOR);
  if (exists && owner !== "1") {
    throw new Error(
      `Refusing to replace existing unmanaged container '${REGISTRY_CONTAINER}'. Rename or remove it and retry.`,
    );
  }
  const stoppedAddressUnavailable = running !== "true" && networkIp === "invalid IP";
  if (
    exists && networkIp && networkIp !== PORTABLE_REGISTRY_IP && !stoppedAddressUnavailable
  ) {
    throw new Error(
      `Refusing to move managed container '${REGISTRY_CONTAINER}' from unexpected network address '${networkIp}'. Expected ${PORTABLE_REGISTRY_IP}.`,
    );
  }
  if (exists && running === "true" && networkIp === PORTABLE_REGISTRY_IP) return;
  if (exists && running === "true") {
    requireCommand(
      docker(
        ["network", "connect", "--ip", PORTABLE_REGISTRY_IP, networkName, REGISTRY_CONTAINER],
        env,
      ),
      "Connecting the managed portable registry to the sandbox network",
    );
    return;
  }
  if (exists) {
    requireCommand(
      docker(["rm", "-f", REGISTRY_CONTAINER], env),
      "Removing the previous managed portable registry",
    );
  }
  requireCommand(
    docker(
      [
        "run",
        "-d",
        "--name",
        REGISTRY_CONTAINER,
        "--label",
        REGISTRY_LABEL,
        "--network",
        networkName,
        "--ip",
        PORTABLE_REGISTRY_IP,
        "-p",
        "127.0.0.1:5000:5000",
        "--restart=always",
        REGISTRY_IMAGE,
      ],
      env,
    ),
    "Starting the managed portable registry",
  );
}

/** Prepare the user-scoped rootless runtime required by the hidden portable profile. */
export function preparePortableExperimentalHost(
  env: NodeJS.ProcessEnv = process.env,
  deps: PortableHostPreparationDeps = {},
  expectedAuthority?: CheckpointPortableRuntimeAuthority | null,
): PortableHostPreparationResult | null {
  if (!isPortableExperimentalProfile(env)) return null;
  const dockerNetworkName = resolveDockerDriverNetworkName(env);
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("The portable experimental profile requires Linux.");
  }
  const uid = deps.uid ?? process.geteuid?.() ?? process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) {
    throw new Error("The portable experimental profile could not resolve the current user ID.");
  }
  // Fail early, before any config write or service activation, when the
  // current user's systemd/cgroup hierarchy cannot enforce the sandbox CPU
  // limit (gh #9188). The diagnostic is credential-free and never edits
  // systemd units or weakens isolation.
  const cpuDelegation = deps.cpuDelegationPreflight ?? inspectPortableCpuDelegation;
  const cpuPreflight = cpuDelegation({ platform: deps.platform, uid: Number(uid) });
  if (!cpuPreflight.ok) throw portableCpuDelegationError(cpuPreflight);
  const currentHome = canonicalAbsolute(deps.home ?? os.userInfo().homedir, "home directory");
  const home = canonicalAbsolute(expectedAuthority?.homeDir ?? currentHome, "home directory");
  const configHome = path.join(home, ".config");
  const runtimeDir = canonicalAbsolute(
    expectedAuthority?.runtimeDir ?? path.join("/run/user", String(uid)),
    "user runtime directory",
  );
  const expectedSocketPath = expectedAuthority
    ? canonicalAbsolute(expectedAuthority.socketPath, "socket path")
    : null;
  if (expectedAuthority) {
    if (expectedAuthority.configHome !== configHome) {
      throw new Error(
        "Portable runtime authority configuration root does not match the current OS user home.",
      );
    }
    if (
      expectedAuthority.uid !== Number(uid) ||
      expectedAuthority.kind !== "podman" ||
      expectedAuthority.ownership !== "current-user" ||
      home !== currentHome ||
      runtimeDir !== path.join("/run/user", String(uid))
    ) {
      throw new Error(
        "Portable runtime authority does not match the current user or runtime kind.",
      );
    }
  }
  const validateConfigAuthority = deps.validateConfigAuthority ?? validateOwnedConfigAuthority;
  validateConfigAuthority({
    homeDir: home,
    configHome,
    runtimeDir,
    socketPath: expectedSocketPath,
    uid: Number(uid),
  });
  if (expectedSocketPath) {
    try {
      (
        deps.captureSocketAuthority ??
        ((socketPath, ownerUid) => capturePodmanSocketAuthority(socketPath, { uid: ownerUid }))
      )(expectedSocketPath, Number(uid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const podman =
    deps.podman ??
    ((args, childEnv, timeoutMs = HOST_COMMAND_TIMEOUT_MS) =>
      spawnSync("podman", [...args], {
        encoding: "utf-8",
        env: childEnv,
        timeout: timeoutMs,
      }));
  const admissionSocketPath = expectedSocketPath ?? path.join(runtimeDir, "podman", "podman.sock");
  assertSocketInsideRuntime(runtimeDir, admissionSocketPath);
  if (expectedAuthority && admissionSocketPath !== expectedAuthority.socketPath) {
    throw new Error("Portable Podman socket path does not match the onboarding checkpoint.");
  }

  env.NETAVARK_FW = "iptables";
  env.CONTAINERS_CONF = writePortableRuntimeConfig(configHome);
  const runtimeAuthority: CheckpointPortableRuntimeAuthority = {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: Number(uid),
    homeDir: home,
    configHome,
    runtimeDir,
    socketPath: admissionSocketPath,
  };
  const serviceEnv = portablePodmanCommandEnvironment(runtimeAuthority, env);

  const systemctl =
    deps.systemctl ??
    ((args, childEnv, timeoutMs = HOST_COMMAND_TIMEOUT_MS) =>
      spawnSync("systemctl", [...args], {
        encoding: "utf-8",
        env: childEnv,
        timeout: timeoutMs,
      }));
  requireCommand(
    systemctl(
      [
        "--user",
        "set-environment",
        "NETAVARK_FW=iptables",
        `CONTAINERS_CONF=${env.CONTAINERS_CONF}`,
      ],
      serviceEnv,
    ),
    "Configuring the rootless container service environment",
  );
  requireCommand(
    systemctl(["--user", "try-restart", "podman.service"], serviceEnv),
    "Refreshing the rootless container service",
  );
  const podmanEnv = portablePodmanCommandEnvironment(runtimeAuthority, env);
  const readiness = inspectPortablePodmanReadiness(runtimeAuthority, {
    ...deps.runtimeReadiness,
    platform: deps.platform,
    uid: Number(uid),
    home,
    env,
    systemctl: (args, childEnv, timeoutMs) => systemctl(args, childEnv, timeoutMs),
    hardenSocketDirectory:
      deps.hardenSocketDirectory ??
      deps.runtimeReadiness?.hardenSocketDirectory ??
      hardenPodmanSocketDirectory,
    captureSocketAuthority: deps.captureSocketAuthority
      ? (socketPath) => deps.captureSocketAuthority!(socketPath, Number(uid))
      : (deps.runtimeReadiness?.captureSocketAuthority ?? capturePodmanSocketAuthority),
    assertSocketAuthority:
      deps.assertSocketAuthority ??
      deps.runtimeReadiness?.assertSocketAuthority ??
      assertPodmanSocketAuthority,
    podmanCapture: deps.runtimeReadiness?.podmanCapture
      ? deps.runtimeReadiness.podmanCapture
      : deps.podman
        ? (_executable, args, timeoutMs) => {
            const result = podman(args, podmanEnv, timeoutMs);
            return {
              status: result.status ?? 1,
              stdout: String(result.stdout ?? ""),
              stderr: String(result.stderr ?? ""),
              ...(result.error ? { error: result.error } : {}),
            };
          }
        : (_executable, args, timeoutMs) => {
            const result = spawnSync("podman", [...args], {
              encoding: "utf-8",
              env: podmanEnv,
              stdio: ["ignore", "pipe", "pipe"],
              timeout: timeoutMs,
            });
            return {
              status: result.status ?? 1,
              stdout: String(result.stdout ?? ""),
              stderr: String(result.stderr ?? ""),
              ...(result.error ? { error: result.error } : {}),
            };
          },
  });
  if (!readiness.ok) throw portablePodmanReadinessError(readiness);
  const socketAuthority = readiness.authority;
  deps.qualifyPodman?.(socketAuthority);
  const dockerHost = readiness.dockerHost;
  const assertVerifiedSocketAuthority = (): void =>
    (
      deps.assertSocketAuthority ??
      deps.runtimeReadiness?.assertSocketAuthority ??
      assertPodmanSocketAuthority
    )(socketAuthority);
  console.log(
    `  Portable Podman readiness: ${readiness.timing.mode}; activation ${String(readiness.timing.activationMs)} ms; API ${String(readiness.timing.apiMs)} ms; total ${String(readiness.timing.totalMs)} ms.`,
  );
  env.DOCKER_HOST = dockerHost;
  podmanEnv.DOCKER_HOST = dockerHost;

  const docker =
    deps.docker ??
    ((args, childEnv) =>
      dockerSpawnSync(args, {
        encoding: "utf-8",
        env: childEnv,
        timeout: REGISTRY_COMMAND_TIMEOUT_MS,
      }));
  requireDockerCompatibleCli(docker, podmanEnv);
  const ip =
    deps.ip ??
    ((args, childEnv) =>
      spawnSync("ip", [...args], {
        encoding: "utf-8",
        env: childEnv,
        timeout: HOST_COMMAND_TIMEOUT_MS,
      }));
  const sudo =
    deps.sudo ??
    ((args, childEnv) =>
      spawnSync("sudo", [...args], {
        encoding: "utf-8",
        env: childEnv,
        timeout: HOST_COMMAND_TIMEOUT_MS,
      }));
  rejectRetiredPortableHostGatewayAlias(podmanEnv, ip);
  ensurePortableSandboxNetwork(
    podmanEnv,
    docker,
    podman,
    dockerHost,
    dockerNetworkName,
    assertVerifiedSocketAuthority,
  );
  ensurePortableHostGatewayAlias(podmanEnv, ip, sudo);
  ensureRegistryContainer(podmanEnv, docker, dockerNetworkName);
  assertVerifiedSocketAuthority();
  return {
    authority: runtimeAuthority,
    socketAuthority,
    containersConf: env.CONTAINERS_CONF,
  };
}

export const portableHostPreparationInternals = {
  REGISTRY_CONTAINER,
  REGISTRY_IMAGE,
  REGISTRY_FRAGMENT,
  PORTABLE_CONTAINERS_CONF,
  ensurePortableHostGatewayAlias,
  portableHostGatewayAliasState,
  validateOwnedConfigAuthority,
  resolvePodmanDockerHost,
};
