// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { shellQuote } from "../runner";

export type RunCaptureOpenshell = (args: string[], opts?: Record<string, unknown>) => string | null;

/**
 * Read a bearer_token agent's web-auth token (e.g. Hermes' API_SERVER_KEY)
 * from its in-sandbox .env. The .env is 0640 root:sandbox and the gateway
 * group can read it, so we grep it via `sandbox exec` as the sandbox user
 * rather than `sandbox download` (which may not have read access). Prints
 * only the value, never the key name, and returns null when the agent has
 * no bearer token or the value is absent.
 */
export function fetchAgentWebAuthTokenFromSandbox(
  runCaptureOpenshell: RunCaptureOpenshell,
  sandboxName: string,
  agent: AgentDefinition,
): string | null {
  const { method, env } = agent.webAuth;
  if (method !== "bearer_token" || !env) return null;
  const envFile = agent.configPaths.envFile;
  if (!envFile) return null;
  const dir = agent.configPaths.dir.replace(/\/+$/, "");
  const envPath = `${dir}/${envFile}`;
  // env is validated env-var-shaped in defs.ts, and shellQuote guards the
  // path, so the interpolation below is injection-safe.
  const assignmentPattern = `^[[:space:]]*(export[[:space:]]+)?${env}=`;
  const script =
    `f=${shellQuote(envPath)}; [ -f "$f" ] || exit 3; ` +
    `grep -m1 -E ${shellQuote(assignmentPattern)} "$f" 2>/dev/null | ` +
    `sed -E ${shellQuote(`s/${assignmentPattern}//`)}`;
  const out = runCaptureOpenshell(
    ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", script],
    { ignoreError: true },
  );
  if (out == null) return null;
  let value = out.replace(/\r?\n$/, "").trim();
  // Strip one layer of surrounding matching quotes if present.
  if (
    value.length >= 2 &&
    (value[0] === '"' || value[0] === "'") &&
    value[value.length - 1] === value[0]
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : null;
}
