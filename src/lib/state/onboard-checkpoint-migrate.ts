// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { isObjectRecord, type JsonValue } from "../core/json-types";
import type { WebSearchConfig } from "../inference/web-search";
import {
  getActiveChannelIdsFromPlan,
  getDisabledChannelIdsFromPlan,
} from "../messaging/plan-validation";
import { inspectCheckpoint } from "./onboard-checkpoint";
import {
  decisionFromLegacyNullable,
  decisionSelected,
  decisionUnset,
} from "./onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointDecision,
  type CheckpointLoadResult,
  type CheckpointMessagingSelection,
  type CheckpointResourceProfile,
  type CheckpointSandboxIdentity,
  type OnboardCheckpoint,
} from "./onboard-checkpoint-types";
import { normalizeSession, SESSION_FILE, type Session } from "./onboard-session";

function identityDecision(session: Session): CheckpointDecision<CheckpointSandboxIdentity> {
  const { sandboxName, agent } = session;
  if (
    session.sandboxPromptProgress.sandboxName &&
    typeof sandboxName === "string" &&
    sandboxName.length > 0 &&
    typeof agent === "string" &&
    agent.length > 0
  ) {
    return decisionSelected({ name: sandboxName, agent });
  }
  return decisionUnset();
}

function webSearchDecision(session: Session): CheckpointDecision<WebSearchConfig> {
  return decisionFromLegacyNullable(
    session.sandboxPromptProgress.webSearch,
    session.webSearchConfig,
    (config) => config,
  );
}

function messagingDecision(session: Session): CheckpointDecision<CheckpointMessagingSelection> {
  return decisionFromLegacyNullable(
    session.sandboxPromptProgress.messaging,
    session.messagingPlan,
    (plan) => ({
      selectedChannels: getActiveChannelIdsFromPlan(plan),
      disabledChannels: getDisabledChannelIdsFromPlan(plan),
    }),
  );
}

function resourceDecision(session: Session): CheckpointDecision<CheckpointResourceProfile> {
  return decisionFromLegacyNullable(
    session.sandboxPromptProgress.resourceProfile,
    session.resourceProfile,
    (profile) => ({ cpu: profile.cpu, memory: profile.memory }),
  );
}

export function deriveCheckpointFromSession(session: Session): OnboardCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: session.sessionId,
    machineState: session.machine.state,
    updatedAt: session.updatedAt,
    sandboxIdentity: identityDecision(session),
    webSearch: webSearchDecision(session),
    messaging: messagingDecision(session),
    resourceProfile: resourceDecision(session),
    effectGroups: {},
    bindings: {
      // Provider/inference resume owns and revalidates the primary inference
      // binding before the sandbox phase. This ledger covers only external
      // effects created inside the sandbox phase.
      credentialEnvs: [],
      registeredProviders: [],
    },
  };
}

export function resolveCheckpointForResume(rawSession: unknown): CheckpointLoadResult {
  if (!isObjectRecord(rawSession)) return { status: "none" };

  const inspected = inspectCheckpoint(rawSession.checkpoint);
  if (inspected.status === "unsupported_future" || inspected.status === "corrupt") {
    return inspected;
  }

  const session = normalizeSession(rawSession as JsonValue);
  if (!session) return { status: "none" };

  if (inspected.status === "loaded") {
    // A checkpoint copied from another session's file would otherwise supply
    // identity, bindings, and effect receipts for the wrong onboarding run.
    if (inspected.checkpoint.sessionId !== session.sessionId) return { status: "corrupt" };
    return inspected;
  }

  return {
    status: "migrated",
    checkpoint: deriveCheckpointFromSession(session),
    fromVersion: 0,
  };
}

export function loadResumeCheckpoint(): CheckpointLoadResult {
  if (!fs.existsSync(SESSION_FILE)) return { status: "none" };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return { status: "corrupt" };
  }
  return resolveCheckpointForResume(raw);
}
