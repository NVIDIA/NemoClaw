// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fenceLaunchReadinessLease,
  LAUNCH_READINESS_LEASE_MS,
  LAUNCH_READINESS_MAX_BYTES,
  type LaunchReadinessIdentity,
  type LaunchReadinessStoreOptions,
  launchReadinessReceiptPath,
  publishLaunchReadinessLease,
  readLaunchReadinessLease,
} from "./launch-readiness-lease";

const SANDBOX = "alpha";
const GATEWAY_PORT = 8080;
const EPOCH_A = "a".repeat(64);
const EPOCH_B = "b".repeat(64);
const DIGEST = "c".repeat(64);

function identity(): LaunchReadinessIdentity {
  return {
    registry: DIGEST,
    agent: DIGEST,
    livePolicy: DIGEST,
    liveInference: DIGEST,
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    liveIdentityFingerprint: DIGEST,
  };
}

describe("launch readiness lease storage", () => {
  let root: string;
  let home: string;
  let wallMs: number;
  let uptimeMs: number;
  let bootId: string;
  let epochs: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launch-readiness-"));
    home = path.join(root, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    fs.chmodSync(home, 0o700);
    wallMs = 2_000_000_000_000;
    uptimeMs = 100_000;
    bootId = "boot-a";
    epochs = [EPOCH_A, EPOCH_B];
  });

  afterEach(() => {
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
      ...overrides,
    };
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
    ).toThrow("disabled after an unsafe clock observation");

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
    ).toThrow("disabled after an unsafe clock observation");

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
