// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineTool } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import {
  deterministicRiskRecommendations,
  isSupportedE2eSelector,
  mergeRecommendations,
  type E2eRecommendationSelector,
  type TrustedE2eRecommendationInventory,
} from "../advisors/e2e-recommendations.mts";
import type { RiskPlan } from "../advisors/risk-plan.mts";

export const E2E_RECEIPT_TOOL = "pr_review_record_e2e_recommendations";
const text = Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" });
const selectorSchema = Type.Object(
  {
    selectorType: Type.Union([Type.Literal("job"), Type.Literal("target"), Type.Literal("all")]),
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,127}$" }),
    required: Type.Boolean(),
    reason: text,
  },
  { additionalProperties: false },
);

export const e2eRecommendationInputSchema = Type.Object(
  {
    recommendations: Type.Array(selectorSchema, { maxItems: 200 }),
    noAdditionalE2eReason: Type.Union([text, Type.Null()]),
    unresolvedRecommendations: Type.Array(text, { maxItems: 50 }),
  },
  { additionalProperties: false },
);

export type E2eRecommendationInput = Static<typeof e2eRecommendationInputSchema>;
export type RecommendationSelector = E2eRecommendationSelector;

export type SpecialistE2eReceipt = {
  kind: "nemoclaw-advisor-e2e-v1";
  headSha: string;
  baseSha: string;
  interest: string;
  expectedSpecialists: string[];
  deterministic: {
    version: number;
    planHash: string;
  };
  advisor: E2eRecommendationInput;
};

export function validateE2eRecommendations(
  value: unknown,
  inventory: TrustedE2eRecommendationInventory,
): E2eRecommendationInput {
  if (!Check(e2eRecommendationInputSchema, value))
    throw new Error("Invalid E2E recommendation record");
  const input = value as E2eRecommendationInput;
  if ((input.recommendations.length === 0) !== (input.noAdditionalE2eReason !== null)) {
    throw new Error(
      "Empty recommendations require an explicit reason; selected recommendations forbid it",
    );
  }
  const seen = new Set<string>();
  const allowedJobs = new Set([...inventory.allowedJobIds, ...inventory.manualOnlyJobIds]);
  for (const item of input.recommendations) {
    const allowed = isSupportedE2eSelector(item, allowedJobs, inventory.liveSupportedTargetIds);
    const key = `${item.selectorType}:${item.id}`;
    if (!allowed || seen.has(key)) throw new Error(`Unknown or duplicate E2E selector: ${key}`);
    seen.add(key);
  }
  return structuredClone(input);
}

export function createE2eRecommendationRecorder(inventory: TrustedE2eRecommendationInventory) {
  let recorded: E2eRecommendationInput | undefined;
  return {
    tool: defineTool({
      name: E2E_RECEIPT_TOOL,
      label: "Record complete E2E recommendations",
      description: `Record every additional E2E recommendation for this specialist, including optional coverage. Do not repeat the deterministic floor. Record a reason for an empty list. Put needed coverage without a supported selector in unresolvedRecommendations. This records evidence only and cannot dispatch tests. Trusted inventory: ${JSON.stringify(inventory)}`,
      parameters: e2eRecommendationInputSchema,
      executionMode: "sequential",
      execute: async (_id, input) => {
        if (recorded) throw new Error("E2E recommendations were already recorded");
        recorded = validateE2eRecommendations(input, inventory);
        return {
          content: [{ type: "text" as const, text: "E2E recommendations recorded." }],
          details: {},
        };
      },
    }),
    snapshot(): E2eRecommendationInput {
      if (!recorded) throw new Error("Specialist did not record E2E recommendations");
      return structuredClone(recorded);
    },
  };
}

export function buildSpecialistE2eReceipt(input: {
  baseSha: string;
  interest: string;
  expectedSpecialists: string[];
  riskPlan: RiskPlan;
  advisor: unknown;
  inventory: TrustedE2eRecommendationInventory;
}): SpecialistE2eReceipt {
  if (![input.baseSha, input.riskPlan.headSha].every((sha) => /^[0-9a-f]{40}$/.test(sha))) {
    throw new Error("E2E receipt requires full candidate and base SHAs");
  }
  if (
    !input.expectedSpecialists.includes(input.interest) ||
    new Set(input.expectedSpecialists).size !== input.expectedSpecialists.length
  ) {
    throw new Error("E2E receipt requires a unique specialist inventory containing its owner");
  }
  return {
    kind: "nemoclaw-advisor-e2e-v1",
    headSha: input.riskPlan.headSha,
    baseSha: input.baseSha,
    interest: input.interest,
    expectedSpecialists: [...input.expectedSpecialists].sort(),
    deterministic: {
      version: input.riskPlan.version,
      planHash: input.riskPlan.planHash,
    },
    advisor: validateE2eRecommendations(input.advisor, input.inventory),
  };
}

export function collectE2eRecommendations(
  values: unknown[],
  expected: Omit<Parameters<typeof buildSpecialistE2eReceipt>[0], "interest" | "advisor">,
): {
  status: "selected" | "no-tests-needed" | "unresolved";
  recommendations: RecommendationSelector[];
  unresolvedRecommendations: string[];
} {
  if (values.length !== expected.expectedSpecialists.length || values.length === 0) {
    throw new Error("Incomplete specialist E2E evidence");
  }
  const seen = new Set<string>();
  let selected: RecommendationSelector[] = deterministicRiskRecommendations(expected.riskPlan).map(
    ({ workflow: _workflow, ...item }) => item,
  );
  const unresolvedRecommendations: string[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid E2E receipt");
    const raw = value as Record<string, unknown>;
    if (typeof raw.interest !== "string" || seen.has(raw.interest))
      throw new Error("Duplicate or invalid specialist E2E evidence");
    const receipt = buildSpecialistE2eReceipt({
      ...expected,
      interest: raw.interest,
      advisor: raw.advisor,
    });
    if (!isDeepStrictEqual(value, receipt))
      throw new Error("Stale, malformed, or mismatched specialist E2E receipt");
    seen.add(receipt.interest);
    selected = mergeRecommendations(selected, receipt.advisor.recommendations);
    unresolvedRecommendations.push(...receipt.advisor.unresolvedRecommendations);
  }
  const recommendations = selected.sort((a, b) =>
    `${a.selectorType}:${a.id}`.localeCompare(`${b.selectorType}:${b.id}`),
  );
  return {
    status:
      unresolvedRecommendations.length > 0
        ? "unresolved"
        : recommendations.length > 0
          ? "selected"
          : "no-tests-needed",
    recommendations,
    unresolvedRecommendations,
  };
}
