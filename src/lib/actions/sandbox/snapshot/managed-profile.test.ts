// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { managedStartupE2eProfile } from "../../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  MANAGED_IMAGE_REPOSITORIES,
  type ShippedManagedImageAgent,
} from "../../../onboard/managed-image/contract";
import {
  encodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
} from "../../../onboard/managed-startup/profile";
import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../../state/registry/types";
import {
  prepareManagedSnapshotProfileRestore,
  readManagedSnapshotProfileAuthority,
  rejectManagedSnapshotCloneUntilRebind,
} from "./managed-profile";

function workload(
  agent: ShippedManagedImageAgent,
  changedProfile = false,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupProfile(
    managedStartupE2eProfile(agent, changedProfile),
  );
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.88",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function sandbox(agent: ShippedManagedImageAgent, receipt = workload(agent)): SandboxEntry {
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    imageTag: receipt.reference,
    fromDockerfile: null,
    workload: receipt,
  };
}

function provider(accepted = true, managedProfileRestore = true): RuntimeProviderBundle {
  return {
    identity: { contractVersion: 1, id: "mxc", displayName: "MXC" },
    workload: {
      providerId: "mxc",
      supported: true,
      profile: {
        support: null,
        hostArchitectures: [],
        managedImageSelectionPolicy: "prefer-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: () => accepted,
    },
    snapshot: {
      providerId: "mxc",
      supported: true,
      contractVersion: 1,
      capabilities: {
        backup: true,
        restore: true,
        managedProfileRestore,
      },
      preflight: () => {
        throw new Error("profile preflight must not perform runtime effects");
      },
      capture: () => {
        throw new Error("profile preflight must not perform runtime effects");
      },
      validateRestore: () => {
        throw new Error("profile preflight must not perform runtime effects");
      },
      restore: () => {
        throw new Error("profile preflight must not perform runtime effects");
      },
    },
  } as unknown as RuntimeProviderBundle;
}

describe("managed snapshot profile restore", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("validates exact secret-free %s profile authority", (agent) => {
    const receipt = workload(agent);
    const source = { sandboxName: "alpha", agentType: agent, workload: receipt };

    const plan = prepareManagedSnapshotProfileRestore(source, sandbox(agent, receipt), provider());

    expect(plan).toMatchObject({
      schemaVersion: 1,
      providerId: "mxc",
      sourceSandboxName: "alpha",
      targetSandboxName: "alpha",
      authority: {
        agent,
        receipt,
        profile: { agent },
      },
      providerRestoreAuthority: {
        agent,
        profileFingerprint: fingerprintManagedStartupProfile(managedStartupE2eProfile(agent)),
      },
    });
  });

  it("returns null for legacy snapshots without managed workload authority", () => {
    expect(
      readManagedSnapshotProfileAuthority({
        sandboxName: "legacy",
        agentType: "openclaw",
      }),
    ).toBeNull();
  });

  it("rejects malformed snapshot authority before consulting the target", () => {
    const receipt = {
      ...workload("hermes"),
      startupProfileSha256: "0".repeat(64),
    };
    expect(() =>
      prepareManagedSnapshotProfileRestore(
        { sandboxName: "alpha", agentType: "hermes", workload: receipt },
        sandbox("hermes"),
        provider(),
      ),
    ).toThrow(/invalid managed workload authority/u);
  });

  it("rebinds a same-name rebuild to its accepted replacement profile", () => {
    const receipt = workload("openclaw");
    const source = { sandboxName: "alpha", agentType: "openclaw", workload: receipt };
    const replacement = workload("openclaw", true);

    const plan = prepareManagedSnapshotProfileRestore(
      source,
      sandbox("openclaw", replacement),
      provider(),
    );

    expect(plan?.authority.receipt).toEqual(receipt);
    expect(plan?.providerRestoreAuthority).toEqual({
      agent: "openclaw",
      profileFingerprint: fingerprintManagedStartupProfile(
        managedStartupE2eProfile("openclaw", true),
      ),
    });
  });

  it("rejects provider refusal and cross-sandbox or cross-agent rebind", () => {
    const receipt = workload("openclaw");
    const source = { sandboxName: "alpha", agentType: "openclaw", workload: receipt };
    expect(() =>
      prepareManagedSnapshotProfileRestore(source, sandbox("openclaw", receipt), provider(false)),
    ).toThrow(/does not accept the snapshot workload receipt/u);
    expect(() =>
      prepareManagedSnapshotProfileRestore(
        source,
        sandbox("openclaw", receipt),
        provider(true, false),
      ),
    ).toThrow(/does not support managed-profile restore/u);
    expect(() =>
      prepareManagedSnapshotProfileRestore(
        source,
        { ...sandbox("openclaw", receipt), name: "beta" },
        provider(),
      ),
    ).toThrow(/requires a managed image or startup-profile rebind/u);
    expect(() =>
      prepareManagedSnapshotProfileRestore(source, sandbox("hermes"), provider()),
    ).toThrow(/requires a managed image or startup-profile rebind/u);
  });

  it("fails before a managed cross-sandbox clone can reach image-only creation", () => {
    expect(() =>
      rejectManagedSnapshotCloneUntilRebind(
        {
          sandboxName: "alpha",
          agentType: "langchain-deepagents-code",
          workload: workload("langchain-deepagents-code"),
        },
        "beta",
      ),
    ).toThrow(/requires managed-profile clone rebind/u);
  });
});
