// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxRegistry } from "../state/registry/types";
import { executeCuaLifecycleRegistryTransaction } from "./lifecycle-registry-transaction";
import { createCuaReconciliationState } from "./reconciliation";

function registry(): SandboxRegistry {
  return {
    defaultSandbox: "alpha",
    sandboxes: {
      alpha: {
        name: "alpha",
        provider: "provider-a",
        model: "model-a",
        policies: ["policy-a"],
        lifecycleGeneration: "generation-a",
      },
      beta: { name: "beta", policies: [] },
    },
  };
}

describe("CUA lifecycle registry transaction", () => {
  it.each([
    {
      concurrentOperation: "inference set",
      mutate: (state: SandboxRegistry) => {
        state.sandboxes.alpha!.provider = "provider-b";
      },
    },
    {
      concurrentOperation: "policy add or remove",
      mutate: (state: SandboxRegistry) => {
        state.sandboxes.alpha!.policies = ["policy-b"];
      },
    },
    {
      concurrentOperation: "snapshot restore",
      mutate: (state: SandboxRegistry) => {
        state.sandboxes.alpha!.lifecycleGeneration = "generation-b";
      },
    },
    {
      concurrentOperation: "a second CUA operation",
      mutate: (state: SandboxRegistry) => {
        state.sandboxes.alpha!.cuaTaskResults = [];
      },
    },
  ])("rejects adapter output without losing a concurrent $concurrentOperation update", ({
    mutate,
  }) => {
    const live = registry();
    const before = structuredClone(live.sandboxes.alpha);
    const save = vi.fn((next: SandboxRegistry) => {
      live.defaultSandbox = next.defaultSandbox;
      live.sandboxes = structuredClone(next.sandboxes);
    });
    let registryLockHeld = false;
    const withLock = <T>(operation: () => T): T => {
      expect(registryLockHeld).toBe(false);
      registryLockHeld = true;
      try {
        return operation();
      } finally {
        registryLockHeld = false;
      }
    };

    const outcome = executeCuaLifecycleRegistryTransaction({
      sandboxName: "alpha",
      deps: { load: () => live, save, withLock },
      execute: (working) => {
        expect(registryLockHeld).toBe(false);
        mutate(live);
        const staged = working.load();
        staged.sandboxes.alpha!.model = "adapter-output";
        working.save(staged);
        return "adapter-output";
      },
      conflict: () => "rejected",
    });

    expect(outcome).toBe("rejected");
    expect(live.sandboxes.alpha).not.toEqual(before);
    expect(live.sandboxes.alpha?.model).toBe("model-a");
    expect(save).not.toHaveBeenCalled();
  });

  it("commits one unchanged sandbox CAS while retaining unrelated registry updates", () => {
    const live = registry();
    const save = vi.fn((next: SandboxRegistry) => {
      live.defaultSandbox = next.defaultSandbox;
      live.sandboxes = structuredClone(next.sandboxes);
    });

    const outcome = executeCuaLifecycleRegistryTransaction({
      sandboxName: "alpha",
      deps: { load: () => live, save, withLock: (operation) => operation() },
      execute: (working) => {
        live.sandboxes.beta!.policies = ["concurrent-beta-policy"];
        const staged = working.load();
        staged.sandboxes.alpha!.model = "adapter-output";
        working.save(staged);
        return "accepted";
      },
      conflict: () => "rejected",
    });

    expect(outcome).toBe("accepted");
    expect(live.sandboxes.alpha?.model).toBe("adapter-output");
    expect(live.sandboxes.beta?.policies).toEqual(["concurrent-beta-policy"]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("persists pending authority before an adapter and requires reconciliation after post-call drift", () => {
    const live = registry();
    const save = vi.fn((next: SandboxRegistry) => {
      live.defaultSandbox = next.defaultSandbox;
      live.sandboxes = structuredClone(next.sandboxes);
    });
    let registryLockHeld = false;
    const withLock = <T>(operation: () => T): T => {
      registryLockHeld = true;
      try {
        return operation();
      } finally {
        registryLockHeld = false;
      }
    };

    const outcome = executeCuaLifecycleRegistryTransaction({
      sandboxName: "alpha",
      deps: { load: () => live, save, withLock },
      execute: (working) => {
        const staged = working.load();
        staged.sandboxes.alpha!.cuaReconciliation = createCuaReconciliationState({
          phase: "pending",
          trigger: "target.attach",
          operation: "target.attach",
        });
        working.save(staged);
        expect(working.checkpoint()).toBe(true);
        expect(registryLockHeld).toBe(false);
        expect(live.sandboxes.alpha?.cuaReconciliation?.phase).toBe("pending");

        live.sandboxes.alpha!.policies = ["concurrent-policy"];
        delete staged.sandboxes.alpha!.cuaReconciliation;
        staged.sandboxes.alpha!.model = "adapter-output";
        working.save(staged);
        return "adapter-output";
      },
      conflict: () => "rejected",
    });

    expect(outcome).toBe("rejected");
    expect(live.sandboxes.alpha?.model).toBe("model-a");
    expect(live.sandboxes.alpha?.policies).toEqual(["concurrent-policy"]);
    expect(live.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "target.attach",
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("requires a checkpointed attempt when execution throws after the external effect starts", () => {
    const live = registry();
    const save = vi.fn((next: SandboxRegistry) => {
      live.defaultSandbox = next.defaultSandbox;
      live.sandboxes = structuredClone(next.sandboxes);
    });

    expect(() =>
      executeCuaLifecycleRegistryTransaction({
        sandboxName: "alpha",
        deps: { load: () => live, save, withLock: (operation) => operation() },
        execute: (working) => {
          const staged = working.load();
          staged.sandboxes.alpha!.cuaReconciliation = createCuaReconciliationState({
            phase: "pending",
            trigger: "security.verify",
            operation: "security.verify",
          });
          working.save(staged);
          expect(working.checkpoint()).toBe(true);
          throw new Error("post-checkpoint failure");
        },
        conflict: () => "rejected",
      }),
    ).toThrow("post-checkpoint failure");
    expect(live.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "security.verify",
    });
    expect(save).toHaveBeenCalledTimes(2);
  });
});
