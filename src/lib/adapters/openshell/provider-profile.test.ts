// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

import { endpointlessProviderProfilePath } from "./provider-profile";
import { endpointlessProviderProfileFailureMessages } from "./provider-profile-registration";

const PROFILE_ID = "openai";

describe("OpenShell endpointless provider profiles", () => {
  it.each([
    [
      "import-failed",
      `\n  ✗ OpenShell could not import the checked-in '${PROFILE_ID}' inference provider profile.`,
      "    Confirm OpenShell is available and authorized, then retry this command.",
    ],
    [
      "export-failed",
      `\n  ✗ OpenShell provider profile '${PROFILE_ID}' could not be read for validation.`,
      "    Confirm OpenShell is available, authorized, and the profile is readable, then retry this command.",
    ],
    [
      "incompatible",
      `\n  ✗ OpenShell provider profile '${PROFILE_ID}' already exists but does not match NemoClaw's endpointless inference contract.`,
      "    Remove the conflicting profile, then retry this command.",
    ],
  ] as const)(
    "returns recovery guidance for a %s profile result (#9806)",
    (reason, summary, action) => {
      expect(endpointlessProviderProfileFailureMessages(reason)).toEqual([summary, action]);
    },
  );

  it("resolves a checked-in profile path for the requested profile", () => {
    expect(endpointlessProviderProfilePath("/repo", PROFILE_ID)).toBe(
      path.join("/repo", "nemoclaw-blueprint", "provider-profiles", "openai.yaml"),
    );
  });
});
