// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  registeredInferenceFixture,
  registeredIdentityFailureAt,
} from "../../../../test/helpers/registered-inference";
import { createProviderEffectBoundary } from "./orchestration";

describe("registered provider recreation", () => {
  it.each([
    ["ordinary", false, false],
    ["deferred", true, false],
    ["resumed", true, true],
  ] as const)(
    "preserves operator ownership and attachment receipt during %s creation",
    async (_route, deferred, resumingVerifiedCreate) => {
      const f = registeredInferenceFixture();
      f.adapter.updateProvider.mockResolvedValue({ ok: true });
      const revalidateSandboxIdentity = vi.fn();
      const boundary = createProviderEffectBoundary({
        deferred,
        resumingVerifiedCreate,
        sandboxName: f.binding.sandboxName,
        gatewayName: f.binding.gatewayName,
        expectedRegisteredInferenceProviderAttachment: f.binding,
        preparationInput: {
          openshellDriver: "docker",
          inferenceProvider: f.binding.providerName,
          messagingProviders: ["messaging-extra"],
          messagingProviderRequests: [],
          extraProviders: [f.binding.providerName, "owned-extra"],
          directCreateProviderNames: [],
          gatewayName: f.binding.gatewayName,
        },
        preparationDeps: {
          runOpenshell: vi.fn(),
          cleanupCreateSources: vi.fn(),
          providerAdapter: f.adapter,
        },
        runVerifiedSandboxCreateEffects: null,
        activateDeferredProviderEffects: async () => [],
        revalidateSandboxIdentityBeforeCreate: revalidateSandboxIdentity,
      });
      await boundary.validateBeforeCreate();
      expect(f.adapter.getProvider).toHaveBeenCalled();
      expect(f.adapter.inspectProviderProfile).toHaveBeenCalled();
      await boundary.publishBeforeCreate();
      await boundary.runAfterVerifiedCreate!({
        sandboxName: f.binding.sandboxName,
        gatewayName: f.binding.gatewayName,
        gatewayPort: 18080,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "direct" as never,
        revalidateSandboxIdentity,
      });
      expect(f.adapter.updateProvider.mock.calls.map(([request]) => request.providerName)).toEqual([
        "messaging-extra",
        "owned-extra",
      ]);
      expect(f.adapter.attachProvider).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "named", gatewayName: f.binding.gatewayName },
        sandboxName: f.binding.sandboxName,
        providerName: f.binding.providerName,
      });
      expect(f.state.attached).toBe(true);
      expect(boundary.registeredInferenceProviderAttachment).toEqual({
        ...f.binding,
        attachedBySelection: true,
      });
      expect(f.binding.attachedBySelection).toBe(false);
      expect(f.adapter.createProvider).not.toHaveBeenCalled();
      expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
      expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
    },
  );
});

function rollbackFixture(
  attached: boolean,
  deferred: boolean,
  resumingVerifiedCreate: boolean,
  previouslyOwned = false,
) {
  const f = registeredInferenceFixture(attached);
  const revalidateSandboxIdentity = vi.fn();
  const boundary = createProviderEffectBoundary({
    deferred,
    resumingVerifiedCreate,
    sandboxName: f.binding.sandboxName,
    gatewayName: f.binding.gatewayName,
    expectedRegisteredInferenceProviderAttachment: {
      ...f.binding,
      attachedBySelection: previouslyOwned,
    },
    preparationInput: {
      openshellDriver: "docker",
      inferenceProvider: f.binding.providerName,
      messagingProviders: [],
      messagingProviderRequests: [],
      extraProviders: [],
      directCreateProviderNames: [],
      gatewayName: f.binding.gatewayName,
    },
    preparationDeps: {
      runOpenshell: vi.fn(),
      cleanupCreateSources: vi.fn(),
      providerAdapter: f.adapter,
    },
    runVerifiedSandboxCreateEffects: null,
    activateDeferredProviderEffects: async () => [],
    revalidateSandboxIdentityBeforeCreate: revalidateSandboxIdentity,
  });
  const create = () =>
    boundary.runAfterVerifiedCreate!({
      sandboxName: f.binding.sandboxName,
      gatewayName: f.binding.gatewayName,
      gatewayPort: 18080,
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
      route: "native",
      revalidateSandboxIdentity,
    });
  return { ...f, boundary, revalidateSandboxIdentity, create };
}

function expectGuardedDetach(f: ReturnType<typeof rollbackFixture>, rollbackOperation: string) {
  const checkOrder = (operation: string) => {
    const index = f.revalidateSandboxIdentity.mock.calls.findIndex(([name]) => name === operation);
    expect(index, operation).toBeGreaterThanOrEqual(0);
    return f.revalidateSandboxIdentity.mock.invocationCallOrder[index]!;
  };
  const rollbackOrder = checkOrder(rollbackOperation);
  const beforeDetach = checkOrder("detach registered inference provider");
  const afterDetach = checkOrder("verify registered inference provider detach");
  expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
  const detachOrder = f.adapter.detachProvider.mock.invocationCallOrder[0]!;
  const absenceOrder = f.adapter.listProviderAttachments.mock.invocationCallOrder.at(-1)!;
  expect(rollbackOrder).toBeLessThan(beforeDetach);
  expect(beforeDetach).toBeLessThan(detachOrder);
  expect(detachOrder).toBeLessThan(absenceOrder);
  expect(absenceOrder).toBeLessThan(afterDetach);
  expect(f.state.attached).toBe(false);
}

