// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the sandbox-side Ollama auth proxy reachability probe.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/3340

import { describe, expect, it, vi } from "vitest";

// Mock the docker adapter so the test never loads runner.ts (which requires
// the compiled ./platform artifact unavailable in the test environment).
vi.mock("../adapters/docker/run", () => ({
  dockerRun: vi.fn(),
  dockerCapture: vi.fn(),
}));

import { OLLAMA_PROXY_PORT } from "../core/ports";
import {
  DEFAULT_OLLAMA_PROBE_NETWORK,
  formatOllamaProxyUnreachableMessage,
  probeOllamaProxySandboxReachability,
  __test,
} from "./ollama-proxy-reachability";

const { parseNetworkIpamConfig } = __test;

// ── parseNetworkIpamConfig ───────────────────────────────────────────────────

describe("parseNetworkIpamConfig", () => {
  it("parses a well-formed IPAM config with IPv4 gateway", () => {
    const raw = JSON.stringify([
      { Subnet: "172.20.0.0/16", Gateway: "172.20.0.1" },
    ]);
    expect(parseNetworkIpamConfig(raw)).toEqual({
      subnet: "172.20.0.0/16",
      gatewayIp: "172.20.0.1",
    });
  });

  it("skips IPv6 entries and returns first IPv4 entry", () => {
    const raw = JSON.stringify([
      { Subnet: "fd00::/64", Gateway: "fd00::1" },
      { Subnet: "10.0.0.0/8", Gateway: "10.0.0.1" },
    ]);
    expect(parseNetworkIpamConfig(raw)).toEqual({
      subnet: "10.0.0.0/8",
      gatewayIp: "10.0.0.1",
    });
  });

  it("returns undefined for empty string", () => {
    expect(parseNetworkIpamConfig("")).toBeUndefined();
  });

  it("returns undefined for Docker '<no value>' sentinel", () => {
    expect(parseNetworkIpamConfig("<no value>")).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseNetworkIpamConfig("not-json")).toBeUndefined();
  });

  it("returns undefined for non-array JSON", () => {
    expect(parseNetworkIpamConfig('{"Subnet":"10.0.0.0/8"}')).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(parseNetworkIpamConfig("[]")).toBeUndefined();
  });

  it("returns undefined when all entries lack an IPv4 Gateway field", () => {
    // No Gateway field in any entry — the loop finds no IPv4 gateway to return
    const raw = JSON.stringify([{ Subnet: "192.168.0.0/20" }]);
    expect(parseNetworkIpamConfig(raw)).toBeUndefined();
  });
});

// ── probeOllamaProxySandboxReachability ──────────────────────────────────────

function makeNetwork(
  partial: { subnet?: string; gatewayIp?: string } = {},
): { subnet?: string; gatewayIp?: string } {
  return { subnet: "172.20.0.0/16", gatewayIp: "172.20.0.1", ...partial };
}

