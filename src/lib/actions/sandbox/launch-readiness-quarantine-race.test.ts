// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import { type LaunchReadinessDeps, withLaunchReadinessMutationGate } from "./launch-readiness";

const SANDBOX_NAME = "alpha";
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_PORT = 8080;

describe("launch readiness quarantine fence", () => {
  it("rejects launch recovery when quarantine is published while it waits for the lock (#10140)", async () => {
    let current: SandboxEntry = {
      name: SANDBOX_NAME,
      gatewayName: GATEWAY_NAME,
      gatewayPort: GATEWAY_PORT,
    };
    let releaseLock!: () => void;
    const lockWaiting = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let reportLockEntered!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      reportLockEntered = resolve;
    });
    const operation = vi.fn();
    const deps: LaunchReadinessDeps = {
      getSandbox: () => current,
      withSandboxLock: async (_name, callback) => {
        reportLockEntered();
        await lockWaiting;
        return await callback();
      },
      withGatewayLock: vi.fn(async (_name, callback) => await callback()),
      checkMutationAuthority: () => "current",
    };

    const recovery = withLaunchReadinessMutationGate(
      {
        sandboxName: SANDBOX_NAME,
        gatewayName: GATEWAY_NAME,
        gatewayPort: GATEWAY_PORT,
        epochId: "a".repeat(64),
      },
      operation,
      deps,
    );
    await lockEntered;
    current = {
      ...current,
      quarantine: {
        schemaVersion: 1,
        fenceId: "00000000-0000-4000-8000-000000000001",
        requestIdentity: "e".repeat(64),
        reasonDigest: "f".repeat(64),
        createdAt: "2026-08-25T04:00:00.000Z",
        updatedAt: "2026-08-25T04:00:00.000Z",
        phase: "fenced",
        target: {
          sandboxName: SANDBOX_NAME,
          providerId: "docker",
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          lifecycleGeneration: "generation-1",
          liveIdentityFingerprint: "b".repeat(64),
          providerHandle: "f".repeat(64),
          providerLifecycleGeneration: "provider-generation-1",
          runtime: { kind: "docker-container", handle: "1".repeat(64) },
        },
        attempts: [],
      },
    };
    releaseLock();

    await expect(recovery).rejects.toThrow("quarantined");
    expect(operation).not.toHaveBeenCalled();
  });
});
