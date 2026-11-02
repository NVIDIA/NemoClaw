// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
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
    expect(f.state.attached).toBe(false);
    expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
    expect(f.revalidateSandboxIdentity).toHaveBeenLastCalledWith(
      "removing newly attached registered inference provider",
    );
    expect(f.revalidateSandboxIdentity.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.adapter.detachProvider.mock.invocationCallOrder[0]!,
    );
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
  f.revalidateSandboxIdentity
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw new Error("identity check unavailable");
    });
  await expect(f.boundary.withRegisteredAttachmentRollback(f.create)).rejects.toThrow(
    "identity check unavailable",
  );
  expect(f.revalidateSandboxIdentity).toHaveBeenNthCalledWith(
    3,
    "verifying restored registered inference attachment",
  );
  expect(f.revalidateSandboxIdentity).toHaveBeenLastCalledWith(
    "removing newly attached registered inference provider",
  );
  expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
  expect(f.state.attached).toBe(false);
});

it.each([
  {
    replaced: false,
    revalidate: () => undefined,
    error: "changed during attachment",
    detachCount: 1,
  },
  {
    replaced: true,
    revalidate: () => {
      throw new Error("sandbox replaced");
    },
    error: "sandbox replaced",
    detachCount: 0,
  },
])(
  "revalidates the sandbox before internal attachment rollback (replaced=$replaced)",
  async ({ replaced, revalidate, error, detachCount }) => {
    const f = rollbackFixture(false, false, false);
    f.adapter.attachProvider.mockImplementation(async () => {
      f.state.attached = true;
      f.state.revision++;
      f.revalidateSandboxIdentity.mockImplementation(revalidate);
      return { ok: true };
    });
    await expect(f.boundary.withRegisteredAttachmentRollback(f.create)).rejects.toThrow(error);
    expect(f.revalidateSandboxIdentity).toHaveBeenLastCalledWith(
      "rolling back unverified registered inference attachment",
    );
    expect(f.adapter.detachProvider).toHaveBeenCalledTimes(detachCount);
    expect(f.state.attached).toBe(replaced);
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  },
);
