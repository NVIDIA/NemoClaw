// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../state/registry/types";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageAgent,
  type ManagedImagePlatform,
} from "./managed-image/contract";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import { ManagedWorkloadAuthorityError, readManagedWorkloadAuthority } from "./workload/authority";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
type ManagedWorkloadReceipt = Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }>;

function managedReceipt(
  agent: ManagedImageAgent,
  platform: ManagedImagePlatform,
  profileAgent: ManagedImageAgent = agent,
): ManagedWorkloadReceipt {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile(profileAgent));
  const digest =
    agent === "openclaw" ? "a" : agent === "hermes" ? "b" : agent === "pi" ? "e" : "c";
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:${digest.repeat(64)}`,
    platform,
    release: "v0.0.100",
    sourceRevision: "d".repeat(40),
    sourceCohort: "ghrun-100-1",
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function managedEntry(
  agent: ManagedImageAgent,
  platform: ManagedImagePlatform = "linux/amd64",
  receipt: ManagedWorkloadReceipt = managedReceipt(agent, platform),
): SandboxEntry {
  return {
    name: `authority-${agent}`,
    agent,
    fromDockerfile: null,
    imageTag: receipt.reference,
    workload: receipt,
  };
}

describe("managed workload authority", () => {
  it.each(
    AGENTS.flatMap((agent) => PLATFORMS.map((platform) => [agent, platform] as const)),
  )("validates exact %s authority on %s", (agent, platform) => {
    const row = managedEntry(agent, platform);
    const authority = readManagedWorkloadAuthority(row);

    expect(authority).toMatchObject({
      agent,
      contract: { agent, platform },
      profile: { agent },
      receipt: { kind: "managed-image", platform },
    });
    expect(authority?.receipt).not.toBe(row.workload);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority?.receipt)).toBe(true);
    expect(Object.isFrozen(authority?.contract.source)).toBe(true);
    expect(Object.isFrozen(authority?.profile.proxy)).toBe(true);
  });

  it("returns null only for an unambiguously non-managed workload", () => {
    expect(
      readManagedWorkloadAuthority({
        agent: "openclaw",
        fromDockerfile: "/tmp/Dockerfile",
        imageTag: "custom:local",
        workload: {
          schemaVersion: 1,
          kind: "legacy-dockerfile",
          reference: "custom:local",
          shared: false,
        },
      }),
    ).toBeNull();
  });

  it("rejects missing explicit agent identity", () => {
    expect(() =>
      readManagedWorkloadAuthority({
        ...managedEntry("openclaw"),
        agent: null,
      }),
    ).toThrow(/does not record an explicit agent/u);
  });

  it("rejects missing explicit OCI platform", () => {
    const { platform: _platform, ...withoutPlatform } = managedReceipt("openclaw", "linux/amd64");
    expect(() =>
      readManagedWorkloadAuthority(
        managedEntry("openclaw", "linux/amd64", withoutPlatform as ManagedWorkloadReceipt),
      ),
    ).toThrow(/does not record an explicit OCI platform/u);
  });

  it("rejects cross-agent image authority", () => {
    const openClawReceipt = managedReceipt("openclaw", "linux/amd64");
    expect(() =>
      readManagedWorkloadAuthority(managedEntry("hermes", "linux/amd64", openClawReceipt)),
    ).toThrow(/does not belong to 'hermes'/u);
  });

  it("rejects image reference and startup profile agent mismatch", () => {
    const hermesReceiptWithOpenClawProfile = managedReceipt("hermes", "linux/amd64", "openclaw");
    expect(() =>
      readManagedWorkloadAuthority(
        managedEntry("hermes", "linux/amd64", hermesReceiptWithOpenClawProfile),
      ),
    ).toThrow(/no valid durable workload receipt/u);
  });

  it("rejects unsupported platform values instead of coercing them", () => {
    expect(() =>
      readManagedWorkloadAuthority(
        managedEntry("openclaw", "linux/amd64", {
          ...managedReceipt("openclaw", "linux/amd64"),
          platform: "linux/s390x",
        } as unknown as ManagedWorkloadReceipt),
      ),
    ).toThrow(ManagedWorkloadAuthorityError);
  });

  it("rejects image-tag drift from the cloned durable receipt", () => {
    expect(() =>
      readManagedWorkloadAuthority({
        ...managedEntry("openclaw"),
        imageTag: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"f".repeat(64)}`,
      }),
    ).toThrow(/image reference does not match/u);
  });

  it("rejects a managed receipt combined with a Dockerfile", () => {
    expect(() =>
      readManagedWorkloadAuthority({
        ...managedEntry("openclaw"),
        fromDockerfile: "/tmp/Dockerfile",
      }),
    ).toThrow(/cannot be combined with a custom Dockerfile/u);
  });

  it.each(PLATFORMS)(
    "restores an accepted candidate image identity from its durable receipt on %s (#7927)",
    (platform) => {
      const authority = readManagedWorkloadAuthority(managedEntry("pi", platform));

      expect(authority).toMatchObject({
        agent: "pi",
        contract: { agent: "pi", platform, image: MANAGED_IMAGE_REPOSITORIES.pi },
        profile: { agent: "pi" },
      });
    },
  );

  it("reads a candidate authority without consulting the candidate selection gate (#7927)", () => {
    expect(readManagedWorkloadAuthority(managedEntry("pi"))?.agent).toBe("pi");
  });

  it("rejects a candidate receipt whose profile targets another agent (#7927)", () => {
    expect(() =>
      readManagedWorkloadAuthority(
        managedEntry("pi", "linux/amd64", managedReceipt("pi", "linux/amd64", "hermes")),
      ),
    ).toThrow(ManagedWorkloadAuthorityError);
  });

  it("still rejects an agent outside the managed image set (#7927)", () => {
    expect(() =>
      readManagedWorkloadAuthority({ ...managedEntry("pi"), agent: "not-an-agent" }),
    ).toThrow(/is not a managed-image agent/u);
  });
});
