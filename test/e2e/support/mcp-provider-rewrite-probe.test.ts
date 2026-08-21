// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  buildMcpProviderRewriteAuthorization,
  MCP_PROVIDER_REWRITE_PROBE_SOURCE,
} from "../live/mcp-provider-rewrite-probe.ts";

describe("managed MCP provider rewrite probe", () => {
  it.each([
    "openshell:resolve:env:FAKE_MCP_SECRET",
    "openshell:resolve:env:v0_FAKE_MCP_SECRET",
    "openshell:resolve:env:v1_FAKE_MCP_SECRET",
    "openshell:resolve:env:v14429878272859325890_FAKE_MCP_SECRET",
  ])("uses only an exact OpenShell placeholder value [case %#]", (runtimeValue) => {
    expect(buildMcpProviderRewriteAuthorization("FAKE_MCP_SECRET", runtimeValue)).toBe(
      `Bearer ${runtimeValue}`,
    );
  });

  it.each([
    undefined,
    "raw-secret",
    "openshell:resolve:env:v_FAKE_MCP_SECRET",
    "openshell:resolve:env:v144298782728593258901_FAKE_MCP_SECRET",
    "openshell:resolve:env:v1_OTHER_MCP_SECRET",
    "openshell:resolve:env:vbad_FAKE_MCP_SECRET",
    "openshell:resolve:env:v1_FAKE_MCP_SECRET\nAuthorization: Bearer raw-secret",
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
});
