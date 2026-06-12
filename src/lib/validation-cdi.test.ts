// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifySandboxCreateFailure } from "../../dist/lib/validation";

describe("classifySandboxCreateFailure GPU CDI injection arm", () => {
  it("detects GPU CDI injection failure from 'CDI device injection failed'", () => {
    const result = classifySandboxCreateFailure(
      "Error response from daemon: CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
    );
    expect(result.kind).toBe("gpu_cdi_injection_failed");
  });

  it("detects GPU CDI injection failure from 'unresolvable CDI devices' alone", () => {
    const result = classifySandboxCreateFailure("unresolvable CDI devices nvidia.com/gpu=all");
    expect(result.kind).toBe("gpu_cdi_injection_failed");
  });

  it("does NOT misclassify generic CDI mentions as gpu_cdi_injection_failed", () => {
    const result = classifySandboxCreateFailure("CDI spec directories configured");
    expect(result.kind).toBe("unknown");
  });

  it("does NOT classify non-GPU CDI injection failures as gpu_cdi_injection_failed", () => {
    const result = classifySandboxCreateFailure(
      "CDI device injection failed: unresolvable CDI devices example.com/widget=all",
    );
    expect(result.kind).toBe("unknown");
  });

  it("classifies gpu_cdi_injection_failed even when 'Created sandbox:' is also present", () => {
    const output =
      "Created sandbox: test-sandbox\nError response from daemon: CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all";
    const result = classifySandboxCreateFailure(output);
    expect(result.kind).toBe("gpu_cdi_injection_failed");
  });
});
