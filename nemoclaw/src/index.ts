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

import { handleSlashCommand } from "./commands/slash.js";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
} from "./onboard/config.js";
import { scanForSecrets, isMemoryPath } from "./security/secret-scanner.js";

// ---------------------------------------------------------------------------
// OpenClaw Plugin SDK compatible types (mirrors openclaw/plugin-sdk)
// ---------------------------------------------------------------------------

/** Subset of OpenClawConfig that we actually read. */
export interface OpenClawConfig {
  [key: string]: unknown;
}

/** Logger provided by the plugin host. */
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

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

/** Event payload for before_tool_call hooks. */
export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

/** Return value from a before_tool_call hook. */
export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
}

/**
 * The API object injected into the plugin's register function by the OpenClaw
 * host. Only the methods we actually call are listed here.
 */
export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerCommand: (command: PluginCommandDefinition) => void;
  registerProvider: (provider: ProviderPlugin) => void;
  registerService: (service: PluginService) => void;
  resolvePath: (input: string) => string;
  on: (hookName: string, handler: (...args: unknown[]) => BeforeToolCallResult | undefined) => void;
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

function activeModelEntries(
  onboardCfg: ReturnType<typeof loadOnboardConfig>,
): ModelProviderEntry[] {
  if (!onboardCfg?.model) {
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
      id: `inference/${onboardCfg.model}`,
      label: onboardCfg.model,
      contextWindow: 131072,
      maxOutput: 8192,
    },
  ];
}

function registeredProviderForConfig(
  onboardCfg: ReturnType<typeof loadOnboardConfig>,
  providerCredentialEnv: string,
): ProviderPlugin {
  const authLabel =
    providerCredentialEnv === "NVIDIA_API_KEY"
      ? `NVIDIA API Key (${providerCredentialEnv})`
      : `OpenAI API Key (${providerCredentialEnv})`;

  return {
    id: "inference",
    label: "Managed Inference Route",
    aliases: ["inference-local", "nemoclaw"],
    envVars: [providerCredentialEnv],
    models: { chat: activeModelEntries(onboardCfg) },
    auth: [
      {
        type: "bearer",
        envVar: providerCredentialEnv,
        headerName: "Authorization",
        label: authLabel,
      },
    ],
  };
}

const DEFAULT_PLUGIN_CONFIG: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

export function getPluginConfig(api: OpenClawPluginApi): NemoClawConfig {
  const raw = api.pluginConfig ?? {};
  return {
    blueprintVersion:
      typeof raw["blueprintVersion"] === "string"
        ? raw["blueprintVersion"]
        : DEFAULT_PLUGIN_CONFIG.blueprintVersion,
    blueprintRegistry:
      typeof raw["blueprintRegistry"] === "string"
        ? raw["blueprintRegistry"]
        : DEFAULT_PLUGIN_CONFIG.blueprintRegistry,
    sandboxName:
      typeof raw["sandboxName"] === "string"
        ? raw["sandboxName"]
        : DEFAULT_PLUGIN_CONFIG.sandboxName,
    inferenceProvider:
      typeof raw["inferenceProvider"] === "string"
        ? raw["inferenceProvider"]
        : DEFAULT_PLUGIN_CONFIG.inferenceProvider,
  };
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/** Tool names that can write/modify files and should be scanned for secrets. */
const WRITE_TOOL_NAMES = new Set(["write", "edit", "apply_patch", "notebook_edit"]);

export default function register(api: OpenClawPluginApi): void {
  // 1. Register /nemoclaw slash command (chat interface)
  api.registerCommand({
    name: "nemoclaw",
    description: "NemoClaw sandbox management (status, eject).",
    acceptsArgs: true,
    handler: (ctx) => handleSlashCommand(ctx, api),
  });

  // 2. Register nvidia-nim provider — use onboard config if available
  const onboardCfg = loadOnboardConfig();
  const providerCredentialEnv = onboardCfg?.credentialEnv ?? "NVIDIA_API_KEY";
  api.registerProvider(registeredProviderForConfig(onboardCfg, providerCredentialEnv));

  const bannerEndpoint = onboardCfg ? describeOnboardEndpoint(onboardCfg) : "build.nvidia.com";
  const bannerProvider = onboardCfg ? describeOnboardProvider(onboardCfg) : "NVIDIA Endpoints";
  const bannerModel = onboardCfg?.model ?? "nvidia/nemotron-3-super-120b-a12b";

  // 3. Register before_tool_call hook to block secrets in memory writes (#1233)
  // NOTE: This relies on OpenClaw's before_tool_call plugin hook contract
  // (PluginHookBeforeToolCallEvent/Result in openclaw/src/plugins/types.ts).
  // If the hook name or return shape changes in a future OpenClaw release,
  // the try/catch ensures the plugin still loads — the scanner just becomes
  // a no-op. Verify after OpenClaw upgrades that blocked writes still show
  // the expected error message.
  try {
    api.on("before_tool_call", (...args: unknown[]): BeforeToolCallResult | undefined => {
      const event = args[0] as Partial<BeforeToolCallEvent> | undefined;
      if (!event?.toolName || !event.params) return undefined;

      const toolName = event.toolName.toLowerCase();
      if (!WRITE_TOOL_NAMES.has(toolName)) return undefined;

      const rawPath = event.params["file_path"] ?? event.params["path"];
      if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
      // Resolve symlinks and traversal before checking — prevents bypasses like
      // /sandbox/project/../../.openclaw-data/memory/secrets.md
      const filePath = api.resolvePath(rawPath);
      if (!isMemoryPath(filePath)) return undefined;

      const content =
        event.params["content"] ?? event.params["new_string"] ?? event.params["patch"];
      if (typeof content !== "string" || content.length === 0) return undefined;

      const matches = scanForSecrets(content);
      if (matches.length === 0) return undefined;

      const summary = matches.map((m) => `  - ${m.pattern} (${m.redacted})`).join("\n");
      api.logger.warn(`[SECURITY] Blocked memory write to ${filePath} — secrets detected`);

      return {
        block: true,
        blockReason:
          `Memory write blocked: detected ${String(matches.length)} likely secret(s):\n${summary}\n\n` +
          "Remove secrets before saving to persistent memory. " +
          "Use environment variables or credential stores instead.",
      };
    });
  } catch (err) {
    api.logger.warn(
      `[SECURITY] Could not register secret scanner hook: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  api.logger.info("");
  api.logger.info("  ┌─────────────────────────────────────────────────────┐");
  api.logger.info("  │  NemoClaw registered                                │");
  api.logger.info("  │                                                     │");
  api.logger.info(`  │  Endpoint:  ${bannerEndpoint.padEnd(40)}│`);
  api.logger.info(`  │  Provider:  ${bannerProvider.padEnd(40)}│`);
  api.logger.info(`  │  Model:     ${bannerModel.padEnd(40)}│`);
  api.logger.info("  │  Slash:     /nemoclaw                               │");
  api.logger.info("  └─────────────────────────────────────────────────────┘");
  api.logger.info("");
}
