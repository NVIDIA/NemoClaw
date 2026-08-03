// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createOnboardIntentDraft } from "./schema";
import { seedOnboardIntentDraft } from "./seed";
import { collectOnboardIntentDraft, type OnboardIntentDraftUiDeps } from "./ui";

function fail(message: string): never {
  throw new Error(message);
}

function makeDeps(replies: string[]): OnboardIntentDraftUiDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    prompt: vi.fn(async () => replies.shift() ?? fail("Missing prompt reply")),
    log: (message = "") => lines.push(message),
    agentChoices: () => [
      { value: "openclaw", label: "OpenClaw" },
      { value: "hermes", label: "Hermes" },
    ],
    inferenceChoices: async (agent) => [
      { value: "build", label: "NVIDIA Endpoints", defaultModel: "nemotron" },
      { value: "openai", label: "OpenAI", defaultModel: "gpt-5" },
      ...(agent === "hermes"
        ? [{ value: "hermesProvider", label: "Hermes Provider", defaultModel: "claude" }]
        : []),
    ],
    webSearchChoices: (agent) =>
      agent === "hermes"
        ? [{ value: "tavily", label: "Tavily" }]
        : [{ value: "brave", label: "Brave" }],
    messagingChoices: () => [
      { value: "slack", label: "Slack" },
      { value: "telegram", label: "Telegram" },
    ],
    managedToolChoices: () => [],
    defaultManagedTools: () => [],
    resourceProfileChoices: () => [
      { value: "default", label: "OpenShell defaults" },
      { value: "large", label: "Large" },
    ],
    policyChoices: () => [
      { value: "balanced", label: "Balanced" },
      { value: "restricted", label: "Restricted" },
    ],
    defaultSandboxName: () => "demo",
    validateSandboxName: (value) =>
      value === "bad" ? fail("Invalid sandbox name") : value.toLowerCase(),
    compatibility: {
      provider: (agent, inference) => agent !== "hermes" || inference.provider !== "openai",
      model: () => true,
      webSearch: (agent, provider) => (agent === "hermes" ? provider === "tavily" : true),
      messaging: () => true,
    },
    checkpoint: vi.fn(),
  };
}

