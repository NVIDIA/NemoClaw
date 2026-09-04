// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { writeOpenShell0044PreAuthState } from "../../../test/support/openshell-gateway-config-helpers";
import {
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "./docker-driver-gateway-config";
import {
  buildDockerDriverGatewayConfigToml,
  buildDockerDriverGatewayLaunch,
  buildDockerDriverGatewayRuntimeIdentity,
  openDockerDriverGatewayLog,
  parseGlibcVersionsFromBinaryText,
  resolveDriftGatewayBin,
  shouldUseContainerizedGateway,
} from "./docker-driver-gateway-launch";
import * as dockerDriverGatewayLocalTls from "./docker-driver-gateway-local-tls";
import { PORTABLE_HOST_GATEWAY_IP } from "./experimental/portable-profile";
import { gatewayProcessCmdlineMatches } from "./gateway-process-identity";

function withTempBinaries<T>(
  fn: (paths: { dir: string; gatewayBin: string; sandboxBin: string }) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-launch-"));
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

describe("docker-driver-gateway-launch", () => {
  it("records the current-launch offset before appending gateway output (#8797)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-log-"));
    const logPath = path.join(dir, "openshell-gateway.log");
    const previousLog = "previous gateway launch\n";
    fs.writeFileSync(logPath, previousLog);
    try {
      const gatewayLog = openDockerDriverGatewayLog(logPath);
      expect(gatewayLog.startOffset).toBe(Buffer.byteLength(previousLog));
      fs.closeSync(gatewayLog.fd);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts GLIBC versions from binary text", () => {
    expect(parseGlibcVersionsFromBinaryText("GLIBC_2.35\0GLIBC_2.39\0GLIBC_2.39")).toEqual([
      "2.35",
      "2.39",
    ]);
  });

  it("requires explicit opt-in before selecting the containerized gateway", () => {
    expect(() =>
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.35",
        requiredGlibcVersions: ["2.38", "2.39"],
      }),
    ).toThrow(/requires explicit opt-in/);
    expect(
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "linux",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1" },
        hostGlibcVersion: "2.35",
        requiredGlibcVersions: ["2.38", "2.39"],
      }),
    ).toMatchObject({ useContainer: true });
    expect(
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.39",
        requiredGlibcVersions: ["2.38", "2.39"],
      }),
    ).toEqual({ useContainer: false });
    expect(
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "darwin",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1" },
        hostGlibcVersion: "2.35",
        requiredGlibcVersions: ["2.39"],
      }),
    ).toEqual({ useContainer: false });
    expect(
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "linux",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "0" },
        hostGlibcVersion: "2.35",
        requiredGlibcVersions: ["2.39"],
      }),
    ).toEqual({ useContainer: false });
  });

  it("writes Docker driver settings in gateway TOML because OpenShell driver config is not env-backed", () => {
    const toml = buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
        OPENSHELL_LOCAL_TLS_DIR: "/tmp/openshell-tls",
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "ghcr.io/nvidia/openshell/supervisor:0.0.44",
      },
      "/home/shadeform/.local/bin/openshell-sandbox",
    );

    expect(toml).toContain('compute_drivers = ["docker"]');
    expect(toml).toContain('sandbox_namespace = "nemoclaw"');
    expect(toml).toContain('grpc_endpoint = "https://127.0.0.1:8080"');
    expect(toml).toContain('network_name = "openshell-docker"');
    expect(toml).toContain('supervisor_image = "ghcr.io/nvidia/openshell/supervisor:0.0.44"');
    expect(toml).toContain('supervisor_bin = "/home/shadeform/.local/bin/openshell-sandbox"');
  });

  it("matches the pinned OpenShell v0.0.85 bind-mount gate contract", () => {
    // OpenShell v0.0.85 contains NVIDIA/OpenShell#2092 (merge 43bb030), whose
    // Docker-driver contract tests prove disabled bind mounts are rejected and
    // enabled read-only mounts render with Docker's `:ro` option. Keep this
    // gateway half paired with the `read_only: true` create-plan assertion in
    // sandbox-create-plan.test.ts.
    const baseEnv = {
      OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
      OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
      OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
    };
    expect(buildDockerDriverGatewayConfigToml(baseEnv)).not.toContain("enable_bind_mounts");
    expect(
      buildDockerDriverGatewayConfigToml({
        ...baseEnv,
        NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS: "1",
      }),
    ).toContain("enable_bind_mounts = true");
  });

  it("assigns different sandbox namespaces to different gateway state roots (#8663)", () => {
    const defaultNamespace = gatewayIdForStateDir("/tmp/openshell-docker-gateway");
    const alternateNamespace = gatewayIdForStateDir("/tmp/openshell-docker-gateway-18080");

    expect(defaultNamespace).toMatch(/^nemoclaw-openshell-docker-gateway-[a-f0-9]{12}$/);
    expect(defaultNamespace).not.toBe(alternateNamespace);
    expect(gatewayIdForStateDir("/tmp/a/gateway")).not.toBe(gatewayIdForStateDir("/tmp/b/gateway"));
  });

  it("writes the exact rootless socket only for the Podman driver", () => {
    const toml = buildDockerDriverGatewayConfigToml({
      OPENSHELL_DRIVERS: "podman",
      OPENSHELL_GRPC_ENDPOINT: `https://${PORTABLE_HOST_GATEWAY_IP}:8080`,
      OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
      OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
      OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
    });

    expect(toml).toContain("[openshell.drivers.podman]");
    expect(toml).toContain('socket_path = "/run/user/1001/podman/podman.sock"');
    expect(toml).not.toContain("sandbox_namespace");
  });

  it("rejects wildcard binds for direct host gateway launches", () => {
    expect(() => {
      withTempBinaries(({ dir, gatewayBin }) => {
        const stateDir = path.join(dir, "state");
        fs.mkdirSync(stateDir);
        buildDockerDriverGatewayLaunch({
          gatewayBin,
          stateDir,
          platform: "linux",
          env: {},
          hostGlibcVersion: "2.39",
          requiredGlibcVersions: ["2.39"],
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "0.0.0.0",
            OPENSHELL_DRIVERS: "docker",
          },
        });
      });
    }).toThrow(/not supported for the OpenShell Docker-driver gateway/);
  });

  it("uses the selected OpenShell env for certificate generation and the gateway process (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    vi.stubEnv("OPENSHELL_DISABLE_TLS", "1");
    vi.stubEnv("OPENSHELL_DISABLE_GATEWAY_AUTH", "1");
    const selectedEnv: NodeJS.ProcessEnv = {
      HOME: "/home/tester",
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "nemoclaw-8090",
      OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
      OPENSHELL_WORKSPACE: "default",
    };
    const ensureTls = vi
      .spyOn(dockerDriverGatewayLocalTls, "ensureDockerDriverGatewayLocalTlsBundle")
      .mockImplementation(({ env, stateDir }) => {
        expect(env).toBe(selectedEnv);
        return dockerDriverGatewayLocalTls.getDockerDriverGatewayLocalTlsBundle(stateDir);
      });

    try {
      withTempBinaries(({ dir, gatewayBin }) => {
        const stateDir = path.join(dir, "state");
        const launch = buildDockerDriverGatewayLaunch({
          ensureLocalTlsBundle: true,
          env: selectedEnv,
          gatewayBin,
          gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
          hostGlibcVersion: "2.39",
          platform: "linux",
          requiredGlibcVersions: ["2.39"],
          stateDir,
        });

        expect(ensureTls).toHaveBeenCalledOnce();
        expect(launch.env).toEqual(
          expect.objectContaining({
            OPENSHELL_GATEWAY: "nemoclaw-8090",
            OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
            OPENSHELL_WORKSPACE: "default",
          }),
        );
        expect(launch.env.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
        expect(launch.env.OPENSHELL_TOKEN).toBeUndefined();
        expect(launch.env.OPENSHELL_DISABLE_TLS).toBeUndefined();
        expect(launch.env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
      });
    } finally {
      ensureTls.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("uses the host binary as the drift binary outside compatibility mode", () => {
    withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
      const identity = buildDockerDriverGatewayRuntimeIdentity({
        gatewayBin,
        sandboxBin,
        stateDir: dir,
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.39",
        requiredGlibcVersions: ["2.39"],
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
      });

      expect(identity.launch?.mode).toBe("host");
      expect(identity.driftGatewayBin).toBe(gatewayBin);
      expect(identity.desiredEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN).toBe(sandboxBin);
      expect(identity.desiredEnv[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]).toBe(
        gatewayIdForStateDir(dir),
      );
      expect(identity.desiredEnv.OPENSHELL_GATEWAY_CONFIG).toBe(
        path.join(dir, "openshell-gateway.toml"),
      );
      expect(resolveDriftGatewayBin(identity, gatewayBin)).toBe(gatewayBin);
    });
  });

  it("falls back to the host binary when no runtime identity is available", () => {
    expect(resolveDriftGatewayBin(null, "/opt/openshell/openshell-gateway")).toBe(
      "/opt/openshell/openshell-gateway",
    );
    expect(resolveDriftGatewayBin(null, null)).toBeNull();
  });

  it("uses the host binary when the gateway ABI is compatible", () => {
    withTempBinaries(({ dir, gatewayBin }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        stateDir: dir,
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.39",
        requiredGlibcVersions: ["2.39"],
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
      });

      expect(launch).toMatchObject({
        command: gatewayBin,
        args: [],
        mode: "host",
        processGatewayBin: gatewayBin,
      });
    });
  });

  it("admits a prepared v0.0.44 pre-auth database only under installer restore authority", () => {
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "1");
    try {
      withTempBinaries(({ dir, gatewayBin }) => {
        const stateDir = path.join(dir, "state");
        fs.mkdirSync(stateDir, { mode: 0o700 });
        writeOpenShell0044PreAuthState(stateDir);

        const launch = buildDockerDriverGatewayLaunch({
          gatewayBin,
          stateDir,
          platform: "linux",
          env: {},
          hostGlibcVersion: "2.39",
          requiredGlibcVersions: ["2.39"],
          gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
        });

        expect(launch.mode).toBe("host");
        expect(fs.existsSync(path.join(stateDir, "openshell-gateway.toml"))).toBe(true);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a prepared v0.0.44 pre-auth database without installer restore authority", () => {
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "0");
    try {
      withTempBinaries(({ dir, gatewayBin }) => {
        const stateDir = path.join(dir, "state");
        fs.mkdirSync(stateDir, { mode: 0o700 });
        writeOpenShell0044PreAuthState(stateDir);

        expect(() =>
          buildDockerDriverGatewayLaunch({
            gatewayBin,
            stateDir,
            platform: "linux",
            env: {},
            hostGlibcVersion: "2.39",
            requiredGlibcVersions: ["2.39"],
            gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
          }),
        ).toThrow(/durable gateway state exists without a config/);
        expect(fs.existsSync(path.join(stateDir, "openshell-gateway.toml"))).toBe(false);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("binds the real no-argument host launch identity to its gateway target", () => {
    withTempBinaries(({ dir, gatewayBin }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        gatewayName: "nemoclaw-8081",
        stateDir: dir,
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.39",
        requiredGlibcVersions: ["2.39"],
        gatewayEnv: {
          OPENSHELL_DRIVERS: "docker",
          OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8081",
        },
      });
      const cmdline = [launch.argv0, ...launch.args].filter(Boolean).join(" ");

      expect(launch.args).toEqual([]);
      expect(launch.argv0).toBe("openshell-gateway[nemoclaw=nemoclaw-8081;port=8081]");
      expect(
        gatewayProcessCmdlineMatches(cmdline, gatewayBin, {
          expectedOpenShellGateway: { name: "nemoclaw-8081", port: 8081 },
        }),
      ).toBe(true);
      expect(
        gatewayProcessCmdlineMatches(cmdline, gatewayBin, {
          expectedOpenShellGateway: { name: "nemoclaw", port: 8080 },
        }),
      ).toBe(false);
    });
  });

  it("scrubs stale internal env from direct host gateway launches", () => {
    withTempBinaries(({ dir, gatewayBin }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        stateDir: dir,
        platform: "linux",
        env: {
          OPENSHELL_DISABLE_GATEWAY_AUTH: "true",
          [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: "stale",
        },
        hostGlibcVersion: "2.39",
        requiredGlibcVersions: ["2.39"],
        gatewayEnv: { OPENSHELL_DRIVERS: "podman" },
      });

      expect(launch.mode).toBe("host");
      expect(launch.env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
      expect(launch.env[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]).toBeUndefined();
    });
  });
});
