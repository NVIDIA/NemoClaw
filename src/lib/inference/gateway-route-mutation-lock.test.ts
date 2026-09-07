// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncResource } from "node:async_hooks";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveCurrentUserModelRouterLockStateDir,
  resolveModelRouterPortLifecycleLockOptions,
  withGatewayRouteMutationLock,
  withGatewayRouteMutationLockSync,
  withModelRouterPortLifecycleLock,
} from "./gateway-route-mutation-lock";

function observeNextLockPublicationAttempt(): { attempted: Promise<void>; restore: () => void } {
  let reportAttempted!: () => void;
  const attempted = new Promise<void>((resolve) => {
    reportAttempted = resolve;
  });
  const link = fsSync.promises.link.bind(fsSync.promises);
  const spy = vi.spyOn(fsSync.promises, "link").mockImplementation(async (existingPath, newPath) => {
    reportAttempted();
    await link(existingPath, newPath);
  });
  return { attempted, restore: () => spy.mockRestore() };
}

describe("gateway route mutation lock", () => {
  it("resolves default and overridden router lock directories without filesystem access", () => {
    const homeDir = "/srv/nemoclaw-controller";
    const expectedStateDir = path.join(homeDir, ".nemoclaw", "state");
    expect(resolveCurrentUserModelRouterLockStateDir(homeDir)).toBe(expectedStateDir);
    expect(resolveModelRouterPortLifecycleLockOptions({}, homeDir).stateDir).toBe(expectedStateDir);
    expect(
      resolveModelRouterPortLifecycleLockOptions({ stateDir: "/isolated" }, homeDir).stateDir,
    ).toBe("/isolated");
  });

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
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    let restorePublication = (): void => {};
    try {
      first = withGatewayRouteMutationLock(
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
      const publication = observeNextLockPublicationAttempt();
      restorePublication = publication.restore;
      second = withGatewayRouteMutationLock(
        "nemoclaw",
        () => {
          events.push("second-enter");
        },
        options,
      );
      await publication.attempted;
      restorePublication();
      restorePublication = (): void => {};
      expect(events).toEqual(["first-enter"]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
    } finally {
      restorePublication();
      releaseFirst();
      await Promise.allSettled([first, second].filter((value): value is Promise<void> => Boolean(value)));
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

  it("serializes router lifecycle operations for the same port", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-router-port-lock-"));
    let publishPeer!: () => void;
    const peerPublished = new Promise<void>((resolve) => {
      publishPeer = resolve;
    });
    let reportOnboardEntered!: () => void;
    const onboardEntered = new Promise<void>((resolve) => {
      reportOnboardEntered = resolve;
    });
    const events: string[] = [];
    const options = { stateDir, pollIntervalMs: 1, timeoutMs: 5_000 };
    let onboarding: Promise<void> | undefined;
    let teardown: Promise<void> | undefined;
    let restorePublication = (): void => {};
    try {
      onboarding = withModelRouterPortLifecycleLock(
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
      const publication = observeNextLockPublicationAttempt();
      restorePublication = publication.restore;
      teardown = withModelRouterPortLifecycleLock(
        4000,
        () => {
          events.push("teardown-peer-scan");
        },
        options,
      );

      await publication.attempted;
      restorePublication();
      restorePublication = (): void => {};
      expect(events).toEqual(["onboard-enter"]);
      publishPeer();
      await Promise.all([onboarding, teardown]);
      expect(events).toEqual(["onboard-enter", "peer-published", "teardown-peer-scan"]);
    } finally {
      restorePublication();
      publishPeer();
      await Promise.allSettled(
        [onboarding, teardown].filter((value): value is Promise<void> => Boolean(value)),
      );
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
