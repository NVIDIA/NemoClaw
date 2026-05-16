// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ContainerRuntime = "colima" | "custom" | "docker-desktop" | "podman" | "unknown";

export function dockerHostRuntime(dockerHost: string | undefined): ContainerRuntime | null {
  if (!dockerHost) return null;
  if (
    dockerHost.includes("/.colima/default/docker.sock") ||
    dockerHost.includes("/.config/colima/default/docker.sock")
  ) {
    return "colima";
  }
  if (dockerHost.includes("/podman/machine/podman.sock") || dockerHost.includes("/podman/podman.sock")) {
    return "podman";
  }
  if (dockerHost.includes("/.docker/run/docker.sock")) return "docker-desktop";
  return "custom";
}

export function firstNonLoopbackNameserver(resolvConf: string): string | null {
  for (const line of resolvConf.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [kind, value] = trimmed.split(/\s+/);
    const isLoopback = value === "::1" || value === "localhost" || Boolean(value?.startsWith("127."));
    if (kind === "nameserver" && value && !isLoopback) return value;
  }
  return null;
}

export function resolveCoreDnsUpstream(input: {
  colimaVmResolvConf?: string;
  containerResolvConf: string;
  hostResolvConf: string;
  runtime: ContainerRuntime;
}): string | null {
  return (
    firstNonLoopbackNameserver(input.containerResolvConf) ??
    (input.runtime === "colima" && input.colimaVmResolvConf
      ? firstNonLoopbackNameserver(input.colimaVmResolvConf)
      : null) ??
    firstNonLoopbackNameserver(input.hostResolvConf)
  );
}

export function selectOpenshellClusterContainer(
  gatewayName: string | undefined,
  containersOutput: string,
): string | null {
  const containers = containersOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (containers.length === 0) return null;

  if (gatewayName) {
    const expectedName = gatewayName.startsWith("openshell-cluster-")
      ? gatewayName
      : `openshell-cluster-${gatewayName}`;
    const matches = containers.filter((container) => container === expectedName);
    return matches.length === 1 ? matches[0] : null;
  }

  return containers.length === 1 ? containers[0] : null;
}

export function isSafeDnsUpstream(value: string): boolean {
  return /^[a-zA-Z0-9.:_-]+$/.test(value);
}

export function buildCoreDnsCorefile(upstreamDns: string): string {
  return `.:53 {
    errors
    health
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
      pods insecure
      fallthrough in-addr.arpa ip6.arpa
    }
    hosts /etc/coredns/NodeHosts {
      ttl 60
      reload 15s
      fallthrough
    }
    prometheus :9153
    cache 30
    loop
    reload
    loadbalance
    forward . ${upstreamDns}
}
`;
}

export function buildCoreDnsPatchJson(upstreamDns: string): string {
  return JSON.stringify({ data: { Corefile: buildCoreDnsCorefile(upstreamDns) } });
}
