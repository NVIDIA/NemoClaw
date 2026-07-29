// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DCODE_VALIDATION_PROFILE_SCHEMA_VERSION,
  type DcodeValidationProfile,
  dcodeValidationProfileDigest,
} from "../../../domain/dcode-validation-profile";
import { resolveDcodeValidationProfileForRebuild } from "./validation-profile";

function profile(): DcodeValidationProfile {
  const content = {
    schemaVersion: DCODE_VALIDATION_PROFILE_SCHEMA_VERSION,
    sandboxName: "dcode",
    taskIdentity: "issue-7774",
    sourceIdentity: `sha256:${"a".repeat(64)}`,
    workingDirectoryRoots: ["/sandbox/workspace"],
    commands: [
      {
        id: "test",
        argv: ["/usr/local/bin/node", "--test"],
        workingDirectory: "/sandbox/workspace",
        environment: ["HOME", "PATH"],
        timeoutSeconds: 60,
        maxOutputBytes: 4096,
        maxInvocations: 1,
      },
    ],
  };
  return { ...content, contentDigest: dcodeValidationProfileDigest(content) };
}

describe("rebuild DCode validation profile handoff", () => {
  it("inherits the immutable registered profile unless the operator disables it (#7774)", () => {
    const recorded = profile();
    const inherited = resolveDcodeValidationProfileForRebuild("dcode", undefined, {
      agent: "langchain-deepagents-code",
      dcodeValidationProfile: recorded,
    });

    expect(inherited).toEqual(recorded);
    expect(inherited).not.toBe(recorded);
    expect(
      resolveDcodeValidationProfileForRebuild("dcode", "disabled", {
        agent: "langchain-deepagents-code",
        dcodeValidationProfile: recorded,
      }),
    ).toBeNull();
  });

  it("rejects the capability for a non-DCode sandbox before rebuild preflight (#7774)", () => {
    expect(() =>
      resolveDcodeValidationProfileForRebuild("openclaw", "disabled", {
        agent: "openclaw",
      }),
    ).toThrow(/supported only for managed LangChain Deep Agents Code/);
  });

  it("allows disabled to clear incompatible recorded state without enabling a new surface (#7774)", () => {
    expect(
      resolveDcodeValidationProfileForRebuild("openclaw", "disabled", {
        agent: "openclaw",
        dcodeValidationProfile: profile(),
      }),
    ).toBeNull();
  });
});
