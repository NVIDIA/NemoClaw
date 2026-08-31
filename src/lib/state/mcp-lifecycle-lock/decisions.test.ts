// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  decideMcpLifecycleAcquisition,
  decideMcpLifecycleDeadlineRecovery,
  decideMcpLifecycleLock,
  decideMcpLifecycleGate,
  decideMcpLifecycleTakeover,
  type CorruptGenerationState,
  type DecideMcpLifecycleLockInput,
  type McpLifecycleLockDecision,
} from "./decisions";
import type { LockObservation, McpLifecycleLockOwner } from "../mcp-lifecycle-lock-identity";

const SANDBOX_NAME = "sandbox-a";
const EMPTY_CORRUPT_GENERATION: CorruptGenerationState = { generation: null, firstSeenAt: 0 };

function owner(overrides: Partial<McpLifecycleLockOwner> = {}): McpLifecycleLockOwner {
  return {
    version: 1,
    sandboxName: SANDBOX_NAME,
    pid: 100,
    processIdentity: "process-a",
    hostIdentity: "host-a",
    pidNamespaceIdentity: "pid:[1]",
    token: "owner-a",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function observation(
  lockOwner: McpLifecycleLockOwner | null,
  overrides: Partial<LockObservation> = {},
): LockObservation {
  return {
    owner: lockOwner,
    mtimeMs: 10,
    dev: 20,
    ino: 30,
    reclaimable: true,
    ...overrides,
  };
}

function decisionInput(
  overrides: Partial<DecideMcpLifecycleLockInput> = {},
): DecideMcpLifecycleLockInput {
  return {
    role: "main",
    observation: observation(owner()),
    sandboxName: SANDBOX_NAME,
    corruptLockGraceMs: 100,
    monotonicNow: 1_000,
    corruptGeneration: EMPTY_CORRUPT_GENERATION,
    ownerDisposition: "active",
    ...overrides,
  };
}

describe("lifecycle lock decisions", () => {
  it.each([
    ["absent", decisionInput({ observation: null }), "absent"],
    ["active", decisionInput(), "wait"],
    ["PID reuse evidence", decisionInput({ ownerDisposition: "stale" }), "reap"],
    [
      "timer-bound",
      decisionInput({
        observation: observation(owner({ shieldsTakeoverToken: "a".repeat(32) })),
        ownerDisposition: "stale",
      }),
      "reap",
    ],
    ["deadline-owned", decisionInput({ role: "deadline", ownerDisposition: "active" }), "wait"],
    ["stale deadline", decisionInput({ role: "deadline", ownerDisposition: "stale" }), "contain"],
    ["reaper-owned", decisionInput({ role: "reaper", ownerDisposition: "active" }), "wait"],
    ["stale reaper", decisionInput({ role: "reaper", ownerDisposition: "stale" }), "contain"],
    [
      "non-reclaimable malformed owner",
      decisionInput({
        observation: observation(null, { reclaimable: false }),
        ownerDisposition: undefined,
      }),
      "wait",
    ],
  ] as const)("maps %s state to %s", (_name, input, expectedKind) => {
    expect(decideMcpLifecycleLock(input).kind).toBe(expectedKind);
  });

  it("ages one corrupt generation from the supplied monotonic observation time", () => {
    const malformed = observation(null);
    const first = decideMcpLifecycleLock(
      decisionInput({ observation: malformed, monotonicNow: 500, ownerDisposition: undefined }),
    );
    const aged = decideMcpLifecycleLock(
      decisionInput({
        observation: malformed,
        monotonicNow: 600,
        corruptGeneration: first.corruptGeneration,
        ownerDisposition: undefined,
      }),
    );

    expect(first).toMatchObject({ kind: "wait", corruptGeneration: { firstSeenAt: 500 } });
    expect(aged).toMatchObject({ kind: "contain", reason: "unverifiable-main-owner" });
  });

  it("restarts corrupt aging when the inode generation changes", () => {
    const first = decideMcpLifecycleLock(
      decisionInput({ observation: observation(null), monotonicNow: 500 }),
    );
    const replacement = decideMcpLifecycleLock(
      decisionInput({
        observation: observation(null, { ino: 31 }),
        monotonicNow: 700,
        corruptGeneration: first.corruptGeneration,
      }),
    );

    expect(replacement).toMatchObject({
      kind: "wait",
      corruptGeneration: { generation: "20:31:10", firstSeenAt: 700 },
    });
  });

  it("contains an aged wrong-sandbox generation instead of reclaiming it", () => {
    const foreign = observation(owner({ sandboxName: "sandbox-b" }));
    const result = decideMcpLifecycleLock(
      decisionInput({
        observation: foreign,
        monotonicNow: 700,
        corruptGeneration: { generation: "20:30:10", firstSeenAt: 500 },
        ownerDisposition: undefined,
      }),
    );

    expect(result).toMatchObject({ kind: "contain", reason: "unverifiable-main-owner" });
  });

  it.each([
    ["open", null, false, "proceed"],
    ["timer deadline", null, true, "wait"],
    ["committed containment", observation(owner()), false, "refuse"],
    ["containment over an expired timer", observation(owner()), true, "refuse"],
  ] as const)("maps the %s gate to %s", (_name, containment, timerExpired, kind) => {
    expect(decideMcpLifecycleGate(containment, timerExpired).kind).toBe(kind);
  });

  it("marks a stale timer-bound main generation for containment during reaping", () => {
    const result = decideMcpLifecycleLock(
      decisionInput({
        observation: observation(owner({ shieldsTakeoverToken: "a".repeat(32) })),
        ownerDisposition: "stale",
      }),
    );

    expect(result).toMatchObject({ kind: "reap", timerBound: true });
  });

  it.each([
    ["same token", "a".repeat(32), "a".repeat(32), "proceed"],
    ["changed token", "a".repeat(32), "b".repeat(32), "refuse"],
    ["removed token", "a".repeat(32), undefined, "refuse"],
  ] as const)("maps %s takeover authority to %s", (_name, expected, observed, kind) => {
    expect(decideMcpLifecycleTakeover(expected, observed).kind).toBe(kind);
  });

  it.each([
    ["proceed", "an open containment gate", { phase: "committed-containment", present: false }],
    ["refuse", "committed containment", { phase: "committed-containment", present: true }],
    [
      "publish",
      "unchanged publication authority",
      {
        phase: "publication",
        authorityCurrent: true,
        existingSelfToken: null,
      },
    ],
    [
      "resume",
      "recovered self publication",
      {
        phase: "publication",
        authorityCurrent: true,
        existingSelfToken: "owner-a",
      },
    ],
    [
      "refuse",
      "changed publication authority",
      {
        phase: "publication",
        authorityCurrent: false,
        existingSelfToken: "owner-a",
      },
    ],
  ] as const)("deadline recovery returns %s for %s", (kind, _name, input) => {
    expect(decideMcpLifecycleDeadlineRecovery(input).kind).toBe(kind);
  });

  const activeOwnerDecision = {
    kind: "wait",
    disposition: "active",
    ownerPid: 100,
    corruptGeneration: EMPTY_CORRUPT_GENERATION,
  } satisfies McpLifecycleLockDecision;
  const staleOwnerDecision = {
    kind: "reap",
    observation: observation(owner()),
    timerBound: true,
    corruptGeneration: EMPTY_CORRUPT_GENERATION,
  } satisfies McpLifecycleLockDecision;
  const staleDeadlineDecision = {
    kind: "contain",
    observation: observation(owner()),
    reason: "deadline-owner",
    corruptGeneration: EMPTY_CORRUPT_GENERATION,
  } satisfies McpLifecycleLockDecision;

  it.each([
    [
      "stale deadline owner",
      { phase: "deadline-owner", lock: staleDeadlineDecision },
      { kind: "contain" },
    ],
    [
      "verified live protected owner",
      {
        phase: "protected-owner",
        lock: activeOwnerDecision,
        exactLocalOwner: true,
        exactCurrentOwner: true,
        syncProcessIdentity: "not-current",
      },
      { kind: "wait", verifiedLive: true },
    ],
    [
      "stale protected owner",
      {
        phase: "protected-owner",
        lock: staleOwnerDecision,
        exactLocalOwner: true,
        exactCurrentOwner: false,
        syncProcessIdentity: "not-current",
      },
      { kind: "contain" },
    ],
    [
      "same-process sibling owner",
      {
        phase: "protected-owner",
        lock: activeOwnerDecision,
        exactLocalOwner: true,
        exactCurrentOwner: true,
        syncProcessIdentity: "match",
      },
      { kind: "refuse", reason: "sync-reentrant-owner" },
    ],
    [
      "unverifiable same-process owner",
      {
        phase: "protected-owner",
        lock: activeOwnerDecision,
        exactLocalOwner: true,
        exactCurrentOwner: false,
        syncProcessIdentity: "unverifiable",
      },
      { kind: "refuse", reason: "sync-reentrant-owner" },
    ],
    [
      "stale unverifiable same-process owner",
      {
        phase: "protected-owner",
        lock: staleOwnerDecision,
        exactLocalOwner: true,
        exactCurrentOwner: false,
        syncProcessIdentity: "unverifiable",
      },
      { kind: "contain" },
    ],
    [
      "foreign unverifiable owner",
      {
        phase: "protected-owner",
        lock: activeOwnerDecision,
        exactLocalOwner: false,
        exactCurrentOwner: false,
        syncProcessIdentity: "not-current",
      },
      { kind: "wait", verifiedLive: false },
    ],
  ] as const)("deadline recovery returns the expected action for %s", (_name, input, expected) => {
    expect(decideMcpLifecycleDeadlineRecovery(input)).toMatchObject(expected);
  });

  it.each([
    [
      "committed containment",
      { phase: "containment", observation: observation(owner()) },
      "refuse",
    ],
    ["open containment gate", { phase: "containment", observation: null }, "publish"],
    ["expired timer", { phase: "timer", deadlineExpired: true }, "wait"],
    ["future timer", { phase: "timer", deadlineExpired: false }, "publish"],
  ] as const)("maps the %s acquisition state to %s", (_name, input, kind) => {
    expect(decideMcpLifecycleAcquisition(input).kind).toBe(kind);
  });

  it.each([
    [
      "active main owner",
      "main-owner",
      {
        kind: "wait",
        disposition: "active",
        ownerPid: 100,
        corruptGeneration: EMPTY_CORRUPT_GENERATION,
      } satisfies McpLifecycleLockDecision,
      "wait",
    ],
    [
      "stale main owner",
      "main-owner",
      {
        kind: "reap",
        observation: observation(owner()),
        timerBound: false,
        corruptGeneration: EMPTY_CORRUPT_GENERATION,
      } satisfies McpLifecycleLockDecision,
      "reap",
    ],
    [
      "unverifiable main owner",
      "main-owner",
      {
        kind: "contain",
        observation: observation(owner({ sandboxName: "sandbox-b" })),
        reason: "unverifiable-main-owner",
        corruptGeneration: { generation: "20:30:10", firstSeenAt: 500 },
      } satisfies McpLifecycleLockDecision,
      "contain",
    ],
    [
      "stale deadline owner",
      "deadline",
      {
        kind: "contain",
        observation: observation(owner()),
        reason: "deadline-owner",
        corruptGeneration: EMPTY_CORRUPT_GENERATION,
      } satisfies McpLifecycleLockDecision,
      "contain",
    ],
    [
      "active reaper",
      "reaper",
      {
        kind: "wait",
        disposition: "active",
        ownerPid: 100,
        corruptGeneration: EMPTY_CORRUPT_GENERATION,
      } satisfies McpLifecycleLockDecision,
      "wait",
    ],
  ] as const)("maps the %s generation to %s", (_name, phase, lock, kind) => {
    expect(decideMcpLifecycleAcquisition({ phase, lock }).kind).toBe(kind);
  });

  it.each([
    ["unchanged authority", false, false, false, false, "owner", "owner", "a", "a", "enter"],
    ["replacement owner", false, false, false, false, "owner", "replacement", "a", "a", "release"],
    ["containment", true, false, false, false, "owner", "owner", "a", "a", "release"],
    ["deadline generation", false, true, false, false, "owner", "owner", "a", "a", "release"],
    ["reaper generation", false, false, true, false, "owner", "owner", "a", "a", "release"],
    ["expired timer", false, false, false, true, "owner", "owner", "a", "a", "release"],
    ["changed authority", false, false, false, false, "owner", "owner", "a", "b", "release"],
  ] as const)(
    "maps published %s to %s",
    (
      _name,
      containmentPresent,
      deadlinePresent,
      reaperPresent,
      timerDeadlineExpired,
      expectedOwnerToken,
      observedOwnerToken,
      expectedTakeoverToken,
      observedTakeoverToken,
      kind,
    ) => {
      expect(
        decideMcpLifecycleAcquisition({
          phase: "published",
          containmentPresent,
          deadlinePresent,
          reaperPresent,
          timerDeadlineExpired,
          expectedOwnerToken,
          observedOwnerToken,
          expectedTakeoverToken,
          observedTakeoverToken,
        }).kind,
      ).toBe(kind);
    },
  );
});
