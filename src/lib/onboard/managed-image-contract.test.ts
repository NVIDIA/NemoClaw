// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractV1,
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "./managed-image/contract";

const MANAGED_IMAGE_PLATFORM = MANAGED_IMAGE_PLATFORMS[0];
const SOURCE_REVISION = "2f03907c37822ea6f1ac9d1bf5c82a4a4568585f";
const SOURCE_RELEASE = "v0.0.89";
const SOURCE_COHORT = "ghrun-7744-2";
const DIGESTS = {
  openclaw: `sha256:${"1a".repeat(32)}`,
  hermes: `sha256:${"2b".repeat(32)}`,
  "langchain-deepagents-code": `sha256:${"3c".repeat(32)}`,
} as const satisfies Record<ShippedManagedImageAgent, `sha256:${string}`>;

function contractFor(agent: ShippedManagedImageAgent): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = DIGESTS[agent];
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: MANAGED_IMAGE_PLATFORM,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: SOURCE_REVISION,
      release: SOURCE_RELEASE,
      cohort: SOURCE_COHORT,
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

describe("managed image contract v1", () => {
  it("advertises startup-profile contract v1 for every shipped agent (#7744)", () => {
    expect(MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION).toBe(1);
    expect(SHIPPED_MANAGED_IMAGE_AGENTS).toEqual([
      "openclaw",
      "hermes",
      "langchain-deepagents-code",
    ]);
  });

  it.each(
    SHIPPED_MANAGED_IMAGE_AGENTS,
  )("maps %s to its immutable public GHCR identity (#7744)", (agent) => {
    const parsed = parseManagedImageContractV1(contractFor(agent), agent);

    expect(parsed).toEqual(contractFor(agent));
    expect(parsed.image).toBe(MANAGED_IMAGE_REPOSITORIES[agent]);
    expect(parsed.reference).toBe(`${parsed.image}@${parsed.digest}`);
    expect(parsed.reference).toMatch(
      /^ghcr\.io\/nvidia\/nemoclaw\/[a-z0-9-]+@sha256:[0-9a-f]{64}$/u,
    );
  });

  it.each(MANAGED_IMAGE_PLATFORMS)("accepts the complete contract on %s (#7744)", (platform) => {
    const contract = { ...contractFor("openclaw"), platform };
    expect(parseManagedImageContractV1(contract, "openclaw", platform)).toEqual(contract);
  });

  it("rejects a mutable tag in place of the exact digest reference (#7744)", () => {
    const contract = {
      ...contractFor("openclaw"),
      reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}:${SOURCE_RELEASE}`,
    };

    expect(() => parseManagedImageContractV1(contract, "openclaw")).toThrow("contract.reference");
  });

  it("rejects a digest that is not a lowercase sha256 identity (#7744)", () => {
    const contract = {
      ...contractFor("hermes"),
      digest: `sha256:${"AB".repeat(32)}`,
    };

    expect(() => parseManagedImageContractV1(contract, "hermes")).toThrow("contract.digest");
  });

  it("rejects a repository outside the agent's reviewed public mapping (#7744)", () => {
    const contract = {
      ...contractFor("langchain-deepagents-code"),
      image: "ghcr.io/example/private/deepagents",
    };

    expect(() => parseManagedImageContractV1(contract, "langchain-deepagents-code")).toThrow(
      "contract.image",
    );
  });

  it("rejects a source identity without a full revision (#7744)", () => {
    const contract = {
      ...contractFor("openclaw"),
      source: {
        repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
        revision: SOURCE_REVISION.slice(0, 12),
        release: SOURCE_RELEASE,
        cohort: SOURCE_COHORT,
      },
    };

    expect(() => parseManagedImageContractV1(contract, "openclaw")).toThrow(
      "contract.source.revision",
    );
  });

  it("rejects a mutable source release alias (#7744)", () => {
    const contract = {
      ...contractFor("hermes"),
      source: {
        repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
        revision: SOURCE_REVISION,
        release: "latest",
        cohort: SOURCE_COHORT,
      },
    };

    expect(() => parseManagedImageContractV1(contract, "hermes")).toThrow(
      "contract.source.release",
    );
  });

  it("rejects a source identity without an exact publication cohort (#7744)", () => {
    const contract = {
      ...contractFor("langchain-deepagents-code"),
      source: {
        repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
        revision: SOURCE_REVISION,
        release: SOURCE_RELEASE,
        cohort: "latest",
      },
    };

    expect(() => parseManagedImageContractV1(contract, "langchain-deepagents-code")).toThrow(
      "contract.source.cohort",
    );
  });

  it.each([
    "ghrun-123456789012345678901-1",
    "ghrun-1-12345678901",
  ])("rejects an unbounded publication cohort %s (#7744)", (cohort) => {
    expect(() =>
      parseManagedImageContractV1(
        {
          ...contractFor("openclaw"),
          source: { ...contractFor("openclaw").source, cohort },
        },
        "openclaw",
      ),
    ).toThrow("contract.source.cohort");
  });

  it.each([
    ["platform", { platform: "linux/ppc64le" }, "contract.platform"],
    [
      "startup profile",
      { startupProfileContractVersion: 2 },
      "contract.startupProfileContractVersion",
    ],
    ["capability", { capabilityContractVersion: 2 }, "contract.capabilityContractVersion"],
  ])("rejects %s contract-version drift instead of guessing compatibility (#7744)", (_label, mutation, expectedField) => {
    expect(() =>
      parseManagedImageContractV1({ ...contractFor("hermes"), ...mutation }, "hermes"),
    ).toThrow(expectedField);
  });

  it("rejects unexpected identity fields so publication metadata cannot alter runtime semantics (#7744)", () => {
    const contract = {
      ...contractFor("openclaw"),
      aliases: [`${MANAGED_IMAGE_REPOSITORIES.openclaw}:${SOURCE_RELEASE}`],
    };

    expect(() => parseManagedImageContractV1(contract, "openclaw")).toThrow(
      "contract must contain exactly",
    );
  });
});
