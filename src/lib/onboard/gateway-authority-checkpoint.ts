// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayCapability } from "../core/gateway-capabilities";
import {
  decisionSelected,
  isDecisionDeclined,
  isDecisionSelected,
} from "../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import type { CheckpointGatewayAuthority } from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";
import {
  describeGatewayOwnerForError,
  type GatewayOwner,
  sameGatewayOwner,
} from "./gateway-ownership";

export function checkpointGatewayAuthority(owner: GatewayOwner): CheckpointGatewayAuthority {
  return {
    gatewayName: owner.gatewayName,
    gatewayPort: owner.gatewayPort,
    mode: owner.mode,
    source: owner.source,
    endpoint: owner.endpoint,
    stateDir: owner.stateDir,
    supervisor: owner.supervisor ? { ...owner.supervisor } : null,
    requiredCapabilities: [...owner.requiredCapabilities],
  };
}

export function gatewayOwnerFromCheckpoint(authority: CheckpointGatewayAuthority): GatewayOwner {
  return {
    ...authority,
    supervisor: authority.supervisor ? { ...authority.supervisor } : null,
    requiredCapabilities: [...authority.requiredCapabilities] as GatewayCapability[],
  };
}

/**
 * Bind the resolved owner to durable resume state before gateway preflight.
 * A new process may re-resolve the declaration, but it may not silently adopt
 * a different authority from the one recorded by the interrupted run.
 */
export function bindGatewayAuthorityToCheckpoint(
  session: Session,
  resolvedOwner: GatewayOwner,
): GatewayOwner {
  const checkpoint = session.checkpoint ?? deriveCheckpointFromSession(session);
  const decision = checkpoint.gatewayAuthority;
  if (isDecisionDeclined(decision)) {
    throw new Error("Onboarding checkpoint contains an invalid declined gateway authority.");
  }
  if (isDecisionSelected(decision)) {
    const recordedOwner = gatewayOwnerFromCheckpoint(decision.value);
    if (!sameGatewayOwner(recordedOwner, resolvedOwner)) {
      throw new Error(
        "Gateway lifecycle authority changed since this onboarding attempt was checkpointed " +
          `(${describeGatewayOwnerForError(recordedOwner)} -> ${describeGatewayOwnerForError(resolvedOwner)}). ` +
          "Changing authority requires a fresh onboarding run; resume will not perform gateway effects.",
      );
    }
    session.checkpoint = checkpoint;
    return recordedOwner;
  }

  session.checkpoint = {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
    gatewayAuthority: decisionSelected(checkpointGatewayAuthority(resolvedOwner)),
  };
  return resolvedOwner;
}
