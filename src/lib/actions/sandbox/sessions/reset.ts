// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { parseAgentIdFromSessionKey, validateAgentId, validateSessionKey } from "./paths";

export type SessionsResetReason = "reset" | "new";

export interface SessionsResetOptions {
  agent: string;
  sessionKey: string;
  reason?: SessionsResetReason;
}

export interface SessionsResetResult {
  key: string;
  reason: SessionsResetReason;
  entry: unknown;
}

interface GatewayCallSuccess {
  result: { ok: true; key: string; entry: unknown };
}

interface GatewayCallFailure {
  error: { code?: string | number; message?: string };
}

type GatewayCallEnvelope = Partial<GatewayCallSuccess & GatewayCallFailure>;

export async function resetSandboxSession(
  sandboxName: string,
  opts: SessionsResetOptions,
): Promise<SessionsResetResult> {
  const agent = validateAgentId(opts.agent);
  const sessionKey = validateSessionKey(opts.sessionKey);
  const keyAgent = parseAgentIdFromSessionKey(sessionKey);
  if (keyAgent !== null && keyAgent !== agent) {
    console.error(
      `  Refusing to invoke sessions.reset: session key '${sessionKey}' is scoped to agent '${keyAgent}', not '${agent}'.`,
    );
    console.error(
      `  Either drop the '${agent}' argument or pass a session key under that agent (e.g. agent:${agent}:...).`,
    );
    process.exit(1);
  }
  const reason: SessionsResetReason = opts.reason === "new" ? "new" : "reset";
  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  const params = JSON.stringify({ key: sessionKey, reason });
  const result = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "openclaw",
      "gateway",
      "call",
      "sessions.reset",
      "--params",
      params,
      "--json",
    ],
    { ignoreError: true },
  );

  if (result.status !== 0) {
    console.error(
      `  Failed to reach the OpenClaw gateway in sandbox '${sandboxName}': exit ${result.status}`,
    );
    if (result.output.trim()) console.error(`  ${result.output.trim()}`);
    console.error(
      `  Verify the gateway is reachable: \`${CLI_NAME} ${sandboxName} status\`.`,
    );
    process.exit(1);
  }

  const envelope = parseGatewayCallEnvelope(result.output);
  if (!envelope || (!envelope.result && !envelope.error)) {
    console.error(
      `  Could not parse gateway call response for session '${sessionKey}'.`,
    );
    if (result.output.trim()) console.error(`  ${result.output.trim()}`);
    process.exit(1);
  }
  if (envelope.error) {
    const code = envelope.error.code ?? "unknown";
    const message = envelope.error.message ?? "no message";
    console.error(
      `  Gateway refused sessions.reset for '${sessionKey}': [${code}] ${message}`,
    );
    process.exit(1);
  }
  const success = envelope.result;
  if (!success || success.ok !== true || typeof success.key !== "string") {
    console.error(`  Gateway returned an unexpected sessions.reset payload.`);
    console.error(`  ${result.output.trim()}`);
    process.exit(1);
  }

  const verb = reason === "new" ? "Replaced" : "Reset";
  console.error(
    `  ${verb} session '${success.key}' on agent '${opts.agent}' via the OpenClaw gateway (archived transcript kept under sessions/).`,
  );
  return { key: success.key, reason, entry: success.entry };
}

function parseGatewayCallEnvelope(output: string): GatewayCallEnvelope | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      return JSON.parse(candidate) as GatewayCallEnvelope;
    } catch {
      // try previous line
    }
  }
  try {
    return JSON.parse(trimmed) as GatewayCallEnvelope;
  } catch {
    return null;
  }
}
