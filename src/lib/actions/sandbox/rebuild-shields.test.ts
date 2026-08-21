// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isShieldsDown: vi.fn(),
  openBackupShieldsWindow: vi.fn(),
  rebindReplacementConfigLock: vi.fn(),
  relockBackupShieldsWindow: vi.fn(),
}));

vi.mock("../../shields", () => ({
  isShieldsDown: mocks.isShieldsDown,
  rebindReplacementConfigLock: mocks.rebindReplacementConfigLock,
}));

vi.mock("./backup-shields-window", () => ({
  openBackupShieldsWindow: mocks.openBackupShieldsWindow,
  relockBackupShieldsWindow: mocks.relockBackupShieldsWindow,
}));

import {
  markRebuildShieldsSourceDeleted,
  openRebuildShieldsWindow,
  relockRebuildShieldsWindow,
} from "./rebuild-shields";

describe("external-policy rebuild Shields window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isShieldsDown.mockReturnValue(false);
  });

  it("keeps policy untouched and rebinds only the replacement config lock (#9833)", () => {
    const window = openRebuildShieldsWindow("alpha", "nemoclaw", "externally-managed");

    expect(window).toEqual({
      policyAuthority: "externally-managed",
      relocked: false,
      sourceDeleted: false,
      wasLocked: true,
    });
    expect(mocks.openBackupShieldsWindow).not.toHaveBeenCalled();

    markRebuildShieldsSourceDeleted(window!);
    expect(relockRebuildShieldsWindow("alpha", window!, true, "nemoclaw")).toBe(true);

    expect(mocks.rebindReplacementConfigLock).toHaveBeenCalledWith("alpha", true);
    expect(mocks.relockBackupShieldsWindow).not.toHaveBeenCalled();
  });
});
