// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createRegisteredHermesSandboxIdentityRevalidator,
  withHermesCredentialEnvReconciliationLock,
} from "../../actions/sandbox/runtime/hermes-lifecycle";
import { reconcileCreatedHermesCredentialEnvironment } from "./orchestration";

describe("post-registration Hermes credential reconciliation", () => {
  const plan = { agent: "hermes" } as never;

  it("serializes through the shared sandbox lifecycle lock", async () => {
    const sandboxName = `hermes-reconcile-${process.pid}-${Date.now()}`;
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAcquired!: () => void;
    const firstIsHeld = new Promise<void>((resolve) => {
      firstAcquired = resolve;
    });

    const first = withHermesCredentialEnvReconciliationLock(sandboxName, async () => {
      events.push("first:acquired");
      firstAcquired();
      await firstMayFinish;
      events.push("first:released");
    });
    await firstIsHeld;
    const second = withHermesCredentialEnvReconciliationLock(sandboxName, () => {
      events.push("second:acquired");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(["first:acquired"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:acquired", "first:released", "second:acquired"]);
  });

  it("refuses a same-name replacement before credential or lifecycle effects", async () => {
    const fingerprint = "a".repeat(64);
    const effects: string[] = [];
    const entry = {
      name: "alpha",
      agent: "hermes",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: fingerprint,
    };
    const revalidate = createRegisteredHermesSandboxIdentityRevalidator({
      sandboxName: "alpha",
      getSandbox: () => entry,
      observeSandbox: () => ({ liveIdentityFingerprint: "b".repeat(64) }),
    });

    await expect(
      reconcileCreatedHermesCredentialEnvironment(
        { sandboxName: "alpha", plan },
        {
          revalidateSandboxIdentity: revalidate,
          reconcileCredentialEnv: () => {
            effects.push("credential mutation");
            return { changed: true };
          },
          restartGateway: async () => {
            effects.push("sandbox restart");
            return { status: 0, stdout: "", stderr: "" };
          },
          waitForGateway: async () => true,
        },
        vi.fn(),
      ),
    ).rejects.toThrow(/live identity changed/u);
    expect(effects).toEqual([]);
  });
});
