// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler for the /nemoclaw slash command (chat interface).
 *
 * Supports subcommands:
 *   /nemoclaw status   - show sandbox/blueprint/inference state
 *   /nemoclaw eject    - rollback to host installation
 *   /nemoclaw shields  - show shields status (read-only)
 *   /nemoclaw config   - show sandbox config (read-only, redacted)
 *   /nemoclaw          - show help
 */

import {
  getPluginConfig,
  type OpenClawPluginApi,
  type PluginCommandContext,
  type PluginCommandResult,
} from "../index.js";
import { loadState } from "../blueprint/state.js";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
} from "../onboard/config.js";
import { slashShieldsStatus } from "./shields-status.js";
import { slashConfigShow } from "./config-show.js";

export function handleSlashCommand(
  ctx: PluginCommandContext,
  api: OpenClawPluginApi,
): PluginCommandResult {
  const tokens = ctx.args?.trim().split(/\s+/).filter(Boolean) ?? [];
  const subcommand = tokens[0] ?? "";
  const subArg = tokens[1];

  switch (subcommand) {
    case "status":
      return slashStatus(api);
    case "eject":
      return slashEject();
    case "onboard":
      return slashOnboard();
    case "shields":
      return slashShieldsStatus(subArg);
    case "config":
      return slashConfigShow();
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
      "  `shields` - Show shields status (up/down, timeout, policy)",
      "  `config`  - Show sandbox configuration (credentials redacted)",
      "  `eject`   - Show rollback instructions",
      "  `onboard` - Show onboarding status and instructions",
      "",
      "For full management use the NemoClaw CLI:",
      "  `nemoclaw <name> shields down|up|status`",
      "  `nemoclaw <name> config get`",
      "  `nemoclaw <name> status`",
      "  `nemoclaw <name> connect`",
      "  `nemoclaw <name> logs`",
      "  `nemoclaw <name> destroy`",
    ].join("\n"),
  };
}

function slashStatus(api: OpenClawPluginApi): PluginCommandResult {
  const onboardConfig = loadOnboardConfig();
  const { sandboxName } = getPluginConfig(api);

  if (!onboardConfig) {
    return {
      text: "**NemoClaw**: No onboard configuration found. Run `nemoclaw onboard` to get started.",
    };
  }

  const lines = [
    "**NemoClaw Status**",
    "",
    `Sandbox: ${sandboxName}`,
    `Endpoint: ${describeOnboardEndpoint(onboardConfig)}`,
    `Provider: ${describeOnboardProvider(onboardConfig)}`,
    `Model: ${onboardConfig.model}`,
    `Onboarded: ${onboardConfig.onboardedAt}`,
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

function slashOnboard(): PluginCommandResult {
  const config = loadOnboardConfig();
  if (config) {
    return {
      text: [
        "**NemoClaw Onboard Status**",
        "",
        `Endpoint: ${describeOnboardEndpoint(config)}`,
        `Provider: ${describeOnboardProvider(config)}`,
        config.ncpPartner ? `NCP Partner: ${config.ncpPartner}` : null,
        `Model: ${config.model}`,
        `Credential: $${config.credentialEnv}`,
        `Profile: ${config.profile}`,
        `Onboarded: ${config.onboardedAt}`,
        "",
        "To reconfigure, run: `nemoclaw onboard`",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return {
    text: [
      "**NemoClaw Onboarding**",
      "",
      "No configuration found. Run the onboard command to set up inference:",
      "",
      "```",
      "nemoclaw onboard",
      "```",
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
