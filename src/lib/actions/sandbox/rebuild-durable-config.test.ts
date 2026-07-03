// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../../state/onboard-session";
import { resolveRebuildDurableConfig } from "./rebuild-durable-config";

describe("resolveRebuildDurableConfig", () => {
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