describe.each([
  ["ordinary", false, false],
  ["deferred", true, false],
  ["resumed", true, true],
] as const)("failed %s creation", (_route, deferred, resuming) => {
  it("rolls back newly selected access after revalidating identity", async () => {
    const f = rollbackFixture(false, deferred, resuming);
    const failure = new Error("registration failed");
    await expect(
      f.boundary.withRegisteredAttachmentRollback(async () => {
        await f.create();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expectGuardedDetach(f, "removing newly attached registered inference provider");
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  });

  it("preserves preexisting access", async () => {
    const f = rollbackFixture(true, deferred, resuming);
    const failure = new Error("registration failed");
    await expect(
      f.boundary.withRegisteredAttachmentRollback(async () => {
        await f.create();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(f.state.attached).toBe(true);
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  });
});

it.each([
  {
    identity: "sandbox",
    replace: (f: ReturnType<typeof rollbackFixture>) => {
      f.revalidateSandboxIdentity.mockImplementation(() => {
        throw new Error("sandbox changed");
      });
    },
  },
  {
    identity: "provider",
    replace: (f: ReturnType<typeof rollbackFixture>) => {
      f.state.id = "replacement-provider";
    },
  },
])(
  "retains access when $identity identity becomes uncertain before rollback",
  async ({ replace }) => {
    const f = rollbackFixture(false, false, false);
    await expect(
      f.boundary.withRegisteredAttachmentRollback(async () => {
        await f.create();
        replace(f);
        throw new Error("registration failed");
      }),
    ).rejects.toThrow("cleanup was not confirmed");
    expect(f.state.attached).toBe(true);
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  },
);

it("keeps published attachment ownership when later finalization fails", async () => {
  const f = rollbackFixture(false, false, false);
  const failure = new Error("retirement failed after registration");
  await expect(
    f.boundary.withRegisteredAttachmentRollback(async () => {
      await f.create();
      f.boundary.markRegistrationPublished();
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(f.state.attached).toBe(true);
  expect(f.boundary.registeredInferenceProviderAttachment?.attachedBySelection).toBe(true);
  expect(f.adapter.detachProvider).not.toHaveBeenCalled();
});

it("does not roll back an attachment owned by an earlier selection", async () => {
  const f = rollbackFixture(true, true, true, true);
  await expect(
    f.boundary.withRegisteredAttachmentRollback(async () => {
      await f.create();
      throw new Error("registration failed");
    }),
  ).rejects.toThrow("registration failed");
  expect(f.boundary.registeredInferenceProviderAttachment?.attachedBySelection).toBe(true);
  expect(f.adapter.detachProvider).not.toHaveBeenCalled();
});

it("rechecks identity before cleanup when post-attachment verification fails", async () => {
  const f = rollbackFixture(false, false, false);
  const operation = "verifying restored registered inference attachment";
  const failure = new Error("identity check unavailable");
  f.revalidateSandboxIdentity.mockImplementation(registeredIdentityFailureAt(operation, failure));
  await expect(f.boundary.withRegisteredAttachmentRollback(f.create)).rejects.toBe(failure);
  expect(f.adapter.attachProvider).toHaveBeenCalledOnce();
  const failureIndex = f.revalidateSandboxIdentity.mock.calls.findIndex(
    ([name]) => name === operation,
  );
  expect(failureIndex).toBeGreaterThanOrEqual(0);
  expect(f.revalidateSandboxIdentity.mock.results[failureIndex]).toEqual({
    type: "throw",
    value: failure,
  });
  expect(f.adapter.attachProvider.mock.invocationCallOrder[0]!).toBeLessThan(
    f.revalidateSandboxIdentity.mock.invocationCallOrder[failureIndex]!,
  );
  expect(f.revalidateSandboxIdentity.mock.invocationCallOrder[failureIndex]!).toBeLessThan(
    f.adapter.detachProvider.mock.invocationCallOrder[0]!,
  );
  expectGuardedDetach(f, "removing newly attached registered inference provider");
  expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
});

it("revalidates the sandbox before rolling back an unverified attachment", async () => {
  const f = rollbackFixture(false, false, false);
  f.adapter.attachProvider.mockImplementation(async () => {
    f.state.attached = true;
    f.state.revision++;
    return { ok: true };
  });
  await expect(f.boundary.withRegisteredAttachmentRollback(f.create)).rejects.toThrow(
    "changed during attachment",
  );
  expectGuardedDetach(f, "rolling back unverified registered inference attachment");
  expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
  expect(f.state.attached).toBe(false);
  expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
});

it("retains an unverified attachment when the sandbox was replaced before rollback", async () => {
  const f = rollbackFixture(false, false, false);
  f.adapter.attachProvider.mockImplementation(async () => {
    f.state.attached = true;
    f.state.revision++;
    f.revalidateSandboxIdentity.mockImplementation(() => {
      throw new Error("sandbox replaced");
    });
    return { ok: true };
  });
  await expect(f.boundary.withRegisteredAttachmentRollback(f.create)).rejects.toThrow(
    "sandbox replaced",
  );
  expect(f.revalidateSandboxIdentity).toHaveBeenLastCalledWith(
    "rolling back unverified registered inference attachment",
  );
  expect(f.adapter.detachProvider).not.toHaveBeenCalled();
  expect(f.state.attached).toBe(true);
  expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
});
