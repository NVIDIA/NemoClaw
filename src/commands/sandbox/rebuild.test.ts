// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  delegateRebuildToOwningRegistry: vi.fn(async () => false),
  delegateRecoveryRetirementToOwningRegistry: vi.fn(async () => false),
  rebuildSandbox: vi.fn(async () => undefined),
  retireRebuildRecoveryBackup: vi.fn(() => ({
    backupPath: "/backups/alpha/2026-09-01",
    gatewayName: "nemoclaw-18080",
    transactionId: "11111111-1111-4111-8111-111111111111",
  })),
}));

vi.mock("../../lib/actions/sandbox/rebuild", () => mocks);
vi.mock("../../lib/actions/sandbox/rebuild/owning-registry", () => ({
  delegateRebuildToOwningRegistry: mocks.delegateRebuildToOwningRegistry,
  delegateRecoveryRetirementToOwningRegistry: mocks.delegateRecoveryRetirementToOwningRegistry,
}));

import RebuildCliCommand from "./rebuild";

const rootDir = process.cwd();

describe("sandbox:rebuild command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes exact confirmed recovery retirement without starting a rebuild", async () => {
    const logSpy = vi.spyOn(RebuildCliCommand.prototype, "log");

    await RebuildCliCommand.run(
      ["alpha", "--retire-recovery", "11111111-1111-4111-8111-111111111111", "--yes"],
      rootDir,
    );

    expect(mocks.retireRebuildRecoveryBackup).toHaveBeenCalledWith({
      sandboxName: "alpha",
      transactionId: "11111111-1111-4111-8111-111111111111",
      confirmDataRecovered: true,
    });
    expect(mocks.delegateRecoveryRetirementToOwningRegistry).toHaveBeenCalledWith(
      {
        sandboxName: "alpha",
        transactionId: "11111111-1111-4111-8111-111111111111",
        confirmDataRecovered: true,
      },
      expect.any(String),
      expect.any(String),
    );
    expect(mocks.rebuildSandbox).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "Retired rebuild recovery '11111111-1111-4111-8111-111111111111' for sandbox 'alpha' from /backups/alpha/2026-09-01.",
    );
  });

  it("delegates sibling-root recovery retirement before the command lifecycle fence", async () => {
    mocks.delegateRecoveryRetirementToOwningRegistry.mockResolvedValueOnce(true);

    await RebuildCliCommand.run(
      ["alpha", "--retire-recovery", "11111111-1111-4111-8111-111111111111", "--yes"],
      rootDir,
    );

    expect(mocks.retireRebuildRecoveryBackup).not.toHaveBeenCalled();
    expect(mocks.rebuildSandbox).not.toHaveBeenCalled();
  });

  it("does not infer data-recovery confirmation when --yes is absent", async () => {
    await RebuildCliCommand.run(
      ["alpha", "--retire-recovery", "11111111-1111-4111-8111-111111111111"],
      rootDir,
    );

    expect(mocks.retireRebuildRecoveryBackup).toHaveBeenCalledWith(
      expect.objectContaining({ confirmDataRecovered: false }),
    );
    expect(mocks.rebuildSandbox).not.toHaveBeenCalled();
  });

  it("preserves the ordinary rebuild route", async () => {
    await RebuildCliCommand.run(["alpha", "--yes"], rootDir);

    expect(mocks.rebuildSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ yes: true }),
    );
    expect(mocks.retireRebuildRecoveryBackup).not.toHaveBeenCalled();
  });

  it("delegates a sibling-root rebuild before the command lifecycle fence", async () => {
    mocks.delegateRebuildToOwningRegistry.mockResolvedValueOnce(true);

    await RebuildCliCommand.run(["alpha", "--yes", "--verbose"], rootDir);

    expect(mocks.delegateRebuildToOwningRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        options: expect.objectContaining({ yes: true, verbose: true }),
        executionOptions: {},
      }),
      expect.any(String),
      expect.any(String),
    );
    expect(mocks.rebuildSandbox).not.toHaveBeenCalled();
  });
});
