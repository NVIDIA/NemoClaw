// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { composeLiveNetworkPolicies } from "./mcp-policy-transition";

describe("live OpenShell Shields policy composition", () => {
  it("preserves externally edited and live-only entries directly from OpenShell", () => {
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

    const composed = YAML.parse(composeLiveNetworkPolicies(target, live));

    expect(composed.network_policies).toEqual({
      permissive_baseline: {},
      mcp_bridge_alpha: edited,
      unrelated_live_entry: { endpoints: [{ host: "unrelated.example.com" }] },
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
      YAML.parse(composeLiveNetworkPolicies(target, live)).network_policies.mcp_bridge_alpha,
    ).toEqual({ endpoints: [{ host: "live.example.com" }] });
  });

  it("preserves every live key in the MCP namespace without an ownership manifest", () => {
    const result = YAML.parse(
      composeLiveNetworkPolicies(
        "version: 1\nnetwork_policies: {}\n",
        "version: 1\nnetwork_policies:\n  mcp_bridge_: {}\n",
      ),
    );
    expect(result.network_policies).toEqual({ mcp_bridge_: {} });
  });

  it("rejects a malformed live document instead of inventing MCP state", () => {
    expect(() =>
      composeLiveNetworkPolicies("version: 1\nnetwork_policies: {}\n", "network_policies: ["),
    ).toThrow(/Live OpenShell policy is not valid YAML/);
  });

  it("keeps an intentional permissive target entry on an ordinary name collision", () => {
    const composed = YAML.parse(
      composeLiveNetworkPolicies(
        "version: 1\nnetwork_policies:\n  npm: {access: full}\n",
        "version: 1\nnetwork_policies:\n  npm: {access: restricted}\n",
      ),
    );
    expect(composed.network_policies.npm).toEqual({ access: "full" });
  });

  it("prefers a differently named live policy on an exact endpoint collision", () => {
    const composed = YAML.parse(
      composeLiveNetworkPolicies(
        YAML.stringify({
          version: 1,
          network_policies: {
            npm_yarn: {
              endpoints: [
                { host: "registry.npmjs.org", port: 443, tls: "skip", enforcement: "audit" },
                { host: "registry.yarnpkg.com", port: 443, tls: "skip", enforcement: "audit" },
              ],
            },
            permissive_baseline: { endpoints: [{ host: "*", port: 443, access: "full" }] },
          },
        }),
        YAML.stringify({
          version: 1,
          network_policies: {
            npm_registry: {
              endpoints: [
                {
                  host: "registry.npmjs.org",
                  port: 443,
                  tls: "auto",
                  protocol: "rest",
                  enforcement: "enforce",
                },
              ],
            },
          },
        }),
      ),
    );

    expect(composed.network_policies).toEqual({
      npm_yarn: {
        endpoints: [
          { host: "registry.yarnpkg.com", port: 443, tls: "skip", enforcement: "audit" },
        ],
      },
      permissive_baseline: { endpoints: [{ host: "*", port: 443, access: "full" }] },
      npm_registry: {
        endpoints: [
          {
            host: "registry.npmjs.org",
            port: 443,
            tls: "auto",
            protocol: "rest",
            enforcement: "enforce",
          },
        ],
      },
    });
  });
});
