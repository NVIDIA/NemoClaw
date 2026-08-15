// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CONTEXT_SECRET_PATTERNS } from "../nemoclaw/src/security/credential-filter.ts";
import { CONTEXT_PATTERNS } from "../src/lib/security/secret-patterns.ts";

function fingerprint(patterns: readonly RegExp[]): string[] {
  return patterns.map((pattern) => `${pattern.source}::${pattern.flags}`);
}

describe("NemoClaw plugin secret-pattern parity", () => {
  it("matches every canonical context pattern source and flag", () => {
    expect(CONTEXT_PATTERNS.length).toBeGreaterThan(0);
    expect(fingerprint(CONTEXT_SECRET_PATTERNS)).toEqual(fingerprint(CONTEXT_PATTERNS));
  });
});
