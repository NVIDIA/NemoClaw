// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { rebindLoopbackDashboardUrlPort } from "./url";

describe("rebindLoopbackDashboardUrlPort", () => {
  it.each([
    ["http://127.0.0.2:18789/dashboard", "http://127.0.0.2:29443/dashboard"],
    ["http://localhost:18789/dashboard", "http://localhost:29443/dashboard"],
    ["https://secure-link.example/dashboard", "https://secure-link.example/dashboard"],
  ] as const)("applies the loopback port policy to %s", (input, expected) => {
    expect(rebindLoopbackDashboardUrlPort(input, 29_443)).toBe(expected);
  });
});
