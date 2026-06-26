// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import * as policies from "../dist/lib/policy";

type TavilyEndpoint = {
  host: string;
  port: number;
  protocol: string;
  enforcement: string;
  rules: Array<{ allow: { method: string; path: string } }>;
  tls?: string;
};

type TavilyPolicy = {
  endpoints?: TavilyEndpoint[];
  binaries?: Array<{ path: string }>;
  access?: string;
};

describe("tavily opt-in preset", () => {
  it("declares narrow api.tavily.com egress for the interpreter binaries it allows", () => {
    const tavily = policies.loadPreset("tavily");
    expect(tavily).not.toBeNull();
    const content = String(tavily);
    const parsed = YAML.parse(content) as {
      network_policies?: {
        tavily?: TavilyPolicy;
      };
    };
    const policy = parsed.network_policies?.tavily;

    expect(policy?.endpoints).toEqual([
      {
        host: "api.tavily.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        rules: [
          { allow: { method: "GET", path: "/**" } },
          { allow: { method: "POST", path: "/**" } },
        ],
      },
    ]);
    expect(policy?.binaries).toEqual([
      { path: "/opt/venv/bin/python3*" },
      { path: "/usr/bin/python3*" },
      { path: "/usr/local/bin/python3*" },
      { path: "/usr/local/bin/node" },
      { path: "/usr/bin/node" },
      { path: "/usr/bin/curl" },
    ]);
    expect(policy).not.toHaveProperty("access", "full");
    expect(policy?.endpoints?.[0]).not.toHaveProperty("tls", "skip");
  });
});
