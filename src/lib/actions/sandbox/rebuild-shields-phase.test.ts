// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RebuildBail } from "./rebuild-credential-preflight";

const phaseMocks = vi.hoisted(() => ({
  openWindow: vi.fn(),
  relockWindow: vi.fn(),
}));

vi.mock("./rebuild-flow-helpers", () => ({
  openRebuildShieldsWindowForState: phaseMocks.openWindow,
}));

vi.mock("./rebuild-shields", () => ({
  relockRebuildShieldsWindow: phaseMocks.relockWindow,
}));

import { runRebuildShieldsPhase } from "./rebuild-shields-phase";

describe("rebuild Shields phase", () => {
  const window = { relocked: false, wasLocked: true };

  beforeEach(() => {
    vi.clearAllMocks();
    window.relocked = false;
    phaseMocks.openWindow.mockReturnValue({
      rebuildShieldsWindow: window,
      staleSandboxWasLocked: false,
    });
    phaseMocks.relockWindow.mockReturnValue(true);
  });

  it("returns relock controls for an opened Shields window", () => {
    const releaseOnboardLock = vi.fn();
    const bail = vi.fn();

    const phase = runRebuildShieldsPhase(
      "alpha",
      false,
      releaseOnboardLock,
      bail as unknown as RebuildBail,
    );

    expect(phaseMocks.openWindow).toHaveBeenCalledWith("alpha", false);
    expect(phase).toMatchObject({ window, staleSandboxWasLocked: false });
    expect(phase?.relock(true)).toBe(true);
    expect(phaseMocks.relockWindow).toHaveBeenCalledWith("alpha", window, true, "nemoclaw");
    expect(releaseOnboardLock).not.toHaveBeenCalled();
    expect(bail).not.toHaveBeenCalled();
  });

  it("releases the onboarding lock when Shields down cannot open a rebuild window", () => {
    phaseMocks.openWindow.mockReturnValue({
      rebuildShieldsWindow: null,
      staleSandboxWasLocked: false,
    });
    const releaseOnboardLock = vi.fn();
    const bail = vi.fn();

    expect(
      runRebuildShieldsPhase("alpha", false, releaseOnboardLock, bail as unknown as RebuildBail),
    ).toBeNull();

    expect(releaseOnboardLock).toHaveBeenCalledOnce();
    expect(bail).toHaveBeenCalledWith("Failed to auto-unlock shields.");
    expect(phaseMocks.relockWindow).not.toHaveBeenCalled();
  });

  it("releases the onboarding lock when Shields state inspection throws", () => {
    phaseMocks.openWindow.mockImplementation(() => {
      throw new Error("Shields state is unreadable");
    });
    const releaseOnboardLock = vi.fn();

    expect(() =>
      runRebuildShieldsPhase("alpha", false, releaseOnboardLock, vi.fn() as unknown as RebuildBail),
    ).toThrow("Shields state is unreadable");

    expect(releaseOnboardLock).toHaveBeenCalledOnce();
    expect(phaseMocks.relockWindow).not.toHaveBeenCalled();
  });
});
