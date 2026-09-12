// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIPv4, isIPv6 } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { isSupportedGatewayDockerHost } from "../../domain/docker-host";
import type { RuntimeProviderGatewayHostRuntime } from "../runtime-provider/contract";
import { ExternalComponentContractError, parseStrictExternalComponentJson } from "./index";

type Network = { id: string; name: string; gatewayIp: string; subnet: string };
const restricted = () => new ExternalComponentContractError("endpoint_restricted");
const ipv4Number = (value: string) =>
  value.split(".").reduce((result, octet) => result * 256 + Number(octet), 0);
const privateIp = (value: string) =>
  /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(value);

function validateAddress(
  gatewayIp: unknown,
  subnet: unknown,
): { gatewayIp: string; subnet: string } {
  if (
    typeof gatewayIp !== "string" ||
    !isIPv4(gatewayIp) ||
    !privateIp(gatewayIp) ||
    typeof subnet !== "string"
  )
    throw restricted();
  const [base, prefix, extra] = subnet.split("/");
  if (
    !base ||
    !isIPv4(base) ||
    !privateIp(base) ||
    !prefix ||
    !/^(?:[89]|[12]\d|30)$/u.test(prefix) ||
    extra !== undefined
  )
    throw restricted();
  const size = 2 ** (32 - Number(prefix));
  const start = ipv4Number(base);
  const ip = ipv4Number(gatewayIp);
  const last = start + size - 1;
  const lastIp = [24, 16, 8, 0].map((shift) => (last >>> shift) & 255).join(".");
  if (start % size !== 0 || ip <= start || ip >= last || !privateIp(lastIp)) throw restricted();
  return { gatewayIp, subnet };
}

function networkIdentity(id: unknown, name: unknown, expectedName: string) {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id) || name !== expectedName)
    throw restricted();
  return { id, name: expectedName };
}

const commandOptions = { maxOutputBytes: 16 * 1024 };

/** Resolve Docker's selected connection before using it in both adapters and gateway configuration. */
export function externalComponentDockerSocket(runtime: RuntimeProviderGatewayHostRuntime): string {
  if (runtime.openShellDriver !== "docker") throw restricted();
  let host = process.env.DOCKER_HOST;
  if (!host) {
    const result = runtime.network.run(
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      10_000,
      commandOptions,
    );
    if (result.status !== 0 || result.error || result.signal || result.timedOut) throw restricted();
    host = String(result.stdout).replace(/\r?\n$/u, "");
  }
  if (!host || !host.startsWith("unix://") || !isSupportedGatewayDockerHost(host))
    throw restricted();
  const socket = host.slice("unix://".length);
  if (runtime.socketPath !== null && runtime.socketPath !== socket) throw restricted();
  return socket;
}

function runNetworkCommand(
  runtime: RuntimeProviderGatewayHostRuntime,
  socket: string,
  args: readonly string[],
  timeoutMs = 10_000,
) {
  return runtime.network.run(args, timeoutMs, {
    ...commandOptions,
    environment: { DOCKER_HOST: `unix://${socket}` },
  });
}

/** Inspect the full object so malformed or multiple networks cannot become a selected first address. */
export function inspectExternalComponentNetwork(
  name: string,
  runtime: RuntimeProviderGatewayHostRuntime,
): Network {
  return inspectNetwork(name, runtime, externalComponentDockerSocket(runtime));
}

function inspectNetwork(
  name: string,
  runtime: RuntimeProviderGatewayHostRuntime,
  socket: string,
): Network {
  try {
    if (runtime.openShellDriver !== "docker" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/u.test(name))
      throw restricted();
    const result = runNetworkCommand(runtime, socket, ["network", "inspect", name]);
    if (result.status !== 0 || result.error || result.signal || result.timedOut) throw restricted();
    const values = parseStrictExternalComponentJson(String(result.stdout));
    if (!Array.isArray(values) || values.length !== 1) throw restricted();
    const network = values[0];
    if (
      !network ||
      network.Driver !== "bridge" ||
      network.Scope !== "local" ||
      network.Internal !== false ||
      network.Ingress === true ||
      !Array.isArray(network.IPAM?.Config)
    )
      throw restricted();
    const identity = networkIdentity(network.Id, network.Name, name);
    const addresses: { gatewayIp: string; subnet: string }[] = [];
    for (const entry of network.IPAM.Config) {
      if (!entry || typeof entry.Subnet !== "string" || typeof entry.Gateway !== "string")
        throw restricted();
      const [base, prefix, extra] = entry.Subnet.split("/");
      if (
        base &&
        isIPv6(base) &&
        isIPv6(entry.Gateway) &&
        /^(?:0|[1-9]\d*)$/u.test(prefix ?? "") &&
        Number(prefix) <= 128 &&
        extra === undefined
      )
        continue;
      addresses.push(validateAddress(entry.Gateway, entry.Subnet));
    }
    if (addresses.length !== 1) throw restricted();
    return { ...identity, ...addresses[0]! };
  } catch {
    throw restricted();
  }
}

/** Provision at most once. Preserve the network after every failure. */
export async function prepareExternalComponentNetwork(
  env: Record<string, string>,
  runtime: RuntimeProviderGatewayHostRuntime,
): Promise<() => void> {
  try {
    const name = env.OPENSHELL_DOCKER_NETWORK_NAME;
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/u.test(name)) throw restricted();
    const socket = externalComponentDockerSocket(runtime);
    // Docker diagnostics do not establish absence. Require a successful, complete listing.
    const listed = runNetworkCommand(runtime, socket, [
      "network",
      "ls",
      "--filter",
      `name=^${name.replace(/[.]/gu, "\\.")}$`,
      "--format",
      "{{.Name}}",
    ]);
    if (listed.status !== 0 || listed.error || listed.signal || listed.timedOut) throw restricted();
    const names = String(listed.stdout).split(/\r?\n/u).filter(Boolean);
    if (names.length > 1 || names.some((entry) => entry !== name)) throw restricted();
    let createdId: string | undefined;
    if (names.length === 0) {
      let created;
      try {
        created = runNetworkCommand(
          runtime,
          socket,
          ["network", "create", "--driver", "bridge", "--attachable", name],
          30_000,
        );
      } catch {
        // A transport exception can follow a daemon-side creation. Inspect the retained state.
      }
      // Reconcile a race or uncertain result by inspection; never repeat the mutation.
      if (
        created &&
        created.status === 0 &&
        !created.error &&
        !created.signal &&
        !created.timedOut
      ) {
        createdId = String(created.stdout).trim();
      }
    }
    const expected = inspectNetwork(name, runtime, socket);
    if (createdId !== undefined && createdId !== expected.id) throw restricted();
    return () => {
      if (
        externalComponentDockerSocket(runtime) !== socket ||
        env.OPENSHELL_DOCKER_NETWORK_NAME !== name ||
        !isDeepStrictEqual(inspectNetwork(name, runtime, socket), expected)
      )
        throw restricted();
    };
  } catch {
    throw new ExternalComponentContractError("preparation_failed");
  }
}
