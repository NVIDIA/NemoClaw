// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectSandbox: vi.fn(),
  enforceRemovedImmutabilityMigrationBoundary: vi.fn(),
  reportRemovedImmutabilityUpgrade: vi.fn(),
  validateSandboxName: vi.fn(),
  withSandboxLifecycleLock: vi.fn(async (_name: string, operation: () => Promise<void>) =>
    operation(),
  ),
}));

vi.mock("../connect", () => ({
  connectSandbox: mocks.connectSandbox,
  validateHermesPortablePrewarmSandboxName: mocks.validateSandboxName,
}));
vi.mock("../../../state/migrations/removed-immutability", () => ({
  enforceRemovedImmutabilityMigrationBoundary: mocks.enforceRemovedImmutabilityMigrationBoundary,
  reportRemovedImmutabilityUpgrade: mocks.reportRemovedImmutabilityUpgrade,
}));
vi.mock("../lifecycle/lock", () => ({
  withSandboxLifecycleLock: mocks.withSandboxLifecycleLock,
}));

import { prewarmHermesPortableSandbox } from ".";

describe("prewarmHermesPortableSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves command boundaries around the exact Hermes-only probe", async () => {
    await prewarmHermesPortableSandbox("my-assistant");

    expect(mocks.validateSandboxName).toHaveBeenCalledWith("my-assistant");
    expect(mocks.reportRemovedImmutabilityUpgrade).toHaveBeenCalledOnce();
    expect(mocks.enforceRemovedImmutabilityMigrationBoundary).toHaveBeenCalledTimes(2);
    expect(mocks.withSandboxLifecycleLock).toHaveBeenCalledWith(
      "my-assistant",
      expect.any(Function),
    );
    expect(mocks.connectSandbox).toHaveBeenCalledWith("my-assistant", {
      probeOnly: true,
      requireHermesPortablePrewarmAuthority: true,
    });
  });

  it("rejects invalid names before inspecting or mutating state", async () => {
    mocks.validateSandboxName.mockImplementationOnce(() => {
      throw new Error("Invalid sandbox name");
    });
    await expect(prewarmHermesPortableSandbox("../../wrong sandbox")).rejects.toThrow(
      "Invalid sandbox name",
    );

    expect(mocks.reportRemovedImmutabilityUpgrade).not.toHaveBeenCalled();
    expect(mocks.enforceRemovedImmutabilityMigrationBoundary).not.toHaveBeenCalled();
    expect(mocks.withSandboxLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.connectSandbox).not.toHaveBeenCalled();
  });

  it("keeps the public upgrade warning behavior before probing", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.reportRemovedImmutabilityUpgrade.mockImplementationOnce(() => {
      throw new Error("inspection unavailable");
    });

    await prewarmHermesPortableSandbox("my-assistant");

    expect(warning).toHaveBeenCalledWith(expect.stringContaining("inspection unavailable"));
    expect(mocks.connectSandbox).toHaveBeenCalledOnce();
  });
});
