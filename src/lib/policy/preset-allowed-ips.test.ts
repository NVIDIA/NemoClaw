// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyPresetContent, loadPresetFromFile, networkPoliciesHasAllowedIps } from ".";

let tempDir: string;

function writePreset(name: string, body: string): string {
  const file = path.join(tempDir, `${name}.yaml`);
  fs.writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-ssrf-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("loadPresetFromFile allowed_ips guard (#6073)", () => {
  it("rejects a preset whose endpoint declares allowed_ips", () => {
    const file = writePreset(
      "evil-preset",
      `\
preset:
  name: evil-preset
  description: sneaky
network_policies:
  evil:
    endpoints:
      - host: 10.200.0.2
        port: 18789
        allowed_ips:
          - 10.0.0.0/8
`,
    );
    expect(loadPresetFromFile(file)).toBeNull();
  });

  it("rejects when allowed_ips appears in a second policy entry", () => {
    const file = writePreset(
      "evil-preset-2",
      `\
preset:
  name: evil-preset-2
  description: sneaky second policy
network_policies:
  legit:
    endpoints:
      - host: api.example.com
        port: 443
  evil:
    endpoints:
      - host: 192.168.1.1
        port: 8080
        allowed_ips:
          - 192.168.0.0/16
`,
    );
    expect(loadPresetFromFile(file)).toBeNull();
  });

  it("rejects a preset with object-level allowed_ips (no endpoints array) (#6072)", () => {
    const file = writePreset(
      "evil-object-level",
      `\
preset:
  name: evil-object-level
  description: allowed_ips at the network-policy object level
network_policies:
  evil:
    allowed_ips:
      - 10.0.0.0/8
    endpoints:
      - host: api.example.com
        port: 443
`,
    );
    expect(loadPresetFromFile(file)).toBeNull();
  });

  it("accepts a valid preset with no allowed_ips", () => {
    const file = writePreset(
      "good-preset",
      `\
preset:
  name: good-preset
  description: clean
network_policies:
  api:
    endpoints:
      - host: api.example.com
        port: 443
`,
    );
    expect(loadPresetFromFile(file)).toMatchObject({ presetName: "good-preset" });
  });

  it("accepts endpoints that omit allowed_ips entirely", () => {
    const file = writePreset(
      "no-ips-preset",
      `\
preset:
  name: no-ips-preset
  description: plain endpoints only
network_policies:
  cdn:
    endpoints:
      - host: cdn.example.com
        port: 443
      - host: assets.example.com
        port: 443
`,
    );
    expect(loadPresetFromFile(file)).toMatchObject({ presetName: "no-ips-preset" });
  });
});

describe("loadPresetFromFile host-gateway allowed_ips exemption (#6073)", () => {
  it("accepts allowed_ips on a host.openshell.internal endpoint (the sandbox->host bridge)", () => {
    const file = writePreset(
      "host-gateway",
      `\
preset:
  name: host-gateway
  description: legitimate host-gateway pin
network_policies:
  gw:
    endpoints:
      - host: host.openshell.internal
        port: 18789
        allowed_ips:
          - 10.0.0.0/8
          - 192.168.0.0/16
`,
    );
    expect(loadPresetFromFile(file)).toMatchObject({ presetName: "host-gateway" });
  });

  it("still rejects allowed_ips on a non-bridge endpoint sharing a preset with a bridge endpoint", () => {
    const file = writePreset(
      "mixed-bridge-and-evil",
      `\
preset:
  name: mixed-bridge-and-evil
  description: the bridge exemption must not cover other hosts
network_policies:
  gw:
    endpoints:
      - host: host.openshell.internal
        port: 18789
        allowed_ips:
          - 10.0.0.0/8
  evil:
    endpoints:
      - host: 10.200.0.2
        port: 8080
        allowed_ips:
          - 10.0.0.0/8
`,
    );
    expect(loadPresetFromFile(file)).toBeNull();
  });

  it("does not exempt object-level allowed_ips even when an endpoint targets the bridge", () => {
    const file = writePreset(
      "obj-level-with-bridge",
      `\
preset:
  name: obj-level-with-bridge
  description: object-level allowed_ips is never a legitimate shape
network_policies:
  gw:
    allowed_ips:
      - 10.0.0.0/8
    endpoints:
      - host: host.openshell.internal
        port: 18789
`,
    );
    expect(loadPresetFromFile(file)).toBeNull();
  });
});

describe("networkPoliciesHasAllowedIps prototype-chain guard (#6072)", () => {
  it("detects allowed_ips on an endpoint's prototype chain", () => {
    const ep: Record<string, unknown> = Object.create({ allowed_ips: [] });
    ep.host = "api.example.com";
    ep.port = 443;
    const np = { evil: { endpoints: [ep] } } as never;
    expect(networkPoliciesHasAllowedIps(np)).toBe(true);
  });

  it("detects allowed_ips on a network-policy object's prototype chain", () => {
    const policy: Record<string, unknown> = Object.create({ allowed_ips: [] });
    policy.endpoints = [{ host: "api.example.com", port: 443 }];
    const np = { evil: policy } as never;
    expect(networkPoliciesHasAllowedIps(np)).toBe(true);
  });
});

describe("applyPresetContent allowed_ips guard (#6073)", () => {
  it("rejects custom preset content containing allowed_ips before any side effects", () => {
    const content = `\
preset:
  name: evil-in-memory
  description: SSRF bypass via applyPresetContent
network_policies:
  evil:
    endpoints:
      - host: 10.200.0.2
        port: 18789
        allowed_ips:
          - 10.0.0.0/8
`;
    expect(
      applyPresetContent("test-sandbox", "evil-in-memory", content, {
        custom: { sourcePath: "evil.yaml" },
      }),
    ).toBe(false);
  });
});
