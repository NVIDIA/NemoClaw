// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { OnboardPolicyApplicationDeps } from "../../src/lib/onboard/policy-selection.js";

const require = createRequire(import.meta.url);

type PolicySelectionModule = typeof import("../../src/lib/onboard/policy-selection.js");
type PolicyApplication = ReturnType<PolicySelectionModule["createOnboardPolicyApplication"]>;

function replaceCachedExports(modulePath: string, exports: unknown): void {
  const cached = require.cache[modulePath];
  assert.ok(cached, `Expected ${modulePath} to be loaded`);
  cached.exports = exports;
}

function restoreRequireCache(prior: Map<string, NodeModule>): void {
  const addedModulePaths = Object.keys(require.cache).filter(
    (modulePath) => !prior.has(modulePath),
  );
  for (const modulePath of addedModulePaths) delete require.cache[modulePath];
  for (const [modulePath, cached] of prior) require.cache[modulePath] = cached;
}

describe("onboarding policy application production wiring", () => {
  it("wires resume policy application to live policy, readiness checks, and sandbox mutation lock (#7695)", async () => {
    const priorCache = new Map(
      Object.entries(require.cache).filter(
        (entry): entry is [string, NodeModule] => entry[1] !== undefined,
      ),
    );
    const events: string[] = [];
    const getSandbox = vi.fn(() => {
      events.push("registry tier read");
      return { policyTier: "restricted" };
    });
    const updateSandbox = vi.fn();
    const waitForSandboxReady = vi.fn(() => {
      events.push("sandbox ready");
      return true;
    });
    const waitForSandboxControlPlaneReady = vi.fn(() => {
      events.push("control plane ready");
      return true;
    });
    const withSandboxMutationLock: OnboardPolicyApplicationDeps["withSandboxMutationLock"] = vi.fn(
      async (_sandboxName, action) => {
        events.push("lock entered");
        try {
          return await action();
        } finally {
          events.push("lock released");
        }
      },
    );
    const syncPresetSelection = vi.fn(() => events.push("policies synchronized"));
    const seedInitialPolicyContext = vi.fn(() => events.push("policy context seeded"));
    let capturedDeps: OnboardPolicyApplicationDeps | undefined;
    let application: PolicyApplication | undefined;

    const onboardPath = require.resolve("../../src/lib/onboard.js");
    const policyPath = require.resolve("../../src/lib/policy/index.js");
    const syncPath = require.resolve("../../src/lib/onboard/policy-preset-sync.js");
    const seedPath = require.resolve("../../src/lib/onboard/policy-context-seed.js");
    const policySelectionPath = require.resolve("../../src/lib/onboard/policy-selection.js");
    const registryPath = require.resolve("../../src/lib/state/registry.js");
    const lockPath = require.resolve("../../src/lib/state/mcp-lifecycle-lock.js");
    const readinessPath = require.resolve("../../src/lib/onboard/sandbox-readiness-tracing.js");
    const finalFlowPath =
      require.resolve("../../src/lib/onboard/machine/final-flow-composition.js");

    try {
      const policy = require(policyPath) as Record<string, unknown>;
      replaceCachedExports(policyPath, {
        ...policy,
        clampSetupPolicyPresetNames: vi.fn((names: string[]) => [...names]),
        customPresetOwnsNetworkPolicyKey: vi.fn(() => false),
        getAppliedPresets: vi.fn(() => []),
        listCustomPresets: vi.fn(() => []),
        listSetupPolicyPresets: vi.fn(() => [{ name: "npm" }]),
        setupPolicyPresetSupported: vi.fn(() => true),
      });

      require(syncPath);
      replaceCachedExports(syncPath, { syncPresetSelection });
      require(seedPath);
      replaceCachedExports(seedPath, { seedInitialPolicyContext });

      delete require.cache[policySelectionPath];
      const policySelection = require(policySelectionPath) as PolicySelectionModule;
      replaceCachedExports(policySelectionPath, {
        ...policySelection,
        createOnboardPolicyApplication: (deps: OnboardPolicyApplicationDeps) => {
          capturedDeps = deps;
          application = policySelection.createOnboardPolicyApplication(deps);
          return application;
        },
      });

      const registry = require(registryPath) as Record<string, unknown>;
      replaceCachedExports(registryPath, { ...registry, getSandbox, updateSandbox });
      const lock = require(lockPath) as Record<string, unknown>;
      replaceCachedExports(lockPath, { ...lock, withSandboxMutationLock });
      const readiness = require(readinessPath) as Record<string, unknown>;
      replaceCachedExports(readinessPath, {
        ...readiness,
        createSandboxReadyWaiter: vi.fn(() => waitForSandboxReady),
      });
      const finalFlow = require(finalFlowPath) as {
        finalizationHandlerDeps: Record<string, unknown>;
        [key: string]: unknown;
      };
      replaceCachedExports(finalFlowPath, {
        ...finalFlow,
        finalizationHandlerDeps: {
          ...finalFlow.finalizationHandlerDeps,
          waitForSandboxControlPlaneReady,
        },
      });

      delete require.cache[onboardPath];
      require(onboardPath);

      assert.ok(capturedDeps, "Expected onboard.ts to capture policy application dependencies");
      assert.ok(application, "Expected onboard.ts to create the policy application");
      expect(capturedDeps.withSandboxMutationLock).toBe(withSandboxMutationLock);
      expect(capturedDeps.waitForSandboxReady).toBe(waitForSandboxReady);
      expect(capturedDeps.waitForSandboxControlPlaneReady).toBe(waitForSandboxControlPlaneReady);

      await expect(
        application.setupPoliciesWithSelection("alpha", { selectedPresets: ["npm"] }),
      ).resolves.toEqual(["npm"]);
      expect(getSandbox).not.toHaveBeenCalled();
      expect(waitForSandboxReady).toHaveBeenCalledTimes(2);
      expect(waitForSandboxControlPlaneReady).toHaveBeenCalledOnce();
      expect(syncPresetSelection).toHaveBeenCalledWith("alpha", [], ["npm"]);
      expect(events).toEqual([
        "lock entered",
        "sandbox ready",
        "policies synchronized",
        "sandbox ready",
        "control plane ready",
        "policy context seeded",
        "lock released",
      ]);
    } finally {
      restoreRequireCache(priorCache);
    }
  });
});
