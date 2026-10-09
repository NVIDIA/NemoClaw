// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the generic sandbox-side host-service reachability probe.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/3340 (Ollama auth proxy) and
//      https://github.com/NVIDIA/NemoClaw/issues/4564 (Model Router port 4000).

import { describe, expect, it, vi } from "vitest";

import { PORTABLE_HOST_GATEWAY_IP } from "./experimental/portable-profile";
import { prepareNativePodmanGatewayHostRuntime } from "./runtime-provider/podman-runtime-surfaces";

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

  it("routes native Docker bridge probes through the inspected numeric gateway", async () => {
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

  it("uses the configured Docker network when networkName is omitted (#9461)", async () => {
    vi.stubEnv("OPENSHELL_DOCKER_NETWORK_NAME", "portable-custom");
    const inspectNetworkImpl = vi.fn(() => makeNetwork());
    let capturedArgs: readonly string[] = [];

    const result = await probeHostServiceSandboxReachability({
      port: 4000,
      inspectNetworkImpl,
      usesHostGatewayRouteImpl: () => false,
      runImpl: (args) => {
        capturedArgs = args;
        return { status: 0 };
      },
    });

    expect(inspectNetworkImpl).toHaveBeenCalledWith("portable-custom");
    const networkIndex = capturedArgs.indexOf("--network");
    expect(networkIndex).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[networkIndex + 1]).toBe("portable-custom");
    expect(result.ok).toBe(true);
    expect(result.networkName).toBe("portable-custom");
  });

  it("routes portable profile probes through the sandbox host gateway", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    let capturedArgs: readonly string[] = [];

    const result = await probeHostServiceSandboxReachability({
      port: 11435,
      inspectNetworkImpl: () => ({ subnet: "10.89.0.0/24" }),
      runImpl: (args) => {
        capturedArgs = args;
        return { status: 0 };
      },
    });

    expect(result).toMatchObject({ ok: true, reason: "ok" });
    expect(capturedArgs).toContain(`host.openshell.internal:${PORTABLE_HOST_GATEWAY_IP}`);
    expect(capturedArgs).not.toContain("host.openshell.internal:host-gateway");
    expect(capturedArgs).not.toContain("host.openshell.internal:10.89.0.1");
  });

  it("routes native Podman probes through the sandbox host gateway", async () => {
    let capturedArgs: readonly string[] = [];
    const inspect = vi.fn(() => ({ subnet: "10.89.0.0/24", gatewayIp: "10.89.0.1" }));
    const run = vi.fn((args: readonly string[]) => {
      capturedArgs = args;
      return { status: 0 };
    });
    const gatewayRuntime = {
      ...prepareNativePodmanGatewayHostRuntime({
        environment: {},
        platform: "linux",
        socketPath: "/run/user/1000/podman/podman.sock",
      }),
      network: {
        sandboxSourceCidrs: () => ["10.89.0.0/24"],
        inspect,
        usesHostGatewayRoute: vi.fn(() => false),
        run,
        ensureProbeImageCached: vi.fn(() => ({ ok: true, alreadyCached: true })),
      },
    };

    const result = await probeHostServiceSandboxReachability({
      gatewayRuntime,
      platform: "linux",
      port: 11435,
    });

    expect(result).toMatchObject({ ok: true, reason: "ok" });
    expect(inspect).toHaveBeenCalledWith("openshell-docker");
    expect(run).toHaveBeenCalledOnce();
    expect(capturedArgs).toContain(`host.openshell.internal:${PORTABLE_HOST_GATEWAY_IP}`);
    expect(capturedArgs).not.toContain("host.openshell.internal:10.89.0.1");
  });

  it("keeps portable host-gateway failures credential-free and inconclusive", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const credential = "nvapi-regression-secret";

    const result = await probeHostServiceSandboxReachability({
      port: 11435,
      inspectNetworkImpl: () =>
        makeNetwork({
          subnet: "10.89.0.0/24",
          gatewayIp: "10.89.0.1",
        }),
      runImpl: () => ({ status: 1, stderr: `nc failed with ${credential}` }),
    });
    const message = formatHostServiceUnreachableMessage(result, {
      serviceLabel: "Ollama auth proxy",
    });

    expect(result).toMatchObject({ ok: false, reason: "probe_unavailable" });
    expect(result.detail).toBe("portable host-gateway probe did not connect");
    expect(result.detail).not.toContain(credential);
    expect(message).toBe("");
    expect(message).not.toContain(credential);
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

  it.each(["nemohermes", "nemo-deepagents"])(
    "uses the invoked %s CLI in the recovery command (#8712)",
    (invokedAs) => {
      vi.stubEnv("NEMOCLAW_INVOKED_AS", invokedAs);

      const msg = formatHostServiceUnreachableMessage(
        {
          ok: false,
          reason: "tcp_failed",
          port: 8081,
          networkName: "openshell-docker",
          subnet: "172.18.0.0/16",
          gatewayIp: "172.18.0.1",
        },
        { serviceLabel: "managed llama.cpp server" },
      );

      expect(msg).toContain(`Then rerun \`${invokedAs} onboard\`.`);
    },
  );

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
