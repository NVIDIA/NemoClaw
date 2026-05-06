// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { B, D, G, R, RD, YW } from "./terminal-style";

describe("terminal-style", () => {
  it("exports terminal style strings", () => {
    for (const value of [B, D, G, R, RD, YW]) {
      expect(typeof value).toBe("string");
    }
  });
});
