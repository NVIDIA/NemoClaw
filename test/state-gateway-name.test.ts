// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { DEFAULT_GATEWAY_NAME, getGatewayName } from "../src/lib/state/gateway-name.js";

describe("DEFAULT_GATEWAY_NAME", () => {
  it("exposes the canonical singleton gateway name 'nemoclaw'", () => {
    expect(DEFAULT_GATEWAY_NAME).toBe("nemoclaw");
  });
});

describe("getGatewayName", () => {
  it("returns the singleton name for the default 8080 gateway port", () => {
    expect(getGatewayName(8080)).toBe(DEFAULT_GATEWAY_NAME);
  });

  it("returns the singleton name for non-default ports until per-port names land", () => {
    // Today NemoClaw runs a single gateway regardless of which port is
    // configured. Lock the current behaviour so the call-site refactor lands
    // first without behavioural drift; the follow-up resolver swap can flip
    // the per-port branch in one place.
    expect(getGatewayName(8081)).toBe(DEFAULT_GATEWAY_NAME);
    expect(getGatewayName(8990)).toBe(DEFAULT_GATEWAY_NAME);
    expect(getGatewayName(65535)).toBe(DEFAULT_GATEWAY_NAME);
  });
});
