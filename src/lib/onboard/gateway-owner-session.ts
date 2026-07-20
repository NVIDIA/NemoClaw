// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CheckpointGatewayOwner } from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";
import { recordCheckpointGatewayOwner } from "./checkpoint-record";
import {
  assertGatewayOwnerMatchesCheckpoint,
  checkpointGatewayOwner,
  type GatewayOwner,
} from "./gateway-ownership";

export interface GatewayOwnerSessionDeps {
  getGatewayOwner(): GatewayOwner;
  loadSession(): Session | null;
  updateSession(mutator: (session: Session) => Session | void): Session;
  resetGatewayOwnerBinding(): void;
}

/** Establish or validate the attempt owner before consent and preflight effects. */
export function prepareGatewayOwnerAttempt(resume: boolean, deps: GatewayOwnerSessionDeps): void {
  if (!resume) {
    deps.resetGatewayOwnerBinding();
    return;
  }
  const owner = deps.getGatewayOwner();
  const recordedOwner = deps.loadSession()?.checkpoint?.gatewayOwner;
  // Pre-field sessions can only be adopted while ownership remains managed.
  // External ownership without durable proof is ambiguous and fails closed.
  if (recordedOwner || owner.mode === "externally-supervised") {
    assertGatewayOwnerMatchesCheckpoint(owner, recordedOwner);
  }
}

export function persistGatewayOwner(
  owner: CheckpointGatewayOwner,
  updateSession: GatewayOwnerSessionDeps["updateSession"],
): Session {
  return updateSession((current) => {
    recordCheckpointGatewayOwner(current, owner);
    return current;
  });
}

/** Persist a fresh/legacy managed binding or revalidate an existing proof. */
export function bindGatewayOwnerSession(
  session: Session | null,
  deps: GatewayOwnerSessionDeps,
): Session {
  const owner = deps.getGatewayOwner();
  if (session?.checkpoint?.gatewayOwner) {
    assertGatewayOwnerMatchesCheckpoint(owner, session.checkpoint.gatewayOwner);
    return session;
  }
  return persistGatewayOwner(checkpointGatewayOwner(owner), deps.updateSession);
}