describe("probeOllamaProxySandboxReachability (#3340)", () => {
  it("returns probe_unavailable when the Docker network does not exist", async () => {
    const result = await probeOllamaProxySandboxReachability({
      inspectNetworkImpl: () => undefined,
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe_unavailable");
    expect(result.detail).toMatch(/not found/i);
  });

  it("returns probe_unavailable when network has no IPv4 gateway (non-host-gateway mode)", async () => {
    const result = await probeOllamaProxySandboxReachability({
      inspectNetworkImpl: () => makeNetwork({ gatewayIp: undefined }),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe_unavailable");
    expect(result.detail).toMatch(/no IPv4 gateway/i);
  });

  it("proceeds without gatewayIp in host-gateway mode", async () => {
    const result = await probeOllamaProxySandboxReachability({
      inspectNetworkImpl: () => makeNetwork({ gatewayIp: undefined }),
      usesHostGatewayRouteImpl: () => true,
      runImpl: () => ({ status: 0 }),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("returns ok when nc exits with status 0", async () => {
    const result = await probeOllamaProxySandboxReachability({
      inspectNetworkImpl: () => makeNetwork(),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 0 }),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.subnet).toBe("172.20.0.0/16");
    expect(result.gatewayIp).toBe("172.20.0.1");
    expect(result.networkName).toBe(DEFAULT_OLLAMA_PROBE_NETWORK);
  });

  it("returns tcp_failed when nc exits with status 1 on Linux native", async () => {
    const result = await probeOllamaProxySandboxReachability({
      inspectNetworkImpl: () => makeNetwork(),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 1, stderr: "nc: connect failed" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tcp_failed");
    expect(result.detail).toContain("host.openshell.internal");
    expect(result.detail).toContain(String(OLLAMA_PROXY_PORT));
  });

  it("returns probe_unavailable when nc exits with status 1 in host-gateway mode (Docker Desktop)", async () => {
    const result = await probeOllamaProxySandboxReachability({
      inspectNetworkImpl: () => makeNetwork(),
      usesHostGatewayRouteImpl: () => true,
      runImpl: () => ({ status: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe_unavailable");
  });

  it("returns probe_unavailable for unexpected non-0/non-1 exit codes", async () => {
    for (const code of [2, 127, 255]) {
      const result = await probeOllamaProxySandboxReachability({
        inspectNetworkImpl: () => makeNetwork(),
        usesHostGatewayRouteImpl: () => false,
        runImpl: () => ({ status: code }),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("probe_unavailable");
    }
  });

  it("returns probe_unavailable when the container runner reports an error", async () => {
    const result = await probeOllamaProxySandboxReachability({
      inspectNetworkImpl: () => makeNetwork(),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: null, error: "docker: Cannot connect to the Docker daemon" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe_unavailable");
    expect(result.detail).toContain("docker: Cannot connect");
  });

  it("returns probe_unavailable on DNS resolution failures (bad address)", async () => {
    const result = await probeOllamaProxySandboxReachability({
      inspectNetworkImpl: () => makeNetwork(),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({
        status: 1,
        stderr: "nc: bad address 'host.openshell.internal'",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe_unavailable");
  });

  it("uses a custom networkName when OPENSHELL_DOCKER_NETWORK_NAME env var is set", async () => {
    const original = process.env.OPENSHELL_DOCKER_NETWORK_NAME;
    process.env.OPENSHELL_DOCKER_NETWORK_NAME = "my-custom-network";
    try {
      let capturedArgs: readonly string[] = [];
      await probeOllamaProxySandboxReachability({
        inspectNetworkImpl: (name) => {
          if (name === "my-custom-network") return makeNetwork();
          return undefined;
        },
        usesHostGatewayRouteImpl: () => false,
        runImpl: (args) => {
          capturedArgs = args;
          return { status: 0 };
        },
      });
      expect(capturedArgs).toContain("my-custom-network");
    } finally {
      if (original === undefined) {
        delete process.env.OPENSHELL_DOCKER_NETWORK_NAME;
      } else {
        process.env.OPENSHELL_DOCKER_NETWORK_NAME = original;
      }
    }
  });

  it("passes the correct docker run arguments including --add-host and nc command", async () => {
    let capturedArgs: readonly string[] = [];
    await probeOllamaProxySandboxReachability({
      port: 11435,
      networkName: "test-network",
      timeoutSec: 3,
      inspectNetworkImpl: () => makeNetwork({ gatewayIp: "172.99.0.1" }),
      usesHostGatewayRouteImpl: () => false,
      runImpl: (args) => {
        capturedArgs = args;
        return { status: 0 };
      },
    });
    expect(capturedArgs).toContain("--rm");
    expect(capturedArgs).toContain("test-network");
    expect(capturedArgs).toContain("host.openshell.internal:172.99.0.1");
    expect(capturedArgs).toContain("nc");
    expect(capturedArgs).toContain("-zw3");
    expect(capturedArgs).toContain("host.openshell.internal");
    expect(capturedArgs).toContain("11435");
  });

  it("uses host-gateway alias in the --add-host flag when in host-gateway mode", async () => {
    let capturedArgs: readonly string[] = [];
    await probeOllamaProxySandboxReachability({
      networkName: "test-network",
      inspectNetworkImpl: () => makeNetwork({ gatewayIp: "172.99.0.1" }),
      usesHostGatewayRouteImpl: () => true,
      runImpl: (args) => {
        capturedArgs = args;
        return { status: 0 };
      },
    });
    expect(capturedArgs).toContain("host.openshell.internal:host-gateway");
    expect(capturedArgs).not.toContain("host.openshell.internal:172.99.0.1");
  });
});

// ── formatOllamaProxyUnreachableMessage ──────────────────────────────────────

describe("formatOllamaProxyUnreachableMessage", () => {
  it("returns empty string for ok result", () => {
    expect(
      formatOllamaProxyUnreachableMessage({
        ok: true,
        reason: "ok",
        networkName: "openshell-docker",
      }),
    ).toBe("");
  });

  it("returns empty string for probe_unavailable result", () => {
    expect(
      formatOllamaProxyUnreachableMessage({
        ok: false,
        reason: "probe_unavailable",
        networkName: "openshell-docker",
      }),
    ).toBe("");
  });

  it("includes subnet-specific ufw command when subnet is known", () => {
    const msg = formatOllamaProxyUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      networkName: "openshell-docker",
      subnet: "172.20.0.0/16",
    });
    expect(msg).toContain("172.20.0.0/16");
    expect(msg).toContain(String(OLLAMA_PROXY_PORT));
    expect(msg).toContain("sudo ufw allow");
    expect(msg).toContain("host.openshell.internal");
    expect(msg).toContain("nemoclaw onboard");
  });

  it("includes dynamic SUBNET= fallback when subnet is unknown", () => {
    const msg = formatOllamaProxyUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      networkName: "openshell-docker",
    });
    expect(msg).toContain("SUBNET=");
    expect(msg).toContain("docker network inspect openshell-docker");
    expect(msg).toContain(String(OLLAMA_PROXY_PORT));
    expect(msg).toContain("sudo ufw allow");
  });

  it("uses the custom port argument when provided", () => {
    const msg = formatOllamaProxyUnreachableMessage(
      {
        ok: false,
        reason: "tcp_failed",
        networkName: "openshell-docker",
        subnet: "10.0.0.0/8",
      },
      19999,
    );
    expect(msg).toContain("19999");
    expect(msg).not.toContain(String(OLLAMA_PROXY_PORT));
  });
});
