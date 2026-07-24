// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Exact-target gateway authority resolution for destructive teardown paths.
 *
 * Onboarding binds authority before gateway effects. Stop, final-sandbox
 * cleanup, and uninstall run in separate processes, so they must reload that
 * authority before they scan listeners, signal processes, or remove runtime
 * resources (#6576).
 */

import fs from "node:fs";
import path from "node:path";

import { normalizeSession, type Session } from "../state/onboard-session";
import { nemoclawStateRoot, resolveHome } from "../state/state-root";
import { hasOpenShellGatewayUserService } from "./docker-driver-gateway-service";
import { gatewayOwnerFromCheckpoint } from "./gateway-authority-checkpoint";
import {
  loadGatewayManagementDeclaration,
  type GatewayManagementLoadResult,
} from "./gateway-management";
import {
  describeGatewayOwnerForError,
  type GatewayOwner,
  resolveGatewayOwner,
  sameGatewayOwner,
} from "./gateway-ownership";
import { resolveGatewayName } from "./gateway-binding";

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
 * Resolve the current owner and revalidate a selected checkpoint for the exact
 * gateway before a teardown effect. A declaration or recorded-owner change is
 * an explicit migration, never permission to switch owners during cleanup.
 */
export function resolveGatewayTeardownAuthority(
  target: GatewayTeardownTarget,
  deps: GatewayTeardownAuthorityDeps = {},
): GatewayOwner {
  if (resolveGatewayName(target.gatewayPort) !== target.gatewayName) {
    throw new Error(
      `Refusing gateway teardown for noncanonical target '${target.gatewayName}@${String(target.gatewayPort)}'.`,
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
      `Refusing gateway teardown for '${target.gatewayName}': the onboarding checkpoint contains an invalid declined gateway authority.`,
    );
  }

  const recorded = gatewayOwnerFromCheckpoint(recordedDecision.value);
  if (recorded.gatewayName !== target.gatewayName || recorded.gatewayPort !== target.gatewayPort) {
    throw new Error(
      `Refusing gateway teardown for '${target.gatewayName}@${String(target.gatewayPort)}': ` +
        `the recorded authority targets '${recorded.gatewayName}@${String(recorded.gatewayPort)}'.`,
    );
  }
  if (!sameGatewayOwner(recorded, resolved)) {
    throw new Error(
      "Gateway lifecycle authority changed since onboarding " +
        `(${describeGatewayOwnerForError(recorded)} -> ${describeGatewayOwnerForError(resolved)}). ` +
        "Changing authority requires a fresh onboarding run; teardown will not perform gateway effects.",
    );
  }
  return recorded;
}
