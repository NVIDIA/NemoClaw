// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Exact-target gateway authority resolution for rebuild, teardown, and provider credential mutations.
 *
 * Onboarding binds authority before gateway effects. Credentials add and reset,
 * stop, final-sandbox cleanup, and uninstall can run after onboarding exits.
 * They must reload that authority before they mutate providers, scan listeners,
 * signal processes, or remove runtime resources (#6576).
 */

import fs from "node:fs";
import path from "node:path";

import { isErrnoException } from "../core/errno";
import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import { inspectCheckpoint } from "../state/onboard-checkpoint";
import type { Session } from "../state/onboard-session";
import { nemoclawStateRoot, resolveHome } from "../state/state-root";
import { hasOpenShellGatewayUserService } from "./docker-driver-gateway-service";
import { gatewayOwnerFromCheckpoint } from "./gateway-authority-checkpoint";
import { resolveGatewayName } from "./gateway-binding";
import {
  type GatewayManagementLoadResult,
  invalidGatewayManagementDeclarationError,
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
  allowMissingPackagedServiceTeardown?: boolean;
  env?: NodeJS.ProcessEnv;
  hasPackagedService?: () => boolean;
  loadDeclaration?: (env: NodeJS.ProcessEnv) => GatewayManagementLoadResult;
  loadSession?: (
    target: GatewayTeardownTarget,
    env: NodeJS.ProcessEnv,
  ) => Pick<Session, "checkpoint"> | null;
}

export type GatewayTeardownAuthorityResolver = (
  target: GatewayTeardownTarget,
  deps?: GatewayTeardownAuthorityDeps,
) => GatewayOwner;

type GatewayAuthorityEffect = "credential mutation" | "rebuild" | "teardown";

const FRESH_ONBOARDING_CHECKPOINT_RECOVERY =
  " Start a fresh onboarding run to replace the invalid checkpoint before retrying.";

export function isManagedPackagedServiceMigration(
  recorded: GatewayOwner,
  resolved: GatewayOwner,
): boolean {
  return (
    recorded.mode === "nemoclaw-managed" &&
    resolved.mode === "nemoclaw-managed" &&
    recorded.source === "packaged-service" &&
    resolved.source === "standalone" &&
    sameGatewayOwner(recorded, { ...resolved, source: "packaged-service" })
  );
}

function loadTargetSession(
  target: GatewayTeardownTarget,
  env: NodeJS.ProcessEnv,
): Pick<Session, "checkpoint"> | null {
  const sessionFile = path.join(
    nemoclawStateRoot(resolveHome(env), target.gatewayPort),
    "onboard-session.json",
  );
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw new GatewayAuthorityError(
      "The persisted onboarding session is unreadable or is not valid JSON; gateway lifecycle authority cannot be revalidated." +
        FRESH_ONBOARDING_CHECKPOINT_RECOVERY,
    );
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new GatewayAuthorityError(
      "The persisted onboarding session is corrupt; gateway lifecycle authority cannot be revalidated." +
        FRESH_ONBOARDING_CHECKPOINT_RECOVERY,
    );
  }

  const inspected = inspectCheckpoint((raw as { checkpoint?: unknown }).checkpoint);
  if (inspected.status === "loaded") return { checkpoint: inspected.checkpoint };
  if (inspected.status === "none" || inspected.status === "legacy") return null;
  if (inspected.status === "unsupported_future") {
    throw new GatewayAuthorityError(
      `The persisted onboarding checkpoint uses unsupported schema version ${String(inspected.foundVersion)}; gateway lifecycle authority cannot be revalidated.${FRESH_ONBOARDING_CHECKPOINT_RECOVERY}`,
    );
  }
  throw new GatewayAuthorityError(
    "The persisted onboarding checkpoint is corrupt; gateway lifecycle authority cannot be revalidated." +
      FRESH_ONBOARDING_CHECKPOINT_RECOVERY,
  );
}

/**
 * Raised when authority cannot be revalidated for the exact gateway.
 *
 * A distinct type so command boundaries can recognise this refusal without
 * matching on message text. Three callers (rebuild, `onboard
 * --recreate-sandbox`, and final-sandbox gateway cleanup) previously let the
 * plain `Error` escape, which crashed the CLI with a Node stack trace and — as
 * every sanctioned recovery path hits one of them — left no way out at all
 * (#8103).
 */
export class GatewayAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayAuthorityError";
  }
}

/**
 * Render an authority-revalidation refusal for a command boundary.
 *
 * Single source of truth for this wording; `credentialsGatewayAuthorityFailureLines`
 * already reported the same refusal this way, so the remaining callers reuse it
 * rather than growing a second phrasing of the same contract. The remedy line
 * stays binary-agnostic so this module does not take a branding dependency that
 * the source-architecture budget counts against every consumer.
 */
