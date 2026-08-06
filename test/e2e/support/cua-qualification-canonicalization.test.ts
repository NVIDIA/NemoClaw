// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getCuaQualificationSandboxObservationDigest } from "../../../tools/e2e/cua-qualification-receipt.mts";

describe("CUA qualification observation identity", () => {
  it("canonicalizes observations to a fixed digest vector", () => {
    expect(
      getCuaQualificationSandboxObservationDigest(
        "nemoclaw-status-absent",
        "cua-qualification-test",
      ),
    ).toBe("sha256:7a9ce89519656d49169c7d7d596e269d15d49fa8f6335bcdd6ad6f5eb07db9e9");
  });
});
