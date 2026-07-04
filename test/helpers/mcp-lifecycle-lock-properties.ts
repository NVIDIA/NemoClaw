// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  classifyMcpLifecycleLock,
  type LockObservation,
  type McpLifecycleLockIdentityProbes,
  type McpLifecycleLockOwner,
} from "../../src/lib/state/mcp-lifecycle-lock-identity";

const PROPERTY_TIMEOUT_MS = 15_000;
const PROPERTY_PARAMETERS = { numRuns: 250, seed: 0x5876c0de } as const;
const SANDBOX_NAME = "property-sandbox";
const LOCAL_HOST = "host:local";
const LOCAL_NAMESPACE = "pid:[4026531836]";

const pidArbitrary = fc.integer({ min: 2, max: Number.MAX_SAFE_INTEGER });
const durationArbitrary = fc.integer({ min: 1, max: 1_000_000 });
const identityArbitrary = fc
  .tuple(fc.uuid(), fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }))
  .map(([bootId, startTicks]) => `linux:${bootId}:${startTicks}`);

function owner(
  pid: number,
  processIdentity: string,
  overrides: Partial<McpLifecycleLockOwner> = {},
): McpLifecycleLockOwner {
  return {
    version: 1,
    sandboxName: SANDBOX_NAME,
    pid,
    processIdentity,
    hostIdentity: LOCAL_HOST,
    pidNamespaceIdentity: LOCAL_NAMESPACE,
    token: "property-owner",
    acquiredAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function observation(lockOwner: McpLifecycleLockOwner | null, mtimeMs = 0): LockObservation {
  return { owner: lockOwner, mtimeMs, dev: 1, ino: 1 };
}

function probes(
  overrides: Partial<McpLifecycleLockIdentityProbes> = {},
): McpLifecycleLockIdentityProbes {
  return {
    localHostIdentity: LOCAL_HOST,
    localPidNamespaceIdentity: LOCAL_NAMESPACE,
    processIsAlive: () => true,
    readProcessIdentity: () => null,
    ...overrides,
  };
}

describe("MCP lifecycle lock classifier properties", () => {
  it("makes corrupt or wrong-sandbox generations stale exactly at the grace boundary", {
    timeout: PROPERTY_TIMEOUT_MS,
  }, () => {
    fc.assert(
      fc.property(
        durationArbitrary,
        durationArbitrary,
        fc.boolean(),
        pidArbitrary,
        identityArbitrary,
        (graceMs, ageMs, hasWrongSandboxOwner, pid, identity) => {
          const lockOwner = hasWrongSandboxOwner
            ? owner(pid, identity, { sandboxName: `${SANDBOX_NAME}-other` })
            : null;
          const localProbes = probes({
            processIsAlive: () => {
              throw new Error("corrupt ownership reached the local PID table");
            },
            readProcessIdentity: () => {
              throw new Error("corrupt ownership reached process identity probing");
            },
          });

          expect(
            classifyMcpLifecycleLock(
              observation(lockOwner, 0),
              SANDBOX_NAME,
              ageMs,
              graceMs,
              localProbes,
            ),
          ).toBe(ageMs >= graceMs ? "stale" : "wait");
        },
      ),
      PROPERTY_PARAMETERS,
    );
  });

  it("keeps a valid matching live owner active across lock age and grace values", {
    timeout: PROPERTY_TIMEOUT_MS,
  }, () => {
    fc.assert(
      fc.property(
        pidArbitrary,
        identityArbitrary,
        durationArbitrary,
        durationArbitrary,
        (pid, identity, ageMs, graceMs) => {
          expect(
            classifyMcpLifecycleLock(
              observation(owner(pid, identity), 0),
              SANDBOX_NAME,
              ageMs,
              graceMs,
              probes({ readProcessIdentity: () => identity }),
            ),
          ).toBe("active");
        },
      ),
      PROPERTY_PARAMETERS,
    );
  });

  it("keeps foreign-host and foreign-namespace contenders active without local probing", {
    timeout: PROPERTY_TIMEOUT_MS,
  }, () => {
    fc.assert(
      fc.property(
        pidArbitrary,
        identityArbitrary,
        fc.constantFrom("host", "namespace"),
        (pid, identity, foreignDimension) => {
          const lockOwner = owner(pid, identity, {
            ...(foreignDimension === "host"
              ? { hostIdentity: `${LOCAL_HOST}:foreign` }
              : { pidNamespaceIdentity: `${LOCAL_NAMESPACE}:foreign` }),
          });
          const localProbes = probes({
            processIsAlive: () => {
              throw new Error("foreign contender reached the local PID table");
            },
            readProcessIdentity: () => {
              throw new Error("foreign contender reached process identity probing");
            },
          });

          expect(
            classifyMcpLifecycleLock(
              observation(lockOwner),
              SANDBOX_NAME,
              Number.MAX_SAFE_INTEGER,
              1,
              localProbes,
            ),
          ).toBe("active");
        },
      ),
      PROPERTY_PARAMETERS,
    );
  });

  it("applies the same liveness contract to main and reaper owner records", {
    timeout: PROPERTY_TIMEOUT_MS,
  }, () => {
    fc.assert(
      fc.property(
        pidArbitrary,
        identityArbitrary,
        fc.constantFrom("main", "reaper"),
        fc.boolean(),
        (pid, identity, lockRole, isAlive) => {
          // Reaper locks intentionally use the same owner schema as the main
          // lock. The token prefix only identifies the role in this property.
          const lockOwner = owner(pid, identity, { token: `${lockRole}-owner` });

          expect(
            classifyMcpLifecycleLock(
              observation(lockOwner),
              SANDBOX_NAME,
              0,
              30_000,
              probes({
                processIsAlive: () => isAlive,
                readProcessIdentity: () => identity,
              }),
            ),
          ).toBe(isAlive ? "active" : "stale");
        },
      ),
      PROPERTY_PARAMETERS,
    );
  });

  it("reaps a live PID only when a fresh identity read confirms the mismatch", {
    timeout: PROPERTY_TIMEOUT_MS,
  }, () => {
    fc.assert(
      fc.property(
        pidArbitrary,
        identityArbitrary,
        fc.constantFrom("match", "mismatch", "unavailable"),
        (pid, identity, freshResult) => {
          const reads: Array<{ pid: number; fresh: boolean }> = [];
          const replacementIdentity = `${identity}:replacement`;
          const freshIdentityByResult = {
            match: identity,
            mismatch: replacementIdentity,
            unavailable: null,
          } as const;
          const readProcessIdentity = (readPid: number, fresh = false): string | null => {
            reads.push({ pid: readPid, fresh });
            return fresh ? freshIdentityByResult[freshResult] : replacementIdentity;
          };

          expect(
            classifyMcpLifecycleLock(
              observation(owner(pid, identity)),
              SANDBOX_NAME,
              0,
              30_000,
              probes({ readProcessIdentity }),
            ),
          ).toBe(freshResult === "mismatch" ? "stale" : "active");
          expect(reads).toEqual([
            { pid, fresh: false },
            { pid, fresh: true },
          ]);
        },
      ),
      PROPERTY_PARAMETERS,
    );
  });
});
