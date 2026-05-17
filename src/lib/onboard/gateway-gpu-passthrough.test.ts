// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { shouldInspectLegacyGatewayGpuPassthrough } from "./gateway-gpu-passthrough";
import type { GatewayReuseState } from "../state/gateway";

describe("gateway GPU passthrough inspection", () => {
  it("only inspects reusable legacy gateway containers", () => {
    const healthy: GatewayReuseState = "healthy";
    const missing: GatewayReuseState = "missing";

    expect(shouldInspectLegacyGatewayGpuPassthrough(healthy, true, false, true)).toBe(true);
    expect(shouldInspectLegacyGatewayGpuPassthrough(healthy, true, false, false)).toBe(false);
    expect(shouldInspectLegacyGatewayGpuPassthrough(healthy, true, true, true)).toBe(false);
    expect(shouldInspectLegacyGatewayGpuPassthrough(missing, true, false, true)).toBe(false);
    expect(shouldInspectLegacyGatewayGpuPassthrough(healthy, false, false, true)).toBe(false);
  });
});
