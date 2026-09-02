// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreEnv } from "../../../../test/helpers/env-test-helpers";

const processProofs = vi.hoisted(() => ({
  externalOwnershipFailure: vi.fn<() => string | null>(() => null),
  processEnvironment: vi.fn<() => Record<string, string> | null>(() => null),
  serviceIdentity: vi.fn<() => { pid: number; executablePath: string | null } | null>(() => null),
  standaloneOwnershipFailure: vi.fn<() => string | null>(() => null),
}));

vi.mock("../../onboard/host-gateway-process", () => ({
  externallySupervisedHostGatewayProcessOwnershipFailure: processProofs.externalOwnershipFailure,
  readHostGatewayProcessEnvironment: processProofs.processEnvironment,
  scopedHostGatewayProcessOwnershipFailure: processProofs.standaloneOwnershipFailure,
}));
vi.mock("../../onboard/docker-driver-gateway-service", () => ({
  getTrustedActiveOpenShellGatewayUserServiceIdentity: processProofs.serviceIdentity,
}));

import {
  buildDockerDriverGatewayRuntimeMarker,
  getDockerDriverGatewayConfigIdentity,
  NEMOCLAW_OPENSHELL_GATEWAY_CONFIG_SHA256_ENV,
  writeDockerDriverGatewayRuntimeMarker,
} from "../../onboard/docker-driver-gateway-runtime-marker";
import { assertMcpGatewayProxyDnsDisabled } from "./mcp-bridge/gateway-security";

const originalStateDir = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;

function gatewayConfig(proxyMode?: boolean, driver: "docker" | "podman" = "docker"): string {
  return [
    "[openshell]",
    "version = 1",
    "",
    "[openshell.gateway]",
    `compute_drivers = ["${driver}"]`,
    "",
    `[openshell.drivers.${driver}]`,
    ...(proxyMode === undefined ? [] : [`proxy_connect_by_hostname = ${String(proxyMode)}`]),
    "",
  ].join("\n");
}

function writeRuntimeIdentity(
  stateDir: string,
  config: string,
  options: {
    runtimeProviderId?: "docker" | "podman";
    openShellDriver?: "docker" | "podman";
    mutateMarker?: (marker: ReturnType<typeof buildDockerDriverGatewayRuntimeMarker>) => void;
  } = {},
): string {
  const runtimeProviderId = options.runtimeProviderId ?? "docker";
  const openShellDriver = options.openShellDriver ?? "docker";
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const configPath = path.join(stateDir, "openshell-gateway.toml");
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  const marker = buildDockerDriverGatewayRuntimeMarker({
    pid: process.pid,
    desiredEnv: {
      NEMOCLAW_RUNTIME_PROVIDER_ID: runtimeProviderId,
      OPENSHELL_DRIVERS: openShellDriver,
      OPENSHELL_GATEWAY_CONFIG: configPath,
    },
    endpoint: "https://127.0.0.1:8080",
  });
  options.mutateMarker?.(marker);
  writeDockerDriverGatewayRuntimeMarker(path.join(stateDir, "runtime.json"), marker);
  process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = stateDir;
  return configPath;
}

afterEach(() => {
  restoreEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", originalStateDir);
  processProofs.externalOwnershipFailure.mockReset().mockReturnValue(null);
  processProofs.processEnvironment.mockReset().mockReturnValue(null);
  processProofs.serviceIdentity.mockReset().mockReturnValue(null);
  processProofs.standaloneOwnershipFailure.mockReset().mockReturnValue(null);
});