export function gatewayAuthorityFailureLines(error: unknown, operation: string): string[] {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    `  Refusing ${operation} because the gateway lifecycle authority could not be revalidated.`,
    `  ${detail}`,
    "  Re-run onboarding to bind the current gateway authority before retrying.",
  ];
}

/**
 * Resolve the current owner and revalidate checkpointed authority for the exact
 * gateway before rebuild, teardown, or provider credential mutation. A
 * declaration or recorded-owner change is an explicit migration. Only the
 * transactional managed-service rebuild migration may adopt another owner.
 */
function resolveGatewayEffectAuthority(
  target: GatewayTeardownTarget,
  effect: GatewayAuthorityEffect,
  deps: GatewayTeardownAuthorityDeps,
): GatewayOwner {
  const operation =
    effect === "teardown"
      ? "gateway teardown"
      : effect === "rebuild"
        ? "sandbox rebuild"
        : "provider credential mutation";
  if (resolveGatewayName(target.gatewayPort) !== target.gatewayName) {
    throw new GatewayAuthorityError(
      `Refusing ${operation} for noncanonical target '${target.gatewayName}@${String(target.gatewayPort)}'.`,
    );
  }

  const env = deps.env ?? process.env;
  const loaded = deps.loadDeclaration
    ? deps.loadDeclaration(env)
    : loadGatewayManagementDeclaration({ env });
  if (!loaded.ok) {
    throw invalidGatewayManagementDeclarationError(loaded.reason);
  }
  const hasPackagedService =
    loaded.declaration === null &&
    target.gatewayPort === DEFAULT_GATEWAY_PORT &&
    (deps.hasPackagedService?.() ?? hasOpenShellGatewayUserService({ env }));
  const resolved = resolveGatewayOwner({
    ...target,
    declaration: loaded.declaration,
    hasPackagedService,
  });

  const session = (deps.loadSession ?? loadTargetSession)(target, env);
  const recordedDecision = session?.checkpoint?.gatewayAuthority;
  if (!recordedDecision || recordedDecision.kind === "unset") return resolved;
  if (recordedDecision.kind === "declined") {
    throw new GatewayAuthorityError(
      `Refusing ${operation} for '${target.gatewayName}': the onboarding checkpoint contains an invalid declined gateway authority.`,
    );
  }

  const recorded = gatewayOwnerFromCheckpoint(recordedDecision.value);
  if (recorded.gatewayName !== target.gatewayName || recorded.gatewayPort !== target.gatewayPort) {
    throw new GatewayAuthorityError(
      `Refusing ${operation} for '${target.gatewayName}@${String(target.gatewayPort)}': ` +
        `the recorded authority targets '${recorded.gatewayName}@${String(recorded.gatewayPort)}'.`,
    );
  }
  if (sameGatewayOwner(recorded, resolved)) return recorded;
  if (effect === "rebuild" && isManagedPackagedServiceMigration(recorded, resolved)) {
    return resolved;
  }
  if (
    effect === "teardown" &&
    deps.allowMissingPackagedServiceTeardown === true &&
    isManagedPackagedServiceMigration(recorded, resolved)
  ) {
    return resolved;
  }
  throw new GatewayAuthorityError(
    "Gateway lifecycle authority changed since onboarding " +
      `(${describeGatewayOwnerForError(recorded)} -> ${describeGatewayOwnerForError(resolved)}). ` +
      `Changing authority requires a fresh onboarding run; ${operation} will not perform gateway effects.`,
  );
}

export function resolveGatewayTeardownAuthority(
  target: GatewayTeardownTarget,
  deps: GatewayTeardownAuthorityDeps = {},
): GatewayOwner {
  return resolveGatewayEffectAuthority(target, "teardown", deps);
}

/**
 * Resolve authority for a transactional sandbox rebuild. A rebuild may adopt
 * the one-way managed-service migration introduced when a previously recorded
 * packaged gateway is no longer selected and NemoClaw uses its standalone
 * service. The rebuild journal persists the returned owner before any MCP or
 * sandbox mutation.
 */
export function resolveGatewayRebuildAuthority(
  target: GatewayTeardownTarget,
  deps: GatewayTeardownAuthorityDeps = {},
): GatewayOwner {
  return resolveGatewayEffectAuthority(target, "rebuild", deps);
}

/** Revalidate the exact checkpointed authority before a provider credential mutation. */
export function resolveGatewayCredentialMutationAuthority(
  target: GatewayTeardownTarget,
  deps: GatewayTeardownAuthorityDeps = {},
): GatewayOwner {
  return resolveGatewayEffectAuthority(target, "credential mutation", deps);
}
