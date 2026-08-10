// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isShieldsDown: vi.fn(),
  openRebuildShieldsWindow: vi.fn(),
}));

vi.mock("../../shields", () => ({
  isShieldsDown: mocks.isShieldsDown,
}));

vi.mock("./rebuild-shields", () => ({
  openRebuildShieldsWindow: mocks.openRebuildShieldsWindow,
}));

import { openRebuildShieldsWindowForState } from "./rebuild-flow-helpers";

describe("rebuild Shields window selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the rebuild Shields window for a live sandbox", () => {
    const window = { relocked: false, wasLocked: true };
    mocks.openRebuildShieldsWindow.mockReturnValue(window);

    expect(openRebuildShieldsWindowForState("alpha", false)).toEqual({
      rebuildShieldsWindow: window,
      staleSandboxWasLocked: false,
    });
    expect(mocks.openRebuildShieldsWindow).toHaveBeenCalledWith("alpha", "nemoclaw");
    expect(mocks.isShieldsDown).not.toHaveBeenCalled();
  });

  it("records Shields up for a stale sandbox without applying Shields down", () => {
    mocks.isShieldsDown.mockReturnValue(false);

    expect(openRebuildShieldsWindowForState("alpha", true)).toEqual({
      rebuildShieldsWindow: { relocked: false, wasLocked: false },
      staleSandboxWasLocked: true,
    });
    expect(mocks.isShieldsDown).toHaveBeenCalledWith("alpha");
    expect(mocks.openRebuildShieldsWindow).not.toHaveBeenCalled();
  });
});
