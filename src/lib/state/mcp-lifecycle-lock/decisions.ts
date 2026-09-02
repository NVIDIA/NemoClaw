// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LockObservation, McpLifecycleLockDisposition } from "../mcp-lifecycle-lock-identity";

export interface CorruptGenerationState {
  generation: string | null;
  firstSeenAt: number;
}

export type McpLifecycleLockRole = "main" | "reaper" | "deadline";

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
      timerBound: boolean;
      corruptGeneration: CorruptGenerationState;
    }
  | {
      kind: "contain";
      observation: LockObservation;
      reason: "deadline-owner" | "reaper-owner" | "unverifiable-main-owner";
      corruptGeneration: CorruptGenerationState;
    };

export interface DecideMcpLifecycleLockInput {
  role: McpLifecycleLockRole;
  observation: LockObservation | null;
  sandboxName: string;
  corruptLockGraceMs: number;
  monotonicNow: number;
  corruptGeneration: CorruptGenerationState;
  /** Classification from the caller's injected process-identity probes. */
  ownerDisposition?: McpLifecycleLockDisposition;
}

function resetCorruptGeneration(): CorruptGenerationState {
  return { generation: null, firstSeenAt: 0 };
}

function corruptGenerationKey(observation: LockObservation): string {
  return `${observation.dev}:${observation.ino}:${observation.mtimeMs}`;
}

/** Decide the next executor action from already-observed lock state. */
export function decideMcpLifecycleLock(
  input: DecideMcpLifecycleLockInput,
): McpLifecycleLockDecision {
  const { observation } = input;
  if (!observation) return { kind: "absent", corruptGeneration: resetCorruptGeneration() };

  const validOwner = observation.owner?.sandboxName === input.sandboxName;
  let disposition = input.ownerDisposition ?? "wait";
  let corruptGeneration = resetCorruptGeneration();

  if (!validOwner && observation.reclaimable) {
    const generation = corruptGenerationKey(observation);
    corruptGeneration =
      input.corruptGeneration.generation === generation
        ? input.corruptGeneration
        : { generation, firstSeenAt: input.monotonicNow };
    disposition =
      input.monotonicNow - corruptGeneration.firstSeenAt >= input.corruptLockGraceMs
        ? "stale"
        : "wait";
  }

  if (disposition !== "stale") {
    return {
      kind: "wait",
      disposition: disposition === "active" ? "active" : "wait",
      ownerPid: observation.owner?.pid ?? null,
      corruptGeneration,
    };
  }
  if (input.role === "deadline") {
    return { kind: "contain", observation, reason: "deadline-owner", corruptGeneration };
  }
  if (input.role === "reaper") {
    return { kind: "contain", observation, reason: "reaper-owner", corruptGeneration };
  }
  if (!validOwner) {
    return {
      kind: "contain",
      observation,
      reason: "unverifiable-main-owner",
      corruptGeneration,
    };
  }
  return {
    kind: "reap",
    observation,
    timerBound: Boolean(observation.owner?.shieldsTakeoverToken),
    corruptGeneration,
  };
}

export type McpLifecycleGateDecision =
  | { kind: "proceed" }
  | { kind: "wait"; reason: "timer-deadline" }
  | {
      kind: "refuse";
      reason: "committed-containment";
      containment: LockObservation;
    };

/** Decide ordinary-acquisition gating without reading paths or timer state. */
export function decideMcpLifecycleGate(
  committedContainment: LockObservation | null,
  timerDeadlineExpired: boolean,
): McpLifecycleGateDecision {
  if (committedContainment) {
    return {
      kind: "refuse",
      reason: "committed-containment",
      containment: committedContainment,
    };
  }
  // Ordinary mutation stays closed after restoreAt, including when the timer
  // process is already gone. Lockdown recovery uses the deadline-fence path.
  return timerDeadlineExpired ? { kind: "wait", reason: "timer-deadline" } : { kind: "proceed" };
}

export type McpLifecycleTakeoverDecision = { kind: "proceed" } | { kind: "refuse" };

/** A caller must retain the exact takeover generation before protected entry. */
export function decideMcpLifecycleTakeover(
  expectedToken: string | undefined,
  observedToken: string | undefined,
): McpLifecycleTakeoverDecision {
  return observedToken === expectedToken ? { kind: "proceed" } : { kind: "refuse" };
}

export type McpLifecycleDeadlineRecoveryInput =
  | { phase: "committed-containment"; present: boolean }
  | { phase: "deadline-owner"; lock: McpLifecycleLockDecision }
  | {
      phase: "protected-owner";
      lock: McpLifecycleLockDecision;
      exactLocalOwner: boolean;
      exactCurrentOwner: boolean;
      syncProcessIdentity: "not-current" | "match" | "mismatch" | "unverifiable";
    }
  | {
      phase: "publication";
      authorityCurrent: boolean;
      existingSelfToken: string | null;
    };

