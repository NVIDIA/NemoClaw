// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the generic sandbox-side host-service reachability probe.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/3340 (Ollama auth proxy) and
//      https://github.com/NVIDIA/NemoClaw/issues/4564 (Model Router port 4000).

import { describe, expect, it, vi } from "vitest";

// Mock the docker adapter so the test never loads runner.ts (which requires
// the compiled ./platform artifact unavailable in the test environment).
vi.mock("../adapters/docker/run", () => ({
  dockerRun: vi.fn(),
  dockerCapture: vi.fn(),
}));

import {
  DEFAULT_PROBE_NETWORK,
  formatHostServiceUnreachableMessage,
  probeHostServiceSandboxReachability,
} from "./host-service-reachability";

function makeNetwork(partial: { subnet?: string; gatewayIp?: string } = {}): {
  subnet?: string;
  gatewayIp?: string;
} {
  return { subnet: "172.18.0.0/16", gatewayIp: "172.18.0.1", ...partial };
}

describe("probeHostServiceSandboxReachability", () => {
  it("returns ok and echoes the probed port when nc connects", async () => {
    const result = await probeHostServiceSandboxReachability({
      port: 4000,
      inspectNetworkImpl: () => makeNetwork(),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 0 }),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.port).toBe(4000);
    expect(result.networkName).toBe(DEFAULT_PROBE_NETWORK);
  });

  it("classifies a UFW-blocked Linux Docker-driver router as tcp_failed (#4564)", async () => {
    const result = await probeHostServiceSandboxReachability({
      port: 4000,
      inspectNetworkImpl: () => makeNetwork(),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 1, stderr: "nc: connect failed" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tcp_failed");
    expect(result.port).toBe(4000);
    expect(result.detail).toContain("host.openshell.internal");
    expect(result.detail).toContain("4000");
  });

  it("treats a missing sandbox network as probe_unavailable (non-fatal during fresh setup)", async () => {
    const result = await probeHostServiceSandboxReachability({
      port: 4000,
      inspectNetworkImpl: () => undefined,
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe_unavailable");
  });

  it("probes the requested port and host alias in the docker run args", async () => {
    let capturedArgs: readonly string[] = [];
    await probeHostServiceSandboxReachability({
      port: 4000,
      networkName: "openshell-docker",
      inspectNetworkImpl: () => makeNetwork({ gatewayIp: "172.18.0.1" }),
      usesHostGatewayRouteImpl: () => false,
      runImpl: (args) => {
        capturedArgs = args;
        return { status: 0 };
      },
    });
    expect(capturedArgs).toContain("openshell-docker");
    expect(capturedArgs).toContain("host.openshell.internal:172.18.0.1");
    expect(capturedArgs).toContain("nc");
    expect(capturedArgs).toContain("host.openshell.internal");
    expect(capturedArgs).toContain("4000");
  });
});

describe("formatHostServiceUnreachableMessage", () => {
  it("emits a Model Router UFW remediation for the routed port (#4564)", () => {
    const msg = formatHostServiceUnreachableMessage(
      {
        ok: false,
        reason: "tcp_failed",
        port: 4000,
        networkName: "openshell-docker",
        subnet: "172.18.0.0/16",
        gatewayIp: "172.18.0.1",
      },
      { serviceLabel: "Model Router", port: 4000 },
    );
    expect(msg).toContain("Model Router");
    expect(msg).toContain("host.openshell.internal:4000");
    expect(msg).toContain("sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 4000 proto tcp");
    expect(msg).toContain("nemoclaw onboard");
  });

  it("falls back to result.port when no explicit port option is given", () => {
    const msg = formatHostServiceUnreachableMessage(
      {
        ok: false,
        reason: "tcp_failed",
        port: 4000,
        networkName: "openshell-docker",
        subnet: "172.18.0.0/16",
      },
      { serviceLabel: "Model Router" },
    );
    expect(msg).toContain("sudo ufw allow from 172.18.0.0/16 to any port 4000 proto tcp");
  });

  it("returns empty string for ok and probe_unavailable results", () => {
    expect(
      formatHostServiceUnreachableMessage(
        { ok: true, reason: "ok", port: 4000, networkName: "openshell-docker" },
        { serviceLabel: "Model Router" },
      ),
    ).toBe("");
    expect(
      formatHostServiceUnreachableMessage(
        { ok: false, reason: "probe_unavailable", port: 4000, networkName: "openshell-docker" },
        { serviceLabel: "Model Router" },
      ),
    ).toBe("");
  });
});
