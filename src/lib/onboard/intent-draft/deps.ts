// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { detectGpu } from "../../inference/nim";
import * as tiers from "../../policy/tiers";
import { loadResourceProfiles } from "../../resources-cmd";
import { listChannels } from "../../sandbox/channels";
import { HERMES_AUTH_METHOD_API_KEY, HERMES_AUTH_METHOD_OAUTH } from "../hermes-auth";
import {
  defaultHermesToolGatewaySelection,
  getRequestedHermesToolGateways,
  HERMES_TOOL_GATEWAY_PRESETS,
} from "../hermes-managed-tools";
import { filterEnabledChannelsByAgent } from "../messaging-state";
import { getAgentInferenceProviderOptions, getDefaultSandboxNameForAgent } from "../sandbox-agent";
import { discoverInferenceIntentChoices, type SetupNimFlowDeps } from "../setup-nim-flow";
import { agentSupportsWebSearchProvider } from "../web-search-support";
import type { OnboardInferenceIntent, OnboardIntentDraft } from "./schema";
import type { OnboardIntentDraftUiDeps } from "./ui";

type DraftAgent = Parameters<typeof discoverInferenceIntentChoices>[2];
type DraftWebSearchProvider = Parameters<typeof agentSupportsWebSearchProvider>[1];

const BASE_PROVIDER_KEYS = new Set([
  "build",
  "openrouter",
  "openai",
  "custom",
  "anthropic",
  "anthropicCompatible",
  "gemini",
  "ollama",
  "install-ollama",
  "vllm",
  "install-vllm",
  "nim-local",
  "routed",
]);

const MESSAGING_CHANNELS = listChannels();

export interface CreateOnboardIntentDraftDepsOptions {
  readonly fromDockerfile: string | null;
  readonly setupNimDeps: SetupNimFlowDeps;
  readonly checkpoint: (draft: OnboardIntentDraft) => void;
  readonly prompt: (question: string) => Promise<string>;
  readonly agentChoices: () => readonly { readonly name: string; readonly displayName: string }[];
  readonly loadAgent: (agentName: string) => DraftAgent;
  readonly webSearchProviders: readonly DraftWebSearchProvider[];
  readonly webSearchLabelFor: (provider: DraftWebSearchProvider) => string;
  readonly rootDir: string;
  readonly validateSandboxName: (value: string) => string;
  readonly validateModel: (value: string) => string;
  readonly env?: NodeJS.ProcessEnv;
}

function draftAgent(options: CreateOnboardIntentDraftDepsOptions, agentName: string): DraftAgent {
  return agentName === "openclaw" ? null : options.loadAgent(agentName);
}

function managedToolsAvailable(agentName: string, inference: OnboardInferenceIntent): boolean {
  return (
    agentName === "hermes" &&
    inference.provider === "hermesProvider" &&
    inference.authMethod !== HERMES_AUTH_METHOD_API_KEY
  );
}

/** Assemble the repository-backed menus used by the secret-free draft UI. */
export function createOnboardIntentDraftDeps(
  options: CreateOnboardIntentDraftDepsOptions,
): OnboardIntentDraftUiDeps {
  const { fromDockerfile, setupNimDeps, checkpoint, env = process.env } = options;
  const messagingChoices = (agentName: string) => {
    const agent = draftAgent(options, agentName);
    const supported = new Set(
      filterEnabledChannelsByAgent(
        MESSAGING_CHANNELS.map((channel) => channel.name),
        agent,
      ),
    );
    return MESSAGING_CHANNELS.filter((channel) => supported.has(channel.name)).map((channel) => ({
      value: channel.name,
      label: channel.label,
    }));
  };

  return {
    prompt: options.prompt,
    log: (message = "") => console.log(message),
    agentChoices: () =>
      options.agentChoices().map((choice) => ({
        value: choice.name,
        label: choice.displayName,
      })),
    inferenceChoices: async (agentName) => {
      const agent = draftAgent(options, agentName);
      return discoverInferenceIntentChoices(setupNimDeps, detectGpu(), agent).map((choice) => ({
        value: choice.key,
        label: choice.label,
        defaultModel: choice.defaultModel,
        endpointRequired: choice.key === "custom" || choice.key === "anthropicCompatible",
        authMethods:
          choice.key === "hermesProvider"
            ? [
                { value: HERMES_AUTH_METHOD_OAUTH, label: "Nous Portal OAuth" },
                { value: HERMES_AUTH_METHOD_API_KEY, label: "Nous API Key" },
              ]
            : undefined,
      }));
    },
    webSearchChoices: (agentName) => {
      const agent = draftAgent(options, agentName);
      return options.webSearchProviders
        .filter((provider) =>
          agentSupportsWebSearchProvider(agent, provider, fromDockerfile, options.rootDir),
        )
        .map((provider) => ({ value: provider, label: options.webSearchLabelFor(provider) }));
    },
    messagingChoices,
    managedToolChoices: (agentName, inference) =>
      managedToolsAvailable(agentName, inference)
        ? HERMES_TOOL_GATEWAY_PRESETS.map((preset) => ({
            value: preset.name,
            label: `${preset.label}: ${preset.description}`,
          }))
        : [],
    defaultManagedTools: (agentName, inference) =>
      managedToolsAvailable(agentName, inference)
        ? (getRequestedHermesToolGateways(env) ?? defaultHermesToolGatewaySelection())
        : [],
    resourceProfileChoices: () => [
      { value: "default", label: "OpenShell defaults" },
      ...Object.keys(loadResourceProfiles())
        .filter((name) => name !== "default")
        .map((name) => ({ value: name, label: name })),
      { value: "custom", label: "Custom CPU and RAM" },
    ],
    policyChoices: () => {
      const choices = tiers.listTiers().map((tier) => ({ value: tier.name, label: tier.label }));
      return choices.sort((left, right) => {
        if (left.value === "balanced") return -1;
        if (right.value === "balanced") return 1;
        return 0;
      });
    },
    defaultSandboxName: (agentName) =>
      getDefaultSandboxNameForAgent(draftAgent(options, agentName)),
    validateSandboxName: options.validateSandboxName,
    validateModel: options.validateModel,
    compatibility: {
      provider: (agentName, inference) =>
        BASE_PROVIDER_KEYS.has(inference.provider) ||
        getAgentInferenceProviderOptions(draftAgent(options, agentName)).includes(
          inference.provider,
        ),
      // Agent manifests do not expose a complete model-compatibility catalog.
      // Re-adopt the selected provider's reviewed default after an agent edit.
      model: () => false,
      webSearch: (agentName, provider) =>
        agentSupportsWebSearchProvider(
          draftAgent(options, agentName),
          provider as DraftWebSearchProvider,
          fromDockerfile,
          options.rootDir,
        ),
      messaging: (agentName, channel) =>
        messagingChoices(agentName).some((choice) => choice.value === channel),
    },
    checkpoint,
  };
}
