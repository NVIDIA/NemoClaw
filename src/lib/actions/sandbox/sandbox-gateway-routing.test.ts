// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayAdaptersForTest } from "../../../../test/helpers/openshell-gateway-adapters";

const requireSource = createRequire(import.meta.url);
const registry = requireSource("../../state/registry.js");
const lifecycleCli = requireSource("../../adapters/openshell/gateway-lifecycle-cli.js");
const reuseCli = requireSource("../../adapters/openshell/gateway-reuse-cli.js");
const routing: typeof import("./sandbox-gateway-routing") = requireSource(
  "./sandbox-gateway-routing.js",
);

describe("sandbox gateway routing helpers", () => {
  let adapters: ReturnType<typeof gatewayAdaptersForTest>;
  beforeEach(() => {
    adapters = gatewayAdaptersForTest({ endpointBinding: "match" });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      gatewayName: "nemoclaw-8090",
      gatewayPort: 8090,
      openshellDriver: "vm",
    });
    vi.spyOn(lifecycleCli, "createCliOpenShellGatewayLifecycle").mockReturnValue(
      adapters.lifecycle,
    );
    vi.spyOn(reuseCli, "createCliOpenShellGatewayReuseObserver").mockReturnValue(adapters.observer);
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses the persisted gateway name for metadata health", async () => {
    await expect(routing.probeGatewayRunning("alpha")).resolves.toBe(true);
    expect(adapters.observer.observeGatewayReuse).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw-8090" },
      expectedGatewayPort: 8090,
    });
  });

  it("refuses metadata health when the selected identity lacks named metadata", async () => {
    adapters.observer.observeGatewayReuse.mockResolvedValue({
      healthy: true,
      namedMetadata: false,
      gatewayReuseState: "healthy",
      shouldSelect: false,
      endpoints: [],
      endpointBinding: "unknown",
    });
    await expect(routing.probeGatewayRunning("alpha")).resolves.toBe(false);
    expect(adapters.lifecycle.selectGateway).not.toHaveBeenCalled();
  });

  it.each(["unknown", "mismatch"] as const)(
    "rejects %s endpoint binding before snapshot routing",
    async (endpointBinding) => {
      adapters.observer.observeGatewayReuse.mockResolvedValue({
        healthy: true,
        namedMetadata: true,
        gatewayReuseState: "healthy",
        shouldSelect: false,
        endpoints: [],
        endpointBinding,
      });
      await expect(routing.probeGatewayRunning("alpha")).resolves.toBe(false);
      expect(adapters.lifecycle.selectGateway).not.toHaveBeenCalled();
    },
  );

  it("awaits selection of the persisted gateway before sandbox commands", async () => {
    await expect(routing.selectSandboxGatewayIfRegistered("alpha")).resolves.toBe(true);
    expect(adapters.lifecycle.selectGateway).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw-8090" },
    });
  });
});
