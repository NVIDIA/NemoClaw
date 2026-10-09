// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler for the /nemoclaw slash command (chat interface).
 *
 * Supports subcommands:
 *   /nemoclaw status   - show sandbox/blueprint/inference state
 *   /nemoclaw eject    - rollback to host installation
 *   /nemoclaw config   - show sandbox config (read-only, redacted)
 *   /nemoclaw          - show help
 */

import { loadState } from "../blueprint/state.js";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
} from "../index.js";
import { loadOnboardConfig } from "../onboard/config.js";
import { readNativeRoute } from "../onboard/native-route.js";
import { getPluginConfig } from "../plugin-config.js";
import { slashConfigShow } from "./config-show.js";

export function handleSlashCommand(
  ctx: PluginCommandContext,
  api: OpenClawPluginApi,
): PluginCommandResult {
  const tokens = ctx.args?.trim().split(/\s+/).filter(Boolean) ?? [];
  const subcommand = tokens[0] ?? "";

  switch (subcommand) {
    case "status":
      return slashStatus(api, ctx.config);
    case "eject":
      return slashEject();
    case "onboard":
      return slashOnboard(ctx.config);
    case "config":
      return slashConfigShow(ctx.config);
    default:
      return slashHelp();
  }
}

function slashHelp(): PluginCommandResult {
  return {
    text: [
      "**NemoClaw**",
      "",
      "Usage: `/nemoclaw <subcommand>`",
      "",
      "Subcommands:",
      "  `status`  - Show sandbox, blueprint, and inference state",
      "  `config`  - Show sandbox configuration (credentials redacted)",
      "  `eject`   - Show rollback instructions",
      "  `onboard` - Show onboarding status and instructions",
      "",
      "For full management use the NemoClaw CLI:",
      "  `nemoclaw <name> config get`",
      "  `nemoclaw <name> status`",
      "  `nemoclaw <name> connect`",
      "  `nemoclaw <name> logs`",
      "  `nemoclaw <name> destroy`",
    ].join("\n"),
  };
}

function slashStatus(api: OpenClawPluginApi, nativeConfig: OpenClawConfig): PluginCommandResult {
  const onboardConfig = loadOnboardConfig();
  const { sandboxName } = getPluginConfig(api);

  const route = readNativeRoute(nativeConfig);

  const lines = [
    "**NemoClaw Status**",
    "",
    `Sandbox: ${sandboxName}`,
    `Endpoint: ${route.endpoint}`,
    `Provider: ${route.provider}`,
    `Model: ${route.model}`,
    `Onboarded: ${onboardConfig?.onboardedAt ?? "(not recorded)"}`,
  ];

  const state = loadState();
  if (state.migrationSnapshot) {
    lines.push("", `Rollback snapshot: ${state.migrationSnapshot}`);
  }

  if (state.lastRebuildAt) {
    lines.push("", `Last rebuild: ${state.lastRebuildAt}`);
    if (state.lastRebuildBackupPath) {
      lines.push(`Rebuild backup: ${state.lastRebuildBackupPath}`);
    }
  }

  return { text: lines.join("\n") };
}

function slashOnboard(nativeConfig: OpenClawConfig): PluginCommandResult {
  const config = loadOnboardConfig();
  const route = readNativeRoute(nativeConfig);
  return {
    text: [
      "**NemoClaw Onboard Status**",
      "",
      `Endpoint: ${route.endpoint}`,
      `Provider: ${route.provider}`,
      `Model: ${route.model}`,
      `Credential: ${route.credential}`,
      `Profile: ${config?.profile ?? "(not recorded)"}`,
      `Onboarded: ${config?.onboardedAt ?? "(not recorded)"}`,
      "",
      "To configure, run: `nemoclaw onboard`",
    ].join("\n"),
  };
}

function slashEject(): PluginCommandResult {
  const state = loadState();

  if (!state.lastAction) {
    return { text: "No NemoClaw deployment found. Nothing to eject from." };
  }

  if (!state.migrationSnapshot && !state.hostBackupPath) {
    return {
      text: "No migration snapshot found. Manual rollback required.",
    };
  }

  return {
    text: [
      "**Eject from NemoClaw**",
      "",
      "To rollback to your host OpenClaw installation, run:",
      "",
      "```",
      "nemoclaw <name> destroy",
      "```",
      "",
      `Snapshot: ${state.migrationSnapshot ?? state.hostBackupPath ?? "none"}`,
    ].join("\n"),
  };
}
