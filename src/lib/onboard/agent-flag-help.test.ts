// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { describeAgentFlag } from "./agent-flag-help";

describe("describeAgentFlag (#5779)", () => {
  it("lists the installed agent runtimes inline", () => {
    expect(describeAgentFlag(["openclaw", "hermes", "langchain-deepagents-code"])).toBe(
      "Agent runtime to onboard (openclaw, hermes, langchain-deepagents-code; aliases: nemohermes → hermes; nemo-deepagents/dcode/deepagents/deepagents-code/langchain → langchain-deepagents-code)",
    );
  });

  it("ignores empty entries and falls back to the generic text when none are known", () => {
    expect(describeAgentFlag([])).toBe("Agent runtime to onboard");
    expect(describeAgentFlag(["", "openclaw"])).toBe("Agent runtime to onboard (openclaw)");
  });
});
