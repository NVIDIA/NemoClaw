// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { MANAGED_IMAGE_REPOSITORIES } from "../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../onboard/managed-startup/profile";
import {
  captureSandboxRebuildAuthority,
  compareAndSwapSandboxRebuildAuthority,
  SandboxRebuildAuthorityError,
  sandboxRebuildAuthorityMatchesEntry,
  sandboxRebuildReplacementMatchesEntry,
  swapSandboxRebuildAuthorityInRegistry,
} from "./registry/rebuild-authority";
import type { SandboxEntry, SandboxRegistry, SandboxWorkloadReceipt } from "./registry/types";

const registryPersistence = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./registry/persistence", () => registryPersistence);
vi.mock("./registry/lock", () => ({
  withLock: <T>(operation: () => T): T => operation(),
}));

const ENCODED_PROFILE = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
const PROFILE_SHA256 = createHash("sha256").update(ENCODED_PROFILE, "utf8").digest("hex");

function receipt(digest: string): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${digest.repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.100",
    sourceRevision: digest.repeat(40),
    sourceCohort: digest === "a" ? "ghrun-100-1" : "ghrun-200-2",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: ENCODED_PROFILE,
    startupProfileSha256: PROFILE_SHA256,
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function entry(generation = "generation-old", fingerprint = "fingerprint-old"): SandboxEntry {
  const workload = receipt("a");
  return {
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "docker",
    imageTag: workload.reference,
    workload,
    lifecycleGeneration: generation,
    lifecycleLiveIdentityFingerprint: fingerprint,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  };
}

function registry(current: SandboxEntry = entry()): SandboxRegistry {
  return {
    sandboxes: {
      alpha: current,
      beta: {
        name: "beta",
        openshellDriver: "docker",
        lifecycleGeneration: "beta-generation",
        lifecycleLiveIdentityFingerprint: "beta-fingerprint",
      },
    },
    defaultSandbox: "alpha",
    defaultSelectionRevision: 7,
  };
}

function replacement(): SandboxEntry {
  const workload = receipt("b");
  return {
    ...entry("generation-new", "fingerprint-new"),
    imageTag: workload.reference,
    workload,
  };
}

describe("sandbox rebuild authority", () => {
  beforeEach(() => {
    registryPersistence.load.mockReset();
    registryPersistence.save.mockReset();
  });

  it("captures a cloned exact authority unit", () => {
    const source = entry();
    const authority = captureSandboxRebuildAuthority(source, "docker");

    expect(authority).toMatchObject({
      schemaVersion: 1,
      sandboxName: "alpha",
      providerId: "docker",
      recordedDriver: "docker",
      lifecycleGeneration: "generation-old",
      liveIdentityFingerprint: "fingerprint-old",
      workload: source.workload,
    });
    expect(authority.entryRevisionSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(authority.workload).not.toBe(source.workload);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.workload)).toBe(true);
    expect(Reflect.set(authority.workload, "reference", "mutated")).toBe(false);
  });

  it.each([
    ["driver", (source: SandboxEntry) => ({ ...source, openshellDriver: "mxc" })],
    [
      "generation",
      (source: SandboxEntry) => ({ ...source, lifecycleGeneration: "other-generation" }),
    ],
    [
      "fingerprint",
      (source: SandboxEntry) => ({
        ...source,
        lifecycleLiveIdentityFingerprint: "other-fingerprint",
      }),
    ],
    [
      "workload",
      (source: SandboxEntry) => {
        const workload = receipt("b");
        return { ...source, imageTag: workload.reference, workload };
      },
    ],
    ["non-authority metadata", (source: SandboxEntry) => ({ ...source, gatewayPort: 9090 })],
  ] as const)("rejects %s drift from exact authority", (_label, mutate) => {
    const authority = captureSandboxRebuildAuthority(entry(), "docker");

    expect(sandboxRebuildAuthorityMatchesEntry(authority, mutate(entry()))).toBe(false);
  });

  it("publishes a replacement by CAS without changing unrelated registry state", () => {
    const before = registry();
    const authority = captureSandboxRebuildAuthority(before.sandboxes.alpha!, "docker");
    const swapped = swapSandboxRebuildAuthorityInRegistry(before, authority, replacement());

    expect(swapped.result).toMatchObject({
      status: "committed",
      entry: {
        lifecycleGeneration: "generation-new",
        lifecycleLiveIdentityFingerprint: "fingerprint-new",
        workload: { reference: receipt("b").reference },
      },
    });
    expect(swapped.registry).not.toBe(before);
    expect(swapped.registry.sandboxes.alpha).toEqual(replacement());
    expect(swapped.registry.sandboxes.beta).toBe(before.sandboxes.beta);
    expect(swapped.registry.defaultSandbox).toBe("alpha");
    expect(swapped.registry.defaultSelectionRevision).toBe(7);
    expect(before.sandboxes.alpha).toEqual(entry());
  });

  it("keeps the original registry object when exact authority is stale", () => {
    const before = registry(entry("generation-concurrent", "fingerprint-concurrent"));
    const authority = captureSandboxRebuildAuthority(entry(), "docker");
    const swapped = swapSandboxRebuildAuthorityInRegistry(before, authority, replacement());

    expect(swapped.result).toMatchObject({
      status: "stale-authority",
      entry: { lifecycleGeneration: "generation-concurrent" },
    });
    expect(swapped.registry).toBe(before);
    expect(swapped.registry.sandboxes.alpha).toBe(before.sandboxes.alpha);
  });

  it("does not overwrite a concurrent non-authority row update", () => {
    const oldEntry = entry();
    const before = registry({ ...oldEntry, model: "concurrently-updated" });
    const authority = captureSandboxRebuildAuthority(oldEntry, "docker");
    const swapped = swapSandboxRebuildAuthorityInRegistry(before, authority, replacement());

    expect(swapped.result).toMatchObject({
      status: "stale-authority",
      entry: { model: "concurrently-updated" },
    });
    expect(swapped.registry).toBe(before);
  });

  it("reconciles an acknowledgement failure to the exact persisted replacement", () => {
    let persisted = registry();
    const authority = captureSandboxRebuildAuthority(persisted.sandboxes.alpha!, "docker");
    registryPersistence.load.mockImplementation(() => structuredClone(persisted));
    registryPersistence.save.mockImplementation((next: SandboxRegistry) => {
      persisted = structuredClone(next);
      throw new Error("registry acknowledgement lost");
    });

    const result = compareAndSwapSandboxRebuildAuthority(authority, replacement());

    expect(result).toMatchObject({
      status: "committed",
      entry: {
        lifecycleGeneration: "generation-new",
        lifecycleLiveIdentityFingerprint: "fingerprint-new",
      },
    });
    expect(registryPersistence.load).toHaveBeenCalledTimes(2);
    expect(registryPersistence.save).toHaveBeenCalledOnce();
  });

  it("does not reconcile failures that happen before persistence", () => {
    const authority = captureSandboxRebuildAuthority(entry(), "docker");
    registryPersistence.load.mockImplementation(() => {
      throw new Error("registry read failed");
    });

    expect(() => compareAndSwapSandboxRebuildAuthority(authority, replacement())).toThrow(
      /registry read failed/u,
    );
    expect(registryPersistence.load).toHaveBeenCalledOnce();
    expect(registryPersistence.save).not.toHaveBeenCalled();
  });

  it("validates a replacement before acquiring durable registry state", () => {
    const authority = captureSandboxRebuildAuthority(entry(), "docker");

    expect(() =>
      compareAndSwapSandboxRebuildAuthority(authority, {
        ...replacement(),
        openshellDriver: "mxc",
      }),
    ).toThrow(SandboxRebuildAuthorityError);
    expect(registryPersistence.load).not.toHaveBeenCalled();
    expect(registryPersistence.save).not.toHaveBeenCalled();
  });

  it("matches exact replacement authority while ignoring later mutable metadata", () => {
    const expected = replacement();

    expect(
      sandboxRebuildReplacementMatchesEntry(expected, {
        ...expected,
        model: "updated-after-publication",
        gatewayPort: 9090,
      }),
    ).toBe(true);
    expect(
      sandboxRebuildReplacementMatchesEntry(expected, {
        ...expected,
        lifecycleLiveIdentityFingerprint: "different-fingerprint",
      }),
    ).toBe(false);
  });

  it.each([
    ["sandbox name", (candidate: SandboxEntry) => ({ ...candidate, name: "other" })],
    ["agent", (candidate: SandboxEntry) => ({ ...candidate, agent: "hermes" })],
    ["provider", (candidate: SandboxEntry) => ({ ...candidate, openshellDriver: "mxc" })],
    [
      "lifecycle generation",
      (candidate: SandboxEntry) => ({
        ...candidate,
        lifecycleGeneration: "generation-old",
      }),
    ],
    [
      "live identity",
      (candidate: SandboxEntry) => ({
        ...candidate,
        lifecycleLiveIdentityFingerprint: "fingerprint-old",
      }),
    ],
    [
      "image reference",
      (candidate: SandboxEntry) => ({
        ...candidate,
        imageTag: receipt("a").reference,
      }),
    ],
  ] as const)("rejects replacement %s drift before CAS", (_label, mutate) => {
    const before = registry();
    const authority = captureSandboxRebuildAuthority(before.sandboxes.alpha!, "docker");

    expect(() =>
      swapSandboxRebuildAuthorityInRegistry(before, authority, mutate(replacement())),
    ).toThrow(SandboxRebuildAuthorityError);
    expect(before).toEqual(registry());
  });

  it("rejects route reservations and missing exact lifecycle authority", () => {
    expect(() =>
      captureSandboxRebuildAuthority({ ...entry(), pendingRouteReservation: true }, "docker"),
    ).toThrow(/route reservations/u);
    expect(() =>
      captureSandboxRebuildAuthority({ ...entry(), lifecycleGeneration: undefined }, "docker"),
    ).toThrow(/lifecycle generation/u);
    expect(() =>
      captureSandboxRebuildAuthority(
        { ...entry(), lifecycleLiveIdentityFingerprint: undefined },
        "docker",
      ),
    ).toThrow(/live identity fingerprint/u);
    expect(() => captureSandboxRebuildAuthority({ ...entry(), agent: "hermes" }, "docker")).toThrow(
      /agent does not match/u,
    );
  });
});
