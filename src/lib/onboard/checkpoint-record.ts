// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { decisionSelected } from "../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import type {
  CheckpointEffectGroupName,
  OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";

function baseCheckpoint(session: Session): OnboardCheckpoint {
  return session.checkpoint ?? deriveCheckpointFromSession(session);
}

export function recordCheckpointSandboxIdentity(
  session: Session,
  name: string,
  agent: string,
): void {
  const base = baseCheckpoint(session);
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: new Date().toISOString(),
    sandboxIdentity: decisionSelected({ name, agent }),
  };
}

export function recordCheckpointEffectGroup(
  session: Session,
  group: CheckpointEffectGroupName,
  fingerprint: string,
): void {
  const base = baseCheckpoint(session);
  const now = new Date().toISOString();
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: now,
    effectGroups: {
      ...base.effectGroups,
      [group]: { completedAt: now, fingerprint },
    },
  };
}
