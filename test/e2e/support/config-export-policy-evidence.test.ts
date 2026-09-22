// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { requireEffectivePolicyDocument } from "./config-export-policy-evidence.ts";

describe("config export effective policy evidence", () => {
  it("returns a successful effective policy observation", () => {
    expect(
      requireEffectivePolicyDocument({
        ok: true,
        value: { appliedRevision: 1, document: "version: 1" },
      }),
    ).toBe("version: 1");
  });

  it("rejects a failed effective policy observation", () => {
    expect(() =>
      requireEffectivePolicyDocument({
        ok: false,
        error: { kind: "command", reason: "failed", message: "policy unavailable" },
      }),
    ).toThrow("the effective sandbox policy could not be read: policy unavailable");
  });
});
