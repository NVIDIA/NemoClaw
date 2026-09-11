// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { TrustedE2eRecommendationInventory } from "../../../tools/advisors/e2e-recommendations.mts";
import { buildRiskPlan } from "../../../tools/advisors/risk-plan.mts";
import {
  buildSpecialistE2eReceipt,
  collectE2eRecommendations,
  createE2eRecommendationRecorder,
  validateE2eRecommendations,
} from "../../../tools/pr-review-advisor/e2e-receipt.mts";

const inventory: TrustedE2eRecommendationInventory = {
  workflow: "e2e.yaml",
  fanoutId: "e2e-all",
  selectorTypes: ["all", "job", "target"],
  allowedJobIds: ["device-auth-health"],
  manualOnlyJobIds: ["hardware-check"],
  liveSupportedTargetIds: ["sample-target"],
};
const empty = {
  recommendations: [],
  noAdditionalE2eReason: "The change only corrects prose.",
  unresolvedRecommendations: [],
};
const expected = {
  baseSha: "b".repeat(40),
  expectedSpecialists: ["first", "second"],
  riskPlan: buildRiskPlan({ headSha: "a".repeat(40), changedFiles: ["docs/example.mdx"] }),
  inventory,
};
const receipt = (interest: string, advisor: unknown = empty) =>
  buildSpecialistE2eReceipt({ ...expected, interest, advisor });

describe("Advisor E2E receipts", () => {
  it("validates the optional full-suite consumer fixture (#11489)", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../fixtures/review-queue-e2e-optional.json", import.meta.url),
        "utf8",
      ),
    );
    const result = collectE2eRecommendations([fixture], {
      ...expected,
      expectedSpecialists: ["verification-mistake-proofing"],
    });
    expect(result.status).toBe("selected");
    expect(result.recommendations).toEqual([
      { selectorType: "all", id: "e2e-all", required: false, reason: "Verify the default suite." },
    ]);
  });
  it("requires every specialist's explicit empty decision before no tests are needed (#11489)", () => {
    expect(collectE2eRecommendations([receipt("first"), receipt("second")], expected)).toEqual({
      status: "no-tests-needed",
      recommendations: [],
      unresolvedRecommendations: [],
    });
    expect(() => collectE2eRecommendations([], expected)).toThrow("Incomplete");
    expect(() => collectE2eRecommendations([receipt("first")], expected)).toThrow("Incomplete");
    expect(() =>
      validateE2eRecommendations({ ...empty, noAdditionalE2eReason: null }, inventory),
    ).toThrow("explicit reason");
  });

  it("preserves optional, hardware, typed, and full-suite recommendations (#11489)", () => {
    const recommendations = [
      {
        selectorType: "job",
        id: "hardware-check",
        required: false,
        reason: "Verify hardware behavior.",
      },
      {
        selectorType: "target",
        id: "sample-target",
        required: true,
        reason: "Verify target behavior.",
      },
      {
        selectorType: "all",
        id: "e2e-all",
        required: false,
        reason: "Verify all default executions.",
      },
    ];
    const result = collectE2eRecommendations(
      [
        receipt("first", {
          recommendations,
          noAdditionalE2eReason: null,
          unresolvedRecommendations: [],
        }),
        receipt("second"),
      ],
      expected,
    );
    expect(result.status).toBe("selected");
    expect(result.recommendations).toHaveLength(3);
    expect(result.recommendations.filter((item) => !item.required)).toHaveLength(2);
  });

  it("keeps coverage without a supported selector unresolved (#11489)", () => {
    const result = collectE2eRecommendations(
      [
        receipt("first", {
          ...empty,
          unresolvedRecommendations: ["No trusted target covers the new device."],
        }),
        receipt("second"),
      ],
      expected,
    );
    expect(result.status).toBe("unresolved");
    expect(result.unresolvedRecommendations).toHaveLength(1);
  });

  it("deduplicates specialists without weakening a required recommendation (#11489)", () => {
    const item = {
      selectorType: "job",
      id: "device-auth-health",
      reason: "Verify authentication.",
    };
    const receipts = [false, true].map((required, index) =>
      receipt(expected.expectedSpecialists[index], {
        recommendations: [{ ...item, required }],
        noAdditionalE2eReason: null,
        unresolvedRecommendations: [],
      }),
    );
    expect(collectE2eRecommendations(receipts, expected).recommendations).toEqual([
      { ...item, required: true },
    ]);
  });

  it.each([
    { selectorType: "job", id: "invented" },
    { selectorType: "target", id: "device-auth-health" },
    { selectorType: "all", id: "" },
    { selectorType: "job", id: "$(command)" },
  ])("rejects an unsupported selector $selectorType:$id (#11489)", (selector) => {
    expect(() =>
      validateE2eRecommendations(
        {
          recommendations: [{ ...selector, required: true, reason: "Check behavior." }],
          noAdditionalE2eReason: null,
          unresolvedRecommendations: [],
        },
        inventory,
      ),
    ).toThrow();
  });

  it("rejects duplicate recommendations and extra input fields (#11489)", () => {
    const item = {
      selectorType: "job",
      id: "device-auth-health",
      required: true,
      reason: "Verify authentication.",
    };
    expect(() =>
      validateE2eRecommendations(
        {
          recommendations: [item, item],
          noAdditionalE2eReason: null,
          unresolvedRecommendations: [],
        },
        inventory,
      ),
    ).toThrow("duplicate");
    expect(() => validateE2eRecommendations({ ...empty, complete: true }, inventory)).toThrow(
      "Invalid",
    );
  });

  it.each([
    { headSha: "c".repeat(40) },
    { baseSha: "c".repeat(40) },
    { kind: "future-v2" },
    { expectedSpecialists: ["first"] },
    { deterministic: {} },
    { additional: true },
  ])("rejects mismatched receipt fields %j (#11489)", (change) => {
    expect(() =>
      collectE2eRecommendations([{ ...receipt("first"), ...change }, receipt("second")], expected),
    ).toThrow("mismatched");
  });

  it("rejects duplicate specialist receipts (#11489)", () => {
    expect(() => collectE2eRecommendations([receipt("first"), receipt("first")], expected)).toThrow(
      "Duplicate",
    );
  });

  it("preserves the deterministic floor when specialists add no tests (#11489)", () => {
    const input = {
      ...expected,
      riskPlan: buildRiskPlan({
        headSha: expected.riskPlan.headSha,
        changedFiles: ["src/lib/onboard/sandbox-create-launch.ts"],
      }),
    };
    const receipts = input.expectedSpecialists.map((interest) =>
      buildSpecialistE2eReceipt({ ...input, interest, advisor: empty }),
    );
    expect(
      collectE2eRecommendations(receipts, input).recommendations.map((item) => item.id),
    ).toContain("device-auth-health");
  });

  it("requires a successful recording and refuses a second recording (#11489)", async () => {
    const recorder = createE2eRecommendationRecorder(inventory);
    expect(() => recorder.snapshot()).toThrow("did not record");
    const execute = recorder.tool.execute as unknown as (
      id: string,
      value: unknown,
    ) => Promise<unknown>;
    await expect(execute("invalid", {})).rejects.toThrow("Invalid");
    expect(() => recorder.snapshot()).toThrow("did not record");
    await execute("valid", empty);
    expect(recorder.snapshot()).toEqual(empty);
    await expect(execute("again", empty)).rejects.toThrow("already recorded");
    const copy = recorder.snapshot();
    copy.noAdditionalE2eReason = "Changed";
    expect(recorder.snapshot()).toEqual(empty);
  });
});
