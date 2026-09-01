// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import type { SandboxEntry } from "../../state/registry/types";
import { parseForwardList } from "../../state/sandbox-session";
import type { ForwardServiceSandboxAuthority } from "./forward-service-controller";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const LEGACY_FORWARD_RELEASE_TIMEOUT_MS = 5_000;
const LEGACY_FORWARD_RELEASE_POLL_MS = 250;

type SandboxObservation = {
  readonly state: "missing" | "not_ready" | "ready";
  readonly liveIdentityFingerprint: string | null;
};

export interface ForwardServiceAuthorityMigration {
  readonly authority: ForwardServiceSandboxAuthority;
  readonly migrated: boolean;
  assertCurrent(): void;
  assertLiveCurrent(): void;
  completeLegacyMigration(): void;
  isLegacyMigrationComplete(): boolean;
}

export interface ForwardServiceAuthorityMigrationDeps {
  readonly compareAndSet: (
    expected: SandboxEntry,
    lifecycleGeneration: string,
    sandboxIdentityFingerprint: string,
  ) => boolean;
  readonly completeMigration: (
    sandboxName: string,
    lifecycleGeneration: string,
    sandboxIdentityFingerprint: string,
  ) => boolean;
  readonly generation?: () => string;
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly observe: (target: {
    sandboxName: string;
    gatewayName: string;
    gatewayPort: number;
  }) => SandboxObservation;
  readonly resolveGatewayName: (entry: SandboxEntry) => string;
  readonly resolveGatewayPort: (entry: SandboxEntry) => number;
}

