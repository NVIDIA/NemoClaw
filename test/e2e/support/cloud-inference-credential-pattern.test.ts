// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { HIGH_CONFIDENCE_PREFIXED_TOKEN_ERE } from "../../../nemoclaw/src/security/secret-scanner.ts";

const credentialPattern = new RegExp(HIGH_CONFIDENCE_PREFIXED_TOKEN_ERE, "u");

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

  it.each([
    ["nvapi-", 20],
    ["ghp_", 36],
    ["npm_", 36],
  ])("enforces the minimum payload for %s", (prefix, minimumPayloadLength) => {
    expect(`${prefix}${"a".repeat(minimumPayloadLength - 1)}`).not.toMatch(credentialPattern);
    expect(`${prefix}${"a".repeat(minimumPayloadLength)}`).toMatch(credentialPattern);
  });

  it.each(["gho_", "ghu_", "ghs_", "ghr_", "github_pat_"])(
    "detects a supported GitHub token prefix: %s",
    (prefix) => {
      expect(`${prefix}${"a".repeat(36)}`).toMatch(credentialPattern);
    },
  );
});
