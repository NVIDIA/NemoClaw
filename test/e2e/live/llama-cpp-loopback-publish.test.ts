// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";

import { observeConfiguredGatewayHostRuntime } from "../../../src/lib/onboard/docker-driver-gateway-env.ts";
import { probeHostServiceSandboxReachability } from "../../../src/lib/onboard/host-service-reachability.ts";
import { expect, test } from "../fixtures/e2e-test.ts";

const PROBE_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";

function docker(args: readonly string[], timeoutMs = 60_000) {
  return spawnSync("docker", [...args], { encoding: "utf8", timeout: timeoutMs });
}

function requireDockerOk(result: ReturnType<typeof docker>, label: string): string {
  const output = result.stdout.trim();
  const detail = result.error?.message ?? (result.stderr.trim() || output);
  const errors = result.status === 0 ? [] : [new Error(`${label} failed: ${detail}`)];
  errors.forEach((error) => {
    throw error;
  });
  return output;
}

test(
  "host loopback succeeds while a loopback-only Docker publish fails the sandbox hop (#11626)",
  {
    timeout: 120_000,
    meta: {
      e2ePhases: [
        "require Docker",
        "create a bridge network and loopback-only listener",
        "prove host loopback and sandbox TCP failure",
      ],
    },
  },
  async ({ cleanup, docker: dockerPrerequisite, progress }) => {
    progress.phase("require Docker");
    await dockerPrerequisite.requireDocker();

    progress.phase("create a bridge network and loopback-only listener");
    const suffix = randomBytes(4).toString("hex");
    const networkName = `nmc-11626-${suffix}`;
    const containerName = `nmc-11626-loopback-${suffix}`;
    cleanup.add(`remove ${containerName}`, () => {
      docker(["rm", "-f", containerName]);
    });
    cleanup.add(`remove ${networkName}`, () => {
      docker(["network", "rm", "-f", networkName]);
    });
    requireDockerOk(
      docker(["network", "create", "--driver", "bridge", networkName]),
      "network create",
    );
    const gatewayIp = requireDockerOk(
      docker(["network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", networkName]),
      "network gateway",
    );
    const subnet = requireDockerOk(
      docker(["network", "inspect", "-f", "{{(index .IPAM.Config 0).Subnet}}", networkName]),
      "network subnet",
    );
    expect(gatewayIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);

    requireDockerOk(docker(["pull", PROBE_IMAGE], 120_000), "pull probe image");
    requireDockerOk(
      docker([
        "run",
        "-d",
        "--name",
        containerName,
        "--network",
        networkName,
        "--pull=missing",
        "-p",
        "127.0.0.1::8081",
        PROBE_IMAGE,
        "httpd",
        "-f",
        "-p",
        "8081",
      ]),
      "loopback-only publish",
    );
    const published = requireDockerOk(docker(["port", containerName, "8081"]), "published port");
    const hostPort = Number(published.split(":").at(-1));
    expect(Number.isInteger(hostPort)).toBe(true);

    progress.phase("prove host loopback and sandbox TCP failure");
    const hostReach = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: hostPort });
      socket.setTimeout(3_000);
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
    expect(hostReach).toBe(true);

    const observed = observeConfiguredGatewayHostRuntime({
      environment: { ...process.env, NEMOCLAW_GATEWAY_RUNTIME: "docker" },
      platform: "linux",
    });
    const sandboxReach = await probeHostServiceSandboxReachability({
      port: hostPort,
      networkName,
      gatewayRuntime: {
        ...observed,
        sandboxHostAddress: null,
        usesHostGatewayRoute: false,
        network: {
          ...observed.network,
          usesHostGatewayRoute: () => false,
        },
      },
      inspectNetworkImpl: () => ({ subnet, gatewayIp }),
      usesHostGatewayRouteImpl: () => false,
      runImpl: (args, timeoutMs) => {
        const result = docker(args, timeoutMs);
        return {
          status: result.status,
          stderr: result.stderr,
          error: result.error?.message,
        };
      },
    });
    expect(sandboxReach.ok).toBe(false);
    expect(sandboxReach.reason).toBe("tcp_failed");
  },
);
