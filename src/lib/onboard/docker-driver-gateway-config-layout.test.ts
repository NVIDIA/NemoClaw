// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { baseGatewayEnv } from "../../../test/support/openshell-gateway-config-helpers";
import { prepareDockerDriverGatewayConfigEnv } from "./docker-driver-gateway-config";
import { prepareNativePodmanGatewayHostRuntime } from "./runtime-provider/podman-runtime-surfaces";

describe("provider-projected OpenShell driver layouts", () => {
  it.each(["split-supervisor", "inline-supervisor"] as const)(
    "renders and reuses the projected %s layout without matching a provider identity",
    (driverConfigLayout) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-layout-"));
      try {
        fs.chmodSync(stateDir, 0o700);
        const env = { ...baseGatewayEnv(stateDir), OPENSHELL_DRIVERS: "example" };
        const sourceRuntime = prepareNativePodmanGatewayHostRuntime({
          environment: env,
          platform: "linux",
        });
        const gatewayRuntime = {
          ...sourceRuntime,
          providerId: "example-provider",
          openShellDriver: "example",
          gatewayConfig: { ...sourceRuntime.gatewayConfig, driverConfigLayout },
        };
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox", {
          gatewayRuntime,
        });
        const configPath = path.join(stateDir, "openshell-gateway.toml");
        const before = fs.readFileSync(configPath, "utf8");
        const parsed = parseToml(before) as {
          openshell: { gateway: { compute_driver: string }; drivers: Record<string, object> };
        };
        expect(parsed.openshell.gateway.compute_driver).toBe("example");
        const driver = parsed.openshell.drivers.example!;
        expect(Object.hasOwn(driver, "network_name")).toBe(
          driverConfigLayout === "inline-supervisor",
        );
        expect(Object.hasOwn(driver, "host_gateway_ip")).toBe(
          driverConfigLayout === "inline-supervisor",
        );
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox", {
          gatewayRuntime,
        });
        expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );
});
