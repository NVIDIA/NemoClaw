// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { buildOnboardFlags, setAgentRegistryReaderForTest } from "./command-support";

afterEach(() => {
  setAgentRegistryReaderForTest(null);
});

describe("buildOnboardFlags --agent help (#5779)", () => {
  it("includes installed agent runtime names in the --agent description when listAgents succeeds", () => {
    setAgentRegistryReaderForTest(() => ["hermes", "langchain-deepagents-code", "openclaw"]);

    const flags = buildOnboardFlags();

    expect(flags.agent.description).toBe(
      "Agent runtime to onboard (openclaw, hermes, langchain-deepagents-code)",
    );
  });

  it("falls back to the generic --agent description when listAgents throws", () => {
    setAgentRegistryReaderForTest(() => {
      throw new Error("registry unavailable");
    });

    const flags = buildOnboardFlags();

    expect(flags.agent.description).toBe("Agent runtime to onboard");
  });
});
