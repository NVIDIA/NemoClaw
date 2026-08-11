// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIPv4 } from "node:net";

import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "./shell-probe.ts";

const DEFAULT_NETWORK_NAME = "openshell-docker";
const DEFAULT_NETWORK_WAIT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const NETWORK_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,128}$/;
const BRIDGE_INTERFACE_PATTERN = /^[a-zA-Z0-9_.-]{1,15}$/;

type HostCommandClient = Pick<HostCliClient, "command" | "isCommandAvailable">;
type CleanupRegistrar = Pick<CleanupRegistry, "add">;

interface DockerNetworkInspect {
  Driver?: unknown;
  Id?: unknown;
  IPAM?: { Config?: unknown };
  Options?: unknown;
}

interface BridgeTopology {
  bridgeInterface: string;
  gatewayIp: string;
  prefixLength: number;
  subnet: string;
}

export interface HostMockFirewallOptions {
  authorized?: boolean;
  cleanup: CleanupRegistrar;
  host: HostCommandClient;
  networkName?: string;
  platform?: NodeJS.Platform;
  port: number;
  waitForNetworkMs?: number;
}

export interface HostMockFirewallResult extends BridgeTopology {
  changed: boolean;
  manualCommand: string;
  reason: "applied" | "platform_not_applicable" | "preexisting" | "ufw_inactive" | "ufw_missing";
}

function ipv4Number(value: string): number | undefined {
  if (!isIPv4(value)) return undefined;
  return value
    .split(".")
    .map(Number)
    .reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
}

function parseBridgeCidr(value: string): { network: number; prefixLength: number } | undefined {
  const match = value.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
  if (!match) return undefined;
  const network = ipv4Number(match[1]!);
  const prefixLength = Number(match[2]);
  if (network === undefined || prefixLength < 16 || prefixLength > 32) return undefined;
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  return (network & mask) >>> 0 === network ? { network, prefixLength } : undefined;
}

function parseBridgeTopology(stdout: string): BridgeTopology {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Docker returned invalid JSON while inspecting the OpenShell network");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !parsed[0] ||
    typeof parsed[0] !== "object"
  ) {
    throw new Error("Docker did not return one OpenShell network inspection record");
  }

  const network = parsed[0] as DockerNetworkInspect;
  if (network.Driver !== "bridge") {
    throw new Error(`OpenShell network driver must be bridge; got ${String(network.Driver)}`);
  }
  const id = typeof network.Id === "string" ? network.Id : "";
  if (!/^[0-9a-f]{12,64}$/i.test(id)) {
    throw new Error("OpenShell bridge network has no valid Docker network ID");
  }
  const options =
    network.Options && typeof network.Options === "object"
      ? (network.Options as Record<string, unknown>)
      : {};
  const configuredInterface = options["com.docker.network.bridge.name"];
  const bridgeInterface =
    typeof configuredInterface === "string" && configuredInterface
      ? configuredInterface
      : `br-${id.slice(0, 12)}`;
  if (!BRIDGE_INTERFACE_PATTERN.test(bridgeInterface)) {
    throw new Error(`OpenShell bridge interface is invalid: ${bridgeInterface}`);
  }

  const ipam = Array.isArray(network.IPAM?.Config) ? network.IPAM.Config : [];
  for (const entry of ipam) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const subnet = typeof record.Subnet === "string" ? record.Subnet : "";
    const gatewayIp = typeof record.Gateway === "string" ? record.Gateway : "";
    const cidr = parseBridgeCidr(subnet);
    const gateway = ipv4Number(gatewayIp);
    if (!cidr || gateway === undefined) continue;
    const mask = (0xffffffff << (32 - cidr.prefixLength)) >>> 0;
    if ((gateway & mask) >>> 0 !== cidr.network) {
      throw new Error(`OpenShell bridge gateway ${gatewayIp} is outside subnet ${subnet}`);
    }
    return { bridgeInterface, gatewayIp, prefixLength: cidr.prefixLength, subnet };
  }
  throw new Error("OpenShell bridge network has no narrow IPv4 subnet and gateway");
}

