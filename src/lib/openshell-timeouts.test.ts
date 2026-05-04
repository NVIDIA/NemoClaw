// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  OPENSHELL_DOWNLOAD_TIMEOUT_MS,
  OPENSHELL_HEAVY_TIMEOUT_MS,
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "./openshell-timeouts";

describe("openshell-timeouts", () => {
  it("exports positive integer constants", () => {
    const constants = [
      OPENSHELL_PROBE_TIMEOUT_MS,
      OPENSHELL_OPERATION_TIMEOUT_MS,
      OPENSHELL_HEAVY_TIMEOUT_MS,
      OPENSHELL_DOWNLOAD_TIMEOUT_MS,
    ];

    for (const value of constants) {
      expect(value).toBeTypeOf("number");
      expect(value).toBeGreaterThan(0);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("maintains expected ordering: PROBE < OPERATION <= DOWNLOAD < HEAVY", () => {
    expect(OPENSHELL_PROBE_TIMEOUT_MS).toBeLessThan(OPENSHELL_OPERATION_TIMEOUT_MS);
    expect(OPENSHELL_OPERATION_TIMEOUT_MS).toBeLessThanOrEqual(OPENSHELL_DOWNLOAD_TIMEOUT_MS);
    expect(OPENSHELL_DOWNLOAD_TIMEOUT_MS).toBeLessThan(OPENSHELL_HEAVY_TIMEOUT_MS);
  });

  it("uses the same probe constant name as PR #2454 for forward compatibility", () => {
    // PR #2454 introduces OPENSHELL_PROBE_TIMEOUT_MS = 15_000 locally.
    // This ensures the shared module stays aligned so #2454 can import it after rebase.
    expect(OPENSHELL_PROBE_TIMEOUT_MS).toBe(15_000);
  });
});
