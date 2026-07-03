// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyMcpLifecycleLock,
  isMcpLifecycleLockOwner,
  type LockObservation,
  type McpLifecycleLockIdentityProbes,
  type McpLifecycleLockOwner,
} from "./mcp-lifecycle-lock-identity";
import {
  getMcpLifecycleLockPath,
  readMcpLifecycleLockObservation,
} from "./mcp-lifecycle-lock-storage";

const PROPERTY_RUNS = 250;
const PROPERTY_IO_TIMEOUT_MS = 15_000;
const SANDBOX_NAME = "property-sandbox";
const LOCAL_HOST = "host:local";
const LOCAL_NAMESPACE = "pid:[4026531836]";

const boundaryPidArbitrary = fc.oneof(
  fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  fc.constantFrom(
    1,
    32_767,
    4_194_303,
    4_194_304,
    2_147_483_647,
    2_147_483_648,
    4_294_967_295,
    Number.MAX_SAFE_INTEGER,
  ),
);
const clockArbitrary = fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
const tickValueArbitrary = fc.oneof(
  fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }),
  fc.constantFrom(0n, 1n, (1n << 64n) - 1n, 1n << 64n, (1n << 128n) - 1n),
);
const tickArbitrary = tickValueArbitrary.map(String);
const bootArbitrary = fc.uuid();
const distinctBootPairArbitrary = fc
  .tuple(bootArbitrary, bootArbitrary)
  .filter(([ownerBoot, currentBoot]) => ownerBoot !== currentBoot);
const processIdentityArbitrary = fc
  .tuple(bootArbitrary, tickArbitrary)
  .map(([boot, ticks]) => `linux:${boot}:${ticks}`);
const nonEmptyStringArbitrary = fc.string({ minLength: 1, maxLength: 80 });

