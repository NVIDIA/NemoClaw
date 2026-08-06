// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { getCuaQualificationSandboxObservationDigest } from "../../../tools/e2e/cua-qualification-receipt.mts";

describe("CUA qualification observation identity", () => {
  it("canonicalizes observations without locale-sensitive sorting", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => 0);

    expect(
      getCuaQualificationSandboxObservationDigest(
        "nemoclaw-status-absent",
        "cua-qualification-test",
      ),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(localeCompare).not.toHaveBeenCalled();
  });
});
