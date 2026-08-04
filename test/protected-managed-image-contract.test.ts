// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  PROTECTED_MANAGED_IMAGE_AGENTS,
  PROTECTED_MANAGED_IMAGE_PLATFORMS,
  type ProtectedManagedImagePlatform,
  parseProtectedManagedImageContracts,
} from "../scripts/checks/protected-managed-image-contract.ts";

const BASE_REPOSITORIES = {
  openclaw: "sandbox-base",
  hermes: "hermes-sandbox-base",
  "langchain-deepagents-code": "langchain-deepagents-code-sandbox-base",
} as const;

function contracts(platform: ProtectedManagedImagePlatform) {
  return PROTECTED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
    const digit = String(index + 1);
    const digest = `sha256:${digit.repeat(64)}`;
    return {
      agent,
      baseReference: `ghcr.io/nvidia/nemoclaw/${BASE_REPOSITORIES[agent]}@sha256:${String(index + 4).repeat(64)}`,
      digest,
      localContentId: `sha256:${String(index + 7).repeat(64)}`,
      platform,
      reference: `localhost:5000/nemoclaw-managed-protected/${agent}@${digest}`,
    };
  });
}

describe("protected managed-image build contract", () => {
  it.each(
    PROTECTED_MANAGED_IMAGE_PLATFORMS,
  )("accepts one unique immutable image for every shipped agent on %s (#7744)", (platform) => {
    const value = contracts(platform);
    expect(parseProtectedManagedImageContracts(value, platform)).toEqual(value);
  });

  it("rejects an incomplete or duplicated all-agent cohort (#7744)", () => {
    const value = contracts("linux/amd64");
    expect(() => parseProtectedManagedImageContracts(value.slice(0, 2), "linux/amd64")).toThrow(
      "exactly all shipped agents",
    );
    expect(() =>
      parseProtectedManagedImageContracts([value[0], value[0], value[2]], "linux/amd64"),
    ).toThrow("each shipped agent once");
  });

  it("rejects cross-platform or mutable image evidence (#7744)", () => {
    const value = contracts("linux/amd64");
    expect(() => parseProtectedManagedImageContracts(value, "linux/arm64")).toThrow(
      "wrong platform",
    );
    expect(() =>
      parseProtectedManagedImageContracts(
        [{ ...value[0], reference: value[0].reference.split("@")[0] }, value[1], value[2]],
        "linux/amd64",
      ),
    ).toThrow("exact agent digest");
  });

  it("rejects identity drift and unexpected receipt fields (#7744)", () => {
    const value = contracts("linux/arm64");
    expect(() =>
      parseProtectedManagedImageContracts(
        [{ ...value[0], digest: `sha256:${"f".repeat(64)}` }, value[1], value[2]],
        "linux/arm64",
      ),
    ).toThrow("exact agent digest");
    expect(() =>
      parseProtectedManagedImageContracts(
        [{ ...value[0], baseReference: value[1].baseReference }, value[1], value[2]],
        "linux/arm64",
      ),
    ).toThrow("invalid base reference");
    expect(() =>
      parseProtectedManagedImageContracts(
        [{ ...value[0], aliases: ["latest"] }, value[1], value[2]],
        "linux/arm64",
      ),
    ).toThrow("unexpected fields");
  });
});
