// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ensureLiveSandboxOrExit } from "../gateway-state";
import { callOpenclawGateway } from "./gateway-rpc";
import {
  buildCanonicalSessionKey,
  DEFAULT_AGENT_ID,
  parseAgentIdFromSessionKey,
  validateAgentId,
  validateSessionKey,
} from "./paths";

export interface SessionsDeleteOptions {
  key: string;
  agent?: string;
  keepTranscript?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface SessionsDeletePayload {
  ok?: boolean;
  key?: string;
  removedTranscript?: boolean;
  entry?: unknown;
  error?: { code?: string | number; message?: string };
}

export interface SessionsDeleteResult {
  key: string;
  removedTranscript: boolean;
  entry?: unknown;
}

export async function deleteSandboxSession(
  sandboxName: string,
  opts: SessionsDeleteOptions,
): Promise<SessionsDeleteResult> {
  const requestedAgent = opts.agent ? validateAgentId(opts.agent) : null;
  const rawKey = validateSessionKey(opts.key);
  const keyAgent = parseAgentIdFromSessionKey(rawKey);

  if (requestedAgent && keyAgent && requestedAgent !== keyAgent) {
    console.error(
      `  Refusing to invoke sessions.delete: session key '${rawKey}' is scoped to agent '${keyAgent}', not '${requestedAgent}'.`,
    );
    console.error(
      `  Drop --agent or pass a key under that agent (e.g. agent:${requestedAgent}:...).`,
    );
    process.exit(1);
  }

  const resolvedAgent = keyAgent ?? requestedAgent ?? DEFAULT_AGENT_ID;
  const canonicalKey = buildCanonicalSessionKey(resolvedAgent, rawKey);
  const deleteTranscript = opts.keepTranscript !== true;

  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  const { payload, rawOutput } = callOpenclawGateway<SessionsDeletePayload>({
    sandboxName,
    method: "sessions.delete",
    params: { key: canonicalKey, deleteTranscript },
  });

  if (payload.ok === false || payload.error) {
    const code = payload.error?.code ?? "unknown";
    const message = payload.error?.message ?? "no message";
    console.error(
      `  Gateway refused sessions.delete for '${canonicalKey}': [${code}] ${message}`,
    );
    process.exit(1);
  }
  if (payload.ok !== true || typeof payload.key !== "string") {
    console.error("  Gateway returned an unexpected sessions.delete payload.");
    console.error(`  ${rawOutput.trim()}`);
    process.exit(1);
  }

  const removedTranscript = payload.removedTranscript ?? deleteTranscript;

  if (opts.json) {
    console.log(
      JSON.stringify({
        key: payload.key,
        removedTranscript,
        entry: payload.entry ?? null,
      }),
    );
  } else {
    const transcriptNote = removedTranscript
      ? "(transcript removed)"
      : "(transcript preserved)";
    console.error(
      `  Deleted session '${payload.key}' on agent '${resolvedAgent}' via the OpenClaw gateway ${transcriptNote}.`,
    );
    if (opts.verbose && payload.entry !== undefined) {
      console.error(`  entry: ${JSON.stringify(payload.entry)}`);
    }
  }

  return { key: payload.key, removedTranscript, entry: payload.entry };
}
