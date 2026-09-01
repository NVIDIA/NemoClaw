// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { FakeDockerApi, FakeDockerApiKind } from "./messaging-providers-helpers.ts";

type DockerPortBinding = {
  HostIp?: unknown;
  HostPort?: unknown;
};

type DockerInspectRecord = {
  Config?: {
    Env?: unknown;
  };
  Name?: unknown;
  HostConfig?: {
    CapDrop?: unknown;
    PidsLimit?: unknown;
    ReadonlyRootfs?: unknown;
    SecurityOpt?: unknown;
  };
  NetworkSettings?: {
    Networks?: unknown;
    Ports?: unknown;
  };
};

function parseRecordArray(
  stdout: string,
  label: string,
  expectedLength: number,
): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => entry === null || typeof entry !== "object")
  ) {
    throw new Error(`${label} did not return an object array`);
  }
  expect(parsed, label).toHaveLength(expectedLength);
  return parsed as Record<string, unknown>[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function selectFixtureContainerNames(names: string[], prefix: string): [string, string] {
  const escapedPrefix = escapeRegExp(prefix);
  const suffix = `${String(process.pid)}-[0-9a-f]{8}`;
  const apiPattern = new RegExp(`^${escapedPrefix}-${suffix}$`, "u");
  const proxyPattern = new RegExp(`^${escapedPrefix}-proxy-${suffix}$`, "u");
  const apiNames = names.filter((name) => apiPattern.test(name));
  const proxyNames = names.filter((name) => proxyPattern.test(name));
  expect(apiNames, "exactly one live credential-bearing fake API container").toHaveLength(1);
  expect(proxyNames, "exactly one live fake API proxy container").toHaveLength(1);
  return [apiNames[0]!, proxyNames[0]!];
}

function inspectRecord(records: DockerInspectRecord[], name: string): DockerInspectRecord {
  const record = records.find((entry) => entry.Name === `/${name}`);
  expect(record, `Docker inspect record for ${name}`).toBeDefined();
  return record!;
}

function networkNames(record: DockerInspectRecord): string[] {
  const networks = record.NetworkSettings?.Networks;
  return networks !== null && typeof networks === "object" ? Object.keys(networks).sort() : [];
}

function portBindings(record: DockerInspectRecord): Record<string, DockerPortBinding[] | null> {
  const ports = record.NetworkSettings?.Ports;
  return ports !== null && typeof ports === "object"
    ? (ports as Record<string, DockerPortBinding[] | null>)
    : {};
}

const CREDENTIAL_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_?KEY|CREDENTIALS?|PASSWORDS?|SECRETS?|TOKENS?)(?:_|$)/u;

function environmentEntries(record: DockerInspectRecord): string[] {
  const entries = record.Config?.Env;
  expect(
    Array.isArray(entries) && entries.every((entry) => typeof entry === "string"),
    "fake API proxy environment inspection",
  ).toBe(true);
  return entries as string[];
}

function environmentName(entry: string): string {
  return entry.split("=", 1)[0]!;
}

function publishedBinding(
  bindings: Record<string, DockerPortBinding[] | null>,
  containerPort: number,
): DockerPortBinding {
  const published = bindings[`${String(containerPort)}/tcp`];
  expect(published, `published binding for container port ${String(containerPort)}`).toHaveLength(
    1,
  );
  return published![0]!;
}

