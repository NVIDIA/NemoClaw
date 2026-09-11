// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

import { endpointlessProviderProfilePath } from "./provider-profile";

const PROFILE_ID = "langfuse-hermes-v1";

describe("OpenShell endpointless provider profiles", () => {
  it("resolves a checked-in profile path for the requested profile", () => {
    expect(endpointlessProviderProfilePath("/repo", PROFILE_ID)).toBe(
      path.join("/repo", "nemoclaw-blueprint", "provider-profiles", "langfuse-hermes-v1.yaml"),
    );
  });
});
