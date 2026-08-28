// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  loadAdvisorSchema,
  metadata,
  validResult,
} from "../../helpers/pr-review-advisor-test-fixtures.ts";

describe("PR review advisor", () => {
  it.each(["needs_rework", "blocked"])(
    "rejects retired public recommendation %s",
    (recommendation) => {
      const schema = loadAdvisorSchema();
      const validate = new Ajv2020({ strict: false }).compile(schema);

      expect(validate(validResult({ summary: { ...validResult().summary, recommendation } }))).toBe(
        false,
      );
    },
  );

  it("normalizes output that validates against the JSON schema", () => {
    const schema = loadAdvisorSchema();
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const result = validResult();

    expect(schema["SPDX-License-Identifier"]).toBe("Apache-2.0");
    expect(validate(result)).toBe(true);

    const decision = {
      id: "T-001",
      term: "review-bound",
      change: "introduced",
      disposition: "replace",
      meaning: "Evidence for one revision.",
      contrast: null,
      existingTerm: "commit SHA",
      semanticImpact: "evidence",
      recommendation: "Use commit SHA.",
      traceId: "term-valid",
      source: { file: "WRITING.md", line: 12, headSha: "a".repeat(40) },
    };
    const invalidReceipts = [
      {
        status: "clear",
        decisions: [],
        noChangesReason: "No candidates.\nInjected text.",
      },
      {
        status: "candidates",
        decisions: [{ ...decision, term: "review-bound\ninjected" }],
        noChangesReason: null,
      },
      {
        status: "candidates",
        decisions: [{ ...decision, recommendation: "Use commit SHA.\nInjected text." }],
        noChangesReason: null,
      },
      {
        status: "candidates",
        decisions: [{ ...decision, source: { ...decision.source, headSha: "abc123" } }],
        noChangesReason: null,
      },
    ];
    expect(invalidReceipts.every((terminologyReview) =>
        Object.is(validate({ ...result, terminologyReview }), false))).toBe(true);
  });
});
