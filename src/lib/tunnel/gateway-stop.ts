// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveGatewayPortFromName, resolveSandboxGatewayName } from "../onboard/gateway-binding";
import * as registry from "../state/registry";
import * as gatewayPortRelease from "./gateway-port-release";
import { resolveExplicitGatewayPortEnv } from "./gateway-port-resolution";

type Log = (message: string) => void;

/**
 * Outcome of the gateway step in `stop`, so the final line can report whether
 * a managed gateway was in scope.
 */
export type GatewayStopOutcome =
  /** A release ran and was confirmed (or intentionally skipped as invalid). */
  | "attempted"
  /** A registered peer still owns the gateway, so it stays up by design. */
  | "kept-shared"
  /** No sandbox name and no explicit NEMOCLAW_GATEWAY_PORT — nothing was scoped. */
  | "not-scoped"
  /** A scoped release ran but the listener was not confirmed gone. */
  | "unconfirmed";

export interface GatewayStopDeps {
  env?: NodeJS.ProcessEnv;
  info?: Log;
  warn?: Log;
  listSandboxes?: typeof registry.listSandboxes;
  releaseManagedGatewayPort?: typeof gatewayPortRelease.releaseManagedGatewayPort;
}

type SharedGatewayOwner = {
  name: string;
  port: number;
};

/**
 * Find another registered sandbox that may still own the selected sandbox's
 * host gateway. The registry is intentionally a conservative ownership
 * signal, matching destroy's last-sandbox gate: a stale registration can keep
 * a gateway alive, but tearing it down while a registered peer is live would
 * break that peer.
 *
 * A missing selected entry is left to releaseManagedGatewayPort(), whose
 * sandbox-specific resolver already fails closed. Invalid or unreadable
 * registry state throws into the best-effort catch below so teardown is
 * skipped rather than guessed.
 */
function findSharedGatewayOwner(
  sandboxName: string,
  listSandboxes: typeof registry.listSandboxes,
): SharedGatewayOwner | null {
  const sandboxes = listSandboxes().sandboxes;
  const selected = sandboxes.find((sandbox) => sandbox.name === sandboxName);
  if (!selected) return null;

  const gatewayName = resolveSandboxGatewayName(selected);
  const port = resolveGatewayPortFromName(gatewayName);
  if (port === null) {
    throw new Error(`Could not resolve gateway port for registered sandbox ${sandboxName}`);
  }

  for (const sandbox of sandboxes) {
    if (sandbox.name === sandboxName) continue;
    try {
      if (resolveSandboxGatewayName(sandbox) === gatewayName) {
        return { name: sandbox.name, port };
      }
    } catch (error) {
      throw new Error(
        `Invalid persisted sandbox gateway for peer '${sandbox.name}': ` +
          `${(error as Error).message ?? String(error)}`,
      );
    }
  }
  return null;
}

function reportUnconfirmedGatewayRelease(
  warn: Log,
  release: { port: number | null; released: boolean; skipped: boolean },
): boolean {
  // The release helper reports invalid bindings itself. For an attempted but
  // unconfirmed release, do not recommend killing raw lsof PIDs: an unrelated
  // listener may be one the scoped stopper deliberately left alone.
  if (!release.released && !release.skipped) {
    warn(
      `NemoClaw gateway port ${release.port ?? "?"} was not confirmed released. ` +
        "Inspect the remaining listener and stop it only if it is the matching gateway process.",
    );
    return true;
  }
  return false;
}

function reportAmbiguousGatewayRelease(warn: Log, env: NodeJS.ProcessEnv, error: unknown): void {
  // A corrupt peer registry entry makes gateway ownership ambiguous. Do not
  // block the selected sandbox's non-gateway stop work, but skip destructive
  // release so a potentially shared gateway is never torn down by guessing.
  warn(
    `Could not release the NemoClaw gateway port: ${(error as Error).message ?? String(error)}. ` +
      "Gateway ownership is ambiguous; repair the sandbox registry and retry. " +
      "Run with NODE_DEBUG=nemoclaw:gateway for details.",
  );
  // Best-effort by design: keep normal output concise, with the full stack
  // available only to an operator explicitly debugging gateway teardown.
  if ((env.NODE_DEBUG ?? "").includes("nemoclaw:gateway")) {
    console.error((error as Error).stack ?? String(error));
  }
}

/**
 * Release the selected sandbox's host gateway only when no registered peer
 * shares it. Without a sandbox name, release only an explicit
 * `NEMOCLAW_GATEWAY_PORT` so a bare `stop` cannot kill the default shared
 * gateway (#8952).
 */
export function releaseGatewayPortForStop(
  sandboxName: string | undefined,
  deps: GatewayStopDeps = {},
): GatewayStopOutcome {
  const env = deps.env ?? process.env;
  const info = deps.info ?? console.log;
  const warn = deps.warn ?? console.warn;
  const listSandboxes = deps.listSandboxes ?? registry.listSandboxes;
  const releaseManagedGatewayPort =
    deps.releaseManagedGatewayPort ?? gatewayPortRelease.releaseManagedGatewayPort;

  if (!sandboxName) {
    // Use the same parsed port that passed the gate; do not fall back to GATEWAY_PORT.
    const port = resolveExplicitGatewayPortEnv(env);
    if (port === null) return "not-scoped";
    try {
      const result = releaseManagedGatewayPort({ port }, { env });
      if (reportUnconfirmedGatewayRelease(warn, result)) return "unconfirmed";
    } catch (error) {
      reportAmbiguousGatewayRelease(warn, env, error);
      return "unconfirmed";
    }
    return "attempted";
  }

  try {
    const sharedOwner = findSharedGatewayOwner(sandboxName, listSandboxes);
    if (sharedOwner) {
      info(
        `Keeping shared NemoClaw gateway port ${sharedOwner.port} running for ` +
          `registered sandbox '${sharedOwner.name}'.`,
      );
      return "kept-shared";
    }

    const result = releaseManagedGatewayPort({ sandboxName });
    if (reportUnconfirmedGatewayRelease(warn, result)) return "unconfirmed";
  } catch (error) {
    reportAmbiguousGatewayRelease(warn, env, error);
    return "unconfirmed";
  }
  return "attempted";
}
