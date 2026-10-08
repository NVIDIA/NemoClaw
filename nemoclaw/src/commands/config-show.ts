// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slash command handler for `/nemoclaw config`.
 *
 * Read-only — shows the current sandbox configuration with credential values
 * redacted. NemoClaw supports agent config as mutable; this command does not
 * modify it.
 */

import type { OpenClawConfig, PluginCommandResult } from "../index.js";
import { loadOnboardConfig } from "../onboard/config.js";
import { readNativeRoute } from "../onboard/native-route.js";

export function slashConfigShow(nativeConfig: OpenClawConfig): PluginCommandResult {
  const config = loadOnboardConfig();

  const route = readNativeRoute(nativeConfig);

  const lines = [
    "**NemoClaw Config**",
    "",
    `Gateway:     ${route.endpoint}`,
    `Auth token:  ${route.credential}`,
    `Inference:   ${route.provider}`,
    `Model:       ${route.model}`,
    `Profile:     ${config?.profile ?? "(not recorded)"}`,
    `Onboarded:   ${config?.onboardedAt ?? "(not recorded)"}`,
    "",
    "Use `nemoclaw <sandbox> config get` for the full sandbox config.",
  ];

  return { text: lines.filter(Boolean).join("\n") };
}
