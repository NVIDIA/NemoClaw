// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkLaunchReadinessMutationAuthority,
  fenceLaunchReadinessLease as fenceLeaseStore,
  LAUNCH_READINESS_LEASE_MS,
  LAUNCH_READINESS_MAX_BYTES,
  LaunchReadinessFenceError,
  type LaunchReadinessIdentity,
  type LaunchReadinessStoreOptions,
  launchReadinessAuthorityPath,
  launchReadinessReceiptPath,
  publishLaunchReadinessLease as publishLeaseStore,
  readLaunchReadinessLease as readLeaseStore,
} from "./launch-readiness-lease";

const SANDBOX = "alpha";
const GATEWAY_PORT = 8080;
const GATEWAY_NAME = "nemoclaw";
const EPOCH_A = "a".repeat(64);
const EPOCH_B = "b".repeat(64);
const EPOCH_C = "d".repeat(64);
const DIGEST = "c".repeat(64);

function identity(gatewayName = GATEWAY_NAME): LaunchReadinessIdentity {
  return {
    registry: DIGEST,
    agent: DIGEST,
    liveInference: DIGEST,
    gatewayName,
    lifecycleGeneration: "generation-1",
    liveIdentityFingerprint: DIGEST,
    session: null,
  };
}

function openClawIdentity(): LaunchReadinessIdentity {
  return {
    ...identity(),
    session: {
      schemaVersion: 1,
      kind: "openclaw-pairing",
      openclawVersion: "2026.7.1",
      deviceIdentitySha256: DIGEST,
      pairingStateSha256: DIGEST,
      requiredRoles: ["operator"],
      requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
    },
  };
}

function throwReadOnly(message: string): never {
  throw Object.assign(new Error(message), { code: "EROFS" });
}