function owner(
  pid: number,
  processIdentity: string | null,
  overrides: Partial<McpLifecycleLockOwner> = {},
): McpLifecycleLockOwner {
  return {
    version: 1,
    sandboxName: SANDBOX_NAME,
    pid,
    processIdentity,
    hostIdentity: LOCAL_HOST,
    pidNamespaceIdentity: LOCAL_NAMESPACE,
    token: "owner-token",
    acquiredAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function observation(lockOwner: McpLifecycleLockOwner | null, mtimeMs = 0): LockObservation {
  return { owner: lockOwner, mtimeMs, dev: 10, ino: 20 };
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

describe("MCP lifecycle lock identity properties", () => {
  it("keeps a matching live owner active across PID, start-tick, and clock boundaries", () => {
    fc.assert(
      fc.property(
        boundaryPidArbitrary,
        processIdentityArbitrary,
        clockArbitrary,
        clockArbitrary,
        (pid, identity, nowMs, mtimeMs) => {
          const result = classifyMcpLifecycleLock(
            observation(owner(pid, identity), mtimeMs),
            SANDBOX_NAME,
            nowMs,
            30_000,
            probes({ readProcessIdentity: () => identity }),
          );

          expect(result).toBe("active");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("reclaims a dead local owner independently of wall-clock skew", () => {
    fc.assert(
      fc.property(
        boundaryPidArbitrary,
        processIdentityArbitrary,
        clockArbitrary,
        clockArbitrary,
        (pid, identity, nowMs, mtimeMs) => {
          const result = classifyMcpLifecycleLock(
            observation(owner(pid, identity), mtimeMs),
            SANDBOX_NAME,
            nowMs,
            30_000,
            probes({ processIsAlive: () => false }),
          );

          expect(result).toBe("stale");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("reclaims PID reuse only after a fresh start-tick mismatch", () => {
    fc.assert(
      fc.property(boundaryPidArbitrary, bootArbitrary, tickArbitrary, (pid, boot, ticks) => {
        const ownerIdentity = `linux:${boot}:${ticks}`;
        const replacementIdentity = `linux:${boot}:${BigInt(ticks) + 1n}`;
        const readProcessIdentity = vi.fn(() => replacementIdentity);
        const result = classifyMcpLifecycleLock(
          observation(owner(pid, ownerIdentity)),
          SANDBOX_NAME,
          0,
          30_000,
          probes({ readProcessIdentity }),
        );

        expect(result).toBe("stale");
        expect(readProcessIdentity).toHaveBeenNthCalledWith(1, pid);
        expect(readProcessIdentity).toHaveBeenNthCalledWith(2, pid, true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("reclaims a live PID whose boot identity changed", () => {
    fc.assert(
      fc.property(
        boundaryPidArbitrary,
        distinctBootPairArbitrary,
        tickArbitrary,
        (pid, [ownerBoot, currentBoot], ticks) => {
          const ownerIdentity = `linux:${ownerBoot}:${ticks}`;
          const replacementIdentity = `linux:${currentBoot}:${ticks}`;
          const result = classifyMcpLifecycleLock(
            observation(owner(pid, ownerIdentity)),
            SANDBOX_NAME,
            0,
            30_000,
            probes({ readProcessIdentity: () => replacementIdentity }),
          );

          expect(result).toBe("stale");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("keeps ownership when a cached start mismatch disappears on refresh", () => {
    fc.assert(
      fc.property(boundaryPidArbitrary, processIdentityArbitrary, (pid, identity) => {
        const readProcessIdentity = vi
          .fn<McpLifecycleLockIdentityProbes["readProcessIdentity"]>()
          .mockReturnValueOnce(`${identity}:cached-other-process`)
          .mockReturnValueOnce(identity);
        const result = classifyMcpLifecycleLock(
          observation(owner(pid, identity)),
          SANDBOX_NAME,
          0,
          30_000,
          probes({ readProcessIdentity }),
        );

        expect(result).toBe("active");
        expect(readProcessIdentity).toHaveBeenNthCalledWith(2, pid, true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("never probes or reaps an owner from a different host", () => {
    fc.assert(
      fc.property(
        boundaryPidArbitrary,
        nonEmptyStringArbitrary,
        processIdentityArbitrary,
        (pid, localHost, identity) => {
          const probe = probes({
            localHostIdentity: localHost,
            processIsAlive: () => {
              throw new Error("foreign host reached local PID probe");
            },
            readProcessIdentity: () => {
              throw new Error("foreign host reached local process-identity probe");
            },
          });
          const result = classifyMcpLifecycleLock(
            observation(owner(pid, identity, { hostIdentity: `${localHost}:foreign` })),
            SANDBOX_NAME,
            0,
            30_000,
            probe,
          );

          expect(result).toBe("active");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("never probes or reaps an owner from a different PID namespace", () => {
    fc.assert(
      fc.property(
        boundaryPidArbitrary,
        nonEmptyStringArbitrary,
        processIdentityArbitrary,
        (pid, localNamespace, identity) => {
          const probe = probes({
            localPidNamespaceIdentity: localNamespace,
            processIsAlive: () => {
              throw new Error("foreign namespace reached local PID probe");
            },
            readProcessIdentity: () => {
              throw new Error("foreign namespace reached local process-identity probe");
            },
          });
          const result = classifyMcpLifecycleLock(
            observation(
              owner(pid, identity, { pidNamespaceIdentity: `${localNamespace}:foreign` }),
            ),
            SANDBOX_NAME,
            0,
            30_000,
            probe,
          );

          expect(result).toBe("active");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("never probes or reaps an owner with missing namespace provenance", () => {
    fc.assert(
      fc.property(
        boundaryPidArbitrary,
        processIdentityArbitrary,
        fc.constantFrom<null | undefined>(null, undefined),
        (pid, identity, ownerNamespace) => {
          const probe = probes({
            processIsAlive: () => {
              throw new Error("unknown namespace reached local PID probe");
            },
            readProcessIdentity: () => {
              throw new Error("unknown namespace reached local process-identity probe");
            },
          });
          const result = classifyMcpLifecycleLock(
            observation(owner(pid, identity, { pidNamespaceIdentity: ownerNamespace })),
            SANDBOX_NAME,
            0,
            30_000,
            probe,
          );

          expect(result).toBe("active");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("rejects every positive PID beyond the safe-integer wire boundary", () => {
    fc.assert(
      fc.property(
        fc.bigInt({
          min: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          max: (1n << 128n) - 1n,
        }),
        (unsafePid) => {
          expect(isMcpLifecycleLockOwner(owner(Number(unsafePid), "process"))).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe("MCP lifecycle lock storage properties", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-property-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { force: true, recursive: true });
  });

  it("round-trips valid owner records without changing their wire shape", {
    timeout: PROPERTY_IO_TIMEOUT_MS,
  }, async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyStringArbitrary,
        boundaryPidArbitrary,
        fc.option(processIdentityArbitrary, { nil: null }),
        fc.option(nonEmptyStringArbitrary, { nil: null }),
        fc.option(nonEmptyStringArbitrary, { nil: null }),
        nonEmptyStringArbitrary,
        async (sandboxName, pid, processIdentity, hostIdentity, pidNamespaceIdentity, token) => {
          const lockOwner: McpLifecycleLockOwner = {
            version: 1,
            sandboxName,
            pid,
            processIdentity,
            hostIdentity,
            pidNamespaceIdentity,
            token,
            acquiredAt: "9999-12-31T23:59:59.999Z",
          };
          const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
          fs.mkdirSync(path.dirname(lockPath), { recursive: true });
          fs.writeFileSync(lockPath, `${JSON.stringify(lockOwner)}\n`);

          const observed = await readMcpLifecycleLockObservation(lockPath);

          expect(observed?.owner).toEqual(lockOwner);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("classifies arbitrary non-JSON lock content as corrupt ownership", {
    timeout: PROPERTY_IO_TIMEOUT_MS,
  }, async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 1_024 }), async (content) => {
        const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, `not-json:${content}`);

        const observed = await readMcpLifecycleLockObservation(lockPath);

        expect(observed?.owner).toBeNull();
        expect(observed?.ino).toBeGreaterThan(0);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("returns no observation for arbitrary missing lock paths", {
    timeout: PROPERTY_IO_TIMEOUT_MS,
  }, async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 1_024 }), async (sandboxName) => {
        const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);

        await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toBeNull();
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
