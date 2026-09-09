// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { HermesPortableRecoveryRollbackError } from "./hermes-portable-lifecycle";

describe("Hermes Portable recovery error", () => {
  it("retains structured failure classes without exposing nested diagnostics (#11248)", () => {
    const primary = new Error("startup refused with Bearer do-not-print");
    const rollback = new Error("rollback diagnostic do-not-print");
    const error = new HermesPortableRecoveryRollbackError(
      "startup-launch",
      "openshell-terminal-settlement",
      primary,
      rollback,
    );

    expect(error).toMatchObject({
      primaryFailureClass: "startup-launch",
      rollbackFailureClass: "openshell-terminal-settlement",
    });
    expect(error.errors).toEqual([primary, rollback]);
    expect(error.message).toBe(
      "Hermes portable lifecycle recovery failed (primary=startup-launch; rollback=openshell-terminal-settlement-unproved)",
    );
    expect(error.message).not.toContain("do-not-print");
  });
});
