// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// The interactive acceptance prompt is served from bin/lib/usage-notice.json to
// both the installer and `nemoclaw onboard`. Guard the shipped copy against the
// doubled-conjunction defect reported in #7301.

import { describe, expect, it } from "vitest";

import { loadUsageNoticeConfig } from "./usage-notice";

describe("usage notice acceptance prompt (#7301)", () => {
  it("reads the shipped interactive prompt without a doubled word", () => {
    const { interactivePrompt } = loadUsageNoticeConfig();

    // The exact grammatical form the prompt must present to the user.
    expect(interactivePrompt).toBe(
      "Type 'yes' to accept the NemoClaw license and third-party software notice and continue [no]: ",
    );
    // Guard against any adjacent duplicated word ("and and", "the the", ...),
    // not just the specific occurrence that regressed.
    expect(interactivePrompt).not.toMatch(/\b(\w+)\s+\1\b/i);
  });
});
