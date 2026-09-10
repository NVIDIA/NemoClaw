// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

import { isOperatorTrustablePrivateIp } from "../../../src/lib/security/trusted-private-endpoint.ts";
import type { HostCliClient } from "./clients/host.ts";
import { RuntimeProviderPrerequisite } from "./runtime-provider.ts";

const RELAY_PORT = 8443;
const RELAY_SOURCE = String.raw`
const net = require("node:net");
const [host, portText] = process.argv.slice(1);
const port = Number(portText);
const server = net.createServer((client) => {
  const upstream = net.connect({ host, port });
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close);
  upstream.on("error", close);
});
server.listen(${String(RELAY_PORT)}, "0.0.0.0");
`;

export interface RoutedPrivateRelay {
  readonly address: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startRoutedPrivateRelay(options: {
  host: HostCliClient;
  sandboxName: string;
  upstreamHost: string;
  upstreamPort: number;
}): Promise<RoutedPrivateRelay> {
  const runtime = new RuntimeProviderPrerequisite(options.host, (reason) => {
    throw new Error(reason);
  });
  const sandboxHandle = await runtime.resolveSandboxResourceHandle(options.sandboxName, {
    artifactName: "routed-private-relay-sandbox-resource",
    timeoutMs: 30_000,
  });
  const networks = await runtime.command(
    ["container", "inspect", "--format", "{{json .NetworkSettings.Networks}}", sandboxHandle],
    { artifactName: "routed-private-relay-sandbox-network", timeoutMs: 30_000 },
  );
  assert.equal(networks.exitCode, 0, `${networks.stdout}\n${networks.stderr}`);
  const networkNames = Object.keys(JSON.parse(networks.stdout) as Record<string, unknown>);
  assert.equal(networkNames.length, 1, "sandbox must have one exact runtime network");
  const networkName = networkNames[0] as string;
  const relayName = `nemoclaw-private-relay-${process.pid}-${randomBytes(4).toString("hex")}`;
  const close = async (): Promise<void> => {
    await runtime.command(["container", "rm", "--force", relayName], {
      artifactName: "cleanup-routed-private-relay",
      timeoutMs: 60_000,
    });
  };
  const start = await runtime.command(
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      relayName,
      "--network",
      networkName,
      "node:22-bookworm-slim",
      "node",
      "-e",
      RELAY_SOURCE,
      options.upstreamHost,
      String(options.upstreamPort),
    ],
    { artifactName: "start-routed-private-relay", timeoutMs: 120_000 },
  );
  assert.equal(start.exitCode, 0, `${start.stdout}\n${start.stderr}`);
  const addressResult = await runtime.command(
    [
      "container",
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      relayName,
    ],
    { artifactName: "inspect-routed-private-relay-address", timeoutMs: 30_000 },
  );
  assert.equal(addressResult.exitCode, 0, `${addressResult.stdout}\n${addressResult.stderr}`);
  const address = addressResult.stdout.trim();
  assert.equal(isIP(address), 4, "routed-private relay must have one IPv4 address");
  assert.equal(
    isOperatorTrustablePrivateIp(address),
    true,
    "routed-private relay must use an operator-trustable private network",
  );
  return Object.freeze({ address, port: RELAY_PORT, close });
}