function validGeneration(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function requirePublishedSandbox(sandboxName: string, entry: SandboxEntry | null): SandboxEntry {
  if (!entry || entry.name !== sandboxName || entry.pendingRouteReservation === true) {
    throw new Error(`Sandbox '${sandboxName}' has no published forwarding authority`);
  }
  return entry;
}

function requireObservedIdentity(
  sandboxName: string,
  gatewayName: string,
  observation: SandboxObservation,
): string {
  const fingerprint = observation.liveIdentityFingerprint;
  if (observation.state === "missing" || !fingerprint || !SHA256_PATTERN.test(fingerprint)) {
    throw new Error(
      `Cannot migrate forwarding for sandbox '${sandboxName}': gateway '${gatewayName}' did not report a stable live identity`,
    );
  }
  return fingerprint;
}

/** Upgrade one unchanged legacy registry row to complete live ForwardTcp authority. */
export function requireForwardServiceAuthority(
  sandboxName: string,
  deps: ForwardServiceAuthorityMigrationDeps,
): ForwardServiceAuthorityMigration {
  const getSandbox = deps.getSandbox;
  const resolveGatewayName = deps.resolveGatewayName;
  const observe = deps.observe;
  const initial = requirePublishedSandbox(sandboxName, getSandbox(sandboxName));
  const gatewayName = resolveGatewayName(initial);
  const gatewayPort = deps.resolveGatewayPort(initial);
  const initialFingerprint = initial.lifecycleLiveIdentityFingerprint;
  const initialGeneration = initial.lifecycleGeneration;
  let migrated = false;
  let legacyMigrationComplete = initial.forwardServiceMigrationVersion === 1;
  let lifecycleGeneration = initialGeneration;
  let sandboxIdentityFingerprint = initialFingerprint;

  if (
    !validGeneration(lifecycleGeneration) ||
    !SHA256_PATTERN.test(sandboxIdentityFingerprint ?? "")
  ) {
    const observedFingerprint = requireObservedIdentity(
      sandboxName,
      gatewayName,
      observe({ sandboxName, gatewayName, gatewayPort }),
    );
    if (sandboxIdentityFingerprint && sandboxIdentityFingerprint !== observedFingerprint) {
      throw new Error(
        `Cannot migrate forwarding for sandbox '${sandboxName}': recorded and live identities disagree`,
      );
    }
    lifecycleGeneration = validGeneration(lifecycleGeneration)
      ? lifecycleGeneration
      : (deps.generation ?? randomUUID)();
    sandboxIdentityFingerprint = observedFingerprint;
    if (!deps.compareAndSet(initial, lifecycleGeneration, sandboxIdentityFingerprint)) {
      throw new Error(
        `Cannot migrate forwarding for sandbox '${sandboxName}': its registry row changed`,
      );
    }
    migrated = true;
  }

  if (
    !validGeneration(lifecycleGeneration) ||
    !SHA256_PATTERN.test(sandboxIdentityFingerprint ?? "")
  ) {
    throw new Error(`Sandbox '${sandboxName}' has incomplete forwarding authority`);
  }
  const authority: ForwardServiceSandboxAuthority = {
    gatewayName,
    sandboxIdentityFingerprint: sandboxIdentityFingerprint!,
    sandboxName,
  };
  const assertCurrent = (): void => {
    const current = requirePublishedSandbox(sandboxName, getSandbox(sandboxName));
    if (
      current.lifecycleGeneration !== lifecycleGeneration ||
      current.lifecycleLiveIdentityFingerprint !== sandboxIdentityFingerprint ||
      (legacyMigrationComplete && current.forwardServiceMigrationVersion !== 1) ||
      resolveGatewayName(current) !== gatewayName
    ) {
      throw new Error(`Sandbox '${sandboxName}' forwarding authority changed`);
    }
  };
  const assertLiveCurrent = (): void => {
    assertCurrent();
    const observedFingerprint = requireObservedIdentity(
      sandboxName,
      gatewayName,
      observe({ sandboxName, gatewayName, gatewayPort }),
    );
    if (observedFingerprint !== sandboxIdentityFingerprint) {
      throw new Error(`Sandbox '${sandboxName}' live identity changed`);
    }
  };
  const completeLegacyMigration = (): void => {
    assertLiveCurrent();
    if (!deps.completeMigration(sandboxName, lifecycleGeneration, sandboxIdentityFingerprint!)) {
      throw new Error(`Sandbox '${sandboxName}' forwarding migration marker changed`);
    }
    legacyMigrationComplete = true;
  };
  assertCurrent();
  if (migrated) assertLiveCurrent();
  return {
    authority,
    migrated,
    assertCurrent,
    assertLiveCurrent,
    completeLegacyMigration,
    isLegacyMigrationComplete: () => legacyMigrationComplete,
  };
}

export interface LegacyForwardMigrationDeps {
  readonly capture: (gatewayName: string) => {
    readonly error?: unknown;
    readonly output?: string | null;
    readonly signal?: NodeJS.Signals | null;
    readonly status?: number | null;
  };
  readonly isReachable: (port: number) => boolean;
  readonly run: (
    gatewayName: string,
    sandboxName: string,
    port: number,
  ) => {
    readonly status?: number | null;
  };
  readonly sleep?: (milliseconds: number) => void;
}

/**
 * One-release upgrade seam: retire every same-gateway legacy SSH forward for
 * an identity-pinned sandbox before its direct ForwardTcp receipts take over.
 * No production path creates a legacy forward.
 */
export function retireLegacySandboxForwards(
  migration: ForwardServiceAuthorityMigration,
  deps: LegacyForwardMigrationDeps,
): number {
  migration.assertCurrent();
  if (migration.isLegacyMigrationComplete()) return 0;
  const listed = deps.capture(migration.authority.gatewayName);
  if (listed.error || listed.signal || listed.status !== 0) {
    throw new Error("Cannot enumerate legacy OpenShell forwards during ForwardTcp migration");
  }
  const entries = parseForwardList(listed.output).filter(
    (entry) => entry.sandboxName === migration.authority.sandboxName,
  );
  const ports = [...new Set(entries.map((entry) => Number(entry.port)))].filter(
    (port) => Number.isInteger(port) && port >= 1 && port <= 65_535,
  );
  for (const port of ports) {
    migration.assertLiveCurrent();
    const result = deps.run(migration.authority.gatewayName, migration.authority.sandboxName, port);
    if (result.status !== 0) {
      throw new Error(`Legacy OpenShell forward ${String(port)} could not be retired`);
    }
    if (!waitForLegacyPortRelease(port, deps.isReachable, deps.sleep)) {
      throw new Error(`Legacy OpenShell forward ${String(port)} did not release its host port`);
    }
  }
  migration.completeLegacyMigration();
  migration.assertCurrent();
  return ports.length;
}

function waitForLegacyPortRelease(
  port: number,
  isReachable: (port: number) => boolean,
  sleep = (milliseconds: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
): boolean {
  const attempts =
    Math.ceil(LEGACY_FORWARD_RELEASE_TIMEOUT_MS / LEGACY_FORWARD_RELEASE_POLL_MS) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isReachable(port)) return true;
    if (attempt + 1 < attempts) sleep(LEGACY_FORWARD_RELEASE_POLL_MS);
  }
  return false;
}
