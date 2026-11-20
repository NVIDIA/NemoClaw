// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyMcpLifecycleLock,
  darwinLegacyHostIdentityAliases,
  isMcpLifecycleLockOwner,
  parseIoregPlatformUuid,
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
  type LockObservation,
  type McpLifecycleLockIdentityProbes,
  type McpLifecycleLockOwner,
} from "./mcp-lifecycle-lock-identity";
import {
  getMcpLifecycleLockPath,
  readMcpLifecycleLockObservation,
  readMcpLifecycleLockObservationSync,
  reclaimStaleMcpLifecycleLockGeneration,
  reclaimStaleMcpLifecycleLockGenerationSync,
  safelyReleaseMcpLifecycleLock,
  safelyReleaseMcpLifecycleLockSync,
  writeMcpLifecycleLockCandidateAndLink,
  writeMcpLifecycleLockCandidateAndLinkSync,
} from "./mcp-lifecycle-lock-storage";

const PROPERTY_RUNS = 250;
const PROPERTY_TIMEOUT_MS = 15_000;
// Moved from test/mcp/mcp-lifecycle-lock.test.ts. The recorded seed is kept so a
// failure replays the same counterexample that suite reported.
const SEEDED_PROPERTY_PARAMETERS = { numRuns: PROPERTY_RUNS, seed: 0x5876c0de } as const;
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
const durationArbitrary = fc.integer({ min: 1, max: 1_000_000 });
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
  return { owner: lockOwner, mtimeMs, dev: 10, ino: 20, reclaimable: true };
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
  it("reclaims a zombie local owner without treating its PID as live", () => {
    const localHostIdentity = readMcpLockHostIdentity();
    const localPidNamespaceIdentity = readMcpLockPidNamespaceIdentity();
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((filePath) => {
      expect(filePath).toBe("/proc/4242/stat");
      return "4242 (mutation owner) Z 1 2 3";
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      expect(
        classifyMcpLifecycleLock(
          observation(
            owner(4242, "linux:test-boot:10", {
              hostIdentity: localHostIdentity,
              pidNamespaceIdentity: localPidNamespaceIdentity,
            }),
          ),
          SANDBOX_NAME,
          0,
          30_000,
        ),
      ).toBe("stale");
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      readFileSync.mockRestore();
      platform.mockRestore();
    }
  });

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

  it(
    "keeps a matching live owner active across lock age and grace values",
    {
      timeout: PROPERTY_TIMEOUT_MS,
    },
    () => {
      fc.assert(
        fc.property(
          boundaryPidArbitrary,
          processIdentityArbitrary,
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
        SEEDED_PROPERTY_PARAMETERS,
      );
    },
  );

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

  it(
    "applies the same liveness contract to main and reaper owner records",
    {
      timeout: PROPERTY_TIMEOUT_MS,
    },
    () => {
      fc.assert(
        fc.property(
          boundaryPidArbitrary,
          processIdentityArbitrary,
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
        SEEDED_PROPERTY_PARAMETERS,
      );
    },
  );

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

  it(
    "reaps a live PID only when a fresh identity read confirms the mismatch",
    {
      timeout: PROPERTY_TIMEOUT_MS,
    },
    () => {
      fc.assert(
        fc.property(
          boundaryPidArbitrary,
          processIdentityArbitrary,
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
        SEEDED_PROPERTY_PARAMETERS,
      );
    },
  );

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

  it("reclaims a dead local owner recorded under a legacy host alias", () => {
    const result = classifyMcpLifecycleLock(
      observation(owner(4242, "darwin:start", { hostIdentity: "darwin:old-name.local" })),
      SANDBOX_NAME,
      0,
      30_000,
      probes({
        localHostIdentity: "darwin:platform-uuid:abc",
        localHostIdentityAliases: ["darwin:old-name.local"],
        processIsAlive: () => false,
      }),
    );
    expect(result).toBe("stale");
  });

  it("derives Darwin legacy aliases only from names the host currently reports", () => {
    expect(
      darwinLegacyHostIdentityAliases({
        hostname: "Akhils-MacBook-Pro.local",
        localHostName: "Akhils-MacBook-Pro",
        hostName: " studio.example.com ",
      }),
    ).toEqual(["darwin:Akhils-MacBook-Pro.local", "darwin:studio.example.com"]);
    expect(darwinLegacyHostIdentityAliases({ hostname: "", localHostName: null })).toEqual([]);
  });

  it("never synthesizes Bonjour conflict-suffix variants", () => {
    expect(
      darwinLegacyHostIdentityAliases({
        hostname: "studio-2.local",
        localHostName: "studio-2",
      }),
    ).toEqual(["darwin:studio-2.local"]);
  });

  it.each([
    ["conflict-suffix variant of this host", "darwin:studio-2.local", "studio"],
    ["base name of this conflict-suffixed host", "darwin:studio.local", "studio-2"],
  ])("keeps a lock from a %s foreign without probing PIDs", (_label, recorded, currentName) => {
    const result = classifyMcpLifecycleLock(
      observation(owner(4242, "darwin:start", { hostIdentity: recorded })),
      SANDBOX_NAME,
      0,
      30_000,
      probes({
        localHostIdentity: "darwin:platform-uuid:abc",
        localHostIdentityAliases: darwinLegacyHostIdentityAliases({
          hostname: `${currentName}.local`,
          localHostName: currentName,
        }),
        processIsAlive: () => {
          throw new Error("possibly foreign host reached local PID probe");
        },
      }),
    );
    expect(result).toBe("active");
  });

  it("reaches the PID checks for a lock under the LocalHostName-derived name", () => {
    const result = classifyMcpLifecycleLock(
      observation(owner(4242, "darwin:start", { hostIdentity: "darwin:studio.local" })),
      SANDBOX_NAME,
      0,
      30_000,
      probes({
        localHostIdentity: "darwin:platform-uuid:abc",
        localHostIdentityAliases: darwinLegacyHostIdentityAliases({
          hostname: "studio.example.com",
          localHostName: "studio",
        }),
        processIsAlive: () => false,
      }),
    );
    expect(result).toBe("stale");
  });

  it("keeps an owner foreign when it matches no local identity or alias", () => {
    const result = classifyMcpLifecycleLock(
      observation(owner(4242, "darwin:start", { hostIdentity: "darwin:other-mac.local" })),
      SANDBOX_NAME,
      0,
      30_000,
      probes({
        localHostIdentity: "darwin:platform-uuid:abc",
        localHostIdentityAliases: ["darwin:old-name.local"],
        processIsAlive: () => {
          throw new Error("foreign host reached local PID probe");
        },
      }),
    );
    expect(result).toBe("active");
  });

  it.runIf(process.platform === "darwin")(
    "derives a hostname-independent macOS identity from IOPlatformUUID",
    () => {
      const hostname = vi.spyOn(os, "hostname");
      try {
        hostname.mockReturnValue("first-name.local");
        const first = readMcpLockHostIdentity();
        hostname.mockReturnValue("first-name-2.local");
        const second = readMcpLockHostIdentity();
        expect(first).toMatch(/^darwin:platform-uuid:[0-9a-f]{64}$/);
        expect(second).toBe(first);
      } finally {
        hostname.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "darwin")(
    "falls back to the hostname identity when ioreg is unavailable",
    () => {
      // Off macOS there is no ioreg, so a mocked darwin host uses the hostname.
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      const hostname = vi.spyOn(os, "hostname").mockReturnValue("first-name.local");
      try {
        expect(readMcpLockHostIdentity()).toBe("darwin:first-name.local");
      } finally {
        hostname.mockRestore();
        platform.mockRestore();
      }
    },
  );

  it("parses IOPlatformUUID from ioreg output", () => {
    expect(
      parseIoregPlatformUuid(
        '  "IOPlatformUUID" = "b397e5ab-9d4f-5b9b-aca3-f6e37e1342be"\n  "other" = "x"',
      ),
    ).toBe("B397E5AB-9D4F-5B9B-ACA3-F6E37E1342BE");
    expect(parseIoregPlatformUuid('"IOPlatformSerialNumber" = "X"')).toBeNull();
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

  it(
    "makes corrupt or wrong-sandbox generations stale exactly at the grace boundary",
    {
      timeout: PROPERTY_TIMEOUT_MS,
    },
    () => {
      fc.assert(
        fc.property(
          durationArbitrary,
          durationArbitrary,
          fc.boolean(),
          boundaryPidArbitrary,
          processIdentityArbitrary,
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

            // fc draws ageMs and graceMs independently, so ageMs === graceMs is
            // almost never sampled. This loop tests the >= comparison at the exact ages.

            expect(
              [graceMs - 1, graceMs, graceMs + 1, ageMs].every(
                (boundaryAgeMs) =>
                  classifyMcpLifecycleLock(
                    observation(lockOwner, 0),
                    SANDBOX_NAME,
                    boundaryAgeMs,
                    graceMs,
                    localProbes,
                  ) === (boundaryAgeMs >= graceMs ? "stale" : "wait"),
              ),
            ).toBe(true);
          },
        ),
        SEEDED_PROPERTY_PARAMETERS,
      );
    },
  );

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

  it("leaves missing and foreign owner generations untouched during safe release", async () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const lockOwner = owner(4242, "linux:test-boot:10");

    await safelyReleaseMcpLifecycleLock(lockPath, "missing");
    safelyReleaseMcpLifecycleLockSync(lockPath, "missing");

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify(lockOwner)}\n`);
    await safelyReleaseMcpLifecycleLock(lockPath, "foreign-token");
    safelyReleaseMcpLifecycleLockSync(lockPath, "foreign-token");

    expect(readMcpLifecycleLockObservationSync(lockPath)?.owner).toEqual(lockOwner);
  });

  it("reports an already-missing generation as not reclaimed", async () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const expected = observation(owner(4242, "linux:test-boot:10"));

    await expect(reclaimStaleMcpLifecycleLockGeneration(lockPath, expected)).resolves.toBe(false);
    expect(reclaimStaleMcpLifecycleLockGenerationSync(lockPath, expected)).toBe(false);
  });

  it("rejects async and sync candidate publication over an existing owner", async () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const existingOwner = owner(4242, "linux:test-boot:10", { token: "existing" });
    const candidateOwner = owner(4343, "linux:test-boot:11", { token: "candidate" });
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify(existingOwner)}\n`);

    await expect(writeMcpLifecycleLockCandidateAndLink(lockPath, candidateOwner)).resolves.toBe(
      false,
    );
    expect(writeMcpLifecycleLockCandidateAndLinkSync(lockPath, candidateOwner)).toBe(false);
    expect(readMcpLifecycleLockObservationSync(lockPath)?.owner).toEqual(existingOwner);
  });

  it(
    "round-trips valid owner records without changing their wire shape",
    {
      timeout: PROPERTY_TIMEOUT_MS,
    },
    async () => {
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
    },
  );

  it(
    "classifies arbitrary non-JSON lock content as corrupt ownership",
    {
      timeout: PROPERTY_TIMEOUT_MS,
    },
    async () => {
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
    },
  );

  it(
    "returns no observation for arbitrary missing lock paths",
    {
      timeout: PROPERTY_TIMEOUT_MS,
    },
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ maxLength: 1_024 }), async (sandboxName) => {
          const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);

          await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toBeNull();
        }),
        { numRuns: PROPERTY_RUNS },
      );
    },
  );
});
