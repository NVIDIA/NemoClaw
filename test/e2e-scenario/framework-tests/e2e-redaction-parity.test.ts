// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity test: the framework's local secret-pattern set
 * (test/e2e-scenario/framework/redaction.ts) must stay in
 * lockstep with the canonical product source
 * (src/lib/security/secret-patterns.ts).
 *
 * The framework deliberately mirrors rather than imports — see the
 * "Framework-local mirror" comment in redaction.ts for why — but the
 * mirror is only safe if it is actually a mirror. This test imports
 * the RegExp arrays from both modules and compares them by behavior
 * (`.source` + `.flags`) rather than by source-text shape, so the
 * source-shape budget (ci/source-shape-test-budget.json) stays at 0.
 *
 * The framework-runtime decoupling is preserved: redaction.ts itself
 * does not import from src/lib/security/. Only this test crosses the
 * boundary, which is the entire point of a parity test.
 */

import { describe, expect, it } from "vitest";

import {
  CONTEXT_PATTERNS as FRAMEWORK_CONTEXT_PATTERNS,
  TOKEN_PREFIX_PATTERNS as FRAMEWORK_TOKEN_PREFIX_PATTERNS,
} from "../framework/redaction.ts";
import {
  CONTEXT_PATTERNS as PRODUCT_CONTEXT_PATTERNS,
  TOKEN_PREFIX_PATTERNS as PRODUCT_TOKEN_PREFIX_PATTERNS,
} from "../../../src/lib/security/secret-patterns.ts";

function fingerprint(patterns: readonly RegExp[]): string[] {
  return patterns.map((re) => `${re.source}::${re.flags}`);
}

describe("framework redaction parity with product source-of-truth", () => {
  it("framework token prefix patterns match product token prefix patterns", () => {
    const framework = fingerprint(FRAMEWORK_TOKEN_PREFIX_PATTERNS);
    const product = fingerprint(PRODUCT_TOKEN_PREFIX_PATTERNS);
    expect(framework.length).toBeGreaterThan(0);
    expect(product.length).toBeGreaterThan(0);
    expect(framework).toEqual(product);
  });

  it("framework context patterns match product context patterns", () => {
    const framework = fingerprint(FRAMEWORK_CONTEXT_PATTERNS);
    const product = fingerprint(PRODUCT_CONTEXT_PATTERNS);
    expect(framework.length).toBeGreaterThan(0);
    expect(product.length).toBeGreaterThan(0);
    expect(framework).toEqual(product);
  });
});
