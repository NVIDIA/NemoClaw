// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ADVISORY_CHECKS, defineAdvisoryRegistry } from "./registry";
import type { AdvisoryCheck } from "./types";

function check(id: string): AdvisoryCheck<unknown> {
  return {
    id,
    phase: "preflight.host",
    severity: "info",
    resumeSafe: true,
    check: () => null,
  };
}

describe("defineAdvisoryRegistry", () => {
  it("preserves explicit order in an immutable registry", () => {
    const registry = defineAdvisoryRegistry([check("first"), check("second")]);

    expect(registry.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(ADVISORY_CHECKS).toEqual([]);
  });

  it("rejects duplicate stable IDs", () => {
    expect(() => defineAdvisoryRegistry([check("duplicate"), check("duplicate")])).toThrow(
      "Duplicate advisory check id 'duplicate'.",
    );
  });
});
