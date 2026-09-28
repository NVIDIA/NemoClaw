// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { exactGatewayRelease } from "../fixtures/openshell-v0116-qualification.ts";

describe("external gateway release qualification", () => {
  it.each([
    ["openshell-gateway 0.0.116\n", "0.0.116"],
    ["openshell-gateway v0.0.116\n", "0.0.116"],
    ["openshell-gateway 0.0.116-dev.1\n", "0.0.116-dev.1"],
    ["diagnostic 0.0.115\nopenshell-gateway 0.0.116\n", null],
  ] as const)("extracts one complete release token from %j", (output, expected) => {
    expect(exactGatewayRelease(output)).toBe(expected);
  });
});
