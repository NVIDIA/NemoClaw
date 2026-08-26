// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { buildOnboardFlags, onboardUsage, setAgentRegistryReaderForTest } from "./command-support";

afterEach(() => {
  setAgentRegistryReaderForTest(null);
});

describe("buildOnboardFlags --agent help (#5779)", () => {
  it("includes installed agent runtime names in the --agent description when listAgents succeeds", () => {
    setAgentRegistryReaderForTest(() => ["hermes", "langchain-deepagents-code", "openclaw"]);

    const flags = buildOnboardFlags();

    expect(flags.agent.description).toBe(
      "Agent runtime to onboard (openclaw, hermes, langchain-deepagents-code; aliases: nemohermes → hermes; nemo-deepagents/dcode/deepagents/deepagents-code/langchain → langchain-deepagents-code)",
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

describe("buildOnboardFlags --observability help", () => {
  it("discloses the bounded content exported by the opt-in", () => {
    const flags = buildOnboardFlags();

    expect(flags.observability.description).toBe(
      "Export bounded prompt, response, tool argument, and tool result content to a local OTLP collector (Deep Agents Code only)",
    );
    expect(flags.observability.allowNo).toBe(true);
  });
});

describe("buildOnboardFlags --apf-interceptor help", () => {
  it("exposes one-way operator selection without a generated --no form (#9833)", () => {
    const flags = buildOnboardFlags();

    expect(flags["apf-interceptor"].hidden).not.toBe(true);
    expect(flags["apf-interceptor"].allowNo).not.toBe(true);
    expect(flags["apf-interceptor"].description).toContain("contained sandbox-scoped policy");
    expect(flags["apf-interceptor"].description).toContain("without claiming its provenance");
    expect(flags["apf-interceptor"].exclusive).toEqual(["resume", "recreate-sandbox"]);
    expect(onboardUsage.join(" ")).toContain("--apf-interceptor");
  });
});

describe("buildOnboardFlags --events help", () => {
  it("exposes the JSONL observer only on the canonical onboard command", () => {
    const onboardFlags = buildOnboardFlags({ includeEvents: true });
    const aliasFlags = buildOnboardFlags();

    expect(onboardFlags.events.description).toBe(
      "Emit versioned read-only onboarding events as JSON Lines on stdout",
    );
    expect(onboardFlags.events.options).toEqual(["jsonl"]);
    expect(aliasFlags.events).toBeUndefined();
  });
});

describe("buildOnboardFlags temporary managed runtime gate", () => {
  it("keeps candidate activation hidden while allowing exact stock qualification catalogs", () => {
    const flags = buildOnboardFlags({ includeEvents: true });

    expect(flags["temp-managed-runtime"].hidden).toBe(true);
    expect(flags["temp-managed-runtime"].description).toBeUndefined();
    expect(flags["temp-managed-runtime-catalog"].hidden).toBe(true);
    expect(flags["temp-managed-runtime-catalog"].dependsOn).toBeUndefined();
    expect(flags.events.hidden).not.toBe(true);
  });
});

describe("buildOnboardFlags experimental profile", () => {
  it("keeps the portable profile hidden and value constrained", () => {
    const flags = buildOnboardFlags();

    expect(flags["experimental-profile"].hidden).toBe(true);
    expect(flags["experimental-profile"].options).toEqual(["portable"]);
    expect(onboardUsage.join(" ")).not.toContain("experimental-profile");
  });
});
