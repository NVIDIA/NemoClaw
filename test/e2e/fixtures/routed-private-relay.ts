// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isOperatorTrustablePrivateIp } from "../../../src/lib/security/trusted-private-endpoint.ts";
import { assertExitZero } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import { RuntimeProviderPrerequisite } from "./runtime-provider.ts";

const RELAY_PORT = 8443;
const SUMMARY_PATH = "/tmp/nemoclaw-private-relay-summary.json";
const DIAGNOSTIC_SCHEMA = String.raw`
const fs = require("node:fs");
const counters = ["listening", "incoming", "upstreamConnected", "clientErrors", "upstreamErrors", "serverErrors"];
const codes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "EACCES", "EADDRINUSE", "OTHER"];
const limit = 65535;
`;

// This process records categories only, never Error text or forwarded bytes.
export const ROUTED_PRIVATE_RELAY_SOURCE =
  DIAGNOSTIC_SCHEMA +
  String.raw`
const net = require("node:net");
const [host, portText, listenPortText, summaryPath] = process.argv.slice(1);
const port = Number(portText);
const summary = Object.fromEntries(counters.map(key => [key, 0]));
summary.errors = Object.fromEntries(codes.map(key => [key, 0]));
function persist() {
  try {
    fs.writeFileSync(summaryPath + ".next", JSON.stringify(summary), { mode: 0o600 });
    fs.renameSync(summaryPath + ".next", summaryPath);
  } catch { /* Diagnostics must not change relay behavior. */ }
}
function count(key) { summary[key] = Math.min(limit, summary[key] + 1); persist(); }
function error(key, err) {
  const code = codes.includes(err.code) ? err.code : "OTHER";
  summary.errors[code] = Math.min(limit, summary.errors[code] + 1);
  count(key);
}
persist();
const server = net.createServer((client) => {
  count("incoming");
  const upstream = net.connect({ host, port });
  upstream.on("connect", () => count("upstreamConnected"));
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", err => { error("clientErrors", err); close(); });
  upstream.on("error", err => { error("upstreamErrors", err); close(); });
});
server.on("error", err => { error("serverErrors", err); process.exitCode = 1; });
server.listen(Number(listenPortText), "0.0.0.0", () => count("listening"));
`;

// Reconstruct the bounded schema instead of persisting arbitrary container logs.
export const ROUTED_PRIVATE_RELAY_SNAPSHOT_SOURCE =
  DIAGNOSTIC_SCHEMA +
  String.raw`
try {
  const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let raw;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error("invalid file");
    const buffer = Buffer.alloc(4097);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 4096) throw new Error("oversized");
    raw = JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { fs.closeSync(fd); }
  const bounded = value => {
    if (!Number.isInteger(value) || value < 0 || value > limit) throw new Error("invalid counter");
    return value;
  };
  const summary = Object.fromEntries(counters.map(key => [key, bounded(raw[key])]));
  summary.errors = Object.fromEntries(codes.map(key => [key, bounded(raw.errors?.[key])]));
  process.stdout.write(JSON.stringify({ available: true, ...summary }) + "\n");
} catch { process.stdout.write('{"available":false}\n'); }
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
  const snapshot = async (phase: string): Promise<void> => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nemoclaw-relay-snapshot-")).catch(
      () => null,
    );
    if (directory === null) return;
    try {
      const summary = path.join(directory, "summary.json");
      // cp supports stopped containers. Do not follow links or stream raw contents
      // into artifacts; only the existing bounded schema reader may publish them.
      const copied = await runtime.command(
        ["container", "cp", `${relayName}:${SUMMARY_PATH}`, summary],
        { artifactName: `routed-private-relay-${phase}-copy`, timeoutMs: 10_000 },
      );
      if (copied.exitCode === 0) {
        await options.host.command(
          process.execPath,
          ["-e", ROUTED_PRIVATE_RELAY_SNAPSHOT_SOURCE, summary],
          { artifactName: `routed-private-relay-${phase}-diagnostics`, timeoutMs: 10_000 },
        );
      }
    } catch {
      // Best-effort evidence must never prevent resource removal or mask a test failure.
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const close = async (): Promise<void> => {
    try {
      await snapshot("final");
    } finally {
      const removal = await runtime.command(["container", "rm", "--force", relayName], {
        artifactName: "cleanup-routed-private-relay",
        timeoutMs: 60_000,
      });
      assertExitZero(removal, "remove owned routed-private relay");
    }
  };
  try {
    const start = await runtime.command(
      [
        "run",
        "--detach",
        "--name",
        relayName,
        "--network",
        networkName,
        "node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9",
        "node",
        "-e",
        ROUTED_PRIVATE_RELAY_SOURCE,
        options.upstreamHost,
        String(options.upstreamPort),
        String(RELAY_PORT),
        SUMMARY_PATH,
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
    await snapshot("startup");
    return Object.freeze({ address, port: RELAY_PORT, close });
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Relay startup and owned cleanup failed");
    }
    throw error;
  }
}
