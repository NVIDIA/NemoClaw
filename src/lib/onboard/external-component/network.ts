// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIPv4, isIPv6 } from "node:net";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { captureOpenshellCommandAsyncResult } from "../../adapters/openshell/async-capture";
import { buildOpenShellSubprocessEnv } from "../../adapters/openshell/resolve-shared";
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

/** Inspect the full object so malformed or multiple networks cannot become a selected first address. */
export function inspectExternalComponentNetwork(
  name: string,
  runtime: RuntimeProviderGatewayHostRuntime,
): Network {
  try {
    if (runtime.openShellDriver !== "docker" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/u.test(name))
      throw restricted();
    const result = runtime.network.run(["network", "inspect", name], 10_000);
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

/** OpenShell alone creates the network. The returned guard detects replacement before startup. */
export async function prepareExternalComponentNetwork(
  env: Record<string, string>,
  gatewayBin: string | null,
  runtime: RuntimeProviderGatewayHostRuntime,
): Promise<() => void> {
  try {
    const name = env.OPENSHELL_DOCKER_NETWORK_NAME;
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/u.test(name)) throw restricted();
    if (runtime.openShellDriver !== "docker") throw restricted();
    // A successful listing distinguishes absence from inspection failure without parsing diagnostics.
    const listed = runtime.network.run(
      ["network", "ls", "--filter", `name=${name}`, "--format", "{{.Name}}"],
      10_000,
    );
    if (listed.status !== 0 || listed.error || listed.signal || listed.timedOut) throw restricted();
    const matches = String(listed.stdout)
      .split(/\r?\n/u)
      .filter((entry) => entry === name);
    if (matches.length > 1) throw restricted();
    if (matches.length === 1) {
      const expected = inspectExternalComponentNetwork(name, runtime);
      return () => {
        if (!isDeepStrictEqual(inspectExternalComponentNetwork(name, runtime), expected))
          throw restricted();
      };
    }
    if (!gatewayBin || !path.isAbsolute(gatewayBin)) throw restricted();
    const args = ["prepare-docker-network", "--network-name", name];
    if (runtime.socketPath) args.push("--socket-path", runtime.socketPath);
    const environment = buildOpenShellSubprocessEnv();
    // Socket detection must use the same runtime directory as ordinary gateway startup.
    if (process.env.XDG_RUNTIME_DIR) environment.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
    const result = await captureOpenshellCommandAsyncResult(gatewayBin, args, {
      environment,
      timeoutMilliseconds: 35_000,
      timeoutKillSignal: "SIGKILL",
      outputLimitBytes: 16 * 1024,
    });
    if (result.status !== 0 || result.error || result.signal || result.timedOut) throw restricted();
    const value = parseStrictExternalComponentJson(result.stdout) as Network;
    if (!value || Object.keys(value).sort().join(",") !== "gatewayIp,id,name,subnet")
      throw restricted();
    const expected = {
      ...networkIdentity(value.id, value.name, name),
      ...validateAddress(value.gatewayIp, value.subnet),
    };
    const revalidate = () => {
      if (!isDeepStrictEqual(inspectExternalComponentNetwork(name, runtime), expected))
        throw restricted();
    };
    revalidate();
    return revalidate;
  } catch {
    throw new ExternalComponentContractError("preparation_failed");
  }
}