describe("managed MCP gateway proxy DNS boundary", () => {
  it("accepts the omitted disabled default when it is bound to the launch marker", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-"));
    try {
      writeRuntimeIdentity(stateDir, gatewayConfig());

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).not.toThrow();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("admits a launch-bound portable Podman gateway to the MCP mutation boundary", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-podman-"));
    try {
      writeRuntimeIdentity(stateDir, gatewayConfig(undefined, "podman"), {
        runtimeProviderId: "docker",
        openShellDriver: "podman",
      });

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).not.toThrow();
      processProofs.standaloneOwnershipFailure.mockReturnValue("process identity does not match");
      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /process identity does not match/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a launch-bound portable Podman gateway with hostname proxy resolution", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-podman-"));
    try {
      writeRuntimeIdentity(stateDir, gatewayConfig(true, "podman"), {
        runtimeProviderId: "docker",
        openShellDriver: "podman",
      });

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /enables proxy hostname resolution/,
      );
      expect(processProofs.standaloneOwnershipFailure).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a launch marker whose driver differs from the selected config", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-podman-"));
    try {
      writeRuntimeIdentity(stateDir, gatewayConfig(false, "podman"), {
        runtimeProviderId: "docker",
        openShellDriver: "podman",
        mutateMarker: (marker) => {
          marker.openShellDriver = "docker";
        },
      });

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /launch marker OpenShell driver does not match the selected config driver/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a legacy launch marker without an OpenShell driver identity", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-"));
    try {
      writeRuntimeIdentity(stateDir, gatewayConfig(), {
        mutateMarker: (marker) => {
          delete marker.openShellDriver;
        },
      });

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /does not record the selected OpenShell driver/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a legacy marker without launch-bound config identity", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-"));
    try {
      const makeLegacy = (marker: ReturnType<typeof buildDockerDriverGatewayRuntimeMarker>) => {
        delete marker.gatewayConfigPath;
        delete marker.gatewayConfigSha256;
      };
      writeRuntimeIdentity(stateDir, gatewayConfig(), { mutateMarker: makeLegacy });
      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /launch marker does not record a gateway config identity/,
      );

      writeRuntimeIdentity(stateDir, gatewayConfig(false), { mutateMarker: makeLegacy });
      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /launch marker does not record a gateway config identity/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects proxy hostname resolution before MCP mutation", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-"));
    try {
      writeRuntimeIdentity(stateDir, gatewayConfig(true));

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /enables proxy hostname resolution/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects config bytes that changed after gateway launch", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-"));
    try {
      const configPath = writeRuntimeIdentity(stateDir, gatewayConfig(false));
      fs.appendFileSync(configPath, "# post-launch change\n");

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /does not match the config recorded at gateway launch/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an unproven selected process even when the file says false", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-"));
    try {
      writeRuntimeIdentity(stateDir, gatewayConfig(false));
      processProofs.standaloneOwnershipFailure.mockReturnValue("process identity does not match");

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /process identity does not match/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("accepts a trusted package-managed process bound to the current config", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-"));
    try {
      const configPath = writeRuntimeIdentity(stateDir, gatewayConfig(false));
      const configSha256 = getDockerDriverGatewayConfigIdentity({
        OPENSHELL_GATEWAY_CONFIG: configPath,
      }).gatewayConfigSha256;
      processProofs.standaloneOwnershipFailure.mockReturnValue("standalone PID file is absent");
      processProofs.serviceIdentity.mockReturnValue({
        pid: process.pid,
        executablePath: "/usr/bin/openshell-gateway",
      });
      processProofs.processEnvironment.mockReturnValue({
        OPENSHELL_GATEWAY_CONFIG: configPath,
        [NEMOCLAW_OPENSHELL_GATEWAY_CONFIG_SHA256_ENV]: configSha256 ?? "",
      });

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).not.toThrow();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a package-managed process whose launch digest differs", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-"));
    try {
      const configPath = writeRuntimeIdentity(stateDir, gatewayConfig(false));
      processProofs.standaloneOwnershipFailure.mockReturnValue("standalone PID file is absent");
      processProofs.serviceIdentity.mockReturnValue({
        pid: process.pid,
        executablePath: "/usr/bin/openshell-gateway",
      });
      processProofs.processEnvironment.mockReturnValue({
        OPENSHELL_GATEWAY_CONFIG: configPath,
        [NEMOCLAW_OPENSHELL_GATEWAY_CONFIG_SHA256_ENV]: "0".repeat(64),
      });

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /managed service config differs from its launch environment/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a package-managed process without a launch-bound config digest", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-gateway-"));
    try {
      const configPath = writeRuntimeIdentity(stateDir, gatewayConfig(false));
      processProofs.standaloneOwnershipFailure.mockReturnValue("standalone PID file is absent");
      processProofs.serviceIdentity.mockReturnValue({
        pid: process.pid,
        executablePath: "/usr/bin/openshell-gateway",
      });
      processProofs.processEnvironment.mockReturnValue({ OPENSHELL_GATEWAY_CONFIG: configPath });

      expect(() => assertMcpGatewayProxyDnsDisabled("nemoclaw", 8080)).toThrow(
        /managed service launch does not record a gateway config digest/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
