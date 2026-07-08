// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type WebAuthManifestRecord = {
  readonly web_auth_method?: unknown;
  readonly web_auth_env?: unknown;
};

export type AgentWebAuthMethod = "bearer_token" | "none";

export interface AgentWebAuth {
  /** How clients authenticate to the agent's HTTP API surface. */
  method: AgentWebAuthMethod;
  /**
   * For bearer_token agents, the in-sandbox env-var name (in the agent's
   * .env) that holds the token. null when the agent has no token-based web auth.
   */
  env: string | null;
}

export function readWebAuth(record: WebAuthManifestRecord): AgentWebAuth {
  const method: AgentWebAuthMethod =
    record.web_auth_method === "bearer_token" ? "bearer_token" : "none";
  const rawEnv = record.web_auth_env;
  const env =
    method === "bearer_token" &&
    typeof rawEnv === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawEnv)
      ? rawEnv
      : null;
  if (method === "bearer_token" && !env) {
    throw new Error(
      "Agent manifest declares web_auth_method: bearer_token but web_auth_env is missing or not a valid env-var name",
    );
  }
  return { method, env };
}
