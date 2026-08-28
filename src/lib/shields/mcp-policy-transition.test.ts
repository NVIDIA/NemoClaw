// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { composeLiveMcpPolicies } from "./mcp-policy-transition";

describe("live MCP Shields policy composition", () => {
  it("preserves externally edited MCP entries directly from OpenShell", () => {
    const target = YAML.stringify({
      version: 1,
      network_policies: { permissive_baseline: {} },
    });
    const edited = { endpoints: [{ host: "operator-edited.example.com" }] };
    const live = YAML.stringify({
      version: 1,
      network_policies: {
        mcp_bridge_alpha: edited,
        unrelated_live_entry: { endpoints: [{ host: "unrelated.example.com" }] },
      },
    });

    const composed = YAML.parse(composeLiveMcpPolicies(target, live));

    expect(composed.network_policies).toEqual({
      permissive_baseline: {},
      mcp_bridge_alpha: edited,
    });
  });

  it("lets the live OpenShell value replace a stale custom-policy value", () => {
    const target = YAML.stringify({
      version: 1,
      network_policies: { mcp_bridge_alpha: { endpoints: [{ host: "stale.example.com" }] } },
    });
    const live = YAML.stringify({
      version: 1,
      network_policies: { mcp_bridge_alpha: { endpoints: [{ host: "live.example.com" }] } },
    });

    expect(
      YAML.parse(composeLiveMcpPolicies(target, live)).network_policies.mcp_bridge_alpha,
    ).toEqual({ endpoints: [{ host: "live.example.com" }] });
  });

  it("preserves every live key in the MCP namespace without an ownership manifest", () => {
    const result = YAML.parse(
      composeLiveMcpPolicies(
        "version: 1\nnetwork_policies: {}\n",
        "version: 1\nnetwork_policies:\n  mcp_bridge_: {}\n",
      ),
    );
    expect(result.network_policies).toEqual({ mcp_bridge_: {} });
  });

  it("rejects a malformed live document instead of inventing MCP state", () => {
    expect(() =>
      composeLiveMcpPolicies("version: 1\nnetwork_policies: {}\n", "network_policies: ["),
    ).toThrow(/Live OpenShell policy is not valid YAML/);
  });
});
