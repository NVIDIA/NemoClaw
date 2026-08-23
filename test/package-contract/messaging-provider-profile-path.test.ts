// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

describe("compiled messaging credential profile path", () => {
  it("uses the packaged CLI repository root (#9875)", () => {
    const repositoryRoot = require(
      path.join(REPOSITORY_ROOT, "dist", "lib", "core", "repository-root.js"),
    ) as { REPOSITORY_ROOT: string };
    const profile = require(
      path.join(REPOSITORY_ROOT, "dist", "lib", "messaging", "provider-profile.js"),
    ) as {
      messagingCredentialProviderProfilePath(root: string): string;
    };

    expect(repositoryRoot.REPOSITORY_ROOT).toBe(REPOSITORY_ROOT);
    expect(profile.messagingCredentialProviderProfilePath(repositoryRoot.REPOSITORY_ROOT)).toBe(
      path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "provider-profiles", "nemoclaw-mcp-v1.yaml"),
    );
  });
});
