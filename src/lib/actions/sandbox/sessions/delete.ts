// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { callOpenclawGateway, sandboxUsesHermesAgent } from "./gateway-rpc";
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
  // Route by the sandbox's registered agent before OpenClaw key validation,
  // the same dispatch `sessions export` uses (#5526). Hermes ships a native
  // `hermes sessions delete` over its own SQLite store and neither exposes the
  // OpenClaw gateway admin RPC nor accepts OpenClaw canonical `agent:<id>:<rest>`
  // session keys.
  //
  // Trust boundary: the routing helper reads the host-side, user-owned sandbox
  // registry; a sandbox process cannot change this agent selection. A sandbox
  // with no registry entry, or with an `agent` other than `hermes`, keeps the
  // OpenClaw path below.
  if (sandboxUsesHermesAgent(sandboxName)) {
    return deleteHermesSession(sandboxName, opts);
  }

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
    console.error(`  Gateway refused sessions.delete for '${canonicalKey}': [${code}] ${message}`);
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
    const transcriptNote = removedTranscript ? "(transcript removed)" : "(transcript preserved)";
    console.error(
      `  Deleted session '${payload.key}' on agent '${resolvedAgent}' via the OpenClaw gateway ${transcriptNote}.`,
    );
    if (opts.verbose && payload.entry !== undefined) {
      console.error(`  entry: ${JSON.stringify(payload.entry)}`);
    }
  }

  return { key: payload.key, removedTranscript, entry: payload.entry };
}

// OpenClaw-only flags are refused rather than silently ignored.
function rejectOpenClawOnlyDeleteOptions(opts: SessionsDeleteOptions): void {
  if (opts.agent) {
    console.error(
      `  Refusing to delete: --agent ${opts.agent} is OpenClaw-only and is not supported on a Hermes sandbox. Omit the flag.`,
    );
    process.exit(1);
  }
  if (opts.keepTranscript === true) {
    console.error(
      "  Refusing to delete: --keep-transcript is OpenClaw-only and is not supported on a Hermes sandbox. Hermes removes the session entry directly; omit the flag.",
    );
    process.exit(1);
  }
  if (opts.json || opts.verbose) {
    console.error(
      "  Refusing to delete: --json and --verbose print the OpenClaw gateway result and are OpenClaw-only; a Hermes sandbox streams the native command output. Omit the flags.",
    );
    process.exit(1);
  }
}

// Reject a leading dash so Hermes cannot parse the id as a flag. Reject
// whitespace because native Hermes ids contain none.
function validateHermesSessionId(rawKey: string): string {
  const sessionId = rawKey.trim();
  if (sessionId === "" || sessionId.startsWith("-") || /\s/.test(sessionId)) {
    console.error(
      `  Refusing to delete: '${rawKey}' is not a valid Hermes session id. Pass a native id from \`sessions list\` (for example 20260727_130357_cb2b61).`,
    );
    process.exit(1);
  }
  return sessionId;
}

async function deleteHermesSession(
  sandboxName: string,
  opts: SessionsDeleteOptions,
): Promise<never> {
  rejectOpenClawOnlyDeleteOptions(opts);
  const sessionId = validateHermesSessionId(opts.key);

  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });
  // execSandbox streams the native command output and exits the process with
  // its exit code, so control never returns here and there is no NemoClaw-side
  // result envelope to build (unlike the OpenClaw gateway path above).
  await execSandbox(sandboxName, ["hermes", "sessions", "delete", sessionId, "--yes"]);
  throw new Error("unreachable: execSandbox terminates the process");
}
