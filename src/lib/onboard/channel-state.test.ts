// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { resolveDisabledChannels } from "./channel-state";

describe("onboard channel state helpers", () => {
  it("prefers disabledChannels from the onboard session mirror", () => {
    const getRegistryDisabledChannels = vi.fn(() => ["discord"]);

    expect(
      resolveDisabledChannels("alpha", {
        loadSession: () => ({ disabledChannels: ["telegram"] }),
        getRegistryDisabledChannels,
      }),
    ).toEqual(["telegram"]);
    expect(getRegistryDisabledChannels).not.toHaveBeenCalled();
  });

  it("falls back to the registry when the session has no mirror", () => {
    expect(
      resolveDisabledChannels("alpha", {
        loadSession: () => ({ disabledChannels: null }),
        getRegistryDisabledChannels: (sandboxName) =>
          sandboxName === "alpha" ? ["discord"] : [],
      }),
    ).toEqual(["discord"]);
  });

  it("treats an empty session mirror as authoritative", () => {
    const getRegistryDisabledChannels = vi.fn(() => ["telegram"]);

    expect(
      resolveDisabledChannels("alpha", {
        loadSession: () => ({ disabledChannels: [] }),
        getRegistryDisabledChannels,
      }),
    ).toEqual([]);
    expect(getRegistryDisabledChannels).not.toHaveBeenCalled();
  });
});