function commandFailure(result: ShellProbeResult): string {
  const detail = [
    result.timedOut ? "timed out" : undefined,
    result.signal ? `signal ${result.signal}` : undefined,
    result.exitCode !== null ? `exit ${result.exitCode}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  return detail || "command did not report an exit status";
}

function manualRule(topology: BridgeTopology, port: number): string[] {
  return [
    "allow",
    "in",
    "on",
    topology.bridgeInterface,
    "from",
    topology.subnet,
    "to",
    topology.gatewayIp,
    "port",
    String(port),
    "proto",
    "tcp",
  ];
}

function manualCommand(topology: BridgeTopology, port: number): string {
  return `sudo ufw ${manualRule(topology, port).join(" ")}`;
}

function remediationError(reason: string, topology: BridgeTopology, port: number): Error {
  return new Error(
    [
      `Could not establish OpenShell sandbox reachability for the live E2E host mock: ${reason}.`,
      `Detected bridge=${topology.bridgeInterface} subnet=${topology.subnet} gateway=${topology.gatewayIp} port=${port}.`,
      `Run this command manually: ${manualCommand(topology, port)}`,
    ].join("\n"),
  );
}

function normalizedRuleSnapshot(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}

function snapshotContainsRule(snapshot: string, rule: readonly string[]): boolean {
  const expected = `ufw ${rule.join(" ")}`;
  return normalizedRuleSnapshot(snapshot)
    .split("\n")
    .some((line) => line === expected);
}

function commandOptions(
  artifactName: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): ShellProbeRunOptions {
  return {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs,
  };
}

async function waitForNetwork(
  host: HostCommandClient,
  networkName: string,
  waitForNetworkMs: number,
): Promise<ShellProbeResult> {
  const waitSeconds = Math.max(1, Math.ceil(waitForNetworkMs / 1_000));
  const script = `set -u
deadline=$((SECONDS + $2))
while [ "$SECONDS" -lt "$deadline" ]; do
  if network_json="$(docker network inspect "$1" 2>/dev/null)"; then
    printf '%s\n' "$network_json"
    exit 0
  fi
  sleep 1
done
exit 124`;
  return host.command(
    "bash",
    ["-c", script, "wait-openshell-network", networkName, String(waitSeconds)],
    commandOptions("host-mock-firewall-network", waitForNetworkMs + 5_000),
  );
}

async function verifyBridgeAddress(
  host: HostCommandClient,
  topology: BridgeTopology,
  port: number,
): Promise<void> {
  const result = await host.command(
    "ip",
    ["-j", "address", "show", "dev", topology.bridgeInterface],
    commandOptions("host-mock-firewall-bridge-address"),
  );
  if (result.exitCode !== 0) {
    throw remediationError(
      `could not inspect bridge interface (${commandFailure(result)})`,
      topology,
      port,
    );
  }
  let addresses: unknown;
  try {
    addresses = JSON.parse(result.stdout);
  } catch {
    addresses = undefined;
  }
  const matches =
    Array.isArray(addresses) &&
    addresses.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as Record<string, unknown>;
      if (record.ifname !== topology.bridgeInterface || !Array.isArray(record.addr_info)) {
        return false;
      }
      return record.addr_info.some(
        (address) =>
          Boolean(address) &&
          typeof address === "object" &&
          (address as Record<string, unknown>).family === "inet" &&
          (address as Record<string, unknown>).local === topology.gatewayIp &&
          (address as Record<string, unknown>).prefixlen === topology.prefixLength,
      );
    });
  if (!matches) {
    throw remediationError(
      `bridge interface does not own ${topology.gatewayIp}/${topology.prefixLength}`,
      topology,
      port,
    );
  }
}

export function registerOpenShellHostMockFirewall(
  options: HostMockFirewallOptions,
): Promise<HostMockFirewallResult> {
  const networkName =
    options.networkName ?? process.env.OPENSHELL_DOCKER_NETWORK_NAME ?? DEFAULT_NETWORK_NAME;
  const waitForNetworkMs = options.waitForNetworkMs ?? DEFAULT_NETWORK_WAIT_MS;
  const authorized = options.authorized ?? process.env.NEMOCLAW_RUN_LIVE_E2E === "1";
  const platform = options.platform ?? process.platform;
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error(`host mock port must be an integer from 1 through 65535; got ${options.port}`);
  }
  if (!NETWORK_NAME_PATTERN.test(networkName)) {
    throw new Error(`OpenShell Docker network name is invalid: ${networkName}`);
  }
  if (!Number.isSafeInteger(waitForNetworkMs) || waitForNetworkMs <= 0) {
    throw new Error("host mock firewall network wait must be a positive safe integer");
  }

  let applyInFlight: Promise<ShellProbeResult> | undefined;
  let baselineRules: string | undefined;
  let closed = false;
  let mutationStarted = false;
  let topology: BridgeTopology | undefined;
  const rule = (): string[] => manualRule(topology!, options.port);

  options.cleanup.add(`restore UFW state after host mock port ${options.port}`, async () => {
    closed = true;
    try {
      await applyInFlight;
    } catch {
      // The state check below owns ambiguous or failed apply cleanup.
    }
    if (!mutationStarted || baselineRules === undefined || !topology) return;

    const current = await options.host.command(
      "sudo",
      ["-n", "ufw", "show", "added"],
      commandOptions("cleanup-host-mock-firewall-rules-before"),
    );
    if (current.exitCode !== 0) {
      throw new Error(
        `could not inspect UFW state during host mock cleanup (${commandFailure(current)})`,
      );
    }
    const currentSnapshot = normalizedRuleSnapshot(current.stdout);
    if (currentSnapshot === baselineRules) return;
    if (!snapshotContainsRule(current.stdout, rule())) {
      throw new Error("UFW state changed outside the host mock rule; cleanup did not modify it");
    }

    const deleted = await options.host.command(
      "sudo",
      ["-n", "ufw", "--force", "delete", ...rule()],
      commandOptions("cleanup-host-mock-firewall-delete"),
    );
    if (deleted.exitCode !== 0) {
      throw new Error(
        `could not delete the host mock UFW rule (${commandFailure(deleted)}); run: sudo ufw --force delete ${rule().join(" ")}`,
      );
    }
    const restored = await options.host.command(
      "sudo",
      ["-n", "ufw", "show", "added"],
      commandOptions("cleanup-host-mock-firewall-rules-after"),
    );
    if (restored.exitCode !== 0) {
      throw new Error(`could not verify restored UFW state (${commandFailure(restored)})`);
    }
    if (normalizedRuleSnapshot(restored.stdout) !== baselineRules) {
      throw new Error("host mock cleanup did not restore the original UFW rules");
    }
  });

  return (async () => {
    if (platform !== "linux") {
      return {
        bridgeInterface: "not-applicable",
        changed: false,
        gatewayIp: "not-applicable",
        manualCommand: "not-applicable",
        prefixLength: 0,
        reason: "platform_not_applicable",
        subnet: "not-applicable",
      };
    }

    const network = await waitForNetwork(options.host, networkName, waitForNetworkMs);
    if (network.exitCode !== 0) {
      throw new Error(
        `OpenShell Docker network ${networkName} did not become inspectable (${commandFailure(network)})`,
      );
    }
    topology = parseBridgeTopology(network.stdout);
    await verifyBridgeAddress(options.host, topology, options.port);
    const command = manualCommand(topology, options.port);
    if (!authorized) {
      throw remediationError(
        "automatic firewall remediation is not authorized",
        topology,
        options.port,
      );
    }
    if (closed) {
      throw new Error("host mock firewall setup was interrupted before UFW inspection");
    }

    const ufwAvailable = await options.host.isCommandAvailable(
      "ufw",
      commandOptions("host-mock-firewall-ufw-available"),
    );
    if (!ufwAvailable) {
      return { ...topology, changed: false, manualCommand: command, reason: "ufw_missing" };
    }
    const status = await options.host.command(
      "sudo",
      ["-n", "ufw", "status"],
      commandOptions("host-mock-firewall-status"),
    );
    if (status.exitCode !== 0) {
      throw remediationError(
        `UFW status is unavailable (${commandFailure(status)})`,
        topology,
        options.port,
      );
    }
    if (/^Status:\s*inactive\s*$/im.test(status.stdout)) {
      return { ...topology, changed: false, manualCommand: command, reason: "ufw_inactive" };
    }
    if (!/^Status:\s*active\s*$/im.test(status.stdout)) {
      throw remediationError(
        "UFW did not report active or inactive status",
        topology,
        options.port,
      );
    }

    const before = await options.host.command(
      "sudo",
      ["-n", "ufw", "show", "added"],
      commandOptions("host-mock-firewall-rules-before"),
    );
    if (before.exitCode !== 0) {
      throw remediationError(
        `could not capture the original UFW rules (${commandFailure(before)})`,
        topology,
        options.port,
      );
    }
    baselineRules = normalizedRuleSnapshot(before.stdout);
    if (snapshotContainsRule(before.stdout, rule())) {
      return { ...topology, changed: false, manualCommand: command, reason: "preexisting" };
    }

    if (closed) {
      throw new Error("host mock firewall setup was interrupted before applying the UFW rule");
    }
    mutationStarted = true;
    applyInFlight = options.host.command(
      "sudo",
      ["-n", "ufw", ...rule()],
      commandOptions("host-mock-firewall-apply"),
    );
    const applied = await applyInFlight;
    applyInFlight = undefined;
    if (closed) {
      throw new Error("host mock firewall setup was interrupted while applying the UFW rule");
    }
    if (applied.timedOut || applied.signal !== null || applied.exitCode === null) {
      throw remediationError(
        `UFW rule application was not confirmed (${commandFailure(applied)})`,
        topology,
        options.port,
      );
    }
    if (applied.exitCode !== 0) {
      throw remediationError(
        `UFW rejected the exact rule (${commandFailure(applied)})`,
        topology,
        options.port,
      );
    }
    if (/Skipping adding existing rule/i.test(`${applied.stdout}\n${applied.stderr}`)) {
      mutationStarted = false;
      return { ...topology, changed: false, manualCommand: command, reason: "preexisting" };
    }

    const after = await options.host.command(
      "sudo",
      ["-n", "ufw", "show", "added"],
      commandOptions("host-mock-firewall-rules-after"),
    );
    if (after.exitCode !== 0) {
      throw remediationError(
        `could not inspect UFW after rule application (${commandFailure(after)})`,
        topology,
        options.port,
      );
    }
    if (!snapshotContainsRule(after.stdout, rule())) {
      throw remediationError(
        "UFW inspection completed but the exact rule was absent",
        topology,
        options.port,
      );
    }
    return { ...topology, changed: true, manualCommand: command, reason: "applied" };
  })();
}