describe("onboarding intent draft UI (#6005)", () => {
  it("collects every choice before Apply and never asks for credential values", async () => {
    const deps = makeDeps(["", "", "", "Demo", "", "none", "", "", "", ""]);

    const result = await collectOnboardIntentDraft(deps);

    expect(result.kind).toBe("apply");
    expect(result.draft).toEqual({
      ...createOnboardIntentDraft({
        agent: "openclaw",
        inference: {
          provider: "build",
          model: "nemotron",
          endpointUrl: null,
          authMethod: null,
        },
        sandbox: "demo",
        web_search: null,
        messaging: [],
        tools: { hermesGateways: [] },
        resources: { profile: "default", gpu: "auto" },
        policy: "balanced",
      }),
      phase: "accepted",
    });
    expect(result.draft.phase).toBe("accepted");
    expect(deps.lines.join("\n").toLowerCase()).not.toContain("api key:");
    expect(deps.lines).toContain("    1) Apply configuration");
    expect(deps.checkpoint).toHaveBeenLastCalledWith(result.draft);
  });

  it("uses Edit a choice to jump to step one and immediately return to review", async () => {
    const initial = {
      ...createOnboardIntentDraft({
        agent: "openclaw",
        inference: { provider: "build", model: "nemotron", endpointUrl: null, authMethod: null },
        sandbox: "demo",
        web_search: null,
        messaging: [],
        tools: { hermesGateways: [] },
        resources: { profile: "default", gpu: "auto" },
        policy: "balanced",
      }),
      phase: "collecting" as const,
    };
    const deps = makeDeps(["2", "1", "1", ""]);

    const result = await collectOnboardIntentDraft(deps, initial);

    expect(result.kind).toBe("apply");
    expect(result.draft.answers.agent).toBe("openclaw");
    expect(deps.prompt).toHaveBeenCalledTimes(4);
    expect(deps.lines.filter((line) => line === "  Review configuration")).toHaveLength(2);
  });

  it("reopens only choices invalidated by an agent edit", async () => {
    const initial = createOnboardIntentDraft({
      agent: "openclaw",
      inference: { provider: "openai", model: "gpt-5", endpointUrl: null, authMethod: null },
      sandbox: "demo",
      web_search: "brave",
      messaging: ["slack"],
      tools: { hermesGateways: [] },
      resources: { profile: "default", gpu: "auto" },
      policy: "balanced",
    });
    const deps = makeDeps(["2", "1", "2", "3", "", "1", "2", ""]);

    const result = await collectOnboardIntentDraft(deps, initial);

    expect(result.draft.answers).toMatchObject({
      agent: "hermes",
      inference: { provider: "hermesProvider" },
      sandbox: "demo",
      messaging: ["slack"],
      tools: { hermesGateways: [] },
      resources: { profile: "default", gpu: "auto" },
    });
    expect(result.draft.answers.web_search).toBeNull();
    expect(result.draft.answers.policy).toBe("restricted");
  });

  it("supports repeated b navigation without treating Backspace as navigation", async () => {
    const deps = makeDeps(["", "", "b", "b", "b", "2", "", "", "demo", "", "none", "", "", "", ""]);

    const result = await collectOnboardIntentDraft(deps);

    expect(result.draft.answers.agent).toBe("hermes");
    expect(deps.lines.filter((line) => line === "  Agent:").length).toBe(3);
    expect(deps.lines.filter((line) => line === "  Inference provider:").length).toBe(3);
    expect(deps.lines.filter((line) => line.startsWith("  [b] Back")).length).toBeGreaterThan(3);
  });

  it("keeps a canonicalized --agent choice instead of defaulting to OpenClaw", async () => {
    const deps = makeDeps(["", "", "", "", "none", "", "", "", ""]);
    deps.agentChoices = () => [
      { value: "openclaw", label: "OpenClaw" },
      { value: "langchain-deepagents-code", label: "LangChain Deep Agents Code" },
    ];
    deps.inferenceChoices = async () => [
      { value: "build", label: "NVIDIA Endpoints", defaultModel: "nemotron" },
    ];
    const initial = seedOnboardIntentDraft(
      { agent: "deepagents" },
      null,
      {},
      () => "langchain-deepagents-code",
    );

    const result = await collectOnboardIntentDraft(deps, initial);

    expect(result.draft.answers.agent).toBe("langchain-deepagents-code");
    expect(deps.lines).not.toContain("  Agent:");
    expect(deps.prompt).toHaveBeenNthCalledWith(1, "  Choose [build]: ");
    expect(deps.lines).toContain("    Agent: langchain-deepagents-code");
  });

  it("collects reviewed Hermes managed tools before Apply", async () => {
    const deps = makeDeps(["", "", "", "demo", "", "none", "1,3", "", "", "", ""]);
    deps.inferenceChoices = async () => [
      {
        value: "hermesProvider",
        label: "Hermes Provider",
        defaultModel: "claude",
        authMethods: [{ value: "oauth", label: "OAuth" }],
      },
    ];
    deps.managedToolChoices = () => [
      { value: "nous-web", label: "Web" },
      { value: "nous-image", label: "Image" },
      { value: "nous-audio", label: "Audio" },
    ];
    deps.defaultManagedTools = () => ["nous-web"];

    const result = await collectOnboardIntentDraft(
      deps,
      createOnboardIntentDraft({ agent: "hermes" }),
    );

    expect(result.draft.answers.tools).toEqual({
      hermesGateways: ["nous-web", "nous-audio"],
    });
    expect(deps.lines).toContain("    Managed tools: nous-web, nous-audio");
  });

  it("walks Sandbox GPU back through RAM, CPU, and Resource profile", async () => {
    const initial = createOnboardIntentDraft({
      agent: "openclaw",
      inference: { provider: "build", model: "nemotron", endpointUrl: null, authMethod: null },
      sandbox: "demo",
      web_search: null,
      messaging: [],
      tools: { hermesGateways: [] },
    });
    const deps = makeDeps(["2", "", "", "b", "b", "b", "1", "", "", ""]);
    deps.resourceProfileChoices = () => [
      { value: "default", label: "OpenShell defaults" },
      { value: "custom", label: "Custom CPU and RAM" },
    ];

    const result = await collectOnboardIntentDraft(deps, initial);

    expect(result.draft.answers.resources).toEqual({ profile: "default", gpu: "auto" });
    expect(deps.prompt).toHaveBeenCalledWith("  CPU [25%]: ");
    expect(deps.prompt).toHaveBeenCalledWith("  RAM [25%]: ");
    expect(deps.lines.filter((line) => line === "  Resource profile:")).toHaveLength(2);
  });

  it("skips unavailable messaging and managed-tool groups in reverse navigation (#6005)", async () => {
    const initial = createOnboardIntentDraft({
      agent: "openclaw",
      inference: { provider: "build", model: "nemotron", endpointUrl: null, authMethod: null },
      sandbox: "demo",
      web_search: null,
      messaging: [],
      tools: { hermesGateways: [] },
      resources: { profile: "default", gpu: "auto" },
      policy: "balanced",
    });
    const deps = makeDeps(["2", "7", "b", "", ""]);
    deps.messagingChoices = () => [];

    const result = await collectOnboardIntentDraft(deps, initial);

    expect(result.kind).toBe("apply");
    expect(deps.lines).toContain("  Web search:");
    expect(deps.lines).not.toContain("  Messaging channels:");
    expect(deps.lines).not.toContain("  Managed tools:");
  });

  it("revalidates a complete seeded draft before showing Review", async () => {
    const initial = createOnboardIntentDraft({
      agent: "openclaw",
      inference: {
        provider: "removed-provider",
        model: "stale-model",
        endpointUrl: null,
        authMethod: null,
      },
      sandbox: "demo",
      web_search: null,
      messaging: [],
      tools: { hermesGateways: [] },
      resources: { profile: "default", gpu: "auto" },
      policy: "balanced",
    });
    const deps = makeDeps(["", "", "", ""]);

    const result = await collectOnboardIntentDraft(deps, initial);

    expect(result.draft.answers.inference).toEqual({
      provider: "build",
      model: "nemotron",
      endpointUrl: null,
      authMethod: null,
    });
    expect(deps.lines.filter((line) => line === "  Inference provider:")).toHaveLength(1);
    expect(deps.lines.filter((line) => line === "  Review configuration")).toHaveLength(1);
  });

  it("resumes an incomplete custom resource choice without losing its saved CPU", async () => {
    const initial = createOnboardIntentDraft({
      agent: "openclaw",
      inference: { provider: "build", model: "nemotron", endpointUrl: null, authMethod: null },
      sandbox: "demo",
      web_search: null,
      messaging: [],
      tools: { hermesGateways: [] },
      resources: { profile: "custom", cpu: "50%", gpu: "auto" },
      policy: "balanced",
    });
    const deps = makeDeps(["", "", "", "", ""]);
    deps.resourceProfileChoices = () => [
      { value: "default", label: "OpenShell defaults" },
      { value: "custom", label: "Custom CPU and RAM" },
    ];

    const result = await collectOnboardIntentDraft(deps, initial);

    expect(result.draft.answers.resources).toEqual({
      profile: "custom",
      cpu: "50%",
      memory: "25%",
      gpu: "auto",
    });
    expect(deps.prompt).toHaveBeenCalledWith("  CPU [50%]: ");
  });
});
