// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MCP_BRIDGE_TEST_CREDENTIALS } from "../e2e/fixtures/mcp-bridge-credentials.ts";
import {
  buildCredentialWindowProviderUpdateArgs,
  CREDENTIAL_WINDOW_ENV_NAME,
  CREDENTIAL_WINDOW_REFRESH_COUNT,
  CREDENTIAL_WINDOW_STEPS,
  credentialWindowRequestId,
  credentialWindowSecrets,
  credentialWindowStableHandlePattern,
} from "../e2e/live/openshell-credential-generation-window.ts";

describe("OpenShell 0.0.116 stable credential-handle proof", () => {
  it("exercises repeated token refreshes with unique scannable values", () => {
    const secrets = credentialWindowSecrets();

    expect(CREDENTIAL_WINDOW_REFRESH_COUNT).toBe(9);
    expect(secrets).toHaveLength(CREDENTIAL_WINDOW_REFRESH_COUNT + 3);
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(
      secrets.every((secret) => secret.startsWith(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow)),
    ).toBe(true);
  });

  it("accepts only the exact stable credential-handle contract", () => {
    const pattern = credentialWindowStableHandlePattern();
    const stable = `openshell:resolve:env:s${"a".repeat(64)}_FAKE_MCP_SECRET`;

    expect(pattern.exec(stable)?.[1]).toBe(`s${"a".repeat(64)}`);
    expect(pattern.test(`openshell:resolve:env:v2_FAKE_MCP_SECRET`)).toBe(false);
    expect(pattern.test(`openshell:resolve:env:s${"A".repeat(64)}_FAKE_MCP_SECRET`)).toBe(false);
    expect(() => credentialWindowStableHandlePattern("FAKE_MCP_SECRET.*")).toThrow(
      "environment name is invalid",
    );
  });

  it("builds explicit attached-key refresh and removal updates", () => {
    expect(buildCredentialWindowProviderUpdateArgs("owned-provider")).toEqual([
      "provider",
      "update",
      "owned-provider",
      "--credential",
      "FAKE_MCP_SECRET",
    ]);
    expect(buildCredentialWindowProviderUpdateArgs("owned-provider", true)).toEqual([
      "provider",
      "update",
      "owned-provider",
      "--credential",
      "FAKE_MCP_SECRET=",
    ]);
  });

  it("keeps credential-window requests independently identifiable", () => {
    expect(CREDENTIAL_WINDOW_ENV_NAME).toBe("FAKE_MCP_SECRET");
    expect(credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterReadd)).toBe(
      "nemoclaw-credential-window:denied-after-readd",
    );
  });
});
