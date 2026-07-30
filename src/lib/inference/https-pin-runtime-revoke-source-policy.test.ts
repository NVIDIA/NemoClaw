// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Revocation has to authenticate the running adapter, and the control-plane
// proof binds the source-subnet policy that adapter was started with. Probing
// without it authenticates against the loopback default while every
// sandbox-facing adapter runs on the OpenShell bridge range, which is why a
// superseded route survived an endpoint update with its upstream credentials
// resident (#7878).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { __test } from "./https-pin-runtime-adapter";

describe("HTTPS Pin Runtime revocation source policy", () => {
  let lockModule: typeof import("./https-pin-runtime-adapter");

  beforeEach(async () => {
    vi.resetModules();
    lockModule = await import("./https-pin-runtime-adapter");
  });

  it("authenticates revocation with the recorded route-source policy (#7878)", async () => {
    const deleteRoute = vi.fn(async () => {});
    const removeRouteState = vi.fn();
    const probeHealth = vi.fn(async () => true);

    await expect(
      lockModule.__test.revokeRouteLocked("a".repeat(64), {
        loadPid: () => 4242,
        readControlToken: () => "persisted-control-token",
        readAllowedSourceCidrs: () => ["172.18.0.0/16"],
        probeHealth,
        deleteRoute,
        isAdapterProcess: () => true,
        removeRouteState,
      }),
    ).resolves.toBe(true);
    // The proof binds the policy digest, so the probe must carry the recorded
    // policy rather than falling back to the 127.0.0.1/32 default.
    expect(probeHealth).toHaveBeenCalledWith({
      controlToken: "persisted-control-token",
      expectedSourceCidrs: ["172.18.0.0/16"],
    });
    expect(deleteRoute).toHaveBeenCalledWith("persisted-control-token", "a".repeat(64));
  });

  it("fails closed for a live adapter whose route-source policy was never recorded (#7878)", async () => {
    const deleteRoute = vi.fn(async () => {});
    const removeRouteState = vi.fn();
    const probeHealth = vi.fn(async () => true);

    await expect(
      lockModule.__test.revokeRouteLocked("a".repeat(64), {
        loadPid: () => 4242,
        readControlToken: () => "persisted-control-token",
        readAllowedSourceCidrs: () => null,
        probeHealth,
        deleteRoute,
        isAdapterProcess: () => true,
        removeRouteState,
      }),
    ).rejects.toThrow("route-source policy was not recorded");
    // Never probe with a made-up policy, and never drop the route record: the
    // adapter still holds the credential, so the caller must keep warning.
    expect(probeHealth).not.toHaveBeenCalled();
    expect(deleteRoute).not.toHaveBeenCalled();
    expect(removeRouteState).not.toHaveBeenCalled();
  });

  it("keeps clearing state for an absent adapter without a recorded policy (#7878)", async () => {
    const deleteRoute = vi.fn(async () => {});
    const removeRouteState = vi.fn();

    // Regression lock: no live adapter means nothing holds the credential, so
    // the pre-existing "drop the stale record" behaviour must not change.
    await expect(
      lockModule.__test.revokeRouteLocked("a".repeat(64), {
        loadPid: () => null,
        readControlToken: () => null,
        readAllowedSourceCidrs: () => null,
        probeHealth: async () => false,
        deleteRoute,
        isAdapterProcess: () => false,
        removeRouteState,
      }),
    ).resolves.toBe(true);
    expect(deleteRoute).not.toHaveBeenCalled();
    expect(removeRouteState).toHaveBeenCalledWith("a".repeat(64));
  });

  it("still reports the authentication failure when the recorded policy no longer matches (#7878)", async () => {
    const removeRouteState = vi.fn();

    await expect(
      lockModule.__test.revokeRouteLocked("a".repeat(64), {
        loadPid: () => 4242,
        readControlToken: () => "persisted-control-token",
        readAllowedSourceCidrs: () => ["172.18.0.0/16"],
        probeHealth: async () => false,
        deleteRoute: async () => {},
        isAdapterProcess: () => true,
        removeRouteState,
      }),
    ).rejects.toThrow("Cannot authenticate the live HTTPS Pin Runtime adapter for revocation.");
    expect(removeRouteState).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["empty", []],
    ["non-array", "172.18.0.0/16"],
    ["non-string entries", [17218]],
    ["blank entries", ["  "]],
  ])("treats a %s recorded route-source policy as unusable (#7878)", (_label, recorded) => {
    expect(
      __test.extractPersistedAllowedSourceCidrs(
        recorded === undefined ? {} : { allowedSourceCidrs: recorded },
      ),
    ).toBeNull();
  });

  it("canonicalises a recorded route-source policy before use (#7878)", () => {
    expect(
      __test.extractPersistedAllowedSourceCidrs({ allowedSourceCidrs: ["172.18.0.0/16"] }),
    ).toEqual(__test.buildAllowedRouteSourceMatcher(["172.18.0.0/16"]).cidrs);
  });
});
