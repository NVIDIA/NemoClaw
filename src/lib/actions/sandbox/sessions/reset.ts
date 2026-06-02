// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Scope boundary for `nemoclaw <name> sessions reset`:
//
//   - NemoClaw side (this file): validate the requested key/agent, canonicalise
//     the session key, dispatch the `sessions.reset` JSON-RPC to the in-sandbox
//     OpenClaw gateway, and surface the envelope to the user.
//   - OpenClaw side (upstream openclaw.ai): owns the actual reset semantics,
//     including clearing the session entry, releasing stale `.jsonl.lock`
//     files, recovering from a corrupt `sessions.json`, and guaranteeing that
//     the next message lands on a clean session. NemoClaw does not touch the
//     in-sandbox session store directly; the upstream recovery contract and
//     its test coverage live with the gateway server, not here.

import { ensureLiveSandboxOrExit } from "../gateway-state";
import { callOpenclawGateway } from "./gateway-rpc";
import {
  buildCanonicalSessionKey,
  DEFAULT_AGENT_ID,
  parseAgentIdFromSessionKey,
  validateAgentId,
  validateSessionKey,
} from "./paths";

export type SessionsResetReason = "reset" | "new";

export interface SessionsResetOptions {
  key: string;
  agent?: string;
  reason?: SessionsResetReason;
  json?: boolean;
  verbose?: boolean;
}

export interface SessionsResetSuccess {
  ok: true;
  key: string;
  entry?: unknown;
}

export interface SessionsResetResult {
  key: string;
  reason: SessionsResetReason;
  entry?: unknown;
}

export async function resetSandboxSession(
  sandboxName: string,
  opts: SessionsResetOptions,
): Promise<SessionsResetResult> {
  const reason: SessionsResetReason = opts.reason === "new" ? "new" : "reset";
  const requestedAgent = opts.agent ? validateAgentId(opts.agent) : null;
  const rawKey = validateSessionKey(opts.key);
  const keyAgent = parseAgentIdFromSessionKey(rawKey);

  if (requestedAgent && keyAgent && requestedAgent !== keyAgent) {
    console.error(
      `  Refusing to invoke sessions.reset: session key '${rawKey}' is scoped to agent '${keyAgent}', not '${requestedAgent}'.`,
    );
    console.error(
      `  Drop --agent or pass a key under that agent (e.g. agent:${requestedAgent}:...).`,
    );
    process.exit(1);
  }

  const resolvedAgent = keyAgent ?? requestedAgent ?? DEFAULT_AGENT_ID;
  const canonicalKey = buildCanonicalSessionKey(resolvedAgent, rawKey);

  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  const { envelope, rawOutput } = callOpenclawGateway<SessionsResetSuccess>({
    sandboxName,
    method: "sessions.reset",
    params: { key: canonicalKey, reason },
  });

  if (envelope.error) {
    const code = envelope.error.code ?? "unknown";
    const message = envelope.error.message ?? "no message";
    console.error(
      `  Gateway refused sessions.reset for '${canonicalKey}': [${code}] ${message}`,
    );
    process.exit(1);
  }
  const success = envelope.result;
  if (!success || success.ok !== true || typeof success.key !== "string") {
    console.error("  Gateway returned an unexpected sessions.reset payload.");
    console.error(`  ${rawOutput.trim()}`);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify({ key: success.key, reason, entry: success.entry ?? null }));
  } else {
    const verb = reason === "new" ? "Replaced" : "Reset";
    console.error(
      `  ${verb} session '${success.key}' on agent '${resolvedAgent}' via the OpenClaw gateway.`,
    );
    if (opts.verbose && success.entry !== undefined) {
      console.error(`  entry: ${JSON.stringify(success.entry)}`);
    }
  }

  return { key: success.key, reason, entry: success.entry };
}
