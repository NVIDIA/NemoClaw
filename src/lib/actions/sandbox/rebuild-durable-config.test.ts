// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession, normalizeSession } from "../../state/onboard-session";
import { resolveRebuildDurableConfig } from "./rebuild-durable-config";

describe("resolveRebuildDurableConfig", () => {
  it("keeps the registry tool-disclosure selection authoritative", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", toolDisclosure: "direct", nemoclawVersion: "0.1.0" },
      createSession({ sandboxName: "alpha", toolDisclosure: "progressive" }),
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("lets an explicit transactional rebuild override the recorded selection", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", toolDisclosure: "progressive", nemoclawVersion: "0.1.0" },
      createSession({ sandboxName: "alpha", toolDisclosure: "progressive" }),
      undefined,
      "direct",
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("recovers tool disclosure from a matching legacy session", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", provider: "ollama-local", model: "model", nemoclawVersion: "0.1.0" },
      createSession({
        sandboxName: "alpha",
        provider: "ollama-local",
        model: "model",
        toolDisclosure: "direct",
      }),
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("defaults missing legacy tool-disclosure state to progressive", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", nemoclawVersion: "0.1.0" },
      null,
    );

    expect(config.toolDisclosure).toBe("progressive");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("fails closed for corrupt durable tool-disclosure state", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", toolDisclosure: "everything" as never, nemoclawVersion: "0.1.0" },
      null,
    );

    expect(config.toolDisclosure).toBe("progressive");
    expect(config.toolDisclosureError).toContain("progressive or direct");
  });

  it("does not let an explicit override mask corrupt durable state", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", toolDisclosure: "everything" as never, nemoclawVersion: "0.1.0" },
      null,
      undefined,
      "direct",
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toContain("progressive or direct");
  });

  it("fails closed for corrupt matching-session state when the registry value is missing", () => {
    const session = normalizeSession({
      version: 1,
      sandboxName: "alpha",
      toolDisclosure: "everything",
    } as never);
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", nemoclawVersion: "0.1.0" },
      session,
    );

    expect(config.toolDisclosureError).toContain("progressive or direct");
  });

  it("uses a matching direct session when a legacy registry stores null", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", toolDisclosure: null as never, nemoclawVersion: "0.1.0" },
      createSession({ sandboxName: "alpha", toolDisclosure: "direct" }),
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("uses a legacy built-in Brave policy for a nonmatching session", () => {
    const session = createSession({ sandboxName: "other", webSearchConfig: null });
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", policies: ["brave"], nemoclawVersion: "0.1.0" },
      session,
    );
    expect(config.webSearchConfig).toEqual({ fetchEnabled: true, provider: "brave" });
  });

  it("does not mistake a legacy custom policy named brave for web search", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        policies: ["brave"],
        customPolicies: [{ name: "brave", content: "allow: []" }],
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.webSearchConfig).toBeNull();
  });

  it("keeps an explicit durable web-search disable authoritative", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        policies: ["brave"],
        webSearchEnabled: false,
        fromDockerfile: null,
      },
      createSession({ sandboxName: "alpha", webSearchConfig: { fetchEnabled: true } }),
    );
    expect(config.webSearchConfig).toBeNull();
  });

  it("fails closed for an ambiguous legacy image without its matching session", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", nemoclawVersion: null },
      createSession({ sandboxName: "other" }),
    );
    expect(config.fromDockerfileError).toContain("cannot distinguish");
  });

  it("accepts an ambiguous legacy image only with scoped managed-image confirmation (#6114)", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", nemoclawVersion: null },
      createSession({ sandboxName: "other" }),
      undefined,
      undefined,
      true,
    );
    expect(config.fromDockerfile).toBeNull();
    expect(config.fromDockerfileError).toBeNull();
  });

  it("rejects matching-session custom-image evidence despite legacy confirmation (#6114)", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", provider: "ollama-local", model: "model", nemoclawVersion: null },
      createSession({
        sandboxName: "alpha",
        provider: "ollama-local",
        model: "model",
        metadata: { gatewayName: "nemoclaw", fromDockerfile: "/tmp/custom.Dockerfile" },
      }),
      undefined,
      undefined,
      true,
    );
    expect(config.fromDockerfileError).toContain("conflicts with a recorded custom --from image");
  });

  it("accepts explicit managed-image provenance for an old agent runtime", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        agentVersion: "2026.3.11",
        nemoclawVersion: null,
        fromDockerfile: null,
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.fromDockerfile).toBeNull();
    expect(config.fromDockerfileError).toBeNull();
  });

  it("does not treat a same-name null image session as proof of a legacy managed image", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", provider: "ollama-local", model: "model", nemoclawVersion: null },
      createSession({ sandboxName: "alpha", provider: "ollama-local", model: "model" }),
    );
    expect(config.fromDockerfileError).toContain("cannot distinguish");
  });

  it("fails closed for corrupt durable web-search state", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", webSearchEnabled: "false" as never, fromDockerfile: null },
      null,
    );
    expect(config.webSearchError).toContain("not boolean");
  });

  it("preserves an explicit durable Tavily provider", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        webSearchEnabled: true,
        webSearchProvider: "tavily",
        fromDockerfile: null,
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.webSearchConfig).toEqual({ fetchEnabled: true, provider: "tavily" });
    expect(config.webSearchError).toBeNull();
  });

  it("recovers provider-less Tavily for an explicitly enabled DCode selection", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        agent: "langchain-deepagents-code",
        policies: ["tavily"],
        webSearchEnabled: true,
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other", webSearchConfig: null }),
    );
    expect(config.webSearchConfig).toEqual({ fetchEnabled: true, provider: "tavily" });
    expect(config.webSearchError).toBeNull();
  });

  it.each([null, "hermes"])('migrates a provider-less Tavily policy for agent "%s"', (agent) => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        agent,
        policies: ["tavily"],
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other", webSearchConfig: null }),
    );
    expect(config.webSearchConfig).toEqual({ fetchEnabled: true, provider: "tavily" });
    expect(config.webSearchError).toBeNull();
  });

  it("backfills a legacy enabled provider from the matching Tavily session", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model",
        webSearchEnabled: true,
        fromDockerfile: null,
      },
      createSession({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "model",
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      }),
    );
    expect(config.webSearchConfig).toEqual({ fetchEnabled: true, provider: "tavily" });
  });

  it("does not infer managed Tavily from the DCode interpreter opt-in preset", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        agent: "langchain-deepagents-code",
        policies: ["tavily"],
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.webSearchConfig).toBeNull();
  });

  it("does not infer managed Tavily from a custom same-name policy", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        policies: ["tavily"],
        customPolicies: [{ name: "tavily", content: "allow: []" }],
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other", webSearchConfig: null }),
    );
    expect(config.webSearchConfig).toBeNull();
  });

  it("fails closed when provider-less durable policies select both web-search providers", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        policies: ["brave", "tavily"],
        webSearchEnabled: true,
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other", webSearchConfig: null }),
    );
    expect(config.webSearchConfig).toBeNull();
    expect(config.webSearchError).toContain("more than one provider");
  });

  it("lets an explicit provider resolve stale dual-policy state", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        policies: ["brave", "tavily"],
        webSearchEnabled: true,
        webSearchProvider: "tavily",
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other", webSearchConfig: null }),
    );
    expect(config.webSearchConfig).toEqual({ fetchEnabled: true, provider: "tavily" });
    expect(config.webSearchError).toBeNull();
  });

  it("uses the unshadowed provider when the other policy name is custom", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        policies: ["brave", "tavily"],
        customPolicies: [{ name: "brave", content: "allow: []" }],
        webSearchEnabled: true,
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other", webSearchConfig: null }),
    );
    expect(config.webSearchConfig).toEqual({ fetchEnabled: true, provider: "tavily" });
    expect(config.webSearchError).toBeNull();
  });

  it("fails closed when the managed provider is shadowed by a custom same-name policy", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        policies: ["tavily"],
        customPolicies: [{ name: "tavily", content: "allow: []" }],
        webSearchEnabled: true,
        webSearchProvider: "tavily",
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other", webSearchConfig: null }),
    );
    expect(config.webSearchConfig).toBeNull();
    expect(config.webSearchError).toContain("conflicts with a custom same-name policy");
  });

  it("fails closed for an invalid durable web-search provider", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        webSearchEnabled: true,
        webSearchProvider: "other" as never,
        fromDockerfile: null,
      },
      null,
    );
    expect(config.webSearchError).toContain("webSearchProvider");
  });

  it.each([
    ["NOUS_API_KEY", "api_key"],
    ["OPENAI_API_KEY", "oauth"],
  ] as const)("recovers legacy Hermes auth from %s", (credentialEnv, expected) => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        provider: "hermes-provider",
        credentialEnv,
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.hermesAuthMethod).toBe(expected);
    expect(config.hermesAuthMethodError).toBeNull();
  });

  it("fails closed when legacy Hermes auth has no durable clue", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", provider: "hermes-provider", nemoclawVersion: "0.1.0" },
      createSession({ sandboxName: "other" }),
    );
    expect(config.hermesAuthMethodError).toContain("cannot determine");
  });

  it("does not borrow Hermes auth from a same-name conflicting selection", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", provider: "hermes-provider", model: "target", nemoclawVersion: "0.1.0" },
      createSession({
        sandboxName: "alpha",
        provider: "hermes-provider",
        model: "different",
        hermesAuthMethod: "oauth",
      }),
    );
    expect(config.hermesAuthMethod).toBeNull();
    expect(config.hermesAuthMethodError).toContain("cannot determine");
  });
});
