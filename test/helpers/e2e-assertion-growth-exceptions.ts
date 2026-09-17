// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
const { Type } = require("typebox") as typeof TypeBoxModule;
const { Check } = require("typebox/value") as typeof TypeBoxValueModule;
import type { E2eAssertionBudget } from "../../scripts/checks/e2e-assertion-census.mts";
import type { GrowthGuardrailDiff } from "./growth-guardrail-diff";

export const E2E_ASSERTION_GROWTH_EXCEPTIONS_FILE = "ci/e2e-assertion-growth-exceptions.json";
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const metrics = Type.Object(
  { expectCalls: count, assertionPoints: count },
  { additionalProperties: false },
);
const limits = Type.Object(
  {
    liveFileCount: count,
    direct: metrics,
    unique: metrics,
    files: Type.Record(
      Type.String({ pattern: "^test/e2e/live/[a-zA-Z0-9_/-]+[.]test[.]ts$" }),
      Type.Tuple([count, count, count, count, count]),
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const policySchema = Type.Object(
  {
    $comment: Type.Optional(Type.String()),
    schemaVersion: Type.Literal(1),
    exceptions: Type.Array(
      Type.Object(
        {
          pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          paths: Type.Array(Type.String({ pattern: "^test/e2e/live/[a-zA-Z0-9_/.-]+[.]ts$" }), {
            minItems: 1,
            uniqueItems: true,
          }),
          baseline: limits,
          maximum: limits,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Bound growth by both the reviewed increase and ceiling after baseline changes. */
function boundedMaximum(current: number, approvedBase: number, maximum: number): number {
  if (maximum < approvedBase) throw new Error("E2E growth maximum is below its approved baseline");
  return Math.max(current, Math.min(maximum, current + maximum - approvedBase));
}

/** Policy must come from the trusted base; candidate policy is never an input. */
export function applyTrustedE2eAssertionGrowthException(
  base: E2eAssertionBudget,
  source: string | null | undefined,
  diff: Pick<GrowthGuardrailDiff, "files" | "pullRequestNumber">,
): E2eAssertionBudget {
  if (source === null || source === undefined) return base;
  const policy: unknown = JSON.parse(source);
  if (!Check(policySchema, policy)) throw new Error("Invalid trusted E2E growth exception policy");
  const numbers = policy.exceptions.map(({ pullRequest }) => pullRequest);
  if (new Set(numbers).size !== numbers.length)
    throw new Error("Duplicate E2E growth exception PR");
  const exception = policy.exceptions.find(
    ({ pullRequest }) => pullRequest === diff.pullRequestNumber,
  );
  if (!exception) return base;
  const changedLivePaths = new Set(
    diff.files.flatMap(({ filename, previous_filename }) =>
      [filename, previous_filename].filter((file): file is string =>
        Boolean(file?.startsWith("test/e2e/live/")),
      ),
    ),
  );
  if (
    changedLivePaths.size !== exception.paths.length ||
    exception.paths.some((file) => !changedLivePaths.has(file))
  )
    return base;
  const { baseline, maximum } = exception;
  if (
    Object.keys(baseline.files).sort().join("\n") !== Object.keys(maximum.files).sort().join("\n")
  ) {
    throw new Error("E2E growth baseline and maximum must cover the same test files");
  }
  const files = { ...base.limits.files };
  for (const [file, cap] of Object.entries(maximum.files)) {
    if (!exception.paths.includes(file))
      throw new Error("E2E growth test is outside approved paths");
    const current = files[file];
    if (!current) throw new Error("E2E growth exception requires an existing test budget");
    files[file] = cap.map((value, index) =>
      boundedMaximum(current[index]!, baseline.files[file]![index]!, value),
    ) as typeof cap;
  }
  const adjustedMetrics = (view: "direct" | "unique") => ({
    ...base.limits[view],
    expectCalls: boundedMaximum(
      base.limits[view].expectCalls,
      baseline[view].expectCalls,
      maximum[view].expectCalls,
    ),
    assertionPoints: boundedMaximum(
      base.limits[view].assertionPoints,
      baseline[view].assertionPoints,
      maximum[view].assertionPoints,
    ),
  });
  return {
    ...base,
    limits: {
      ...base.limits,
      liveFileCount: boundedMaximum(
        base.limits.liveFileCount,
        baseline.liveFileCount,
        maximum.liveFileCount,
      ),
      direct: adjustedMetrics("direct"),
      unique: adjustedMetrics("unique"),
      files,
    },
  };
}
