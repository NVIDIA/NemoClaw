// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertCompatibleDockerDaemonReachable,
  prepareContainerizedDockerDriverGatewayLaunch,
  shouldUseContainerizedGateway,
} from "./docker-driver-gateway-compat";

import {
  buildDockerDriverGatewayLaunch,
  buildDockerDriverGatewayRuntimeIdentity,
  prepareAndLogDockerDriverGatewayLaunch,
  resolveDriftGatewayBin,
} from "./docker-driver-gateway-launch";

const PINNED_COMPAT_IMAGE_OVERRIDE = `registry.example/nemoclaw/gateway-compat:0.0.72@sha256:${"a".repeat(
  64,
)}`;

function withTempBinaries<T>(
  fn: (paths: { dir: string; gatewayBin: string; sandboxBin: string }) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-compat-"));
  const gatewayBin = path.join(dir, "openshell-gateway");
  const sandboxBin = path.join(dir, "openshell-sandbox");
  try {
    fs.writeFileSync(gatewayBin, "GLIBC_2.39\n", { mode: 0o755 });
    fs.writeFileSync(sandboxBin, "#!/bin/sh\n", { mode: 0o755 });
    return fn({ dir, gatewayBin, sandboxBin });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("docker-driver-gateway compatibility container", () => {
  it("builds a Docker-hosted gateway launch that preserves Docker-driver env", () => {
    withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
      const stateDir = path.join(dir, "state");
      const dockerSocket = path.join(dir, "docker.sock");
      fs.mkdirSync(stateDir);
      fs.writeFileSync(dockerSocket, "");
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: {
          DOCKER_HOST: `unix://${dockerSocket}`,
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
        },
        gatewayEnv: {
          OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
          OPENSHELL_DRIVERS: "docker",
        },
      });

      expect(launch.mode).toBe("container");
      expect(launch.command).toBe("docker");
      expect(launch.processGatewayBin).toBeNull();
      expect(launch.args).toEqual(
        expect.arrayContaining([
          "run",
          "--rm",
          "--name",
          "nemoclaw-openshell-gateway",
          "--network",
          "host",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--volume",
          `${gatewayBin}:/opt/nemoclaw/openshell-gateway:ro`,
          "--volume",
          `${stateDir}:${stateDir}:rw`,
          "--volume",
          `${dir}:${dir}:ro`,
          "--volume",
          `${dockerSocket}:${dockerSocket}:ro`,
          "--env",
          "OPENSHELL_DRIVERS",
          "--env",
          "OPENSHELL_DOCKER_SUPERVISOR_BIN",
          "--env",
          "OPENSHELL_GATEWAY_CONFIG",
          "ubuntu:24.04@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54",
          "/opt/nemoclaw/openshell-gateway",
        ]),
      );
      expect(launch.args).not.toContain("ubuntu:24.04");
      expect(launch.args).not.toContain("--publish");
      expect(launch.args).not.toContain("-p");
      expect(launch.args).toContain(`${dockerSocket}:${dockerSocket}:ro`);
      expect(launch.args).not.toContain(`${dockerSocket}:${dockerSocket}:rw`);
      expect(launch.env.OPENSHELL_DOCKER_SUPERVISOR_BIN).toBe(sandboxBin);
      expect(launch.env.DOCKER_HOST).toBe(`unix://${dockerSocket}`);
      expect(launch.env.OPENSHELL_BIND_ADDRESS).toBe("127.0.0.1");
      const configPath = launch.env.OPENSHELL_GATEWAY_CONFIG;
      expect(configPath).toBe(path.join(stateDir, "openshell-gateway.toml"));
      expect(configPath).toBeDefined();
      const toml = fs.readFileSync(configPath as string, "utf-8");
      expect(toml).toContain(`supervisor_bin = "${sandboxBin}"`);
      expect(toml).toContain("disable_tls = false");
      expect(toml).toContain("[openshell.gateway.tls]");
      expect(toml).toContain(`cert_path = "${path.join(stateDir, "tls", "server", "tls.crt")}"`);
      expect(toml).toContain(`client_ca_path = "${path.join(stateDir, "tls", "ca.crt")}"`);
      expect(toml).toContain("[openshell.gateway.mtls_auth]");
      expect(toml).toContain("enabled = true");
      expect(toml).toContain("[openshell.gateway.gateway_jwt]");
      expect(toml).toContain(`signing_key_path = "${path.join(stateDir, "jwt", "signing.pem")}"`);
      expect(toml).toContain("[openshell.gateway.auth]");
      expect(toml).toContain("allow_unauthenticated_users = false");
      expect(toml).toContain(`guest_tls_ca = "${path.join(stateDir, "tls", "ca.crt")}"`);
      expect(toml).toContain(
        `guest_tls_cert = "${path.join(stateDir, "tls", "client", "tls.crt")}"`,
      );
      expect(launch.env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
      expect(launch.args).not.toContain("OPENSHELL_DISABLE_GATEWAY_AUTH");
      expect(fs.existsSync(path.join(stateDir, "jwt", "public.pem"))).toBe(true);
    });
  });

  it("rejects TCP DOCKER_HOST for the compatibility gateway", () => {
    expect(() => {
      withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
        const stateDir = path.join(dir, "state");
        fs.mkdirSync(stateDir);
        buildDockerDriverGatewayLaunch({
          gatewayBin,
          sandboxBin,
          stateDir,
          platform: "linux",
          env: {
            DOCKER_HOST: "tcp://attacker.example:2375",
            NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
          },
          gatewayEnv: {
            OPENSHELL_DRIVERS: "docker",
          },
        });
      });
    }).toThrow(/only absolute unix:\/\/ Docker sockets are supported/);
  });

  it("scrubs stale auth-disable env from compatibility gateway launches", () => {
    withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
      const stateDir = path.join(dir, "state");
      fs.mkdirSync(stateDir);
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: {
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
          OPENSHELL_DISABLE_GATEWAY_AUTH: "true",
        },
        gatewayEnv: {
          OPENSHELL_DRIVERS: "docker",
        },
      });

      expect(launch.mode).toBe("container");
      expect(launch.env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
      expect(launch.args).not.toContain("OPENSHELL_DISABLE_GATEWAY_AUTH");
    });
  });

  it("requires digest-pinned compatibility gateway image overrides", () => {
    withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
      const stateDir = path.join(dir, "state");
      fs.mkdirSync(stateDir);
      expect(() =>
        buildDockerDriverGatewayLaunch({
          gatewayBin,
          sandboxBin,
          stateDir,
          platform: "linux",
          env: {
            NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
            NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_IMAGE: "ubuntu:24.04",
          },
          gatewayEnv: {
            OPENSHELL_DRIVERS: "docker",
          },
        }),
      ).toThrow(/must include an immutable @sha256/);

      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: {
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
          NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_IMAGE: PINNED_COMPAT_IMAGE_OVERRIDE,
        },
        gatewayEnv: {
          OPENSHELL_DRIVERS: "docker",
        },
      });
      expect(launch.args).toContain(PINNED_COMPAT_IMAGE_OVERRIDE);
    });
  });

  it("warns about the trust boundary on the production compatibility launch path", () => {
    const messages: string[] = [];
    const warnings: string[] = [];
    prepareAndLogDockerDriverGatewayLaunch(
      {
        command: "docker",
        args: [],
        env: {
          OPENSHELL_BIND_ADDRESS: "127.0.0.1",
          OPENSHELL_GATEWAY_CONFIG: "/tmp/openshell-gateway.toml",
        },
        mode: "container",
        processGatewayBin: null,
        reason: "forced by test",
      },
      (message) => messages.push(message),
      (message) => warnings.push(message),
    );

    expect(messages).toContain(
      "  Compatibility gateway bind: 127.0.0.1 main listener plus OpenShell Docker-driver bridge reachability.",
    );
    expect(warnings).toEqual([
      "  SECURITY NOTICE: compatibility container uses host networking plus Docker API access; enabled only by NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH=1. Review/removal conditions: docs/security/openshell-0.0.72-compatibility-review.mdx#source-of-truth-boundaries.",
    ]);
    expect(messages).toContain(
      "  Gateway auth boundary: host-side OpenShell CLI uses local mTLS; sandbox callbacks use mTLS plus OpenShell gateway JWT.",
    );
  });

  it("fails within the bounded dockerForceRm timeout when Docker hangs", () => {
    const timeoutError = Object.assign(new Error("spawnSync docker ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const removeContainer = vi.fn(() => ({ error: timeoutError })) as unknown as NonNullable<
      Parameters<typeof prepareContainerizedDockerDriverGatewayLaunch>[1]
    >;
    const launch = {
      command: "docker",
      args: [],
      env: {},
      mode: "container" as const,
      processGatewayBin: null,
      containerName: "nemoclaw-openshell-gateway",
    };

    const verifyDockerDaemon = vi.fn();
    expect(() =>
      prepareContainerizedDockerDriverGatewayLaunch(launch, removeContainer, verifyDockerDaemon),
    ).toThrow(/Failed to remove prior OpenShell compatibility gateway container.*ETIMEDOUT/);
    expect(verifyDockerDaemon).toHaveBeenCalledWith(launch.env);
    expect(removeContainer).toHaveBeenCalledWith("nemoclaw-openshell-gateway", {
      ignoreError: true,
      suppressOutput: true,
      timeout: 30_000,
    });
  });

  it("fails closed when the configured Unix socket does not answer as a Docker daemon", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-daemon-probe-"));
    const socketPath = path.join(dir, "docker.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const probeError = Object.assign(new Error("spawnSync docker ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const probe = vi.fn(() => {
      throw probeError;
    }) as unknown as NonNullable<Parameters<typeof assertCompatibleDockerDaemonReachable>[1]>;

    try {
      expect(() =>
        assertCompatibleDockerDaemonReachable({ DOCKER_HOST: `unix://${socketPath}` }, probe),
      ).toThrow(/could not reach the Docker daemon.*within 5000ms.*ETIMEDOUT/);
      expect(probe).toHaveBeenCalledWith(
        "docker",
        ["--host", `unix://${socketPath}`, "version", "--format", "{{.Server.Version}}"],
        expect.objectContaining({ timeout: 5_000 }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects wildcard binds for the compatibility gateway", () => {
    expect(() => {
      withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
        const stateDir = path.join(dir, "state");
        fs.mkdirSync(stateDir);
        buildDockerDriverGatewayLaunch({
          gatewayBin,
          sandboxBin,
          stateDir,
          platform: "linux",
          env: {
            NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
            NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_BIND_ADDRESS: "0.0.0.0",
          },
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_DRIVERS: "docker",
          },
        });
      });
    }).toThrow(/only supports 127\.0\.0\.1/);
  });

  it("keeps the drift gateway binary null for the containerized compatibility gateway (#4520)", () => {
    withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
      const stateDir = path.join(dir, "state");
      fs.mkdirSync(stateDir);
      const identity = buildDockerDriverGatewayRuntimeIdentity({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1" },
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
      });

      expect(identity.launch?.mode).toBe("container");
      // The compat gateway parent process is `/usr/bin/docker`, not the host
      // binary, so the executable check must be skipped via a null drift bin.
      expect(identity.driftGatewayBin).toBeNull();
      // The identity bin still falls back to the host binary for listener PID
      // matching, where the cmdline contains the gateway path.
      expect(identity.identityGatewayBin).toBe(gatewayBin);

      // Callers must preserve that deliberate null rather than coalescing it
      // back to the host binary (the #4520 false-stale bug).
      expect(resolveDriftGatewayBin(identity, gatewayBin)).toBeNull();
      // `?? gatewayBin` would have wrongly restored the host path:
      expect(identity.driftGatewayBin ?? gatewayBin).toBe(gatewayBin);
    });
  });

  it("throws with opt-in guidance when host glibc is older than gateway requirement (#4760)", () => {
    expect(() =>
      shouldUseContainerizedGateway({
        gatewayBin: "/does-not-exist",
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.17",
        requiredGlibcVersions: ["2.28"],
      }),
    ).toThrow(/NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH=1/);
  });
});
