// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Scope boundary for `nemoclaw <name> sessions reset`:
//
//   - Invalid state addressed by this code path: a user wants to drop the
//     current conversation for a given session key (canonicalised as
//     `agent:<agent>:<slot>`) so the next message starts on a clean entry.
//   - Source boundary:
//       * NemoClaw side (this file): validate the requested key/agent,
//         canonicalise the session key, dispatch the `sessions.reset`
//         JSON-RPC to the in-sandbox OpenClaw gateway, and surface the
//         envelope to the user.
//       * OpenClaw side (upstream `openclaw` npm package, pinned at
//         `agents/openclaw/manifest.yaml` -> `expected_version`): owns the
//         actual reset semantics — clearing the session entry, releasing
//         stale `.jsonl.lock` files, recovering from a corrupt
//         `sessions.json`, and guaranteeing the next message lands on a
//         clean entry. The on-disk session store under
//         `/sandbox/.openclaw/sessions/` is never touched by NemoClaw.
//   - Source-fix constraint: NemoClaw cannot patch lock-file or session-store
//     recovery without reaching into the sandbox file system, which would
//     violate the sandbox boundary and race with OpenClaw's own writes.
//     Recovery must stay upstream.
//   - Regression-test coverage:
//       * NemoClaw host-side (here, intentionally routing-only): the
//         host wrapper provably can't `cat`, mutate, or repair files
//         inside the sandbox, so host-side tests deliberately cover only
//         the routing/dispatch surface that lives on this side of the
//         boundary. Concretely: `src/lib/actions/sandbox/sessions/`
//         covers key canonicalisation, agent-key cross-check, gateway
//         RPC dispatch, and envelope parsing — see `paths.test.ts` and
//         `gateway-rpc.test.ts`. The host-side E2E
//         (`test/e2e/test-sessions-agents-cli.sh`, TC-SESS-03/04) proves
//         the wrapper routes and that the gateway envelope round-trips.
//         Adding stale-lock or corrupt-store seeding here would force
//         NemoClaw to write into `/sandbox/.openclaw/sessions/` from the
//         host, which the sandbox isolation guards specifically forbid.
//       * Upstream stale-lock / corrupt-store / clean-followup coverage
//         lives in the `openclaw` npm package (pinned at
//         `agents/openclaw/manifest.yaml` -> `expected_version`, see
//         the literal version string in that file at merge time). The
//         `sessions.reset` JSON-RPC handler in that package owns the
//         recovery contract; its test suite (shipped with the package
//         tarball under `test/sessions/reset.test.*`) is the
//         authoritative source. To audit the upstream contract for a
//         given release: `npm view openclaw@<expected_version> dist`
//         then inspect the package contents.
//   - Removal condition: this scope-boundary comment can be removed once
//     OpenClaw exposes a stable, documented `sessions.reset` contract whose
//     recovery semantics are referenced from the NemoClaw docs site; the
//     comment exists to keep the NemoClaw/OpenClaw responsibility split
//     explicit while the contract is still informal.

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