export async function assertFakeApiDockerTopologyProof(options: {
  host: HostCliClient;
  kind: FakeDockerApiKind;
  containerPrefix: string;
  api: FakeDockerApi;
  env: NodeJS.ProcessEnv;
  redactionValues: string[];
}): Promise<void> {
  const commandOptions = {
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 30_000,
  };
  const containerList = await options.host.command("docker", ["ps", "--format", "{{.Names}}"], {
    ...commandOptions,
    artifactName: `prove-fake-${options.kind}-container-names`,
  });
  assertExitZero(containerList, `list fake ${options.kind} API containers`);
  const [apiContainer, proxyContainer] = selectFixtureContainerNames(
    containerList.stdout.split(/\r?\n/u).filter(Boolean),
    options.containerPrefix,
  );

  const inspect = await options.host.command("docker", ["inspect", apiContainer, proxyContainer], {
    ...commandOptions,
    artifactName: `prove-fake-${options.kind}-docker-inspect`,
  });
  assertExitZero(inspect, `inspect fake ${options.kind} API topology`);
  const records = parseRecordArray(inspect.stdout, "fake API Docker inspection", 2);
  const apiRecord = inspectRecord(records, apiContainer);
  const proxyRecord = inspectRecord(records, proxyContainer);
  const proxyEnvironment = environmentEntries(proxyRecord);
  expect(
    proxyEnvironment.some((entry) => CREDENTIAL_ENVIRONMENT_NAME.test(environmentName(entry))),
    "fake API proxy credential environment names",
  ).toBe(false);
  expect(
    proxyEnvironment.some((entry) =>
      options.redactionValues.some((value) => value.length > 0 && entry.includes(value)),
    ),
    "fake API proxy redaction values",
  ).toBe(false);
  const apiNetworks = networkNames(apiRecord);
  expect(apiNetworks, "credential-bearing fake API network attachments").toHaveLength(1);
  const internalNetwork = apiNetworks[0]!;
  expect(networkNames(proxyRecord), "fake API proxy network attachments").toEqual(
    ["bridge", internalNetwork].sort(),
  );
  expect(
    Object.values(portBindings(apiRecord)).flatMap((binding) => binding ?? []),
    "credential-bearing fake API published ports",
  ).toHaveLength(0);

  const internalNetworkInspect = await options.host.command(
    "docker",
    ["network", "inspect", internalNetwork],
    { ...commandOptions, artifactName: `prove-fake-${options.kind}-internal-network` },
  );
  assertExitZero(internalNetworkInspect, `inspect fake ${options.kind} API internal network`);
  const [internalNetworkRecord] = parseRecordArray(
    internalNetworkInspect.stdout,
    "fake API internal network inspection",
    1,
  );
  expect(internalNetworkRecord?.Driver, "fake API network driver").toBe("bridge");
  expect(internalNetworkRecord?.Internal, "fake API network isolation").toBe(true);

  const openshellNetwork =
    options.env.OPENSHELL_DOCKER_NETWORK_NAME ??
    process.env.OPENSHELL_DOCKER_NETWORK_NAME ??
    "openshell-docker";
  const openshellNetworkInspect = await options.host.command(
    "docker",
    ["network", "inspect", openshellNetwork],
    { ...commandOptions, artifactName: `prove-fake-${options.kind}-openshell-network` },
  );
  assertExitZero(openshellNetworkInspect, "inspect OpenShell Docker network for topology proof");
  const [openshellNetworkRecord] = parseRecordArray(
    openshellNetworkInspect.stdout,
    "OpenShell Docker network inspection",
    1,
  );
  const ipam = openshellNetworkRecord?.IPAM as
    | { Config?: Array<{ Gateway?: unknown }> }
    | undefined;
  const bridgeGateways =
    ipam?.Config?.flatMap((entry) =>
      typeof entry.Gateway === "string" && /^\d+\.\d+\.\d+\.\d+$/u.test(entry.Gateway)
        ? [entry.Gateway]
        : [],
    ) ?? [];
  expect(openshellNetworkRecord?.Driver, "OpenShell Docker network driver").toBe("bridge");
  expect(bridgeGateways, "one OpenShell IPv4 bridge gateway").toHaveLength(1);

  const expectedContainerPorts = [8079, 8080, ...(options.kind === "slack" ? [8081] : [])];
  const proxyBindings = portBindings(proxyRecord);
  expect(Object.keys(proxyBindings).sort(), "fake API proxy published container ports").toEqual(
    expectedContainerPorts.map((port) => `${String(port)}/tcp`).sort(),
  );
  const observedHostPorts = expectedContainerPorts.map((containerPort) => {
    const binding = publishedBinding(proxyBindings, containerPort);
    expect(binding.HostIp, `host address for proxy port ${String(containerPort)}`).toBe(
      bridgeGateways[0],
    );
    expect(binding.HostPort, `host port for proxy port ${String(containerPort)}`).toMatch(
      /^[1-9]\d*$/u,
    );
    return String(binding.HostPort);
  });
  expect(new Set(observedHostPorts).size, "distinct fake API proxy host ports").toBe(
    expectedContainerPorts.length,
  );
  expect(options.api.port, "returned fake API REST port").toBe(observedHostPorts[1]);
  if (options.kind === "slack") {
    expect(options.api.alternatePort, "returned fake Slack websocket port").toBe(
      observedHostPorts[2],
    );
  }

  expect(proxyRecord.HostConfig?.ReadonlyRootfs, "fake API proxy read-only root").toBe(true);
  expect(proxyRecord.HostConfig?.CapDrop, "fake API proxy capability drops").toContain("ALL");
  expect(proxyRecord.HostConfig?.SecurityOpt, "fake API proxy security options").toContain(
    "no-new-privileges",
  );
  expect(proxyRecord.HostConfig?.PidsLimit, "fake API proxy PID limit").toBe(32);
}
