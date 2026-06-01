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

export interface SessionsDeleteSuccess {
  ok: true;
  key: string;
  removedTranscript?: boolean;
  entry?: unknown;
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

  const { envelope, rawOutput } = callOpenclawGateway<SessionsDeleteSuccess>({
    sandboxName,
    method: "sessions.delete",
    params: { key: canonicalKey, deleteTranscript },
  });

  if (envelope.error) {
    const code = envelope.error.code ?? "unknown";
    const message = envelope.error.message ?? "no message";
    console.error(
      `  Gateway refused sessions.delete for '${canonicalKey}': [${code}] ${message}`,
    );
    process.exit(1);
  }
  const success = envelope.result;
  if (!success || success.ok !== true || typeof success.key !== "string") {
    console.error("  Gateway returned an unexpected sessions.delete payload.");
    console.error(`  ${rawOutput.trim()}`);
    process.exit(1);
  }

  const removedTranscript = success.removedTranscript ?? deleteTranscript;

  if (opts.json) {
    console.log(
      JSON.stringify({
        key: success.key,
        removedTranscript,
        entry: success.entry ?? null,
      }),
    );
  } else {
    const transcriptNote = removedTranscript
      ? "(transcript removed)"
      : "(transcript preserved)";
    console.error(
      `  Deleted session '${success.key}' on agent '${resolvedAgent}' via the OpenClaw gateway ${transcriptNote}.`,
    );
    if (opts.verbose && success.entry !== undefined) {
      console.error(`  entry: ${JSON.stringify(success.entry)}`);
    }
  }

  return { key: success.key, removedTranscript, entry: success.entry };
}
