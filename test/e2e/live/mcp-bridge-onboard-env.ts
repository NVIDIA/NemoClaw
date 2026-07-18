// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

const EXACT_MAIN_OVERLAY_KEYS = new Set([
  "PATH",
  "NEMOCLAW_OPENSHELL_BIN",
  "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
  "NEMOCLAW_OPENSHELL_SANDBOX_BIN",
]);

export function buildMcpBridgeExactMainEnv(options: {
  baseEnv?: NodeJS.ProcessEnv;
  envOverlay?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const envOverlay = options.envOverlay ?? {};
  for (const key of Object.keys(envOverlay)) {
    if (!EXACT_MAIN_OVERLAY_KEYS.has(key)) {
      throw new Error(`MCP exact-main command does not allow env overlay key '${key}'`);
    }
  }

  return {
    ...buildAvailabilityProbeEnv(options.baseEnv),
    ...envOverlay,
  };
}

export function buildMcpBridgeOnboardEnv(options: {
  agent: "openclaw" | "hermes" | "langchain-deepagents-code";
  baseEnv?: NodeJS.ProcessEnv;
  compatibleKey: string;
  compatibleModel: string;
  endpointUrl: string;
  envOverlay?: NodeJS.ProcessEnv;
  sandboxName: string;
}): NodeJS.ProcessEnv {
  return {
    ...buildMcpBridgeExactMainEnv(options),
    COMPATIBLE_API_KEY: options.compatibleKey,
    NVIDIA_INFERENCE_API_KEY: options.compatibleKey,
    NEMOCLAW_AGENT: options.agent,
    NEMOCLAW_ENDPOINT_URL: options.endpointUrl,
    NEMOCLAW_MODEL: options.compatibleModel,
    NEMOCLAW_COMPAT_MODEL: options.compatibleModel,
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_SANDBOX_NAME: options.sandboxName,
    NEMOCLAW_RECREATE_SANDBOX: "1",
  };
}
