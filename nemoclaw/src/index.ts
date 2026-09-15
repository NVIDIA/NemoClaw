// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NemoClaw — OpenClaw Plugin for OpenShell
 *
 * Uses the real OpenClaw plugin API. Types defined locally are minimal stubs
 * that match the OpenClaw SDK interfaces available at runtime via
 * `openclaw/plugin-sdk`. We define them here because the SDK package is only
 * available inside the OpenClaw host process and cannot be imported at build
 * time.
 */

import { readFileSync } from "node:fs";
import { renderBox } from "./banner.js";
import { handleSlashCommand } from "./commands/slash.js";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
} from "./onboard/config.js";
import { getPluginConfig } from "./plugin-config.js";
import { registerRuntimeContext } from "./runtime-context.js";

type PluginScalar = string | number | boolean | null | undefined;
type PluginValue = PluginScalar | PluginRecord | PluginValue[];
type PluginRecord = { [key: string]: PluginValue };

function isToolParams(value: unknown): value is ToolParams {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isToolParams(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function readObjectProperty(value: unknown, key: string): ToolParams | undefined {
  if (!isToolParams(value)) {
    return undefined;
  }
  const property = value[key];
  return isToolParams(property) ? property : undefined;
}

// ---------------------------------------------------------------------------
// OpenClaw Plugin SDK compatible types (mirrors openclaw/plugin-sdk)
// ---------------------------------------------------------------------------

/** Subset of OpenClawConfig that we actually read. */
export interface OpenClawConfig {
  [key: string]: PluginValue;
}

/** Logger provided by the plugin host. */
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

type ToolParams = { [key: string]: PluginValue };

/** Context passed to slash-command handlers. */
export interface PluginCommandContext {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config: OpenClawConfig;
  from?: string;
  to?: string;
  accountId?: string;
}

/** Return value from a slash-command handler. */
export interface PluginCommandResult {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}

/** Registration shape for a slash command. */
export interface PluginCommandDefinition {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
}

/** Auth method for a provider plugin. */
export interface ProviderAuthMethod {
  id?: string;
  type: string;
  envVar?: string;
  headerName?: string;
  label?: string;
}

/** Model entry in a provider's model catalog. */
export interface ModelProviderEntry {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutput?: number;
}

/** Model catalog shape. */
export interface ModelProviderConfig {
  chat?: ModelProviderEntry[];
  completion?: ModelProviderEntry[];
}

/** Registration shape for a custom model provider. */
export interface ProviderPlugin {
  id: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  envVars?: string[];
  models?: ModelProviderConfig;
  auth: ProviderAuthMethod[];
}

/** Background service registration. */
export interface PluginService {
  id: string;
  start: (ctx: { config: OpenClawConfig; logger: PluginLogger }) => void | Promise<void>;
  stop?: (ctx: { config: OpenClawConfig; logger: PluginLogger }) => void | Promise<void>;
}

/** Return value from a before_prompt_build hook. */
export interface BeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

/** Return value from a registered plugin hook. */
export type HookResult = BeforePromptBuildResult | undefined;

/**
 * The API object injected into the plugin's register function by the OpenClaw
 * host. Only the methods we actually call are listed here.
 */
export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  config: OpenClawConfig;
  pluginConfig?: OpenClawConfig;
  logger: PluginLogger;
  registerCommand: (command: PluginCommandDefinition) => void;
  registerProvider: (provider: ProviderPlugin) => void;
  registerService: (service: PluginService) => void;
  on: (
    hookName: string,
    handler: (...args: readonly PluginValue[]) => HookResult | Promise<HookResult>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Plugin-specific config (read from pluginConfig in openclaw.plugin.json)
// ---------------------------------------------------------------------------

export interface NemoClawConfig {
  blueprintVersion: string;
  blueprintRegistry: string;
  sandboxName: string;
  inferenceProvider: string;
}

// Gateway plugins run inside the sandbox, where OpenClaw keeps its active config here.
const OPENCLAW_CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";
const DEFAULT_INFERENCE_MODEL = "nvidia/nemotron-3-super-120b-a12b";

function normalizeInferenceModel(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("inference/") ? trimmed.slice("inference/".length) : trimmed;
}

function readOpenClawPrimaryModel(
  logger?: PluginLogger,
  configPath = OPENCLAW_CONFIG_PATH,
): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    const agents = readObjectProperty(parsed, "agents");
    const defaults = readObjectProperty(agents, "defaults");
    const model = readObjectProperty(defaults, "model");
    const primary = readStringProperty(model, "primary");
    return primary ? normalizeInferenceModel(primary) : "";
  } catch (err) {
    logger?.debug(
      `Could not read OpenClaw primary model from ${configPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "";
  }
}

function activeModelEntries(activeModel: string): ModelProviderEntry[] {
  if (!activeModel) {
    return [
      {
        id: "nvidia/nemotron-3-super-120b-a12b",
        label: "Nemotron 3 Super 120B (March 2026)",
        contextWindow: 131072,
        maxOutput: 8192,
      },
      {
        id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
        label: "Nemotron Ultra 253B",
        contextWindow: 131072,
        maxOutput: 4096,
      },
      {
        id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
        label: "Nemotron Super 49B v1.5",
        contextWindow: 131072,
        maxOutput: 4096,
      },
      {
        id: "nvidia/nemotron-3-nano-30b-a3b",
        label: "Nemotron 3 Nano 30B",
        contextWindow: 131072,
        maxOutput: 4096,
      },
    ];
  }

  return [
    {
      id: `inference/${activeModel}`,
      label: activeModel,
      contextWindow: 131072,
      maxOutput: 8192,
    },
  ];
}

function registeredProviderForConfig(
  activeModel: string,
  providerCredentialEnv: string,
): ProviderPlugin {
  const isNvidiaCredential =
    providerCredentialEnv === "NVIDIA_INFERENCE_API_KEY" ||
    providerCredentialEnv === "NVIDIA_API_KEY";
  const authLabel = isNvidiaCredential
    ? `NVIDIA API Key (${providerCredentialEnv})`
    : `OpenAI API Key (${providerCredentialEnv})`;

  return {
    id: "inference",
    label: "Managed Inference Route",
    aliases: ["inference-local", "nemoclaw"],
    envVars: [providerCredentialEnv],
    models: { chat: activeModelEntries(activeModel) },
    auth: [
      {
        id: "bearer",
        type: "bearer",
        envVar: providerCredentialEnv,
        headerName: "Authorization",
        label: authLabel,
      },
    ],
  };
}

export { getPluginConfig };

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default function register(api: OpenClawPluginApi): void {
  // Register /nemoclaw slash command (chat interface)
  api.registerCommand({
    name: "nemoclaw",
    description: "NemoClaw sandbox management (status, eject).",
    acceptsArgs: true,
    handler: (ctx) => handleSlashCommand(ctx, api),
  });

  // Register nvidia-nim provider from the active OpenClaw config, falling
  // back to the onboard snapshot and then the NemoClaw default.
  const onboardCfg = loadOnboardConfig();
  const activeModel = readOpenClawPrimaryModel(api.logger) || (onboardCfg?.model ?? "");

  // Register runtime context injection (sandbox-awareness hook)
  const pluginConfig = getPluginConfig(api);
  try {
    registerRuntimeContext(api, pluginConfig);
  } catch (err) {
    api.logger.warn(
      `Could not register runtime context hook: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const bannerEndpoint = onboardCfg ? describeOnboardEndpoint(onboardCfg) : "build.nvidia.com";
  const bannerProvider = onboardCfg ? describeOnboardProvider(onboardCfg) : "NVIDIA Endpoints";
  const bannerModel = activeModel || DEFAULT_INFERENCE_MODEL;

  const providerCredentialEnv = onboardCfg?.credentialEnv ?? "NVIDIA_INFERENCE_API_KEY";
  api.registerProvider(registeredProviderForConfig(activeModel, providerCredentialEnv));

  const bannerLines = [
    "  NemoClaw registered",
    null,
    `  Endpoint:  ${bannerEndpoint}`,
    `  Provider:  ${bannerProvider}`,
    `  Model:     ${bannerModel}`,
    "  Slash:     /nemoclaw",
  ];

  process.stderr.write("\n");
  for (const line of renderBox(bannerLines)) {
    process.stderr.write(`[gateway] ${line}\n`);
  }
  process.stderr.write("\n");
}
