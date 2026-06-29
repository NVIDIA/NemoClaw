// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../tools/e2e-advisor/analyze.mts";

describe("E2E recommendation advisor prompt", () => {
  it("requires resume and repair E2E for onboarding machine compatibility changes", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("Onboarding resume compatibility rule");
    expect(prompt).toContain("onboard-resume-e2e");
    expect(prompt).toContain("onboard-repair-e2e");
    expect(prompt).toContain("src/lib/onboard/machine");
  });
});
