// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import {
  nativeLocalIdentity,
  normalizeNativeLocalProviderAttachment,
  type NativeLocalBinding,
} from "./contract";
import { prepareNativeLocalProfile } from "./profile";

const binding: NativeLocalBinding = {
  provider: "ollama-local",
  agent: "openclaw",
  endpointUrl: "http://host.openshell.internal:11435/v1",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated",
  gatewayName: "nemoclaw",
  sandboxName: "alice",
};

function legacyAttachment() {
  return { ...binding, ...nativeLocalIdentity(binding, 1), schemaVersion: 1, providerId: "owned" };
}

describe("native local address policy compatibility", () => {
  it("preserves the recorded IPv4 boundary and gives new selections a distinct identity (#13544)", () => {
    const legacy = legacyAttachment();
    const normalized = normalizeNativeLocalProviderAttachment(legacy);
    expect(normalized).toEqual(legacy);
    const oldProfile = prepareNativeLocalProfile(normalized!);
    const profile = prepareNativeLocalProfile(binding);
    expect(profile.profileId).not.toBe(oldProfile.profileId);
    expect(profile.providerName).not.toBe(oldProfile.providerName);
    expect(oldProfile.document.endpoints[0].allowed_ips).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]);
    const { allowed_ips: oldAddresses, ...oldEndpoint } = oldProfile.document.endpoints[0];
    const { allowed_ips: addresses, ...endpoint } = profile.document.endpoints[0];
    expect(addresses).toEqual([...oldAddresses, "fc00::/7"]);
    expect(endpoint).toEqual(oldEndpoint);
    expect(profile.document.credentials).toEqual(oldProfile.document.credentials);
    expect(profile.document.binaries).toEqual(oldProfile.document.binaries);
    expect(
      normalizeNativeLocalProviderAttachment({
        ...legacy,
        endpointUrl: "http://host.docker.internal:11435/v1",
      }),
    ).toBeUndefined();
  });

  it("keeps literal IPv4 endpoints and identities restricted to one address (#13544)", () => {
    const literal = { ...binding, endpointUrl: "http://192.168.1.20:11435/v1" };
    expect(nativeLocalIdentity(literal)).toEqual(nativeLocalIdentity(literal, 1));
    expect(prepareNativeLocalProfile(literal).document.endpoints[0].allowed_ips).toEqual([
      "192.168.1.20/32",
    ]);
  });

  it.each([
    "http://unrelated.example:11435/v1",
    "http://host.openshell.internal.evil:11435/v1",
    "http://[fdc4:f303:9324::254]:11435/v1",
    "http://[2001:4860:4860::8888]:11435/v1",
    "http://host.openshell.internal:80/v1",
    "http://host.openshell.internal:11435/v1/*",
  ])("rejects an unqualified endpoint %s (#13544)", (endpointUrl) => {
    expect(() => prepareNativeLocalProfile({ ...binding, endpointUrl })).toThrow("boundary");
  });

  it("registers and reuses the new profile beside an installed IPv4 profile, then refuses drift (#13544)", async () => {
    const legacy = prepareNativeLocalProfile(legacyAttachment());
    const profile = prepareNativeLocalProfile(binding);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-local-policy-test-"));
    try {
      const profilePath = path.join(directory, "profile.json");
      fs.writeFileSync(profilePath, JSON.stringify(profile.document));
      const run = vi
        .fn()
        .mockReturnValueOnce({
          status: 1,
          stdout: "",
          stderr: `Provider profile '${profile.profileId}' not found`,
        })
        .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
        .mockReturnValue({ status: 0, stdout: JSON.stringify(profile.document), stderr: "" });
      const adapter = createCliOpenShellProviderAdapter({ run, environment: {} });
      const request = { target: { kind: "named" as const, gatewayName: "nemoclaw" }, profilePath };
      expect(await adapter.importProviderProfile(request)).toMatchObject({ ok: true });
      expect(await adapter.importProviderProfile(request)).toMatchObject({ ok: true });
      expect(run.mock.calls.filter(([args]) => args.includes("import"))).toHaveLength(1);
      expect(run.mock.calls.every(([args]) => !args.includes(legacy.profileId))).toBe(true);
      run.mockClear();
      run.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({ ...profile.document, endpoints: legacy.document.endpoints }),
        stderr: "",
      });
      expect(await adapter.importProviderProfile(request)).toMatchObject({
        ok: false,
        error: { reason: "profile_incompatible" },
      });
      expect(run.mock.calls.every(([args]) => args.includes("export"))).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
