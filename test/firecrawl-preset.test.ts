// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import * as policies from "../src/lib/policy";

type FirecrawlEndpoint = {
  host: string;
  port: number;
  protocol: string;
  enforcement: string;
  access?: string;
  request_body_credential_rewrite?: boolean;
  rules: Array<{ allow: { method: string; path: string } }>;
  tls?: string;
};

type FirecrawlPolicy = {
  endpoints?: FirecrawlEndpoint[];
  binaries?: Array<{ path: string }>;
};

describe("firecrawl opt-in preset", () => {
  it("declares narrow api.firecrawl.dev egress for the interpreter binaries it allows", () => {
    const firecrawl = policies.loadPreset("firecrawl");
    expect(firecrawl).not.toBeNull();
    const content = String(firecrawl);
    const parsed = YAML.parse(content) as {
      network_policies?: {
        firecrawl?: FirecrawlPolicy;
      };
    };
    const policy = parsed.network_policies?.firecrawl;

    expect(policy?.endpoints).toEqual([
      {
        host: "api.firecrawl.dev",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        rules: [
          { allow: { method: "POST", path: "/v2/search" } },
          { allow: { method: "POST", path: "/v2/scrape" } },
        ],
      },
    ]);
    // Firecrawl rewrites the Authorization bearer header via the provider
    // profile, so the endpoint must not carry request-body rewriting.
    expect(policy?.endpoints?.[0]).not.toHaveProperty("request_body_credential_rewrite");
    expect(policy?.binaries).toEqual([
      { path: "/opt/venv/bin/python3*" },
      { path: "/opt/hermes/.venv/bin/python" },
      { path: "/usr/local/bin/node" },
      { path: "/usr/bin/node" },
      { path: "/usr/local/bin/curl" },
      { path: "/usr/bin/curl" },
    ]);
    expect(policy?.binaries).not.toEqual(
      expect.arrayContaining([
        { path: "/usr/bin/python3*" },
        { path: "/usr/local/bin/python3*" },
        { path: "/sandbox/**/bin/python3*" },
      ]),
    );
    expect(policy).not.toHaveProperty("access", "full");
    expect(policy?.endpoints?.[0]).not.toHaveProperty("access");
    expect(policy?.endpoints?.[0]).not.toHaveProperty("tls", "skip");
  });
});
