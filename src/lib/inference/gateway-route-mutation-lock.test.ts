// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncResource } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  withGatewayRouteMutationLock,
  withGatewayRouteMutationLockSync,
} from "./gateway-route-mutation-lock";

describe("gateway route mutation lock", () => {
  it("serializes separate operations for the same gateway", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-gateway-lock-"));
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let reportFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      reportFirstEntered = resolve;
    });
    const events: string[] = [];
    const options = { stateDir, pollIntervalMs: 1, timeoutMs: 5_000 };
    try {
      const first = withGatewayRouteMutationLock(
        "nemoclaw",
        async () => {
          events.push("first-enter");
          reportFirstEntered();
          await firstReleased;
          events.push("first-exit");
        },
        options,
      );
      await firstEntered;
      const second = withGatewayRouteMutationLock(
        "nemoclaw",
        () => {
          events.push("second-enter");
        },
        options,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(["first-enter"]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
    } finally {
      releaseFirst();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("allows operations for different gateways to overlap", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-gateway-lock-"));
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let reportFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      reportFirstEntered = resolve;
    });
    const options = { stateDir, pollIntervalMs: 1, timeoutMs: 5_000 };
    try {
      const first = withGatewayRouteMutationLock(
        "nemoclaw",
        async () => {
          reportFirstEntered();
          await firstReleased;
        },
        options,
      );
      await firstEntered;
      await expect(
        withGatewayRouteMutationLock("nemoclaw-9090", () => "second", options),
      ).resolves.toBe("second");
      releaseFirst();
      await first;
    } finally {
      releaseFirst();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("makes sync and async operations contend in the same explicit nondefault state directory", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-gateway-cross-mode-"));
    const outsideLockContext = new AsyncResource("gateway-route-cross-mode-test");
    const options = { stateDir, pollIntervalMs: 1, timeoutMs: 5_000 };
    const contentionOptions = { ...options, timeoutMs: 25 };
    try {
      await withGatewayRouteMutationLock(
        "nemoclaw-18080",
        () => {
          expect(() =>
            outsideLockContext.runInAsyncScope(() =>
              withGatewayRouteMutationLockSync(
                "nemoclaw-18080",
                () => "must-not-enter",
                contentionOptions,
              ),
            ),
          ).toThrow();
        },
        options,
      );
      expect(
        withGatewayRouteMutationLockSync("nemoclaw-18080", () => "entered-after-release", options),
      ).toBe("entered-after-release");
    } finally {
      outsideLockContext.emitDestroy();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps cross-gateway router onboarding publication ahead of teardown", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-router-port-lock-"));
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    let publishPeer!: () => void;
    const peerPublished = new Promise<void>((resolve) => {
      publishPeer = resolve;
    });
    let reportOnboardEntered!: () => void;
    const onboardEntered = new Promise<void>((resolve) => {
      reportOnboardEntered = resolve;
    });
    const events: string[] = [];
    const options = { pollIntervalMs: 1, timeoutMs: 5_000 };
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
      vi.resetModules();
      const firstGateway = await import("./gateway-route-mutation-lock");
      const onboarding = firstGateway.withModelRouterPortLifecycleLock(
        4000,
        async () => {
          events.push("onboard-enter");
          reportOnboardEntered();
          await peerPublished;
          events.push("peer-published");
        },
        options,
      );
      await onboardEntered;
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18081");
      vi.resetModules();
      const secondGateway = await import("./gateway-route-mutation-lock");
      const teardown = secondGateway.withModelRouterPortLifecycleLock(
        4000,
        () => {
          events.push("teardown-peer-scan");
        },
        options,
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(["onboard-enter"]);
      publishPeer();
      await Promise.all([onboarding, teardown]);
      expect(events).toEqual(["onboard-enter", "peer-published", "teardown-peer-scan"]);
    } finally {
      publishPeer();
      vi.unstubAllEnvs();
      homedirSpy.mockRestore();
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
