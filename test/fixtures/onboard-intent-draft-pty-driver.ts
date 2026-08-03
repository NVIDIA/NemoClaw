// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createInterface } from "node:readline";

import * as intentDraft from "../../src/lib/onboard/intent-draft/index.ts";

const intentDraftModule =
  (intentDraft as typeof intentDraft & { default?: typeof intentDraft }).default ?? intentDraft;
const { collectOnboardIntentDraft } = intentDraftModule;

const readline = createInterface({ input: process.stdin, output: process.stdout });
let promptSequence = 0;
const prompt = (question: string) => {
  console.log(`PTY_PROMPT:${++promptSequence}:${JSON.stringify(question)}`);
  return new Promise<string>((resolve) => readline.question(question, resolve));
};

const result = await collectOnboardIntentDraft({
  prompt,
  log: (message = "") => console.log(message),
  agentChoices: () => [
    { value: "openclaw", label: "OpenClaw" },
    { value: "hermes", label: "Hermes" },
  ],
  inferenceChoices: async (agent) => [
    { value: "build", label: "NVIDIA Endpoints", defaultModel: "nemotron" },
    ...(agent === "openclaw"
      ? [{ value: "openai", label: "OpenAI", defaultModel: "gpt-5" }]
      : [{ value: "hermesProvider", label: "Hermes Provider", defaultModel: "claude" }]),
  ],
  webSearchChoices: (agent) => [
    agent === "hermes" ? { value: "tavily", label: "Tavily" } : { value: "brave", label: "Brave" },
  ],
  messagingChoices: () => [],
  managedToolChoices: () => [],
  defaultManagedTools: () => [],
  resourceProfileChoices: () => [{ value: "default", label: "OpenShell defaults" }],
  policyChoices: () => [{ value: "balanced", label: "Balanced" }],
  defaultSandboxName: () => "demo",
  validateSandboxName: (value) => value,
  compatibility: {
    provider: (agent, inference) => agent !== "hermes" || inference.provider !== "openai",
    model: () => true,
    webSearch: (agent, provider) => (agent === "hermes" ? provider === "tavily" : true),
    messaging: () => true,
  },
  checkpoint: () => undefined,
});

readline.close();
console.log(
  `PTY_RESULT:${result.kind}:${result.draft.answers.agent}:${result.draft.answers.inference?.provider}:${result.draft.answers.web_search ?? "none"}:${result.draft.answers.sandbox}`,
);
