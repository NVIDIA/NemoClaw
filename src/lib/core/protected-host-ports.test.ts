// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

describe("protected NemoClaw host ports", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the default and automatic gateway ports reserved under an override", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.resetModules();

    const {
      AUTOMATIC_GATEWAY_PORT_RANGE_END,
      AUTOMATIC_GATEWAY_PORT_RANGE_START,
      DEFAULT_GATEWAY_PORT,
      isProtectedNemoClawHostPort,
    } = await import("./protected-host-ports");

    expect(isProtectedNemoClawHostPort(DEFAULT_GATEWAY_PORT)).toBe(true);
    expect(isProtectedNemoClawHostPort(18080)).toBe(true);
    expect(isProtectedNemoClawHostPort(AUTOMATIC_GATEWAY_PORT_RANGE_START)).toBe(true);
    expect(isProtectedNemoClawHostPort(AUTOMATIC_GATEWAY_PORT_RANGE_END)).toBe(true);
    expect(isProtectedNemoClawHostPort(AUTOMATIC_GATEWAY_PORT_RANGE_START - 1)).toBe(false);
    expect(isProtectedNemoClawHostPort(AUTOMATIC_GATEWAY_PORT_RANGE_END + 1)).toBe(false);
  });
});
