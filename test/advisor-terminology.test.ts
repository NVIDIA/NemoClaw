// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PR_HEAD_COMMIT_PROSE_GUIDANCE } from "../tools/advisors/terminology.mts";
import { buildSystemPrompt as buildE2eSystemPrompt } from "../tools/e2e-advisor/analyze.mts";
import { buildSystemPrompt as buildE2eTargetSystemPrompt } from "../tools/e2e-advisor/targets.mts";
import { buildSystemPrompt as buildPrReviewSystemPrompt } from "../tools/pr-review-advisor/analyze.mts";

describe("advisor commit terminology", () => {
  it("uses PR head commit terminology in every advisor prompt", () => {
    const prompts = [
      buildPrReviewSystemPrompt(),
      buildE2eSystemPrompt(),
      buildE2eTargetSystemPrompt(),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain(PR_HEAD_COMMIT_PROSE_GUIDANCE);
    }
  });
});
