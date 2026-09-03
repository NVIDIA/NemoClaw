// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slash command handler for `/nemoclaw config`.
 *
 * Read-only — shows the current sandbox configuration with credential
 * values redacted. Configuration can only be modified from the host CLI
 * (security invariant: sandbox never writes its own immutable config).
 */

import type { PluginCommandResult } from "../index.js";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
} from "../onboard/config.js";

export function slashConfigShow(): PluginCommandResult {
  const config = loadOnboardConfig();

  if (!config) {
    return {
      text: [
        "**NemoClaw Config**",
        "",
        "No configuration found. Run `nemoclaw onboard` from the host to configure.",
      ].join("\n"),
    };
  }

  // Redact credential env var value — only show the variable name when it
  // looks like a safe env-var identifier. Malformed persisted data must
  // never be echoed verbatim (could leak a raw token).
  const hasCredentialEnv =
    typeof config.credentialEnv === "string" && config.credentialEnv.length > 0;
  const isSafeEnvName = hasCredentialEnv && /^[A-Z_][A-Z0-9_]*$/.test(config.credentialEnv);
  const authTokenText = !hasCredentialEnv
    ? "(not configured)"
    : isSafeEnvName
      ? `$${config.credentialEnv} (set via env var)`
      : "(configured)";

  const lines = [
    "**NemoClaw Config**",
    "",
    `Gateway:     ${describeOnboardEndpoint(config)}`,
    `Auth token:  ${authTokenText}`,
    `Inference:   ${describeOnboardProvider(config)}`,
    config.ncpPartner ? `NCP Partner: ${config.ncpPartner}` : null,
    `Model:       ${config.model}`,
    `Profile:     ${config.profile}`,
    `Onboarded:   ${config.onboardedAt}`,
    "",
    "Configuration can only be modified from the host CLI.",
    "Use `nemoclaw config get <sandbox>` for the full sandbox config.",
  ];

  return { text: lines.filter(Boolean).join("\n") };
}
