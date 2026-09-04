// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPresetContent, loadPresetFromFile, networkPoliciesHasAllowedIps } from ".";

let tempDir: string;

const UNTRUSTED_ALLOWED_IPS_PRESET = `\
preset:
  name: evil-preset
  description: SSRF bypass through private allowed_ips
network_policies:
  evil:
    endpoints:
      - host: api.example.com
        port: 18789
        allowed_ips:
          - 10.0.0.0/8
`;

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
    const file = writePreset("evil-preset", UNTRUSTED_ALLOWED_IPS_PRESET);
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

describe("applyPresetContent private endpoint guard", () => {
  it.each(["127.0.0.1", "169.254.169.254", "metadata.google.internal"])(
    "rejects an untrusted private or special-use endpoint host %s before side effects",
    (host) => {
      const content = `preset:
  name: private-host
network_policies:
  service:
    endpoints:
      - host: "${host}"
        port: 80
        protocol: rest
`;
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(
        applyPresetContent("test-sandbox", "private-host", content, {
          custom: { sourcePath: "private-host.yaml" },
        }),
      ).toBe(false);
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(
          /endpoint host.*is rejected.*explicit trust only for RFC1918, CGNAT, or IPv6 unique local/i,
        ),
      );

      error.mockRestore();
    },
  );
});

describe("applyPresetContent allowed_ips guard (#6073)", () => {
  it("rejects a custom preset when the full YAML document is invalid (#9406)", () => {
    const content = `preset: corp
preset: corp
network_policies:
  wide_open:
    endpoints:
      - allowed_ips: ["169.254.169.254"]
`;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      applyPresetContent("test-sandbox", "invalid-full-document", content, {
        custom: { sourcePath: "invalid.yaml" },
      }),
    ).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "  Preset 'invalid-full-document' has invalid or missing network_policies.",
    );

    error.mockRestore();
  });

  it("rejects custom preset content containing allowed_ips before any side effects", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      applyPresetContent("test-sandbox", "evil-preset", UNTRUSTED_ALLOWED_IPS_PRESET, {
        custom: { sourcePath: "evil-preset.yaml" },
      }),
    ).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "  Preset 'evil-preset' contains 'allowed_ips', which is not permitted in user-supplied presets.",
    );

    error.mockRestore();
  });

  it("rejects a forged process-local pin capability before any side effects (#8176)", () => {
    const content = `preset:
  name: forged-private
network_policies:
  private:
    endpoints:
      - host: api.corp.example
        port: 443
        allowed_ips: [10.20.30.40]
`;
    const forged = {
      receipt: {
        version: 1,
        contentDigest: createHash("sha256").update(content).digest("hex"),
      },
    };

    expect(
      applyPresetContent("test-sandbox", "forged-private", content, {
        custom: {
          sourcePath: "forged-private.yaml",
          trustedPrivatePinCapability: forged as never,
        },
      }),
    ).toBe(false);
  });

  it("rejects a custom hostless endpoint with broad address ranges", () => {
    const content = `\
preset:
  name: hostless-in-memory
  description: broad hostless endpoint
network_policies:
  broad:
    endpoints:
      - ports: [80, 443]
        allowed_ips:
          - 1.0.0.0/8
`;
    expect(
      applyPresetContent("test-sandbox", "hostless-in-memory", content, {
        custom: { sourcePath: "hostless.yaml" },
      }),
    ).toBe(false);
  });
});
