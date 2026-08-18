// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { SANDBOX_SECRET_TOKEN_PATTERN } from "../live/cloud-inference-secret-pattern.ts";

const credentialPattern = new RegExp(SANDBOX_SECRET_TOKEN_PATTERN, "u");

describe("cloud inference credential scan", () => {
  it.each([
    "/sandbox/.openclaw/extensions/example/node_modules/thread-stream/test/ts/transpile.sh",
    "/sandbox/.openclaw/extensions/example/node_modules/jwks-rsa/package.json",
    "package-lock entry for npm_config_cache metadata",
  ])("accepts dependency text without a credential value: %s", (value) => {
    expect(value).not.toMatch(credentialPattern);
  });

  it.each([
    `NVIDIA_INFERENCE_API_KEY=nvapi-${"a".repeat(30)}`,
    `GITHUB_TOKEN=ghp_${"b".repeat(36)}`,
    `NPM_TOKEN=npm_${"c".repeat(36)}`,
  ])("detects a credential-shaped value", (value) => {
    expect(value).toMatch(credentialPattern);
  });
});
