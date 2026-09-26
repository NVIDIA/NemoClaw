// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../test/helpers/timeouts";

const mocks = vi.hoisted(() => ({
  delegateRebuildToOwningRegistry: vi.fn(async () => false),
  delegateRecoveryRetirementToOwningRegistry: vi.fn(async () => false),
  enforceRemovedImmutabilityMigrationBoundary: vi.fn(),
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
vi.mock("../../lib/state/migrations/removed-immutability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/state/migrations/removed-immutability")>()),
  enforceRemovedImmutabilityMigrationBoundary: mocks.enforceRemovedImmutabilityMigrationBoundary,
}));

import RebuildCliCommand from "./rebuild";

const rootDir = process.cwd();
let home: string;

describe("sandbox:rebuild command", testTimeoutOptions(15_000), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-command-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { force: true, recursive: true });
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

  it("blocks delegated recovery retirement at the legacy-authority boundary", async () => {
    mocks.enforceRemovedImmutabilityMigrationBoundary.mockImplementationOnce(() => {
      throw new Error("legacy recovery artifacts remain");
    });

    await expect(
      RebuildCliCommand.run(
        ["alpha", "--retire-recovery", "11111111-1111-4111-8111-111111111111", "--yes"],
        rootDir,
      ),
    ).rejects.toThrow("legacy recovery artifacts remain");

    expect(mocks.enforceRemovedImmutabilityMigrationBoundary).toHaveBeenCalledWith("alpha", {
      allowStateRecord: true,
    });
    expect(mocks.delegateRecoveryRetirementToOwningRegistry).not.toHaveBeenCalled();
    expect(mocks.retireRebuildRecoveryBackup).not.toHaveBeenCalled();
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
