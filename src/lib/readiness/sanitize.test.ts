// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { sanitizeReadinessText } from "./sanitize.js";

describe("sanitizeReadinessText", () => {
  it("uses URL-aware full redaction for readiness text", () => {
    const result = sanitizeReadinessText(
      "https://service-user:service-password@example.com/path",
      1024,
    );

    expect(result).toBe("https://example.com/path");
    expect(result).not.toContain("service-password");
    expect(result).not.toContain("service-user:");
  });
});
