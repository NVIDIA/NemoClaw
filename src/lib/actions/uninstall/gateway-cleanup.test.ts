// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  collectLiveOpenShellGatewayNames,
  portableGatewayIsReachable,
  removeGatewayRegistration,
  type GatewayCleanupRuntime,
} from "./gateway-cleanup";

function harness(): GatewayCleanupRuntime {
  return {
    commandExists: () => true,
    env: {},
    gatewayLifecycle: {
      supportsLegacyLifecycle: vi.fn(),
      selectGateway: vi.fn(),
      registerGateway: vi.fn(),
      removeGateway: vi.fn().mockResolvedValue({ ok: true, state: "completed" }),
      destroyGateway: vi.fn(),
      listGateways: vi.fn().mockResolvedValue({ ok: true, names: ["owned", "sibling"] }),
    },
    gatewayReuseObserver: {
      observeGatewayReuse: vi.fn().mockResolvedValue({
        healthy: true,
        namedMetadata: true,
        gatewayReuseState: "healthy",
        shouldSelect: false,
        endpoints: [],
        endpointBinding: "unknown",
      }),
    },
    runDocker: vi.fn(),
    resolveGatewayTeardownAuthority: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  };
}

describe("uninstall gateway cleanup through typed capabilities", () => {
  it("uses named health and registry facts without constructing a subprocess", async () => {
    const runtime = harness();
    expect(await portableGatewayIsReachable(runtime, "owned")).toBe(true);
    expect(await collectLiveOpenShellGatewayNames(runtime, "owned")).toEqual(
      new Set(["owned", "sibling"]),
    );
    expect(runtime.gatewayReuseObserver.observeGatewayReuse).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "owned" },
    });
    expect(runtime.gatewayLifecycle.listGateways).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "owned" },
    });
    expect(runtime.runDocker).not.toHaveBeenCalled();
  });
  it("removes only the requested registration through the injected lifecycle", async () => {
    const runtime = harness();
    expect(await removeGatewayRegistration(runtime, "owned", false, 8080)).toBe(true);
    expect(runtime.gatewayLifecycle.removeGateway).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "owned" },
    });
    expect(runtime.gatewayLifecycle.destroyGateway).not.toHaveBeenCalled();
    expect(runtime.runDocker).not.toHaveBeenCalled();
  });
  it("preserves externally supervised state when remove is unsupported", async () => {
    const runtime = harness();
    vi.mocked(runtime.gatewayLifecycle.removeGateway).mockResolvedValue({
      ok: false,
      unsupported: true,
      ambiguous: false,
      error: { kind: "command", reason: "failed", message: "Unsupported remove." },
    });
    expect(await removeGatewayRegistration(runtime, "owned", false, 8080)).toBe(false);
    expect(runtime.gatewayLifecycle.destroyGateway).not.toHaveBeenCalled();
    expect(runtime.resolveGatewayTeardownAuthority).not.toHaveBeenCalled();
  });
});
