// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NemoClawConfig, OpenClawPluginApi } from "./index.js";

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