describe("launch readiness lease storage", () => {
  let root: string;
  let home: string;
  let runtimeRoot: string;
  let wallMs: number;
  let uptimeMs: number;
  let bootId: string;
  let epochs: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launch-readiness-"));
    home = path.join(root, "home");
    runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(home, { mode: 0o700 });
    fs.chmodSync(home, 0o700);
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    fs.chmodSync(runtimeRoot, 0o700);
    wallMs = 2_000_000_000_000;
    uptimeMs = 100_000;
    bootId = "boot-a";
    epochs = [EPOCH_A, EPOCH_B];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function options(
    overrides: Partial<LaunchReadinessStoreOptions> = {},
  ): LaunchReadinessStoreOptions {
    return {
      home,
      nowWallMs: () => wallMs,
      nowUptimeMs: () => uptimeMs,
      bootId: () => bootId,
      uid: () => process.getuid?.() ?? 0,
      randomEpoch: () => epochs.shift() ?? EPOCH_B,
      runtimeAuthorityRoot: () => runtimeRoot,
      ...overrides,
    };
  }

  function fenceLaunchReadinessLease(
    sandboxName: string,
    gatewayPort: number,
    storeOptions: LaunchReadinessStoreOptions,
  ) {
    return fenceLeaseStore(sandboxName, GATEWAY_NAME, gatewayPort, storeOptions);
  }

  function readLaunchReadinessLease(
    sandboxName: string,
    gatewayPort: number,
    storeOptions: LaunchReadinessStoreOptions,
  ) {
    return readLeaseStore(sandboxName, GATEWAY_NAME, gatewayPort, storeOptions);
  }

  function publishLaunchReadinessLease(
    sandboxName: string,
    gatewayPort: number,
    expectedEpochId: string,
    launchIdentity: LaunchReadinessIdentity,
    storeOptions: LaunchReadinessStoreOptions,
  ) {
    return publishLeaseStore(
      sandboxName,
      GATEWAY_NAME,
      gatewayPort,
      expectedEpochId,
      launchIdentity,
      storeOptions,
    );
  }

  function publish(): ReturnType<typeof publishLaunchReadinessLease> {
    const fence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    return publishLaunchReadinessLease(SANDBOX, GATEWAY_PORT, fence.epochId, identity(), options());
  }

  function restoreReceipt(targetHome: string, raw: string): void {
    const target = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, targetHome);
    fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
    fs.chmodSync(path.dirname(target), 0o700);
    fs.writeFileSync(target, raw, { mode: 0o600 });
  }

  function readInFreshProcess(gatewayName = GATEWAY_NAME, gatewayPort = GATEWAY_PORT): string {
    const moduleUrl = pathToFileURL(path.resolve("src/lib/state/launch-readiness-lease.ts")).href;
    const source = `
      import launchReadinessLease from ${JSON.stringify(moduleUrl)};
      const { readLaunchReadinessLease } = launchReadinessLease;
      const result = readLaunchReadinessLease(
        ${JSON.stringify(SANDBOX)},
        ${JSON.stringify(gatewayName)},
        ${gatewayPort},
        {
          home: ${JSON.stringify(home)},
          nowWallMs: () => ${wallMs},
          nowUptimeMs: () => ${uptimeMs},
          bootId: () => ${JSON.stringify(bootId)},
          uid: () => ${process.getuid?.() ?? 0},
          runtimeAuthorityRoot: () => ${JSON.stringify(runtimeRoot)},
        },
      );
      process.stdout.write(result.kind);
    `;
    return execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      { encoding: "utf8" },
    );
  }

  function expectFenceFailure(operation: () => unknown, blocksRecovery: boolean): void {
    try {
      operation();
      throw new Error("Expected launch-readiness fencing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(LaunchReadinessFenceError);
      expect((error as LaunchReadinessFenceError).blocksRecovery).toBe(blocksRecovery);
    }
  }

  it("publishes a fixed 24-hour lease and accepts it on the same boot and user", () => {
    const lease = publish();
    expect(lease.leaseExpiresWallMs - lease.leaseStartedWallMs).toBe(LAUNCH_READINESS_LEASE_MS);
    wallMs += 60_000;
    uptimeMs += 60_000;
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options())).toMatchObject({
      kind: "valid",
      lease: { epochId: EPOCH_A, sandboxName: SANDBOX },
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "disables macOS evidence despite caller-controlled runtime path variables (#8942)",
    () => {
      const sandboxName = `darwin-authority-${process.pid}-${Date.now()}`;
      const productionOptions = options({
        runtimeAuthorityRoot: undefined,
        randomEpoch: () => EPOCH_A,
      });
      vi.stubEnv("TMPDIR", runtimeRoot);
      vi.stubEnv("HOME", runtimeRoot);
      vi.stubEnv("XDG_RUNTIME_DIR", runtimeRoot);
      vi.stubEnv("DARWIN_USER_TEMP_DIR", runtimeRoot);
      vi.stubEnv("NEMOCLAW_RUNTIME_AUTHORITY_ROOT", runtimeRoot);
      vi.stubEnv("LAUNCHD_SOCKET", runtimeRoot);
      vi.stubEnv("SECURITYSESSIONID", "caller-session");
      vi.stubEnv("__CF_USER_TEXT_ENCODING", "caller-encoding");

      expectFenceFailure(
        () => fenceLeaseStore(sandboxName, GATEWAY_NAME, GATEWAY_PORT, productionOptions),
        false,
      );

      const testAuthorityOptions = options({ randomEpoch: () => EPOCH_A });
      const fence = fenceLeaseStore(sandboxName, GATEWAY_NAME, GATEWAY_PORT, testAuthorityOptions);
      publishLeaseStore(
        sandboxName,
        GATEWAY_NAME,
        GATEWAY_PORT,
        fence.epochId,
        identity(),
        testAuthorityOptions,
      );
      expect(readLeaseStore(sandboxName, GATEWAY_NAME, GATEWAY_PORT, productionOptions).kind).toBe(
        "unsafe",
      );
      expect(
        checkLaunchReadinessMutationAuthority(
          sandboxName,
          GATEWAY_NAME,
          GATEWAY_PORT,
          null,
          productionOptions,
        ),
      ).toBe("current");
    },
  );

  it("preserves the original lease envelope when the complete preflight republishes before expiry", () => {
    const first = publish();
    wallMs += 60 * 60_000;
    uptimeMs += 60 * 60_000;
    const fence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    wallMs += 60 * 60_000;
    uptimeMs += 60 * 60_000;
    const second = publishLaunchReadinessLease(
      SANDBOX,
      GATEWAY_PORT,
      fence.epochId,
      identity(),
      options(),
    );
    expect(second.epochId).toBe(EPOCH_B);
    expect(second.leaseStartedWallMs).toBe(first.leaseStartedWallMs);
    expect(second.leaseExpiresWallMs).toBe(first.leaseExpiresWallMs);
  });

  it("fences a schema-1 receipt through the normal fallback without invalidating authority (#9023)", () => {
    const first = publish();
    const receiptPath = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home);
    const oldReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
      schemaVersion: number;
      identity: Record<string, unknown>;
    };
    oldReceipt.schemaVersion = 1;
    delete oldReceipt.identity.session;
    fs.writeFileSync(receiptPath, JSON.stringify(oldReceipt), { mode: 0o600 });

    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("malformed");
    const next = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());

    expect(next).toMatchObject({ schemaVersion: 3, epochId: EPOCH_B });
    expect(next.preservedLeaseStartedWallMs).toBe(first.leaseStartedWallMs);
    expect(next.preservedLeaseExpiresWallMs).toBe(first.leaseExpiresWallMs);
    expect(
      JSON.parse(fs.readFileSync(launchReadinessAuthorityPath(SANDBOX, runtimeRoot), "utf8")),
    ).toMatchObject({ schemaVersion: 1, epochId: EPOCH_B });
  });

  it("starts a new envelope only after the prior lease expires", () => {
    const first = publish();
    wallMs = first.leaseExpiresWallMs;
    uptimeMs += LAUNCH_READINESS_LEASE_MS;
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("expired");
    const fence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    const second = publishLaunchReadinessLease(
      SANDBOX,
      GATEWAY_PORT,
      fence.epochId,
      identity(),
      options(),
    );
    expect(second.leaseStartedWallMs).toBe(wallMs);
    expect(second.leaseExpiresWallMs).toBe(wallMs + LAUNCH_READINESS_LEASE_MS);
  });

  it("rejects rollback, future publication, and the stricter monotonic expiry", () => {
    const lease = publish();
    wallMs = lease.publishedWallMs - 1;
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("malformed");
    wallMs = lease.publishedWallMs + 1;
    uptimeMs = lease.publishedUptimeMs - 1;
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("malformed");
    uptimeMs = lease.publishedUptimeMs + LAUNCH_READINESS_LEASE_MS + 1;
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("expired");
  });

  it("rejects non-finite, negative, and inconsistent time records", () => {
    expect(() =>
      fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options({ nowWallMs: () => Number.NaN })),
    ).toThrow();
    expect(() =>
      fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options({ nowUptimeMs: () => -1 })),
    ).toThrow();

    publish();
    const receiptPath = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home);
    const value = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    value.leaseExpiresWallMs = Number(value.leaseExpiresWallMs) + 1;
    fs.writeFileSync(receiptPath, JSON.stringify(value), { mode: 0o600 });
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("malformed");
  });

  it("durably fences clock rollback without starting a replacement envelope", () => {
    const original = publish();
    wallMs = original.publishedWallMs - 1;
    const rollbackFence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(rollbackFence).toMatchObject({
      publicationState: "time-unsafe",
      preservedLeaseStartedWallMs: original.leaseStartedWallMs,
      preservedLeaseExpiresWallMs: original.leaseExpiresWallMs,
      preservedLeaseElapsedMs: 0,
    });
    expect(() =>
      publishLaunchReadinessLease(
        SANDBOX,
        GATEWAY_PORT,
        rollbackFence.epochId,
        identity(),
        options(),
      ),
    ).toThrow("disabled while authority or clock history is unsafe");

    wallMs = original.publishedWallMs + 1;
    uptimeMs += 2;
    const repeatedFence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(repeatedFence.publicationState).toBe("time-unsafe");
    expect(() =>
      publishLaunchReadinessLease(
        SANDBOX,
        GATEWAY_PORT,
        repeatedFence.epochId,
        identity(),
        options(),
      ),
    ).toThrow("disabled while authority or clock history is unsafe");

    wallMs = original.leaseExpiresWallMs;
    uptimeMs += LAUNCH_READINESS_LEASE_MS;
    const expiredFence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(expiredFence).toMatchObject({
      publicationState: "ready",
      preservedLeaseStartedWallMs: null,
      preservedLeaseExpiresWallMs: null,
      preservedLeaseElapsedMs: null,
    });
  });

  it("carries the stricter monotonic elapsed duration across republication", () => {
    publish();
    wallMs += 60 * 60_000;
    uptimeMs += 2 * 60 * 60_000;
    const fence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(fence.preservedLeaseElapsedMs).toBe(2 * 60 * 60_000);

    const second = publishLaunchReadinessLease(
      SANDBOX,
      GATEWAY_PORT,
      fence.epochId,
      identity(),
      options(),
    );
    expect(second.elapsedAtPublicationMs).toBe(2 * 60 * 60_000);

    wallMs += 21 * 60 * 60_000;
    uptimeMs += 22 * 60 * 60_000;
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("expired");
  });

  it("rejects reboot and restored state or home volumes", () => {
    publish();
    bootId = "boot-b";
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("identity");

    bootId = "boot-a";
    const stateRoot = path.join(home, ".nemoclaw");
    const savedState = path.join(root, "saved-state");
    const raw = fs.readFileSync(launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home), "utf8");
    fs.renameSync(stateRoot, savedState);
    restoreReceipt(home, raw);
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("identity");

    const replacementHome = path.join(root, "replacement-home");
    fs.mkdirSync(replacementHome, { mode: 0o700 });
    restoreReceipt(replacementHome, raw);
    expect(
      readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options({ home: replacementHome })).kind,
    ).toBe("identity");
  });

  it("uses the random fence epoch as publication CAS authority", () => {
    const stale = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    const current = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(() =>
      publishLaunchReadinessLease(SANDBOX, GATEWAY_PORT, stale.epochId, identity(), options()),
    ).toThrow("authority changed");
    expect(
      publishLaunchReadinessLease(SANDBOX, GATEWAY_PORT, current.epochId, identity(), options())
        .epochId,
    ).toBe(current.epochId);
  });

  it("keeps the newer published lease valid when a paused producer resumes stale", () => {
    const pausedProducer = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    const currentProducer = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    publishLaunchReadinessLease(
      SANDBOX,
      GATEWAY_PORT,
      currentProducer.epochId,
      identity(),
      options(),
    );

    expect(
      checkLaunchReadinessMutationAuthority(
        SANDBOX,
        GATEWAY_NAME,
        GATEWAY_PORT,
        pausedProducer.epochId,
        options(),
      ),
    ).toBe("changed");
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options())).toMatchObject({
      kind: "valid",
      lease: { epochId: currentProducer.epochId },
    });
    expect(() =>
      publishLaunchReadinessLease(
        SANDBOX,
        GATEWAY_PORT,
        pausedProducer.epochId,
        identity(),
        options(),
      ),
    ).toThrow("authority changed");
  });

  it("revalidates the runtime epoch used to enter the recovery mutation window", () => {
    const stale = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(
      checkLaunchReadinessMutationAuthority(
        SANDBOX,
        GATEWAY_NAME,
        GATEWAY_PORT,
        stale.epochId,
        options(),
      ),
    ).toBe("current");

    const current = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(
      checkLaunchReadinessMutationAuthority(
        SANDBOX,
        GATEWAY_NAME,
        GATEWAY_PORT,
        stale.epochId,
        options(),
      ),
    ).toBe("changed");
    expect(
      checkLaunchReadinessMutationAuthority(
        SANDBOX,
        GATEWAY_NAME,
        GATEWAY_PORT,
        current.epochId,
        options(),
      ),
    ).toBe("current");
  });

  it("revalidates authoritative absence under the recovery mutation gate", () => {
    expect(
      checkLaunchReadinessMutationAuthority(SANDBOX, GATEWAY_NAME, GATEWAY_PORT, null, options()),
    ).toBe("current");

    fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(
      checkLaunchReadinessMutationAuthority(SANDBOX, GATEWAY_NAME, GATEWAY_PORT, null, options()),
    ).toBe("changed");
  });

  it("rejects a copied fence after the state volume changes during preflight", () => {
    const fence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    const stateRoot = path.join(home, ".nemoclaw");
    const savedState = path.join(root, "preflight-state");
    const raw = fs.readFileSync(launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home), "utf8");
    fs.renameSync(stateRoot, savedState);
    restoreReceipt(home, raw);

    expect(() =>
      publishLaunchReadinessLease(SANDBOX, GATEWAY_PORT, fence.epochId, identity(), options()),
    ).toThrow("authority changed");
  });

  it("rejects unknown schema fields and reads only the bounded exact file", () => {
    publish();
    const receiptPath = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home);
    const value = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    value.extra = true;
    fs.writeFileSync(receiptPath, JSON.stringify(value), { mode: 0o600 });
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("malformed");

    fs.writeFileSync(receiptPath, "x".repeat(LAUNCH_READINESS_MAX_BYTES + 1), { mode: 0o600 });
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("unsafe");
  });

  it("stores only the exact credential-free OpenClaw session qualification (#9023)", () => {
    const fence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    publishLaunchReadinessLease(
      SANDBOX,
      GATEWAY_PORT,
      fence.epochId,
      openClawIdentity(),
      options(),
    );
    const receiptPath = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home);
    const raw = fs.readFileSync(receiptPath, "utf8");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("privateKey");
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options())).toMatchObject({
      kind: "valid",
      lease: { identity: { session: openClawIdentity().session } },
    });

    const value = JSON.parse(raw) as {
      identity: { session: { requiredScopes: string[] } };
    };
    value.identity.session.requiredScopes = ["operator.pairing", "operator.write"];
    fs.writeFileSync(receiptPath, JSON.stringify(value), { mode: 0o600 });
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("malformed");
  });

  it("requires an exact bounded private runtime-authority record", () => {
    publish();
    const authorityPath = launchReadinessAuthorityPath(SANDBOX, runtimeRoot);
    expect(path.basename(authorityPath)).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(fs.statSync(path.dirname(authorityPath)).mode & 0o777).toBe(0o700);
    const authorityFd = fs.openSync(authorityPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(authorityFd).mode & 0o777).toBe(0o600);

      const authority = JSON.parse(fs.readFileSync(authorityFd, "utf8")) as Record<string, unknown>;
      authority.extra = true;
      fs.ftruncateSync(authorityFd, 0);
      fs.writeSync(authorityFd, JSON.stringify(authority), 0, "utf8");
      expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("unsafe");

      fs.ftruncateSync(authorityFd, 0);
      fs.writeSync(authorityFd, "x".repeat(LAUNCH_READINESS_MAX_BYTES + 1), 0, "utf8");
      expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("unsafe");
    } finally {
      fs.closeSync(authorityFd);
    }
  });

  it("rejects an authority copied to a restored runtime root", () => {
    publish();
    const authorityPath = launchReadinessAuthorityPath(SANDBOX, runtimeRoot);
    const authority = fs.readFileSync(authorityPath, "utf8");
    const replacementRuntime = path.join(root, "replacement-runtime");
    const replacementPath = launchReadinessAuthorityPath(SANDBOX, replacementRuntime);
    fs.mkdirSync(path.dirname(replacementPath), { mode: 0o700, recursive: true });
    fs.chmodSync(replacementRuntime, 0o700);
    fs.chmodSync(path.join(replacementRuntime, "nemoclaw"), 0o700);
    fs.chmodSync(path.dirname(replacementPath), 0o700);
    fs.writeFileSync(replacementPath, authority, { mode: 0o600 });

    expect(
      readLaunchReadinessLease(
        SANDBOX,
        GATEWAY_PORT,
        options({ runtimeAuthorityRoot: () => replacementRuntime }),
      ).kind,
    ).toBe("identity");
  });

  it("quarantines unsafe authority history for one fixed non-sliding 24-hour interval before a new envelope", () => {
    publish();
    const authorityPath = launchReadinessAuthorityPath(SANDBOX, runtimeRoot);
    fs.writeFileSync(authorityPath, "{}\n", { mode: 0o600 });
    epochs = [EPOCH_B, EPOCH_C, "e".repeat(64)];

    const quarantined = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(quarantined).toMatchObject({
      publicationState: "time-unsafe",
      preservedLeaseStartedWallMs: wallMs,
      preservedLeaseExpiresWallMs: wallMs + LAUNCH_READINESS_LEASE_MS,
      preservedLeaseElapsedMs: 0,
    });
    expect(() =>
      publishLaunchReadinessLease(
        SANDBOX,
        GATEWAY_PORT,
        quarantined.epochId,
        identity(),
        options(),
      ),
    ).toThrow("disabled while authority or clock history is unsafe");

    wallMs += LAUNCH_READINESS_LEASE_MS;
    uptimeMs += LAUNCH_READINESS_LEASE_MS - 1;
    const stillQuarantined = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(stillQuarantined).toMatchObject({
      publicationState: "time-unsafe",
      preservedLeaseStartedWallMs: quarantined.preservedLeaseStartedWallMs,
      preservedLeaseExpiresWallMs: quarantined.preservedLeaseExpiresWallMs,
      preservedLeaseElapsedMs: LAUNCH_READINESS_LEASE_MS - 1,
    });

    uptimeMs += 1;
    const recovered = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    expect(recovered).toMatchObject({
      publicationState: "ready",
      preservedLeaseStartedWallMs: null,
      preservedLeaseExpiresWallMs: null,
      preservedLeaseElapsedMs: null,
    });
    const lease = publishLaunchReadinessLease(
      SANDBOX,
      GATEWAY_PORT,
      recovered.epochId,
      identity(),
      options(),
    );
    expect(lease.leaseStartedWallMs).toBe(wallMs);
    expect(lease.leaseExpiresWallMs).toBe(wallMs + LAUNCH_READINESS_LEASE_MS);
  });

  it("rejects unsafe receipt permissions and foreign ownership authority", () => {
    publish();
    const receiptPath = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home);
    const receiptDir = path.dirname(receiptPath);
    expect(fs.statSync(receiptDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);

    fs.chmodSync(receiptPath, 0o640);
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("unsafe");
    fs.chmodSync(receiptPath, 0o600);

    fs.chmodSync(receiptDir, 0o750);
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("unsafe");
    fs.chmodSync(receiptDir, 0o700);

    const stateAncestor = path.dirname(path.dirname(receiptDir));
    fs.chmodSync(stateAncestor, 0o770);
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("unsafe");
    fs.chmodSync(stateAncestor, 0o700);

    expect(
      readLaunchReadinessLease(
        SANDBOX,
        GATEWAY_PORT,
        options({ uid: () => (process.getuid?.() ?? 0) + 1 }),
      ).kind,
    ).toBe("unsafe");
  });

  it("rejects symlinked ancestors, symlinked receipts, and hard links", () => {
    const linkHome = path.join(root, "link-home");
    fs.mkdirSync(linkHome, { mode: 0o700 });
    const target = path.join(root, "target-state");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, path.join(linkHome, ".nemoclaw"));
    expect(() =>
      fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options({ home: linkHome })),
    ).toThrow();

    publish();
    const receiptPath = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home);
    const saved = `${receiptPath}.saved`;
    fs.renameSync(receiptPath, saved);
    fs.symlinkSync(saved, receiptPath);
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("unsafe");
    fs.unlinkSync(receiptPath);
    fs.renameSync(saved, receiptPath);
    fs.linkSync(receiptPath, `${receiptPath}.link`);
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("unsafe");
  });

  it("uses one sandbox-global authority epoch across owning gateway changes", () => {
    const gatewayA = "gateway-a";
    const gatewayB = "gateway-b";
    const portA = 8080;
    const portB = 8081;
    const fenceA = fenceLeaseStore(SANDBOX, gatewayA, portA, options());
    const first = publishLeaseStore(
      SANDBOX,
      gatewayA,
      portA,
      fenceA.epochId,
      identity(gatewayA),
      options(),
    );
    wallMs += 60_000;
    uptimeMs += 60_000;

    const fenceB = fenceLeaseStore(SANDBOX, gatewayB, portB, options());
    expect(fenceB.epochId).toBe(EPOCH_B);
    expect(fenceB.preservedLeaseStartedWallMs).toBe(first.leaseStartedWallMs);
    expect(fenceB.preservedLeaseExpiresWallMs).toBe(first.leaseExpiresWallMs);
    expect(readLeaseStore(SANDBOX, gatewayA, portA, options()).kind).toBe("identity");
    expect(readInFreshProcess(gatewayA, portA)).toBe("identity");
  });

  it("blocks when a prior runtime epoch exists but its rotation cannot be made durable", () => {
    const fence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    fs.unlinkSync(launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home));
    const authorityPath = launchReadinessAuthorityPath(SANDBOX, runtimeRoot);
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      destination === authorityPath
        ? throwReadOnly("read-only runtime authority")
        : rename(source, destination),
    );

    expect(fence.epochId).toBe(EPOCH_A);
    expectFenceFailure(() => fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()), true);
  });

  it("allows the complete preflight only when runtime authority and persistent evidence are securely absent", () => {
    const mkdir = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation((target, mkdirOptions) =>
      String(target).startsWith(runtimeRoot)
        ? throwReadOnly("read-only runtime root")
        : mkdir(target, mkdirOptions as fs.MakeDirectoryOptions & { recursive: true }),
    );

    expectFenceFailure(() => fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()), false);
    expect(fs.existsSync(launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home))).toBe(false);
    expect(fs.existsSync(launchReadinessAuthorityPath(SANDBOX, runtimeRoot))).toBe(false);
  });

  it("blocks when runtime authority is unsafe even though persistent evidence is missing", () => {
    fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
    fs.unlinkSync(launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home));
    const authorityDir = path.dirname(launchReadinessAuthorityPath(SANDBOX, runtimeRoot));
    fs.chmodSync(authorityDir, 0o500);

    expectFenceFailure(() => fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()), true);
    fs.chmodSync(authorityDir, 0o700);
  });

  it.each(["file", "directory", "ancestor"] as const)(
    "keeps a restored unsafe persistent %s invalid across processes",
    (unsafePart) => {
      publish();
      const receiptPath = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home);
      const receiptDir = path.dirname(receiptPath);
      const target =
        unsafePart === "file"
          ? receiptPath
          : unsafePart === "directory"
            ? receiptDir
            : path.dirname(receiptDir);
      const before = fs.statSync(receiptPath);
      const originalMode = fs.statSync(target).mode & 0o777;
      fs.chmodSync(target, unsafePart === "file" ? 0o640 : 0o770);

      expectFenceFailure(() => fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()), false);
      fs.chmodSync(target, originalMode);
      const restored = fs.statSync(receiptPath);
      expect({ dev: restored.dev, ino: restored.ino }).toEqual({
        dev: before.dev,
        ino: before.ino,
      });
      expect(readInFreshProcess()).toBe("identity");

      epochs = [EPOCH_C];
      const newFence = fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options());
      publishLaunchReadinessLease(SANDBOX, GATEWAY_PORT, newFence.epochId, identity(), options());
      expect(readInFreshProcess()).toBe("valid");
    },
  );

  it("rejects the unchanged persistent inode after simulated read-only remount fencing", () => {
    publish();
    const receiptPath = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home);
    const before = fs.statSync(receiptPath);
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      destination === receiptPath
        ? throwReadOnly("read-only persistent state")
        : rename(source, destination),
    );

    expectFenceFailure(() => fenceLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()), false);
    vi.restoreAllMocks();
    const restored = fs.statSync(receiptPath);
    expect({ dev: restored.dev, ino: restored.ino, ctimeMs: restored.ctimeMs }).toEqual({
      dev: before.dev,
      ino: before.ino,
      ctimeMs: before.ctimeMs,
    });
    expect(readInFreshProcess()).toBe("identity");
  });

  it("stores receipts by a SHA-256 key while verifying the exact sandbox name", () => {
    publish();
    const receiptPath = launchReadinessReceiptPath(SANDBOX, GATEWAY_PORT, home);
    expect(path.basename(receiptPath)).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(readLaunchReadinessLease("beta", GATEWAY_PORT, options()).kind).toBe("missing");

    const value = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    value.sandboxName = "beta";
    fs.writeFileSync(receiptPath, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(receiptPath, 0o600);
    expect(readLaunchReadinessLease(SANDBOX, GATEWAY_PORT, options()).kind).toBe("missing");
  });
});
