// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAgentBranding } from "./branding";

describe("getAgentBranding", () => {
  let originalAgent: string | undefined;
  let originalInvokedAs: string | undefined;

  beforeEach(() => {
    originalAgent = process.env.NEMOCLAW_AGENT;
    originalInvokedAs = process.env.NEMOCLAW_INVOKED_AS;
    delete process.env.NEMOCLAW_AGENT;
    delete process.env.NEMOCLAW_INVOKED_AS;
  });

  afterEach(() => {
    if (originalAgent === undefined) delete process.env.NEMOCLAW_AGENT;
    else process.env.NEMOCLAW_AGENT = originalAgent;
    if (originalInvokedAs === undefined) delete process.env.NEMOCLAW_INVOKED_AS;
    else process.env.NEMOCLAW_INVOKED_AS = originalInvokedAs;
  });

  it("defaults to nemoclaw + OpenClaw branding when no env vars are set", () => {
    const branding = getAgentBranding();
    expect(branding.cli).toBe("nemoclaw");
    expect(branding.display).toBe("NemoClaw");
    expect(branding.product).toBe("OpenClaw");
  });

  it("uses Hermes product branding but nemoclaw CLI when only NEMOCLAW_AGENT is set (#3358)", () => {
    // The exact repro: `NEMOCLAW_AGENT=hermes nemoclaw onboard` should NOT
    // suggest `nemohermes` because the user invoked via the nemoclaw binary.
    process.env.NEMOCLAW_AGENT = "hermes";
    const branding = getAgentBranding();
    expect(branding.cli).toBe("nemoclaw");
    expect(branding.display).toBe("NemoHermes");
    expect(branding.product).toBe("Hermes");
  });

  it("uses nemohermes CLI when the alias launcher set NEMOCLAW_INVOKED_AS", () => {
    process.env.NEMOCLAW_AGENT = "hermes";
    process.env.NEMOCLAW_INVOKED_AS = "nemohermes";
    const branding = getAgentBranding();
    expect(branding.cli).toBe("nemohermes");
    expect(branding.display).toBe("NemoHermes");
    expect(branding.product).toBe("Hermes");
  });

  it("rejects unknown NEMOCLAW_INVOKED_AS values and falls back to nemoclaw", () => {
    process.env.NEMOCLAW_INVOKED_AS = "rm -rf /";
    const branding = getAgentBranding();
    expect(branding.cli).toBe("nemoclaw");
  });

  it("treats an explicit agent argument as overriding NEMOCLAW_AGENT", () => {
    process.env.NEMOCLAW_AGENT = "openclaw";
    const branding = getAgentBranding("hermes");
    expect(branding.product).toBe("Hermes");
    expect(branding.cli).toBe("nemoclaw");
  });

  it("uses Deep Agents Code product branding under the nemoclaw CLI (#5665)", () => {
    // Selecting the agent through the base CLI must keep the command name the
    // user actually invoked, while still using the agent-specific product copy.
    const branding = getAgentBranding("langchain-deepagents-code");
    expect(branding.cli).toBe("nemoclaw");
    expect(branding.display).toBe("NemoDeepAgents");
    expect(branding.product).toBe("LangChain Deep Agents Code");
  });

  it.each([
    "dcode",
    "langchain",
  ])("uses Deep Agents Code product branding for NEMOCLAW_AGENT=%s aliases", (agentAlias) => {
    process.env.NEMOCLAW_AGENT = agentAlias;
    const branding = getAgentBranding();
    expect(branding.cli).toBe("nemoclaw");
    expect(branding.display).toBe("NemoDeepAgents");
    expect(branding.product).toBe("LangChain Deep Agents Code");
  });

  it("uses nemo-deepagents CLI when the Deep Agents alias launcher set NEMOCLAW_INVOKED_AS", () => {
    process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
    process.env.NEMOCLAW_INVOKED_AS = "nemo-deepagents";
    const branding = getAgentBranding();
    expect(branding.cli).toBe("nemo-deepagents");
    expect(branding.display).toBe("NemoDeepAgents");
    expect(branding.product).toBe("LangChain Deep Agents Code");
  });
});
