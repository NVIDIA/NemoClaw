// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

const AUTOMATIC_GATEWAY_PORT_RE = /^(?:899[0-9]|900[0-5])$/;
const CONFIGURED_PORT_NAMES = [
  "NEMOCLAW_DASHBOARD_PORT",
  "NEMOCLAW_HERMES_DASHBOARD_PORT",
  "NEMOCLAW_VLLM_PORT",
  "NEMOCLAW_OLLAMA_PORT",
  "NEMOCLAW_OLLAMA_PROXY_PORT",
  "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT",
  "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
  "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
] as const;

const COMPLETION_ERROR =
  "Onboarding completed, but NemoClaw could not finalize the automatically selected gateway port record.";

/** Promote a launcher-restored pending port only after direct onboarding succeeds. */
export function completeAutomaticGatewayPortAfterOnboard(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env._NEMOCLAW_AUTOMATIC_GATEWAY_PORT !== "1") return false;
  const port = String(env.NEMOCLAW_GATEWAY_PORT ?? "").trim();
  if (!AUTOMATIC_GATEWAY_PORT_RE.test(port)) throw new Error(COMPLETION_ERROR);

  const configuredPorts = Object.fromEntries(
    CONFIGURED_PORT_NAMES.flatMap((name) =>
      env[name] === undefined ? [] : [[name, env[name] as string]],
    ),
  );
  const resolver = path.join(__dirname, "..", "..", "..", "..", "scripts", "install.sh");
  const result = spawnSync("/bin/bash", [resolver, "--internal-complete-automatic-gateway-port"], {
    encoding: "utf8",
    env: {
      HOME: env.HOME || "/",
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      NEMOCLAW_GATEWAY_PORT: port,
      ...configuredPorts,
    },
    maxBuffer: 64 * 1024,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0 || result.signal) throw new Error(COMPLETION_ERROR);
  return true;
}
