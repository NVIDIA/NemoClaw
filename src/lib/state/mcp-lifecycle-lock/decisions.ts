// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LockObservation, McpLifecycleLockDisposition } from "../mcp-lifecycle-lock-identity";

export interface CorruptGenerationState {
  generation: string | null;
  firstSeenAt: number;
}

export type McpLifecycleLockDecision =
  | { kind: "absent"; corruptGeneration: CorruptGenerationState }
  | {
      kind: "wait";
      disposition: "active" | "wait";
      ownerPid: number | null;
      corruptGeneration: CorruptGenerationState;
    }
  | {
      kind: "reap";
      observation: LockObservation;
      corruptGeneration: CorruptGenerationState;
    };

export interface DecideMcpLifecycleLockInput {
  observation: LockObservation | null;
  sandboxName: string;
  corruptLockGraceMs: number;
  monotonicNow: number;
  corruptGeneration: CorruptGenerationState;
  ownerDisposition?: McpLifecycleLockDisposition;
}

function resetCorruptGeneration(): CorruptGenerationState {
  return { generation: null, firstSeenAt: 0 };
}

export function decideMcpLifecycleLock(
  input: DecideMcpLifecycleLockInput,
): McpLifecycleLockDecision {
  const { observation } = input;
  if (!observation) return { kind: "absent", corruptGeneration: resetCorruptGeneration() };

  const validOwner = observation.owner?.sandboxName === input.sandboxName;
  let disposition = input.ownerDisposition ?? "wait";
  let corruptGeneration = resetCorruptGeneration();
  if (!validOwner && observation.reclaimable) {
    const generation = `${String(observation.dev)}:${String(observation.ino)}:${String(observation.mtimeMs)}`;
    corruptGeneration =
      input.corruptGeneration.generation === generation
        ? input.corruptGeneration
        : { generation, firstSeenAt: input.monotonicNow };
    disposition =
      input.monotonicNow - corruptGeneration.firstSeenAt >= input.corruptLockGraceMs
        ? "stale"
        : "wait";
  }

  if (disposition === "stale") {
    return { kind: "reap", observation, corruptGeneration };
  }
  return {
    kind: "wait",
    disposition: disposition === "active" ? "active" : "wait",
    ownerPid: observation.owner?.pid ?? null,
    corruptGeneration,
  };
}

export type McpLifecycleAcquisitionInput =
  | { phase: "reaper" | "main-owner"; lock: McpLifecycleLockDecision }
  | {
      phase: "published";
      reaperPresent: boolean;
      expectedOwnerToken: string;
      observedOwnerToken: string | undefined;
    };

export type McpLifecycleAcquisitionDecision =
  | { kind: "publish" }
  | { kind: "enter" }
  | { kind: "wait"; ownerPid: number | null }
  | { kind: "release" }
  | { kind: "reap" };

export function decideMcpLifecycleAcquisition(
  input: McpLifecycleAcquisitionInput,
): McpLifecycleAcquisitionDecision {
  if (input.phase === "published") {
    return !input.reaperPresent && input.observedOwnerToken === input.expectedOwnerToken
      ? { kind: "enter" }
      : { kind: "release" };
  }
  if (input.lock.kind === "reap") return { kind: "reap" };
  if (input.lock.kind === "absent") return { kind: "publish" };
  return { kind: "wait", ownerPid: input.lock.ownerPid };
}
