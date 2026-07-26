// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import { revokeDestroyedSandboxHttpsPinRoute } from "./destroy";

const ROUTE_ID = "a".repeat(64);
const ROUTE_URL = `http://host.openshell.internal:11438/route/${ROUTE_ID}`;
const GATEWAY_NAME = "nemoclaw-19080";

describe("destroy HTTPS-pin route cleanup (#6141)", () => {
  it("revokes an unreferenced route after the owning registry row is gone", async () => {
    const revokeRoute = vi.fn(async () => true);

    await revokeDestroyedSandboxHttpsPinRoute(GATEWAY_NAME, ROUTE_ID, {
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      revokeRoute,
    });

    expect(revokeRoute).toHaveBeenCalledWith(ROUTE_ID);
  });

  it("preserves a route that another sandbox still references", async () => {
    const revokeRoute = vi.fn(async () => true);

    await revokeDestroyedSandboxHttpsPinRoute(GATEWAY_NAME, ROUTE_ID, {
      listSandboxes: () => ({
        sandboxes: [{ name: "peer", endpointUrl: ROUTE_URL }],
        defaultSandbox: "peer",
      }),
      revokeRoute,
    });

    expect(revokeRoute).not.toHaveBeenCalled();
  });

  it("keeps successful sandbox deletion non-fatal when the registry read fails", async () => {
    const warn = vi.fn();

    await expect(
      revokeDestroyedSandboxHttpsPinRoute(GATEWAY_NAME, ROUTE_ID, {
        listSandboxes: () => {
          throw new Error("registry unavailable");
        },
        revokeRoute: async () => {
          throw new Error("delete unavailable");
        },
        warn,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be revoked"));
  });

  it("keeps successful sandbox deletion non-fatal when adapter route revocation fails", async () => {
    const warn = vi.fn();

    await expect(
      revokeDestroyedSandboxHttpsPinRoute(GATEWAY_NAME, ROUTE_ID, {
        listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
        revokeRoute: async () => {
          throw new Error("delete unavailable");
        },
        warn,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be revoked"));
  });

  it("waits for an in-flight peer route registration before deciding whether to revoke", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-destroy-route-lock-"));
    const lockOptions = { stateDir, pollIntervalMs: 1, timeoutMs: 5_000 };
    let releasePeer!: () => void;
    const peerReleased = new Promise<void>((resolve) => {
      releasePeer = resolve;
    });
    let reportPeerEntered!: () => void;
    const peerEntered = new Promise<void>((resolve) => {
      reportPeerEntered = resolve;
    });
    const registryEntries: Array<{ name: string; endpointUrl: string }> = [];
    const revokeRoute = vi.fn(async () => true);
    const events: string[] = [];
    const withTestLock: typeof withGatewayRouteMutationLock = (gatewayName, operation) =>
      withGatewayRouteMutationLock(gatewayName, operation, lockOptions);

    try {
      // Model inference-set's critical section: its route is live after PUT but
      // not discoverable by destroy until the registry commit completes.
      const peerMutation = withTestLock(GATEWAY_NAME, async () => {
        events.push("peer-route-put");
        reportPeerEntered();
        await peerReleased;
        registryEntries.push({ name: "peer", endpointUrl: ROUTE_URL });
        events.push("peer-registry-commit");
      });
      await peerEntered;

      const destroyCleanup = revokeDestroyedSandboxHttpsPinRoute(GATEWAY_NAME, ROUTE_ID, {
        listSandboxes: () => ({ sandboxes: registryEntries, defaultSandbox: "peer" }),
        revokeRoute,
        withGatewayRouteMutationLock: withTestLock,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(["peer-route-put"]);
      expect(revokeRoute).not.toHaveBeenCalled();

      releasePeer();
      await Promise.all([peerMutation, destroyCleanup]);

      expect(events).toEqual(["peer-route-put", "peer-registry-commit"]);
      expect(revokeRoute).not.toHaveBeenCalled();
    } finally {
      releasePeer();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
