// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  buildMcpProviderRewriteAuthorization,
  buildMcpCredentialHandleAuthorizationPattern,
  MCP_PROVIDER_REWRITE_PROBE_SOURCE,
} from "../live/mcp-provider-rewrite-probe.ts";

describe("managed MCP provider rewrite probe", () => {
  const stableCredentialId = "a".repeat(64);

  it.each([
    "openshell:resolve:env:v0_FAKE_MCP_SECRET",
    "openshell:resolve:env:v1_FAKE_MCP_SECRET",
    "openshell:resolve:env:v14429878272859325890_FAKE_MCP_SECRET",
  ])("accepts an exact ordinary-static OpenShell credential revision [case %#]", (runtimeValue) => {
    expect(buildMcpProviderRewriteAuthorization("FAKE_MCP_SECRET", runtimeValue)).toBe(
      `Bearer ${runtimeValue}`,
    );
  });

  it("accepts an exact refresh-managed OpenShell stable credential handle", () => {
    const runtimeValue = `openshell:resolve:env:s${stableCredentialId}_FAKE_MCP_SECRET`;
    expect(buildMcpProviderRewriteAuthorization("FAKE_MCP_SECRET", runtimeValue)).toBe(
      `Bearer ${runtimeValue}`,
    );
  });

  it.each([
    undefined,
    "raw-secret",
    "openshell:resolve:env:FAKE_MCP_SECRET",
    "openshell:resolve:env:v_FAKE_MCP_SECRET",
    "openshell:resolve:env:v144298782728593258901_FAKE_MCP_SECRET",
    `openshell:resolve:env:s${"a".repeat(63)}_FAKE_MCP_SECRET`,
    `openshell:resolve:env:s${"a".repeat(65)}_FAKE_MCP_SECRET`,
    `openshell:resolve:env:s${"A".repeat(64)}_FAKE_MCP_SECRET`,
    `openshell:resolve:env:s${stableCredentialId}_OTHER_MCP_SECRET`,
    "openshell:resolve:env:vbad_FAKE_MCP_SECRET",
    `openshell:resolve:env:s${stableCredentialId}_FAKE_MCP_SECRET\nAuthorization: Bearer raw-secret`,
  ])("rejects an absent or unsafe runtime value [case %#]", (runtimeValue) => {
    expect(buildMcpProviderRewriteAuthorization("FAKE_MCP_SECRET", runtimeValue)).toBeNull();
  });

  it("embeds the reviewed helper and reads the fresh child environment", () => {
    expect(() => new vm.Script(MCP_PROVIDER_REWRITE_PROBE_SOURCE)).not.toThrow();
    expect(MCP_PROVIDER_REWRITE_PROBE_SOURCE).toContain("process.env[credentialKey]");
    expect(MCP_PROVIDER_REWRITE_PROBE_SOURCE).not.toContain(
      '"Bearer openshell:resolve:env:" + credentialKey',
    );
  });

  it.each([
    "Bearer openshell:resolve:env:v0_FAKE_MCP_SECRET",
    "Bearer openshell:resolve:env:v1_FAKE_MCP_SECRET",
    "Bearer openshell:resolve:env:v14429878272859325890_FAKE_MCP_SECRET",
  ])("accepts an ordinary-static Deep Agents credential revision [case %#]", (value) => {
    expect(value).toMatch(
      new RegExp(buildMcpCredentialHandleAuthorizationPattern("FAKE_MCP_SECRET"), "u"),
    );
  });

  it("accepts a refresh-managed Deep Agents stable credential handle", () => {
    const value = `Bearer openshell:resolve:env:s${stableCredentialId}_FAKE_MCP_SECRET`;
    expect(value).toMatch(
      new RegExp(buildMcpCredentialHandleAuthorizationPattern("FAKE_MCP_SECRET"), "u"),
    );
  });

  it.each([
    "Bearer openshell:resolve:env:FAKE_MCP_SECRET",
    "raw-secret",
    "Bearer openshell:resolve:env:v_FAKE_MCP_SECRET",
    `Bearer openshell:resolve:env:s${stableCredentialId}_OTHER_MCP_SECRET`,
    `Bearer openshell:resolve:env:s${"a".repeat(63)}_FAKE_MCP_SECRET`,
    `Bearer openshell:resolve:env:s${"a".repeat(65)}_FAKE_MCP_SECRET`,
    `Bearer openshell:resolve:env:s${"A".repeat(64)}_FAKE_MCP_SECRET`,
    "Bearer openshell:resolve:env:vbad_FAKE_MCP_SECRET",
    "Bearer openshell:resolve:env:v144298782728593258901_FAKE_MCP_SECRET",
  ])("rejects unsafe Deep Agents authorization [case %#]", (value) => {
    expect(value).not.toMatch(
      new RegExp(buildMcpCredentialHandleAuthorizationPattern("FAKE_MCP_SECRET"), "u"),
    );
  });
});
