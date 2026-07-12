// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { stringSetsEqual } from "./hermes-managed-tools";

describe("stringSetsEqual", () => {
  it("accepts equal selections regardless of order or duplicates", () => {
    expect(stringSetsEqual(["nous-web", "nous-code"], ["nous-code", "nous-web"])).toBe(true);
    expect(stringSetsEqual(["nous-web", "nous-web"], ["nous-web"])).toBe(true);
  });

  it("rejects selections with a missing or additional gateway", () => {
    expect(stringSetsEqual(["nous-web"], ["nous-web", "nous-code"])).toBe(false);
    expect(stringSetsEqual(["nous-web", "nous-code"], ["nous-web"])).toBe(false);
  });
});
