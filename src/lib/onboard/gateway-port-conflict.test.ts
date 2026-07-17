// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  couldBeNemoClawGatewayPortListener,
  failFastOnForeignGatewayPortConflict,
} from "./gateway-port-conflict";
import type { PortProbeResult } from "./preflight";

function blockedPort(processName: string): PortProbeResult {
  return {
    ok: false,
    process: processName,
    pid: 1234,
    reason: "listener is already using the port",
  };
}

describe("gateway port conflict", () => {
  it("exits with a report for an identifiable foreign gateway port listener", async () => {
    const checkPortAvailable = vi.fn().mockResolvedValue(blockedPort("python3"));
    const exitProcess = vi.fn();
    const lines: string[] = [];

    await failFastOnForeignGatewayPortConflict({
      gatewayPort: 8080,
      externallySupervised: false,
      checkPortAvailable,
      getGatewayPortCheckOptions: () => ({ host: "127.0.0.1" }),
      isDockerDriverGatewayPortListener: () => false,
      exitProcess,
      serviceHints: ["       systemctl --user stop openshell-gateway.service"],
      writeError: (line) => lines.push(line),
    });

    expect(checkPortAvailable).toHaveBeenCalledWith(8080, { host: "127.0.0.1" });
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(lines.join("\n")).toContain("Port 8080 is not available.");
    expect(lines.join("\n")).toContain("Blocked by: python3 (PID 1234)");
    expect(lines.join("\n")).toContain("NEMOCLAW_GATEWAY_PORT=<port> nemoclaw onboard");
  });

  it("keeps OpenShell-like listeners on the gateway reuse path", async () => {
    const checkPortAvailable = vi.fn().mockResolvedValue(blockedPort("openshell-gateway"));
    const exitProcess = vi.fn();

    await failFastOnForeignGatewayPortConflict({
      gatewayPort: 8080,
      externallySupervised: false,
      checkPortAvailable,
      getGatewayPortCheckOptions: () => ({ host: "127.0.0.1" }),
      isDockerDriverGatewayPortListener: () => false,
      exitProcess,
    });

    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("keeps Docker-driver gateway listeners on the gateway reuse path", () => {
    expect(couldBeNemoClawGatewayPortListener(blockedPort("python3"), () => true)).toBe(true);
  });

  it("defers an arbitrary declared external executable to exact attachment validation (#6576)", async () => {
    const checkPortAvailable = vi.fn().mockResolvedValue(blockedPort("gatewayd"));
    const exitProcess = vi.fn();

    await failFastOnForeignGatewayPortConflict({
      gatewayPort: 8080,
      externallySupervised: true,
      checkPortAvailable,
      getGatewayPortCheckOptions: () => ({ host: "127.0.0.1" }),
      isDockerDriverGatewayPortListener: () => false,
      exitProcess,
    });

    expect(checkPortAvailable).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });
});
