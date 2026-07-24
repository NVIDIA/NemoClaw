// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Exact-target gateway authority resolution for teardown and provider credential mutations.
 *
 * Onboarding binds authority before gateway effects. Credentials add and reset,
 * stop, final-sandbox cleanup, and uninstall can run after onboarding exits.
 * They must reload that authority before they mutate providers, scan listeners,
 * signal processes, or remove runtime resources (#6576).
 */

import fs from "node:fs";
import path from "node:path";

import { normalizeSession, type Session } from "../state/onboard-session";
import { nemoclawStateRoot, resolveHome } from "../state/state-root";
import { hasOpenShellGatewayUserService } from "./docker-driver-gateway-service";
import { gatewayOwnerFromCheckpoint } from "./gateway-authority-checkpoint";
import { resolveGatewayName } from "./gateway-binding";
import {
  type GatewayManagementLoadResult,
  loadGatewayManagementDeclaration,
} from "./gateway-management";
import {
  describeGatewayOwnerForError,
  type GatewayOwner,
  resolveGatewayOwner,
  sameGatewayOwner,
} from "./gateway-ownership";

export interface GatewayTeardownTarget {
  gatewayName: string;
  gatewayPort: number;
}

export interface GatewayTeardownAuthorityDeps {
  env?: NodeJS.ProcessEnv;
  hasPackagedService?: () => boolean;
  loadDeclaration?: (env: NodeJS.ProcessEnv) => GatewayManagementLoadResult;
  loadSession?: (target: GatewayTeardownTarget, env: NodeJS.ProcessEnv) => Session | null;
}

export type GatewayTeardownAuthorityResolver = (
  target: GatewayTeardownTarget,
  deps?: GatewayTeardownAuthorityDeps,
) => GatewayOwner;

type GatewayAuthorityEffect = "credential mutation" | "teardown";

function loadTargetSession(target: GatewayTeardownTarget, env: NodeJS.ProcessEnv): Session | null {
  const sessionFile = path.join(
    nemoclawStateRoot(resolveHome(env), target.gatewayPort),
    "onboard-session.json",
  );
  try {
    if (!fs.existsSync(sessionFile)) return null;
    return normalizeSession(JSON.parse(fs.readFileSync(sessionFile, "utf-8")));
  } catch {
    // Preserve loadSession() compatibility for legacy or interrupted state.
    // A valid selected authority still remains binding when it can be read.
    return null;
  }
}

/**
 * Resolve the current owner and revalidate checkpointed authority for the exact
 * gateway before teardown or provider credential mutation. A declaration or
 * recorded-owner change is an explicit migration. It does not permit the
 * operation to use another owner.
 */
function resolveGatewayEffectAuthority(
  target: GatewayTeardownTarget,
  effect: GatewayAuthorityEffect,
  deps: GatewayTeardownAuthorityDeps,
): GatewayOwner {
  const operation = effect === "teardown" ? "gateway teardown" : "provider credential mutation";
  if (resolveGatewayName(target.gatewayPort) !== target.gatewayName) {
    throw new Error(
      `Refusing ${operation} for noncanonical target '${target.gatewayName}@${String(target.gatewayPort)}'.`,
    );
  }

  const env = deps.env ?? process.env;
  const loaded = deps.loadDeclaration
    ? deps.loadDeclaration(env)
    : loadGatewayManagementDeclaration({ env });
  if (!loaded.ok) {
    throw new Error(`Invalid gateway management declaration: ${loaded.reason}`);
  }
  const resolved = resolveGatewayOwner({
    ...target,
    declaration: loaded.declaration,
    hasPackagedService: deps.hasPackagedService?.() ?? hasOpenShellGatewayUserService(),
  });

  const session = (deps.loadSession ?? loadTargetSession)(target, env);
  const recordedDecision = session?.checkpoint?.gatewayAuthority;
  if (!recordedDecision || recordedDecision.kind === "unset") return resolved;
  if (recordedDecision.kind === "declined") {
    throw new Error(
      `Refusing ${operation} for '${target.gatewayName}': the onboarding checkpoint contains an invalid declined gateway authority.`,
    );
  }

  const recorded = gatewayOwnerFromCheckpoint(recordedDecision.value);
  if (recorded.gatewayName !== target.gatewayName || recorded.gatewayPort !== target.gatewayPort) {
    throw new Error(
      `Refusing ${operation} for '${target.gatewayName}@${String(target.gatewayPort)}': ` +
        `the recorded authority targets '${recorded.gatewayName}@${String(recorded.gatewayPort)}'.`,
    );
  }
  if (!sameGatewayOwner(recorded, resolved)) {
    throw new Error(
      "Gateway lifecycle authority changed since onboarding " +
        `(${describeGatewayOwnerForError(recorded)} -> ${describeGatewayOwnerForError(resolved)}). ` +
        `Changing authority requires a fresh onboarding run; ${operation} will not perform gateway effects.`,
    );
  }
  return recorded;
}

export function resolveGatewayTeardownAuthority(
  target: GatewayTeardownTarget,
  deps: GatewayTeardownAuthorityDeps = {},
): GatewayOwner {
  return resolveGatewayEffectAuthority(target, "teardown", deps);
}

/** Revalidate the exact checkpointed authority before a provider credential mutation. */
export function resolveGatewayCredentialMutationAuthority(
  target: GatewayTeardownTarget,
  deps: GatewayTeardownAuthorityDeps = {},
): GatewayOwner {
  return resolveGatewayEffectAuthority(target, "credential mutation", deps);
}
