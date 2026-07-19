// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { renderPresetScope } from "./preset-scope-render";

const WHATSAPP_LIKE_PRESET = `preset:
  name: whatsapp
  description: "WhatsApp Web WebSocket and media"
network_policies:
  whatsapp:
    name: whatsapp
    endpoints:
      - host: web.whatsapp.com
        port: 443
        access: full
        tls: skip
      - host: "*.whatsapp.net"
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
      - host: raw.githubusercontent.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow:
              method: GET
              path: "/WhiskeySockets/Baileys/master/src/Defaults/index.ts"
    binaries:
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/node }
`;

describe("renderPresetScope", () => {
  it("returns an empty list for content with no network_policies", () => {
    expect(renderPresetScope("preset:\n  name: x\n  description: 'y'\n")).toEqual([]);
    expect(renderPresetScope("")).toEqual([]);
  });

  it("returns an empty list for malformed YAML instead of throwing", () => {
    expect(renderPresetScope("::: not yaml :::")).toEqual([]);
  });

  it("renders full L4 tunnel endpoints with access + tls but no rule lines", () => {
    const lines = renderPresetScope(WHATSAPP_LIKE_PRESET);
    const joined = lines.join("\n");
    expect(joined).toContain("- web.whatsapp.com:443 (access: full, tls: skip)");
    const idx = lines.findIndex((line) => line.includes("web.whatsapp.com:443"));
    expect(idx).toBeGreaterThan(-1);
    expect(lines[idx + 1] ?? "").not.toMatch(/^\s+allow:/);
  });

  it("renders REST endpoints with per-rule methods and paths", () => {
    const lines = renderPresetScope(WHATSAPP_LIKE_PRESET);
    const joined = lines.join("\n");
    expect(joined).toContain("- *.whatsapp.net:443 (protocol: rest, enforcement: enforce)");
    expect(joined).toMatch(/allow:\s+GET\s+\/\*\*/);
    expect(joined).toMatch(/allow:\s+POST\s+\/\*\*/);
  });

  it("surfaces the narrowly scoped Baileys version-fetch path, not just the host", () => {
    const joined = renderPresetScope(WHATSAPP_LIKE_PRESET).join("\n");
    expect(joined).toContain("raw.githubusercontent.com:443");
    expect(joined).toContain("/WhiskeySockets/Baileys/master/src/Defaults/index.ts");
  });

  it("lists declared binaries", () => {
    const joined = renderPresetScope(WHATSAPP_LIKE_PRESET).join("\n");
    expect(joined).toContain("binaries:");
    expect(joined).toContain("- /usr/local/bin/node");
    expect(joined).toContain("- /usr/bin/node");
  });

  it("prints one policy block per preset network policy", () => {
    const multi = `network_policies:
  policy_a:
    name: policy_a
    endpoints:
      - host: a.example
        port: 443
        protocol: rest
        rules:
          - allow: { method: GET, path: "/a" }
  policy_b:
    name: policy_b
    endpoints:
      - host: b.example
        port: 443
        access: full
`;
    const joined = renderPresetScope(multi).join("\n");
    expect(joined).toContain("policy 'policy_a':");
    expect(joined).toContain("policy 'policy_b':");
    expect(joined).toContain("- a.example:443");
    expect(joined).toContain("- b.example:443");
  });

  it("skips malformed endpoint entries without dropping the surrounding scope", () => {
    const partial = `network_policies:
  mixed:
    name: mixed
    endpoints:
      - host: 42
      - foo: bar
      - host: good.example
        port: 443
        protocol: rest
        rules:
          - allow: { method: GET, path: "/**" }
`;
    const joined = renderPresetScope(partial).join("\n");
    expect(joined).toContain("- good.example:443");
    expect(joined).not.toMatch(/^\s+- 42/m);
  });

  it("emits (no endpoints declared) rather than skipping an empty policy", () => {
    const empty = `network_policies:
  bare:
    name: bare
    endpoints: []
`;
    const joined = renderPresetScope(empty).join("\n");
    expect(joined).toContain("policy 'bare':");
    expect(joined).toContain("(no endpoints declared)");
  });
});
