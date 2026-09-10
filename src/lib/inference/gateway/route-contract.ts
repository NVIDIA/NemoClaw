// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getSandboxInferenceConfig,
  parseGatewayInference,
  resolveAgentInferenceApi,
} from "../config";

export { buildGatewayInferenceGetArgs } from "./command-args";
export { parseGatewayInference };

/** Resolve the provider route recorded in one managed startup profile. */
export function resolveManagedStartupInferenceRoute(
  agentName: string,
  provider: string,
  model: string,
  preferredInferenceApi: string | null,
) {
  const api =
    agentName === "langchain-deepagents-code"
      ? "openai-completions"
      : resolveAgentInferenceApi(agentName, provider, preferredInferenceApi);
  return getSandboxInferenceConfig(model, provider, api);
}
