// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withGatewayRouteMutationLock } from "../inference/gateway-route-mutation-lock";
import { getMcpLifecycleLockPath, withSandboxMutationLock } from "../state/mcp-lifecycle-lock";
import { withCuaCommandRouteLock } from "./command-route-lock";

const cleanupDirectories: string[] = [];

function temporaryStateDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-command-lock-"));
  cleanupDirectories.push(directory);
  return directory;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("CUA command mutation lease", () => {
  it.each([
    "target",
    "task",
    "security",
  ] as const)("keeps one %s mutation authoritative after its live lease is older than ten seconds", async (resource) => {
    const stateDir = temporaryStateDirectory();
    const entered = deferred();
    const releaseAdapter = deferred();
    const entries: string[] = [];
    let activeMutations = 0;
    let maximumActiveMutations = 0;
    let adapterCalls = 0;
    let activeResource = false;
    const sandboxLease = <T>(sandboxName: string, operation: () => Promise<T> | T) =>
      withSandboxMutationLock(sandboxName, operation, {
        stateDir,
        pollIntervalMs: 5,
        timeoutMs: 5_000,
      });
    const commandDeps = {
      getSandbox: () => ({ name: "alpha" }),
      withSandboxMutationLock: sandboxLease,
      withGatewayRouteMutationLock: <T>(gatewayName: string, operation: () => Promise<T> | T) =>
        withGatewayRouteMutationLock(gatewayName, operation, {
          stateDir,
          pollIntervalMs: 5,
          timeoutMs: 5_000,
        }),
    };
    const mutate = async <T>(label: string, operation: () => Promise<T> | T): Promise<T> => {
      entries.push(label);
      activeMutations += 1;
      maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
      try {
        return await operation();
      } finally {
        activeMutations -= 1;
      }
    };

    const first = withCuaCommandRouteLock(
      "alpha",
      () =>
        mutate(`first-${resource}`, async () => {
          adapterCalls += 1;
          entered.resolve();
          await releaseAdapter.promise;
          activeResource = true;
          return "accepted";
        }),
      commandDeps,
    );
    await entered.promise;

    // A process-backed sandbox lease is identity/liveness based, not
    // age-expiring. Make the held generation look older than the registry's
    // ten-second stale threshold and prove contenders still cannot enter.
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(getMcpLifecycleLockPath("alpha", stateDir), old, old);
    fs.utimesSync(getMcpLifecycleLockPath("gateway-route:nemoclaw", stateDir), old, old);

    const contenders = ["inference-set", "policy-add", "policy-remove", "snapshot-restore"].map(
      (label) => sandboxLease("alpha", () => mutate(label, () => undefined)),
    );
    const routeContender = withGatewayRouteMutationLock(
      "nemoclaw",
      () => mutate("gateway-route-change", () => undefined),
      { stateDir, pollIntervalMs: 5, timeoutMs: 5_000 },
    );
    const second = withCuaCommandRouteLock(
      "alpha",
      () =>
        mutate(`second-${resource}`, () => {
          if (activeResource) return "conflict";
          adapterCalls += 1;
          activeResource = true;
          return "accepted";
        }),
      commandDeps,
    );

    let blockedAssertion: unknown;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(entries).toEqual([`first-${resource}`]);
      expect(maximumActiveMutations).toBe(1);
    } catch (error) {
      blockedAssertion = error;
    } finally {
      releaseAdapter.resolve();
    }
    await expect(first).resolves.toBe("accepted");
    await expect(second).resolves.toBe("conflict");
    await Promise.all([...contenders, routeContender]);
    if (blockedAssertion) throw blockedAssertion;

    expect(maximumActiveMutations).toBe(1);
    expect(adapterCalls).toBe(1);
    expect(entries).toEqual(
      expect.arrayContaining([
        `first-${resource}`,
        `second-${resource}`,
        "inference-set",
        "policy-add",
        "policy-remove",
        "snapshot-restore",
        "gateway-route-change",
      ]),
    );
  });
});
