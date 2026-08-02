// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { containsSecurityResourceLimitDiagnostic } from "../fixtures/resource-limit-diagnostics.ts";

describe("resource-limit security diagnostics", () => {
  it.each([
    "[SECURITY] Sandbox resource limits were NOT hardened for this shell.",
    "[SECURITY] Could not set soft nproc limit",
    "[SECURITY] Could not set hard nofile limit",
    "[SECURITY] Effective sandbox resource limits do not match policy",
  ])("recognizes a failed hardening warning: %s", (warning) => {
    expect(containsSecurityResourceLimitDiagnostic(warning)).toBe(true);
  });

  it("ignores unrelated security and shell output", () => {
    expect(
      containsSecurityResourceLimitDiagnostic(
        "[SECURITY] Provider credentials are unavailable.\nnproc_soft=512\nnofile_soft=65536",
      ),
    ).toBe(false);
  });
});