export type McpLifecycleDeadlineRecoveryDecision =
  | { kind: "proceed" }
  | { kind: "publish" }
  | { kind: "resume"; token: string }
  | { kind: "wait"; ownerPid: number; verifiedLive: true }
  | { kind: "wait"; ownerPid: number | null; verifiedLive: false }
  | { kind: "contain"; observation: LockObservation }
  | {
      kind: "refuse";
      reason: "committed-containment" | "authority-changed" | "sync-reentrant-owner";
    };

/** Decide Shields deadline recovery while sync and async executors retain their own I/O. */
export function decideMcpLifecycleDeadlineRecovery(
  input: McpLifecycleDeadlineRecoveryInput,
): McpLifecycleDeadlineRecoveryDecision {
  if (input.phase === "committed-containment") {
    return input.present
      ? { kind: "refuse", reason: "committed-containment" }
      : { kind: "proceed" };
  }

  if (input.phase === "publication") {
    if (!input.authorityCurrent) {
      return { kind: "refuse", reason: "authority-changed" };
    }
    return input.existingSelfToken
      ? { kind: "resume", token: input.existingSelfToken }
      : { kind: "publish" };
  }

  if (input.phase === "deadline-owner") {
    return input.lock.kind === "contain"
      ? { kind: "contain", observation: input.lock.observation }
      : {
          kind: "wait",
          ownerPid: input.lock.kind === "wait" ? input.lock.ownerPid : null,
          verifiedLive: false,
        };
  }

  if (input.syncProcessIdentity === "match") {
    return { kind: "refuse", reason: "sync-reentrant-owner" };
  }
  if ((input.lock.kind === "reap" || input.lock.kind === "contain") && input.exactLocalOwner) {
    return { kind: "contain", observation: input.lock.observation };
  }
  if (input.syncProcessIdentity === "unverifiable") {
    return { kind: "refuse", reason: "sync-reentrant-owner" };
  }
  const ownerPid = input.lock.kind === "wait" ? input.lock.ownerPid : null;
  if (
    input.lock.kind === "wait" &&
    input.lock.disposition === "active" &&
    input.exactCurrentOwner &&
    ownerPid !== null
  ) {
    return { kind: "wait", ownerPid, verifiedLive: true };
  }
  return { kind: "wait", ownerPid, verifiedLive: false };
}

export type McpLifecycleAcquisitionInput =
  | { phase: "containment"; observation: LockObservation | null }
  | { phase: "deadline" | "reaper" | "main-owner"; lock: McpLifecycleLockDecision }
  | { phase: "timer"; deadlineExpired: boolean }
  | {
      phase: "published";
      containmentPresent: boolean;
      deadlinePresent: boolean;
      reaperPresent: boolean;
      timerDeadlineExpired: boolean;
      expectedOwnerToken: string;
      observedOwnerToken: string | undefined;
      expectedTakeoverToken: string | undefined;
      observedTakeoverToken: string | undefined;
    };

export type McpLifecycleAcquisitionDecision =
  | { kind: "publish" }
  | { kind: "enter" }
  | { kind: "wait"; ownerPid: number | null }
  | { kind: "release" }
  | { kind: "reap" }
  | { kind: "refuse"; containment: LockObservation }
  | {
      kind: "contain";
      role: "main" | "reaper" | "deadline";
      observation: LockObservation;
    };

/** Decide the next ordinary-acquisition executor action from observed state. */
export function decideMcpLifecycleAcquisition(
  input: McpLifecycleAcquisitionInput,
): McpLifecycleAcquisitionDecision {
  if (input.phase === "published") {
    const gatesOpen =
      !input.containmentPresent &&
      !input.deadlinePresent &&
      !input.reaperPresent &&
      !input.timerDeadlineExpired &&
      input.observedOwnerToken === input.expectedOwnerToken;
    return gatesOpen &&
      decideMcpLifecycleTakeover(input.expectedTakeoverToken, input.observedTakeoverToken).kind ===
        "proceed"
      ? { kind: "enter" }
      : { kind: "release" };
  }

  if (input.phase === "containment") {
    const gate = decideMcpLifecycleGate(input.observation, false);
    return gate.kind === "refuse"
      ? { kind: "refuse", containment: gate.containment }
      : { kind: "publish" };
  }

  if (input.phase === "timer") {
    return decideMcpLifecycleGate(null, input.deadlineExpired).kind === "wait"
      ? { kind: "wait", ownerPid: null }
      : { kind: "publish" };
  }

  if (input.lock.kind === "reap" && input.phase === "main-owner") return { kind: "reap" };
  if (input.lock.kind === "contain") {
    const role = input.phase === "main-owner" ? "main" : input.phase;
    return { kind: "contain", role, observation: input.lock.observation };
  }
  if (input.lock.kind === "absent") return { kind: "publish" };
  if (input.lock.kind === "wait") {
    return { kind: "wait", ownerPid: input.lock.ownerPid };
  }
  return { kind: "wait", ownerPid: null };
}
